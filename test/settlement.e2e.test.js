// Stage two through the relay: an agent pays "on Base", the call fails, and the refund is
// settled on Monad through the router and paid on Base by the outpost.
// One local chain plays both: a second token contract stands in for USDC on Base, and two mock
// LayerZero endpoints carry the message. (The contracts are tested in test/foundry/Settlement*.sol.)
const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("hardhat");
const { createRelay } = require("../verifier/relay");
const { createSuretyClient } = require("../sdk");
const { createMockProvider, mockPayingFetch } = require("../examples/mock-provider");
const { parseReceipt } = require("../verifier/payment");
const { deployRefundPair, flushRefunds, refundStatus, b32 } = require("../scripts/crosschain");
const { configFromEnv } = require("../start");

const MONAD = 30390;
const BASE = 30184;
const BASE_CAIP = "eip155:8453";
const usd = (n) => ethers.parseUnits(String(n), 6);

describe("Refunds on the payer's chain, through the relay", function () {
  this.timeout(30_000);
  let owner, relayKey, treasury, providerOp, agent, stranger;
  let usdc, usdcBase, vault, monad, base, router, outpost, relay, mock, client, relayUrl;

  async function start({ flushAt = 0, network = BASE_CAIP, payWith } = {}) {
    [owner, relayKey, treasury, providerOp, agent, stranger] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockUSDC");
    usdc = await Token.deploy();
    usdcBase = await Token.deploy();
    vault = await (await ethers.getContractFactory("SuretyVault")).deploy(usdc, owner.address, relayKey.address, treasury.address, usd(100), 7 * 86400, 500);
    await vault.setMaxDailySlashBps(10_000);
    await vault.setMaxClaimPayout(usd(100));
    const Endpoint = await ethers.getContractFactory("MockEndpoint");
    monad = await Endpoint.deploy(MONAD);
    base = await Endpoint.deploy(BASE);
    await monad.setRemote(BASE, base);

    const pair = await deployRefundPair({
      hubSigner: owner, spokeSigner: owner, hubEndpoint: await monad.getAddress(), spokeEndpoint: await base.getAddress(),
      hubEid: MONAD, spokeEid: BASE, vault: await vault.getAddress(), relay: relayKey.address, spokeUsdc: await usdcBase.getAddress(), log: () => {},
    });
    ({ router, outpost } = pair);
    await vault.setArbiter(pair.state.router); // the one step the vault's owner takes

    await usdc.mint(providerOp.address, usd(1_000));
    await usdc.connect(providerOp).approve(vault, ethers.MaxUint256);
    await usdc.mint(agent.address, usd(1_000));
    await usdcBase.mint(agent.address, usd(1_000));
    const { chainId } = await ethers.provider.getNetwork();
    mock = createMockProvider({ usdc: payWith === "monad" ? usdc : usdcBase, agentSigner: agent, payTo: providerOp.address, price: usd(2), chainId, network: payWith === "monad" ? undefined : network });
    await mock.listen();
    await vault.connect(providerOp).register(mock.slaUrl());
    await vault.connect(providerOp).depositBond(usd(200));

    relay = createRelay({
      vaultAddress: await vault.getAddress(), usdcAddress: await usdc.getAddress(), signer: relayKey,
      routerAddress: pair.state.router, flushAt,
      remote: { [BASE_CAIP]: { provider: ethers.provider, usdc: await usdcBase.getAddress(), eid: BASE } },
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "surety-")), allowInsecure: true, slaTtlMs: 0, statusTtlMs: 0,
    });
    await new Promise((r) => relay.listen(0, "127.0.0.1", r));
    relayUrl = `http://127.0.0.1:${relay.address().port}`;
    client = createSuretyClient({ relayUrl, fetch: mockPayingFetch() });
  }
  afterEach(async () => {
    await Promise.all([new Promise((r) => relay.close(r)), new Promise((r) => mock.server.close(r))]);
  });

  it("deploys the pair pointed at each other, with the relay's key allowed to file claims", async () => {
    await start();
    expect(await router.peers(BASE)).to.equal(b32(await outpost.getAddress()));
    expect(await outpost.peers(MONAD)).to.equal(b32(await router.getAddress()));
    expect(await router.relay()).to.equal(relayKey.address);
    expect(await router.vault()).to.equal(await vault.getAddress());
    expect(await outpost.usdc()).to.equal(await usdcBase.getAddress());
    expect(await outpost.hubEid()).to.equal(MONAD);
  });

  it("a failed call paid on Base is settled on Monad and paid back on Base", async () => {
    await start();
    await usdcBase.mint(await outpost.getAddress(), usd(50)); // the float
    const before = await usdcBase.balanceOf(agent.address);

    const r = await client.call(providerOp.address, "/slow");
    expect(r.verdict).to.equal("fail");
    expect(r.claim.payout).to.equal(usd(2).toString());
    expect(r.claim.settlesOn).to.equal(BASE_CAIP);
    expect(r.claim.delivery).to.equal("queued");

    // Settled: the bond is down by the refund plus the 5% fee, and the router holds the refund.
    expect((await vault.providers(providerOp.address)).bond).to.equal(usd(200) - usd(2) - usd(0.1));
    expect(await usdc.balanceOf(await router.getAddress())).to.equal(usd(2));
    expect(await usdc.balanceOf(agent.address)).to.equal(usd(1_000)); // nothing paid on Monad
    expect(await usdcBase.balanceOf(agent.address)).to.equal(before - usd(2)); // not yet refunded
    let status = await refundStatus({ router, outpost, spokeEid: BASE, agents: [agent.address] });
    expect(status.pending).to.deep.equal({ refunds: 1, amount: usd(2) });

    // Anyone can send the batch. Here a stranger pays for it.
    const sent = await flushRefunds({ router: router.connect(stranger), dstEid: BASE, log: () => {} });
    expect(sent.refunds).to.equal(1);
    await base.deliver(0);
    expect(await usdcBase.balanceOf(agent.address)).to.equal(before); // paid 2 on Base, got 2 back on Base
    status = await refundStatus({ router, outpost, spokeEid: BASE, agents: [agent.address] });
    expect(status.pending.refunds).to.equal(0);
    expect(status.reimbursable).to.equal(usd(2));
    expect(status.spareFloat).to.equal(usd(48));
    expect(status.credits[0].amount).to.equal(0n);
  });

  it("with no float the refund waits as a credit, and is paid once the float is topped up", async () => {
    await start();
    await client.call(providerOp.address, "/broken");
    await flushRefunds({ router, dstEid: BASE, log: () => {} });
    await base.deliver(0);
    let status = await refundStatus({ router, outpost, spokeEid: BASE, agents: [agent.address] });
    expect(status.credits[0].amount).to.equal(usd(2));
    expect(status.spareFloat).to.equal(0n);

    const before = await usdcBase.balanceOf(agent.address);
    await usdcBase.mint(await outpost.getAddress(), usd(10));
    await outpost.connect(stranger).collect(agent.address);
    expect(await usdcBase.balanceOf(agent.address)).to.equal(before + usd(2));
  });

  it("sends the batch by itself once the queue is full", async () => {
    await start({ flushAt: 2 });
    await usdcBase.mint(await outpost.getAddress(), usd(50));
    const first = await client.call(providerOp.address, "/slow");
    expect(first.claim.delivery).to.equal("queued");
    const second = await client.call(providerOp.address, "/slow");
    expect(second.claim.delivery).to.equal("sent");
    expect(await base.inboxLength()).to.equal(1n);
    const before = await usdcBase.balanceOf(agent.address);
    await base.deliver(0);
    expect(await usdcBase.balanceOf(agent.address)).to.equal(before + usd(4));
  });

  it("a payment on Monad is still refunded on Monad, now through the router", async () => {
    await start({ payWith: "monad" });
    const before = await usdc.balanceOf(agent.address);
    const r = await client.call(providerOp.address, "/slow");
    expect(r.claim.payout).to.equal(usd(2).toString());
    expect(r.claim.settlesOn).to.equal(undefined);
    expect(await usdc.balanceOf(agent.address)).to.equal(before); // refunded at once, on Monad
    expect(await usdc.balanceOf(await router.getAddress())).to.equal(0n);
  });

  it("one payment cannot be refunded on both chains", async () => {
    await start();
    const r = await client.call(providerOp.address, "/slow");
    await expect(router.connect(relayKey).payClaim(r.claim.id, providerOp.address, agent.address, usd(2), ethers.ZeroHash))
      .to.be.revertedWithCustomError(vault, "ClaimAlreadyPaid");
    await expect(router.connect(relayKey).payClaimRemote(r.claim.id, providerOp.address, agent.address, usd(2), ethers.ZeroHash, BASE))
      .to.be.revertedWithCustomError(vault, "ClaimAlreadyPaid");
  });

  it("a receipt naming a chain the relay does not serve is not refunded", async () => {
    await start({ network: "eip155:42161" }); // paid with the Base token, but the receipt says Arbitrum
    const r = await client.call(providerOp.address, "/slow");
    expect(r.claim).to.equal(null);
    expect(r.claimError).to.match(/^error:payment_/); // looked for on Monad, where there is no such transfer
    expect((await vault.providers(providerOp.address)).claimCount).to.equal(0n);
  });

  it("the server turns this on with ROUTER_ADDRESS, and stays as it was without it", function () {
    const env = { SURETY_NETWORK: "mainnet", VAULT_ADDRESS: ethers.ZeroAddress.replace(/0$/, "1"), ARBITER_KEY: `0x${"11".repeat(32)}`,
      PROVIDER_ADDRESS: ethers.ZeroAddress.replace(/0$/, "2"), PAY_TO_ADDRESS: ethers.ZeroAddress.replace(/0$/, "3") };
    const plain = configFromEnv(env);
    expect(plain.routerAddress).to.equal(undefined);
    expect(plain.remote).to.equal(undefined);

    const routerAddress = "0x00000000000000000000000000000000000000aa";
    const on = configFromEnv({ ...env, ROUTER_ADDRESS: routerAddress, FLUSH_AT: "5" });
    expect(on.routerAddress).to.equal(ethers.getAddress(routerAddress));
    expect(Object.keys(on.remote)).to.deep.equal(["eip155:8453"]); // Base, the chain paired with Monad mainnet
    expect(on.remote["eip155:8453"].eid).to.equal(30184);
    expect(on.remote["eip155:8453"].usdc).to.equal("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(on.flushAt).to.equal(5);
    expect(configFromEnv({ ...env, ROUTER_ADDRESS: routerAddress }).flushAt).to.equal(undefined); // the relay's default applies
    expect(() => configFromEnv({ ...env, ROUTER_ADDRESS: "0x123" })).to.throw("not an address");
  });

  it("reads the chain off a receipt in both the new and the old form", function () {
    const receipt = (network) => parseReceipt(new Headers({ "payment-response": JSON.stringify({ success: true, transaction: `0x${"ab".repeat(32)}`, network }) }));
    expect(receipt("eip155:8453").network).to.equal("eip155:8453");
    expect(receipt("base").network).to.equal("eip155:8453");
    expect(receipt("Base-Sepolia").network).to.equal("eip155:84532");
    expect(receipt("solana").network).to.equal(null);
    expect(receipt(undefined).network).to.equal(null);
    expect(receipt(8453).network).to.equal(null);
  });
});

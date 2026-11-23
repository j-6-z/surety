// The relay in front of the REAL x402 SDK: official server middleware and
// official paying client. Only the facilitator is faked (it settles on the
// local chain), since the real one lives on Monad.
const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("hardhat");
const { createRelay } = require("../verifier/relay");
const { createSuretyClient } = require("../sdk");
const { createX402Provider } = require("../examples/x402-provider");
const { createPayingFetch } = require("../examples/x402-client");
const { startFakeFacilitator } = require("../examples/fake-facilitator");

const usd = (n) => ethers.parseUnits(String(n), 6);

describe("Relay with the real x402 SDK", function () {
  this.timeout(60_000);
  let s;

  before(async () => {
    const [owner, arbiter, treasury, providerOp, payTo] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const usdcAddr = await usdc.getAddress();
    const vault = await (await ethers.getContractFactory("SuretyVault")).deploy(
      usdcAddr, owner.address, arbiter.address, treasury.address, usd(1), 7 * 86400, 500
    );
    const { chainId } = await ethers.provider.getNetwork();
    const network = `eip155:${chainId}`;

    const agent = ethers.Wallet.createRandom().connect(ethers.provider);
    await ethers.provider.send("hardhat_setBalance", [agent.address, "0x56BC75E2D63100000"]);
    await usdc.mint(agent.address, usd(10));
    await usdc.mint(providerOp.address, usd(10));

    const facilitator = await startFakeFacilitator({ usdc, network, wallets: { [agent.address.toLowerCase()]: agent } });
    const api = createX402Provider({
      network, usdc: usdcAddr, payTo: payTo.address, price: "$0.01", slowMs: 600, slowMaxMs: 300,
      facilitatorUrl: `http://127.0.0.1:${facilitator.address().port}`,
    });
    await api.listen();

    await usdc.connect(providerOp).approve(await vault.getAddress(), ethers.MaxUint256);
    await vault.connect(providerOp).register(api.slaUrl());
    await vault.connect(providerOp).depositBond(usd(5));

    const relay = createRelay({
      vaultAddress: await vault.getAddress(), usdcAddress: usdcAddr, signer: arbiter,
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "surety-x402-")), allowInsecure: true,
    });
    await new Promise((r) => relay.listen(0, "127.0.0.1", r));
    const client = createSuretyClient({
      relayUrl: `http://127.0.0.1:${relay.address().port}`,
      fetch: createPayingFetch(agent.privateKey, network, usdcAddr).fetch,
    });
    s = { usdc, vault, agent, payTo, provider: providerOp.address, client, relay, api, facilitator };
  });

  after(async () => {
    await new Promise((r) => s.relay.close(r));
    await s.api.close();
    await new Promise((r) => s.facilitator.close(r));
  });

  it("the 402 handshake and payment work through the relay", async () => {
    const before = await s.usdc.balanceOf(s.agent.address);
    const r = await s.client.call(s.provider, "/quote");
    expect(r.response.status).to.equal(200);
    expect(await r.response.json()).to.deep.equal({ symbol: "MON", price: 1.23 });
    expect(r.verdict).to.equal("pass");
    expect(before - (await s.usdc.balanceOf(s.agent.address))).to.equal(usd(0.01));
    expect(await s.usdc.balanceOf(s.payTo.address)).to.equal(usd(0.01));
  });

  it("a slow real-x402 call is refunded using the SDK's own receipt", async () => {
    const before = await s.usdc.balanceOf(s.agent.address);
    const r = await s.client.call(s.provider, "/slow");
    expect(r.verdict).to.equal("fail");
    expect(r.reason).to.equal("too_slow");
    expect(r.claimError).to.equal(null);
    expect(r.claim.payout).to.equal(usd(0.01).toString());
    expect(await s.usdc.balanceOf(s.agent.address)).to.equal(before);
  });

  it("a wrong-shape real-x402 call is refunded", async () => {
    const before = await s.usdc.balanceOf(s.agent.address);
    const r = await s.client.call(s.provider, "/broken");
    expect(r.reason).to.equal("schema_mismatch");
    expect(r.claim).to.not.equal(null);
    expect(await s.usdc.balanceOf(s.agent.address)).to.equal(before);
    expect((await s.vault.providers(s.provider)).claimCount).to.equal(2n);
  });
});

describe("testnet-check script (dry run on the local chain)", function () {
  this.timeout(60_000);

  it("sets itself up and gets 3/3, and can be run a second time", async () => {
    const { main } = require("../scripts/testnet-check");
    const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
    await ethers.provider.send("hardhat_setBalance", [wallet.address, "0x56BC75E2D63100000"]);
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const usdcAddr = await usdc.getAddress();
    await usdc.mint(wallet.address, usd(1)); // what the faucet gives
    const vault = await (await ethers.getContractFactory("SuretyVault", wallet)).deploy(
      usdcAddr, wallet.address, wallet.address, wallet.address, usd(100), 7 * 86400, 500
    );
    const { chainId } = await ethers.provider.getNetwork();
    const network = `eip155:${chainId}`;
    const facilitator = await startFakeFacilitator({ usdc, network, wallets: { [wallet.address.toLowerCase()]: wallet } });
    const lines = [];
    const cfg = {
      wallet, vaultAddress: await vault.getAddress(), usdcAddress: usdcAddr, network,
      facilitatorUrl: `http://127.0.0.1:${facilitator.address().port}`,
      slowMs: 600, slowMaxMs: 300, apiPort: 0, relayPort: 0, log: (m) => lines.push(m),
    };
    try {
      const first = await main(cfg);
      expect(first.results.map((r) => r.ok), lines.join("\n")).to.deep.equal([true, true, true]);
      expect(first.provider.claimCount).to.equal(2n);
      expect(lines.join("\n")).to.contain("RESULT: 3/3");
      const second = await main(cfg); // already registered and bonded
      expect(second.results.map((r) => r.ok)).to.deep.equal([true, true, true]);
      expect(second.provider.claimCount).to.equal(4n);
    } finally {
      await new Promise((r) => facilitator.close(r));
    }
  });
});

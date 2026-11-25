// The cross-chain scripts, run against the real vault and two mock LayerZero endpoints.
// (The contracts themselves are tested in test/foundry/Crosschain.t.sol.)
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployPair, sendReport, readMirror, encodeUlnConfig, providersFrom, routeState, b32 } = require("../scripts/crosschain");
const { CHAINS, pairFor } = require("../crosschain.config");

const MONAD = 30390;
const BASE = 30184;
const USDC = (n) => ethers.parseUnits(String(n), 6);

describe("cross-chain scripts", function () {
  let owner, provider, other, usdc, vault, monad, base, pair;
  const quiet = () => {};

  beforeEach(async function () {
    [owner, provider, other] = await ethers.getSigners();
    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    vault = await (await ethers.getContractFactory("SuretyVault")).deploy(usdc, owner.address, owner.address, owner.address, USDC(1), 7 * 86400, 500);
    const Endpoint = await ethers.getContractFactory("MockEndpoint");
    monad = await Endpoint.deploy(MONAD);
    base = await Endpoint.deploy(BASE);
    await monad.setRemote(BASE, base);
    await usdc.mint(provider.address, USDC(10));
    await usdc.connect(provider).approve(vault, USDC(10));
    await vault.connect(provider).register("ipfs://sla");
    await vault.connect(provider).depositBond(USDC(10));
    pair = await deployPair({
      hubSigner: owner, spokeSigner: owner, hubEndpoint: await monad.getAddress(), spokeEndpoint: await base.getAddress(),
      hubEid: MONAD, spokeEid: BASE, vault: await vault.getAddress(), log: quiet,
    });
  });

  it("deploys both contracts and points them at each other", async function () {
    expect(await pair.beacon.peers(BASE)).to.equal(b32(pair.state.mirror));
    expect(await pair.mirror.peers(MONAD)).to.equal(b32(pair.state.beacon));
    expect(await pair.beacon.vault()).to.equal(await vault.getAddress());
    expect(await pair.mirror.hubEid()).to.equal(MONAD);
    expect(await pair.mirror.maxAge()).to.equal(3600);
  });

  it("can be run again without redeploying or resending anything", async function () {
    const lines = [];
    const saves = [];
    const again = await deployPair({
      hubSigner: owner, spokeSigner: owner, hubEndpoint: await monad.getAddress(), spokeEndpoint: await base.getAddress(),
      hubEid: MONAD, spokeEid: BASE, vault: await vault.getAddress(), saved: pair.state, save: (s) => saves.push(s), log: (l) => lines.push(l),
    });
    expect(again.state).to.deep.equal(pair.state);
    expect(lines).to.deep.equal([]);
    expect(saves).to.deep.equal([]);
  });

  it("finishes a deploy that stopped halfway", async function () {
    const saves = [];
    const half = { beacon: pair.state.beacon }; // as if the mirror step never ran
    const done = await deployPair({
      hubSigner: owner, spokeSigner: owner, hubEndpoint: await monad.getAddress(), spokeEndpoint: await base.getAddress(),
      hubEid: MONAD, spokeEid: BASE, vault: await vault.getAddress(), saved: half, save: (s) => saves.push({ ...s }), log: quiet,
    });
    expect(done.state.beacon).to.equal(pair.state.beacon);
    expect(done.state.mirror).to.not.equal(pair.state.mirror);
    expect(saves).to.have.length(1);
    expect(await done.beacon.peers(BASE)).to.equal(b32(done.state.mirror));
  });

  it("sends a report and reads it back from the mirror", async function () {
    const sent = await sendReport({ beacon: pair.beacon, dstEid: BASE, providers: [provider.address, other.address], log: quiet });
    expect(sent.nonce).to.equal(1);
    expect(sent.guid).to.match(/^0x[0-9a-f]{64}$/);
    expect(sent.fee).to.equal(await pair.beacon.quote(BASE, [provider.address, other.address]));

    let rows = await readMirror({ mirror: pair.mirror, vault, providers: [provider.address] });
    expect(rows[0].mirror.covered).to.equal(false); // sent, but not delivered yet
    expect(rows[0].mirror.observedAt).to.equal(0);
    expect(rows[0].vault.covered).to.equal(true);

    await base.deliver(0);
    rows = await readMirror({ mirror: pair.mirror, vault, providers: [provider.address, other.address] });
    expect(rows[0].mirror).to.include({ covered: true, fresh: true, nonce: 1 });
    expect(rows[0].mirror.cover).to.equal(USDC(10));
    expect(rows[0].mirror.dailyAllowance).to.equal(USDC(2));
    expect(rows[0].vault.cover).to.equal(USDC(10));
    expect(rows[1].mirror).to.include({ covered: false, fresh: true });
    expect(rows[1].vault.covered).to.equal(false);
  });

  it("shows a provider that queued its exit as no longer covered", async function () {
    await sendReport({ beacon: pair.beacon, dstEid: BASE, providers: [provider.address], log: quiet });
    await base.deliver(0);
    await vault.connect(provider).requestBondWithdraw(USDC(10));
    await ethers.provider.send("evm_increaseTime", [5]);
    await sendReport({ beacon: pair.beacon, dstEid: BASE, providers: [provider.address], log: quiet });
    await base.deliver(1);
    const [row] = await readMirror({ mirror: pair.mirror, vault, providers: [provider.address] });
    expect(row.mirror.covered).to.equal(false);
    expect(row.mirror.cover).to.equal(USDC(10)); // still slashable while it waits to leave
  });

  it("encodes the verifier setup the way LayerZero's library decodes it", async function () {
    const [a, b] = ["0x00000000000000000000000000000000000000bb", "0x00000000000000000000000000000000000000aa"];
    const tuple = "tuple(uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs)";
    const [c] = ethers.AbiCoder.defaultAbiCoder().decode([tuple], encodeUlnConfig(15, [a, b]));
    expect(c.confirmations).to.equal(15n);
    expect(c.requiredDVNCount).to.equal(2n);
    expect(c.optionalDVNCount).to.equal(255n); // LayerZero's "none"; 0 would mean "inherit the default"
    expect(c.optionalDVNThreshold).to.equal(0n);
    expect([...c.requiredDVNs]).to.deep.equal([ethers.getAddress(b), ethers.getAddress(a)]); // ascending, as required
    expect([...c.optionalDVNs]).to.deep.equal([]);
    expect(() => encodeUlnConfig(15, [])).to.throw("At least one DVN");
    expect(() => encodeUlnConfig(15, [a, a.toUpperCase().replace("0X", "0x")])).to.throw("twice");
  });

  it("takes providers from the command line, else from PROVIDER_ADDRESS", function () {
    const lower = provider.address.toLowerCase();
    expect(providersFrom([lower], {})).to.deep.equal([provider.address]);
    expect(providersFrom([], { PROVIDER_ADDRESS: lower })).to.deep.equal([provider.address]);
    expect(() => providersFrom([], {})).to.throw("at least one provider");
    expect(() => providersFrom(["0x123"], {})).to.throw("not an address");
  });

  it("tells a missing route from one that only needs its verifiers named", function () {
    const live = { ok: true, dead: false, required: [{}, {}] };
    const placeholder = { ok: true, dead: true, required: [{}] };
    expect(routeState({ ok: false }, live)).to.equal("none");
    expect(routeState(placeholder, placeholder)).to.equal("unpinned"); // LayerZero's default on a new route
    expect(routeState(live, placeholder)).to.equal("unpinned");
    expect(routeState(live, { ok: true, dead: false, required: [{}] })).to.equal("mismatch");
    expect(routeState(live, live)).to.equal("ready");
  });

  it("has a well-formed address table", function () {
    for (const [key, chain] of Object.entries(CHAINS)) {
      for (const a of [...chain.endpoints, chain.deadDvn, ...Object.values(chain.dvns)]) expect(ethers.isAddress(a), `${key} ${a}`).to.equal(true);
      expect(String(chain.eid)[0], key).to.equal(key === "monad" || key === "base" ? "3" : "4"); // 30xxx mainnet, 40xxx testnet
    }
    const mainnet = pairFor("mainnet", {});
    expect([mainnet.hub.chainId, mainnet.spoke.chainId]).to.deep.equal([143, 8453]);
    expect(Object.keys(mainnet.hub.dvns).filter((n) => mainnet.spoke.dvns[n]).length).to.be.at.least(2);
    expect(pairFor("testnet", { BASE_SEPOLIA_RPC: "http://x" }).spoke.rpc).to.equal("http://x");
    expect(() => pairFor("devnet", {})).to.throw("No cross-chain pair");
  });
});

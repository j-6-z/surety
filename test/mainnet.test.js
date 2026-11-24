// What stands between this code and real money: the network profiles, the
// split of keys by role, the deploy guard, and the preflight check.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { networkFromEnv, NETWORKS } = require("../networks");
const { configFromEnv, buildSuretyApp } = require("../start");
const { mainnetProblems } = require("../scripts/deploy");
const { preflight } = require("../scripts/mainnet-check");
const { startFakeFacilitator } = require("../examples/fake-facilitator");

const usd = (n) => ethers.parseUnits(String(n), 6);
const KEY = "0x" + "11".repeat(32), KEY2 = "0x" + "22".repeat(32);
const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), C = "0x" + "c3".repeat(20);

describe("Mainnet readiness", function () {
  this.timeout(60_000);

  describe("network profiles", () => {
    it("defaults to testnet and switches to mainnet by name", () => {
      expect(networkFromEnv({})).to.include({ key: "testnet", chainId: 10143, caip: "eip155:10143", real: false });
      const m = networkFromEnv({ SURETY_NETWORK: "MAINNET" });
      expect(m).to.include({ key: "mainnet", chainId: 143, caip: "eip155:143", real: true, usdc: NETWORKS.mainnet.usdc });
      expect(m.usdc).to.not.equal(NETWORKS.testnet.usdc);
      expect(() => networkFromEnv({ SURETY_NETWORK: "sepolia" })).to.throw("testnet");
    });

    it("keeps each network's RPC override to itself", () => {
      const env = { MONAD_TESTNET_RPC: "https://t.example", MONAD_MAINNET_RPC: "https://m.example" };
      expect(networkFromEnv(env).rpc).to.equal("https://t.example");
      expect(networkFromEnv({ ...env, SURETY_NETWORK: "mainnet" }).rpc).to.equal("https://m.example");
      expect(networkFromEnv({ SURETY_NETWORK: "mainnet", EXPLORER_URL: "https://x.example/" }).explorer).to.equal("https://x.example");
    });
  });

  describe("deploy guard", () => {
    const good = { OWNER_ADDRESS: A, ARBITER_ADDRESS: B, MIN_BOND_USDC: "1", I_UNDERSTAND_UNAUDITED: "yes" };
    it("lets a split, explicit setup through", () => {
      expect(mainnetProblems(good, C)).to.deep.equal([]);
    });
    it("refuses a missing owner, a shared key, the deployer as owner, a default bond, and an unconfirmed audit status", () => {
      expect(mainnetProblems({}, C)).to.have.length(4);
      expect(mainnetProblems({ ...good, ARBITER_ADDRESS: A }, C).join()).to.contain("must be different wallets");
      expect(mainnetProblems({ ...good, OWNER_ADDRESS: C.toUpperCase().replace("0X", "0x") }, C).join()).to.contain("deploying from");
      expect(mainnetProblems({ ...good, MIN_BOND_USDC: undefined }, C).join()).to.contain("MIN_BOND_USDC");
      expect(mainnetProblems({ ...good, I_UNDERSTAND_UNAUDITED: "y" }, C).join()).to.contain("not been audited");
      expect(mainnetProblems({ ...good, MIN_BOND_USDC: "100" }, C).join()).to.contain("second MIN_BOND_USDC line");
      expect(mainnetProblems({ ...good, MIN_BOND_USDC: "100", ALLOW_LARGE_MIN_BOND: "yes" }, C)).to.deep.equal([]);
      expect(mainnetProblems({ ...good, MIN_BOND_USDC: "10" }, C)).to.deep.equal([]);
    });
  });

  describe("server settings", () => {
    const base = { VAULT_ADDRESS: A, PUBLIC_URL: "https://s.example" };
    it("on testnet one key still plays every part", () => {
      const c = configFromEnv({ ...base, PRIVATE_KEY: KEY });
      expect(c.providerAddress).to.equal(c.wallet.address);
      expect(c.demoWallet).to.equal(c.wallet);
      expect(c).to.include({ network: "eip155:10143", usdcAddress: NETWORKS.testnet.usdc, explorer: "https://testnet.monadvision.com" });
    });
    it("on mainnet the roles are separate and the demo is off unless it has its own wallet", () => {
      const env = { ...base, SURETY_NETWORK: "mainnet", ARBITER_KEY: KEY, PROVIDER_ADDRESS: B, PAY_TO_ADDRESS: C };
      const c = configFromEnv(env);
      expect(c).to.include({ network: "eip155:143", usdcAddress: NETWORKS.mainnet.usdc, payTo: C });
      expect(c.providerAddress.toLowerCase()).to.equal(B);
      expect(c.providerAddress).to.not.equal(c.wallet.address);
      expect(c.demoWallet).to.equal(null);
      const withDemo = configFromEnv({ ...env, DEMO_KEY: KEY2, USDC_DOMAIN_NAME: "USD Coin" });
      expect(withDemo.demoWallet.address).to.not.equal(withDemo.wallet.address);
      expect(withDemo.tokenDomain).to.deep.equal({ name: "USD Coin", version: "2" });
    });
    it("refuses a mainnet setup that would run everything from one key", () => {
      const m = { ...base, SURETY_NETWORK: "mainnet" };
      expect(() => configFromEnv({ ...m, ARBITER_KEY: KEY })).to.throw("PROVIDER_ADDRESS and PAY_TO_ADDRESS");
      expect(() => configFromEnv({ ...m, PRIVATE_KEY: KEY, PROVIDER_ADDRESS: B, PAY_TO_ADDRESS: C })).to.throw("ARBITER_KEY");
    });
    it("serves the provider's address, not the relay's, and no demo without a demo wallet", async () => {
      const c = configFromEnv({ ...base, SURETY_NETWORK: "mainnet", ARBITER_KEY: KEY, PROVIDER_ADDRESS: B, PAY_TO_ADDRESS: C });
      const { app } = buildSuretyApp({ ...c, reader: {} });
      const server = await new Promise((r) => { const h = app.listen(0, "127.0.0.1", () => r(h)); });
      try {
        const url = `http://127.0.0.1:${server.address().port}`;
        const home = await (await fetch(url, { headers: { accept: "text/html" } })).text();
        expect(home.toLowerCase()).to.contain(B).and.to.not.contain(c.wallet.address.toLowerCase());
        expect((await fetch(`${url}/demo/run?kind=good`, { method: "POST" })).status).to.equal(404);
        const sla = await (await fetch(`${url}/.well-known/surety.json`)).json();
        expect(sla.payTo.toLowerCase()).to.equal(C);
        expect(sla.endpoints.map((e) => e.path)).to.not.include("/v1/demo/slow");
      } finally {
        await new Promise((r) => server.close(r));
      }
    });
  });

  describe("preflight and live check, on the local chain", () => {
    let s;
    before(async () => {
      const [owner, treasury] = await ethers.getSigners();
      const arbiter = ethers.Wallet.createRandom().connect(ethers.provider);
      await ethers.provider.send("hardhat_setBalance", [arbiter.address, "0x56BC75E2D63100000"]);
      const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
      const usdcAddr = await usdc.getAddress();
      const deploy = async (o, a) => (await ethers.getContractFactory("SuretyVault")).deploy(usdcAddr, o, a, treasury.address, usd(1), 7 * 86400, 500);
      const vault = await deploy(owner.address, arbiter.address);
      const { chainId } = await ethers.provider.getNetwork();
      const caip = `eip155:${chainId}`;
      const facilitator = await startFakeFacilitator({ usdc, network: caip, wallets: { [arbiter.address.toLowerCase()]: arbiter } });
      const net = { ...NETWORKS.mainnet, chainId: Number(chainId), caip, usdc: usdcAddr, rpc: "local", facilitatorUrl: `http://127.0.0.1:${facilitator.address().port}` };
      const supported = async () => new Response(JSON.stringify({ kinds: [{ network: caip, scheme: "exact" }] }));
      const run = (o) => preflight({ provider: ethers.provider, net, fetch: supported, log() {}, ...o });
      s = { owner, arbiter, usdc, usdcAddr, vault, deploy, net, facilitator, run, caip };
    });
    after(() => new Promise((r) => s.facilitator.close(r)));

    it("passes a properly split setup and reads the token's signing name from the chain", async () => {
      const r = await s.run({ vaultAddress: await s.vault.getAddress(), wallet: s.arbiter.address });
      expect(r.problems).to.deep.equal([]);
      expect(r.tokenDomain).to.deep.equal({ name: "Mock USDC", version: "2" });
      expect(r.facts.minBond).to.equal(usd(1));
      expect(r.facts.maxClaim).to.equal(usd(0.05)); // 5% of the minimum bond
      expect(r.facts.dailyBps).to.equal(2_000n);
    });

    it("catches an owner key on the server, a shared owner and arbiter, and the wrong arbiter", async () => {
      const vaultAddress = await s.vault.getAddress();
      expect((await s.run({ vaultAddress, wallet: s.owner.address })).problems.join()).to.contain("vault OWNER").and.to.contain("could not pay refunds");
      const shared = await s.deploy(s.owner.address, s.owner.address);
      expect((await s.run({ vaultAddress: await shared.getAddress() })).problems.join()).to.contain("same wallet");
      expect((await s.run({ vaultAddress: ethers.Wallet.createRandom().address })).problems.join()).to.contain("Nothing is deployed");
      expect((await s.run({ vaultAddress: "0x1234" })).problems.join()).to.contain("not a valid address");
    });

    it("catches the wrong chain, a facilitator that does not settle here, and a wallet with no gas", async () => {
      const vaultAddress = await s.vault.getAddress();
      expect((await s.run({ net: { ...s.net, chainId: 143 } })).problems.join()).to.contain("not 143");
      expect((await s.run({ fetch: async () => new Response("{}") })).problems.join()).to.contain("does not list");
      const broke = ethers.Wallet.createRandom().address;
      const v = await s.deploy(s.owner.address, broke);
      expect((await s.run({ vaultAddress: await v.getAddress(), wallet: broke })).problems.join()).to.contain("no MON");
    });

    it("the live run works with the owner elsewhere and leaves the vault's settings alone", async () => {
      const { main } = require("../scripts/testnet-check");
      await s.usdc.mint(s.arbiter.address, usd(1.2));
      const lines = [];
      const out = await main({
        wallet: s.arbiter, vaultAddress: await s.vault.getAddress(), usdcAddress: s.usdcAddr, network: s.caip,
        facilitatorUrl: s.net.facilitatorUrl, ownerElsewhere: true, tokenDomain: { name: "Mock USDC", version: "2" },
        slowMs: 600, slowMaxMs: 300, apiPort: 0, relayPort: 0, log: (m) => lines.push(m),
      });
      expect(out.results.map((r) => r.ok), lines.join("\n")).to.deep.equal([true, true, true]);
      expect(await s.vault.minProviderBond()).to.equal(usd(1)); // untouched
      expect(out.provider.bond).to.equal(usd(1.1) - usd(0.0021)); // two refunds of 0.001 plus the 5% fee each
      expect(lines.join("\n")).to.not.contain("minimum bond set");
    });

    it("the live run refuses a wallet that is not the arbiter", async () => {
      const { main } = require("../scripts/testnet-check");
      const other = ethers.Wallet.createRandom().connect(ethers.provider);
      const err = await main({ wallet: other, vaultAddress: await s.vault.getAddress(), usdcAddress: s.usdcAddr, network: s.caip, facilitatorUrl: s.net.facilitatorUrl, ownerElsewhere: true, log() {} }).then(() => null, (e) => e.message);
      expect(err).to.contain("must be the vault's arbiter");
    });
  });
});

describe("What the site says on each network", function () {
  this.timeout(60_000);
  const fs = require("fs"), os = require("os"), path = require("path");
  const { NET, useNetwork } = require("../site/theme");
  const saved = { ...NET };
  afterEach(() => useNetwork(saved));

  const TESTNET_WORDS = /testnet|test usdc|test funds|test wallet|test network|test mon\b|faucet|10143|0x534b2f3A|0xf3F9e32D|no value/i;
  const pagesFor = (profile) => {
    useNetwork(profile);
    const { landingPage } = require("../marketdata/landing");
    const { directoryPage } = require("../site/directory");
    const { bondPage } = require("../site/bond-page");
    const { build } = require("../scripts/generate");
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "surety-net-"));
    build({ out, log() {}, scheduleFile: path.join(out, "schedule.json") });
    const pages = {
      home: landingPage({ url: "https://s.example", provider: B, vaultAddress: profile.vault, repoUrl: "https://github.com/x/y", price: "$0.001" }),
      providers: directoryPage({ url: "https://s.example", vaultAddress: profile.vault }),
      bond: bondPage({ url: "https://s.example", vaultAddress: profile.vault, usdcAddress: profile.usdc, chainId: profile.chainId }),
    };
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".html") ? [path.join(dir, e.name)] : []));
    for (const f of walk(out)) pages[path.relative(out, f)] = fs.readFileSync(f, "utf8");
    return pages;
  };

  it("on mainnet, no page calls it a testnet or says the money is not real", () => {
    const pages = pagesFor(NETWORKS.mainnet);
    expect(Object.keys(pages).length).to.be.above(9);
    for (const [name, html] of Object.entries(pages)) {
      const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ");
      // The kit page may explain that the kit itself defaults to testnet; nothing else may mention it.
      const hit = text.match(TESTNET_WORDS);
      if (hit && !(name.startsWith("kit") && /testnet by default/.test(text))) throw new Error(`${name} still says "${hit[0]}": …${text.slice(Math.max(0, hit.index - 80), hit.index + 80)}…`);
      expect(html, name).to.not.contain("{{").and.to.not.contain("undefined");
    }
    expect(pages.home).to.contain("Monad mainnet").and.to.contain("real USDC").and.to.contain(NETWORKS.mainnet.vault);
    expect(pages.home).to.contain("Beta, not audited").and.to.contain("Unaudited beta");
    expect(pages.bond).to.contain("has not been audited").and.to.contain('"chainName":"Monad"');
    expect(pages[path.join("faq", "index.html")]).to.contain("every bond, payment and refund is real USDC");
    expect(pages[path.join("docs", "index.html")]).to.contain(NETWORKS.mainnet.vault).and.to.contain("chain ID 143");
  });

  it("on testnet, everything still says test funds", () => {
    const pages = pagesFor(NETWORKS.testnet);
    expect(pages.home).to.contain("Monad testnet").and.to.contain("Test funds only").and.to.contain(NETWORKS.testnet.vault);
    expect(pages[path.join("faq", "index.html")]).to.contain("test USDC that has no value");
    for (const [name, html] of Object.entries(pages)) expect(html, name).to.not.contain("{{").and.to.not.contain("real USDC");
  });

  it("the server describes the chain it is actually on", async () => {
    const c = configFromEnv({ VAULT_ADDRESS: NETWORKS.mainnet.vault, PUBLIC_URL: "https://s.example", SURETY_NETWORK: "mainnet", ARBITER_KEY: KEY, PROVIDER_ADDRESS: B, PAY_TO_ADDRESS: C });
    const { app } = buildSuretyApp({ ...c, reader: {} }); // the build default is testnet; the server must override it
    const server = await new Promise((r) => { const h = app.listen(0, "127.0.0.1", () => r(h)); });
    try {
      const home = await (await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { accept: "text/html" } })).text();
      expect(home).to.contain("Monad mainnet").and.to.contain("monadvision.com/address/" + NETWORKS.mainnet.vault);
      expect(home).to.not.contain("testnet.monadvision.com");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("Taking a bond out of an old vault", function () {
  this.timeout(60_000);
  it("queues the whole bond, refuses to collect early, and collects once the wait is over", async () => {
    const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
    const { withdrawBond } = require("../scripts/withdraw-bond");
    const [owner, arbiter, treasury, prov, stranger] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const vault = await (await ethers.getContractFactory("SuretyVault")).deploy(await usdc.getAddress(), owner.address, arbiter.address, treasury.address, usd(1), 7 * 86400, 500);
    const vaultAddress = await vault.getAddress();
    await usdc.mint(prov.address, usd(2));
    await usdc.connect(prov).approve(vaultAddress, usd(2));
    await vault.connect(prov).register("x");
    await vault.connect(prov).depositBond(usd(1.1));
    const chainNow = async () => await time.latest();
    const run = async (action, wallet = prov) => withdrawBond({ wallet, vaultAddress, action, log() {}, now: ((t) => () => t)(await chainNow()) }).then((p) => p, (e) => e.message);

    expect((await run()).bond).to.equal(usd(1.1)); // looking changes nothing
    expect(await run("complete")).to.contain("Nothing is queued");
    expect(await run("request", stranger)).to.contain("no listing");
    expect((await run("request")).bondPendingWithdraw).to.equal(usd(1.1));
    expect(await vault.isActive(prov.address)).to.equal(false);
    expect(await run("complete")).to.contain("Not yet");
    await time.increase(7 * 86400 + 1);
    const before = await usdc.balanceOf(prov.address);
    expect((await run("complete")).bond).to.equal(0n);
    expect((await usdc.balanceOf(prov.address)) - before).to.equal(usd(1.1));
    expect(await run("request")).to.contain("no bond left");
  });
});

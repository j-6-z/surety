const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("hardhat");
const { createRelay } = require("../verifier/relay");
const { createSuretyClient } = require("../sdk");
const { createPayingFetch } = require("../examples/x402-client");
const { startFakeFacilitator } = require("../examples/fake-facilitator");
const { createPriceReader, priceFromSqrt } = require("../marketdata/prices");
const { createMarketApi } = require("../marketdata/server");
const { matchEndpoint } = require("../verifier/sla");

const usd = (n) => ethers.parseUnits(String(n), 6);
const sqrtBig = (n) => {
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
};
/// sqrtPriceX96 for a pool where 1 MON (18 decimals) costs `usdPerMon` USDC (6 decimals).
function sqrtPriceFor(usdPerMon, usdcIsToken0) {
  const microUsdPerMon = BigInt(Math.round(usdPerMon * 1e6)); // raw USDC units per 1e18 raw MON
  const [num, den] = usdcIsToken0 ? [10n ** 18n, microUsdPerMon] : [microUsdPerMon, 10n ** 18n];
  return sqrtBig((num << 192n) / den);
}

describe("Market Data API", function () {
  this.timeout(60_000);

  describe("price maths", () => {
    it("turns sqrtPriceX96 into a price for either token order", () => {
      expect(priceFromSqrt(sqrtPriceFor(0.0325, false), 18, 6)).to.be.closeTo(0.0325, 1e-9); // USDC per MON
      expect(1 / priceFromSqrt(sqrtPriceFor(0.0325, true), 6, 18)).to.be.closeTo(0.0325, 1e-9);
      expect(priceFromSqrt(2n ** 96n, 18, 18)).to.equal(1);
    });

    it("SLA paths can cover a parameter", () => {
      const sla = { endpoints: [{ method: "GET", path: "/v1/pool/:address" }] };
      expect(matchEndpoint(sla, "GET", "/v1/pool/0xabc")).to.not.equal(null);
      expect(matchEndpoint(sla, "GET", "/v1/pool/0xabc/extra")).to.equal(null);
      expect(matchEndpoint(sla, "POST", "/v1/pool/0xabc")).to.equal(null);
    });
  });

  describe("on-chain reader", () => {
    let wmon, dataUsdc, factory, deep, reader;
    const mkPool = async (fee, usdPerMon, usdcDepth) => {
      const usdcIs0 = (await dataUsdc.getAddress()).toLowerCase() < (await wmon.getAddress()).toLowerCase();
      const pool = await (await ethers.getContractFactory("MockV3Pool")).deploy(
        await wmon.getAddress(), await dataUsdc.getAddress(), fee, sqrtPriceFor(usdPerMon, usdcIs0)
      );
      await dataUsdc.mint(await pool.getAddress(), usd(usdcDepth));
      await wmon.mint(await pool.getAddress(), ethers.parseEther("1000"));
      await factory.setPool(await wmon.getAddress(), await dataUsdc.getAddress(), fee, await pool.getAddress());
      return pool;
    };
    const mkReader = async (extra = {}) =>
      createPriceReader({
        provider: ethers.provider, cacheMs: 0,
        factories: [{ dex: "mock-v3", address: await factory.getAddress() }],
        wmon: await wmon.getAddress(), usdc: await dataUsdc.getAddress(), ...extra,
      });

    beforeEach(async () => {
      const T = await ethers.getContractFactory("MockToken");
      wmon = await T.deploy("Wrapped MON", "WMON", 18);
      dataUsdc = await T.deploy("USD Coin", "USDC", 6);
      factory = await (await ethers.getContractFactory("MockV3Factory")).deploy();
      reader = await mkReader();
    });

    it("prices MON from the deepest pool and ignores a thin one with a bad price", async () => {
      await mkPool(500, 9.99, 3); // thin and wrong
      deep = await mkPool(3000, 0.0325, 250_000);
      const p = await reader.monPrice();
      expect(p.priceUsd).to.be.closeTo(0.0325, 1e-7);
      expect(p.pool).to.equal(await deep.getAddress());
      expect(p.feeBps).to.equal(30);
      expect(p.poolUsdc).to.equal(250_000);
      expect(p.block).to.be.greaterThan(0);
    });

    it("refuses to quote when no pool is deep enough", async () => {
      await mkPool(500, 0.03, 3);
      const err = await reader.monPrice().then(() => null, (e) => e);
      expect(err.message).to.equal("no_liquid_pool");
      expect(err.status).to.equal(503);
      expect(err.detail.poolsFound).to.equal(1);
    });

    it("reads any pool by address", async () => {
      const pool = await mkPool(3000, 0.05, 10_000);
      const d = await reader.readPool(await pool.getAddress());
      expect([d.token0.symbol, d.token1.symbol].sort()).to.deep.equal(["USDC", "WMON"]);
      const usdcSide = d.token0.symbol === "USDC" ? d.token0 : d.token1;
      expect(usdcSide.reserve).to.equal(10_000);
      expect(d.token0.symbol === "USDC" ? d.price1In0 : d.price0In1).to.be.closeTo(0.05, 1e-7);
    });
  });

  describe("paid, through the relay, with the real x402 SDK", () => {
    let s;
    before(async () => {
      const [owner, arbiter, treasury, providerOp, payTo] = await ethers.getSigners();
      const T = await ethers.getContractFactory("MockToken");
      const wmon = await T.deploy("Wrapped MON", "WMON", 18);
      const dataUsdc = await T.deploy("USD Coin", "USDC", 6);
      const factory = await (await ethers.getContractFactory("MockV3Factory")).deploy();
      const usdcIs0 = (await dataUsdc.getAddress()).toLowerCase() < (await wmon.getAddress()).toLowerCase();
      const pool = await (await ethers.getContractFactory("MockV3Pool")).deploy(
        await wmon.getAddress(), await dataUsdc.getAddress(), 3000, sqrtPriceFor(0.0325, usdcIs0)
      );
      await dataUsdc.mint(await pool.getAddress(), usd(50_000));
      await factory.setPool(await wmon.getAddress(), await dataUsdc.getAddress(), 3000, await pool.getAddress());

      const payUsdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
      const payAddr = await payUsdc.getAddress();
      const vault = await (await ethers.getContractFactory("SuretyVault")).deploy(
        payAddr, owner.address, arbiter.address, treasury.address, usd(1), 7 * 86400, 500
      );
      const { chainId } = await ethers.provider.getNetwork();
      const network = `eip155:${chainId}`;
      const agent = ethers.Wallet.createRandom().connect(ethers.provider);
      await ethers.provider.send("hardhat_setBalance", [agent.address, "0x56BC75E2D63100000"]);
      await payUsdc.mint(agent.address, usd(10));
      await payUsdc.mint(providerOp.address, usd(10));
      const facilitator = await startFakeFacilitator({ usdc: payUsdc, network, wallets: { [agent.address.toLowerCase()]: agent } });

      const readerOpts = {
        provider: ethers.provider, cacheMs: 0, factories: [{ dex: "mock-v3", address: await factory.getAddress() }],
        wmon: await wmon.getAddress(), usdc: await dataUsdc.getAddress(),
      };
      const reader = createPriceReader(readerOpts);
      const api = createMarketApi({
        reader, network, usdc: payAddr, payTo: payTo.address, price: "$0.01",
        facilitatorUrl: `http://127.0.0.1:${facilitator.address().port}`,
      });
      const apiUrl = await api.listen();
      await payUsdc.connect(providerOp).approve(await vault.getAddress(), ethers.MaxUint256);
      await vault.connect(providerOp).register(api.slaUrl());
      await vault.connect(providerOp).depositBond(usd(5));
      const relay = createRelay({
        vaultAddress: await vault.getAddress(), usdcAddress: payAddr, signer: arbiter,
        dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "surety-api-")), allowInsecure: true,
      });
      await new Promise((r) => relay.listen(0, "127.0.0.1", r));
      const relayUrl = `http://127.0.0.1:${relay.address().port}`;
      const payingFetch = createPayingFetch(agent.privateKey, network, payAddr).fetch;
      s = { payUsdc, dataUsdc, vault, agent, pool, provider: providerOp.address, apiUrl, relayUrl, relay, api, facilitator,
        payingFetch, client: createSuretyClient({ relayUrl, fetch: payingFetch }) };
    });
    after(async () => {
      await new Promise((r) => s.relay.close(r));
      await s.api.close();
      await new Promise((r) => s.facilitator.close(r));
    });

    it("sells the MON price for one payment and passes its own SLA", async () => {
      const before = await s.payUsdc.balanceOf(s.agent.address);
      const r = await s.client.call(s.provider, "/v1/price/mon");
      const body = await r.response.json();
      expect(r.response.status).to.equal(200);
      expect(body.priceUsd).to.be.closeTo(0.0325, 1e-7);
      expect(body.source).to.equal("onchain");
      expect(r.verdict).to.equal("pass");
      expect(before - (await s.payUsdc.balanceOf(s.agent.address))).to.equal(usd(0.01));
    });

    it("sells any pool by address under one SLA entry", async () => {
      const r = await s.client.call(s.provider, `/v1/pool/${await s.pool.getAddress()}`);
      expect(r.verdict).to.equal("pass");
      expect((await r.response.json()).pool).to.equal(await s.pool.getAddress());
    });

    it("rejects a bad address before the paywall, so the caller isn't charged", async () => {
      const before = await s.payUsdc.balanceOf(s.agent.address);
      const res = await s.payingFetch(`${s.apiUrl}/v1/pool/not-an-address`);
      expect(res.status).to.equal(400);
      expect(await s.payUsdc.balanceOf(s.agent.address)).to.equal(before);
    });

    it("doesn't charge when it can't produce a price", async () => {
      const poolAddr = await s.pool.getAddress();
      await ethers.provider.send("hardhat_setStorageAt", [
        await s.dataUsdc.getAddress(),
        ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [poolAddr, 0])),
        ethers.ZeroHash,
      ]); // drain the pool's USDC
      const before = await s.payUsdc.balanceOf(s.agent.address);
      const r = await s.client.call(s.provider, "/v1/price/mon");
      expect(r.response.status).to.equal(503);
      expect((await r.response.json()).error).to.equal("no_liquid_pool");
      expect(await s.payUsdc.balanceOf(s.agent.address)).to.equal(before);
      expect(r.claim).to.equal(null);
    });

    it("free routes describe the API and its SLA", async () => {
      const info = await (await fetch(`${s.apiUrl}/`)).json();
      expect(info.endpoints).to.have.length(2);
      const sla = await (await fetch(`${s.apiUrl}/.well-known/surety.json`)).json();
      expect(sla.endpoints.map((e) => e.path)).to.deep.equal(["/v1/price/mon", "/v1/pool/:address"]);
    });
  });
});

describe("start.js: relay and API on one port", function () {
  this.timeout(60_000);

  it("registers itself, relays a paid call from a separate wallet, and runs the homepage demo", async () => {
    const { startSurety } = require("../start");
    const T = await ethers.getContractFactory("MockToken");
    const wmon = await T.deploy("Wrapped MON", "WMON", 18);
    const dataUsdc = await T.deploy("USD Coin", "USDC", 6);
    const factory = await (await ethers.getContractFactory("MockV3Factory")).deploy();
    const usdcIs0 = (await dataUsdc.getAddress()).toLowerCase() < (await wmon.getAddress()).toLowerCase();
    const pool = await (await ethers.getContractFactory("MockV3Pool")).deploy(
      await wmon.getAddress(), await dataUsdc.getAddress(), 3000, sqrtPriceFor(0.0117, usdcIs0)
    );
    await dataUsdc.mint(await pool.getAddress(), usd(68_000));
    await factory.setPool(await wmon.getAddress(), await dataUsdc.getAddress(), 3000, await pool.getAddress());

    const operator = ethers.Wallet.createRandom().connect(ethers.provider); // owner, arbiter and provider
    const agent = ethers.Wallet.createRandom().connect(ethers.provider); // a different wallet
    for (const w of [operator, agent]) await ethers.provider.send("hardhat_setBalance", [w.address, "0x56BC75E2D63100000"]);
    const payUsdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const payAddr = await payUsdc.getAddress();
    await payUsdc.mint(operator.address, usd(5));
    await payUsdc.mint(agent.address, usd(1));
    const vault = await (await ethers.getContractFactory("SuretyVault", operator)).deploy(
      payAddr, operator.address, operator.address, operator.address, usd(0.5), 7 * 86400, 500
    );
    const { chainId } = await ethers.provider.getNetwork();
    const network = `eip155:${chainId}`;
    const facilitator = await startFakeFacilitator({
      usdc: payUsdc, network,
      wallets: { [agent.address.toLowerCase()]: agent, [operator.address.toLowerCase()]: operator },
    });
    const lines = [];
    const s = await startSurety({
      wallet: operator, vaultAddress: await vault.getAddress(), usdcAddress: payAddr, network,
      facilitatorUrl: `http://127.0.0.1:${facilitator.address().port}`,
      reader: createPriceReader({
        provider: ethers.provider, cacheMs: 0, factories: [{ dex: "mock-v3", address: await factory.getAddress() }],
        wmon: await wmon.getAddress(), usdc: await dataUsdc.getAddress(),
      }),
      host: "127.0.0.1", allowInsecure: true, log: (m) => lines.push(m),
      demo: { slowMs: 300, promiseMs: 100, cooldownMs: { good: 60_000, slow: 60_000 } },
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "surety-start-")),
    });
    try {
      expect((await vault.providers(operator.address)).metadataURI).to.equal(`${s.url}/.well-known/surety.json`);
      expect(lines.join("\n")).to.contain("NOT ACTIVE"); // no bond yet
      expect((await (await fetch(`${s.url}/health`)).json()).ok).to.equal(true);
      expect((await (await fetch(`${s.url}/`)).json()).name).to.equal("Surety Market Data API");

      await payUsdc.connect(operator).approve(await vault.getAddress(), ethers.MaxUint256);
      await vault.connect(operator).depositBond(usd(1));
      const client = createSuretyClient({ relayUrl: s.url, fetch: createPayingFetch(agent.privateKey, network, payAddr).fetch });
      const before = await payUsdc.balanceOf(agent.address);
      const r = await client.call(s.provider, "/v1/price/mon");
      expect(r.verdict).to.equal("pass");
      expect((await r.response.json()).priceUsd).to.be.closeTo(0.0117, 1e-7);
      expect(before - (await payUsdc.balanceOf(agent.address))).to.equal(usd(0.001));
      expect(await payUsdc.balanceOf(s.payTo)).to.equal(usd(0.001)); // paid to a different address than the agent
      expect((await client.trust(s.provider)).active).to.equal(true);

      // The homepage demo: real paid calls made by the server's own wallet.
      const demo = async (kind) => {
        const res = await fetch(`${s.url}/demo/run?kind=${kind}`, { method: "POST" });
        return { http: res.status, ...(await res.json()) };
      };
      const good = await demo("good");
      expect(good.verdict).to.equal("pass");
      expect(good.data.priceUsd).to.be.closeTo(0.0117, 1e-7);
      expect(good.paymentTx).to.match(/^0x[0-9a-f]{64}$/);
      expect(good.refund).to.equal(null);

      const bondBefore = (await vault.providers(operator.address)).bond;
      const slow = await demo("slow");
      expect(slow.verdict).to.equal("fail");
      expect(slow.reason).to.equal("too_slow");
      expect(slow.promisedMs).to.equal(100);
      expect(slow.refund.payout).to.equal(usd(0.001).toString());
      expect(await vault.claimPaid(ethers.solidityPackedKeccak256(["uint256", "bytes32"], [chainId, slow.paymentTx]))).to.equal(true);
      expect(bondBefore - (await vault.providers(operator.address)).bond).to.equal(usd(0.00105)); // refund + 5% fee

      const again = await demo("slow"); // inside the cooldown: no second refund
      expect(again.replay).to.equal(true);
      expect(again.refund.tx).to.equal(slow.refund.tx);
      expect((await vault.providers(operator.address)).claimCount).to.equal(1n);
      expect((await demo("nope")).http).to.equal(400);
      const lastRuns = await (await fetch(`${s.url}/demo/last`)).json();
      expect(lastRuns.good.verdict).to.equal("pass");
      expect(lastRuns.slow.verdict).to.equal("fail");
      const t = await client.trust(s.provider);
      expect(t.calls).to.equal(2); // the agent's call and the good demo; the slow demo is not counted
      expect(t.passRate).to.equal(1);

      // Provider directory, and what an unknown address gets.
      const dir = await (await fetch(`${s.url}/providers.json`)).json();
      expect(dir.providers).to.have.length(1);
      expect(dir.providers[0].provider).to.equal(operator.address);
      expect(dir.providers[0].active).to.equal(true);
      expect(dir.providers[0].host).to.equal(new URL(s.url).host);
      expect(dir.providers[0].endpoints.map((e) => e.path)).to.deep.equal(["/v1/price/mon", "/v1/pool/:address"]); // demo endpoint left out
      const dirPage = await fetch(`${s.url}/providers/`, { headers: { accept: "text/html" } });
      expect(dirPage.status).to.equal(200);
      expect(await dirPage.text()).to.contain("Provider directory").and.to.contain('aria-current="page"');
      // Self-serve bonding: a brand-new provider lists and bonds using only what the page's server routes return.
      const j = async (p) => { const r = await fetch(s.url + p); return { http: r.status, ...(await r.json()) }; };
      const bondHtml = await fetch(`${s.url}/bond/`, { headers: { accept: "text/html" } });
      expect(await bondHtml.text()).to.contain("Bond your API").and.to.contain(await vault.getAddress());
      const slaUrl = `${s.url}/.well-known/surety.json`;
      const check = await j(`/bond/sla-check?url=${encodeURIComponent(slaUrl)}`);
      expect(check.ok).to.equal(true);
      expect(check.endpoints[0]).to.deep.include({ method: "GET", path: "/v1/price/mon", checksShape: true });
      expect((await j(`/bond/sla-check?url=${encodeURIComponent(s.url + "/health")}`)).ok).to.equal(false); // JSON, but not an SLA
      expect((await j("/bond/sla-check?url=ftp://x")).ok).to.equal(false);
      expect((await j("/bond/tx?kind=deposit&amount=1.5")).http).to.equal(400);
      expect((await j("/bond/tx?kind=register&url=javascript:alert(1)")).http).to.equal(400);
      expect((await j("/bond/tx?kind=drain")).http).to.equal(400);
      expect((await j("/bond/account?address=nope")).http).to.equal(400);

      const newcomer = ethers.Wallet.createRandom().connect(ethers.provider);
      await ethers.provider.send("hardhat_setBalance", [newcomer.address, "0x56BC75E2D63100000"]);
      await payUsdc.mint(newcomer.address, usd(2));
      const fresh = await j(`/bond/account?address=${newcomer.address}`);
      expect(fresh).to.include({ registered: false, active: false, usdcBalance: usd(2).toString(), minBond: usd(0.5).toString() });
      const sign = async (path) => {
        const tx = await j(path);
        expect(tx.ok, path).to.equal(true);
        await (await newcomer.sendTransaction({ to: tx.to, data: tx.data })).wait(); // what the wallet does in the browser
        return tx;
      };
      await sign(`/bond/tx?kind=register&url=${encodeURIComponent(slaUrl)}`);
      const approve = await sign(`/bond/tx?kind=approve&amount=${usd(0.6)}`);
      expect(approve.to).to.equal(payAddr); // the approval goes to the token, for exactly the amount asked
      expect(await payUsdc.allowance(newcomer.address, await vault.getAddress())).to.equal(usd(0.6));
      await sign(`/bond/tx?kind=deposit&amount=${usd(0.6)}`);
      const afterBond = await j(`/bond/account?address=${newcomer.address}`);
      expect(afterBond).to.include({ registered: true, active: true, bond: usd(0.6).toString(), metadataURI: slaUrl });
      const dir2 = await j("/providers.json");
      expect(dir2.providers.map((p) => p.provider)).to.include(newcomer.address); // shows up in the directory
      await sign(`/bond/tx?kind=withdraw&amount=${usd(0.2)}`);
      expect((await j(`/bond/account?address=${newcomer.address}`)).active).to.equal(false); // queued exit drops coverage at once
      await sign("/bond/tx?kind=cancelWithdraw");
      expect((await j(`/bond/account?address=${newcomer.address}`)).active).to.equal(true);

      const missing = await fetch(`${s.url}/no-such-page`, { headers: { accept: "text/html" } });
      expect(missing.status).to.equal(404);
      expect(await missing.text()).to.contain("That page doesn't exist.");
      const missingJson = await fetch(`${s.url}/no-such-page`, { headers: { accept: "application/json" } });
      expect(missingJson.status).to.equal(404);
      expect((await missingJson.json()).error).to.equal("not_found");
    } finally {
      await s.close();
      await new Promise((r) => facilitator.close(r));
    }
  });
});

describe("app.js (Vercel entry point)", () => {
  const load = (env) => {
    const saved = { ...process.env };
    for (const k of ["PRIVATE_KEY", "VAULT_ADDRESS", "PUBLIC_URL", "VERCEL", "VERCEL_URL", "VERCEL_PROJECT_PRODUCTION_URL"]) delete process.env[k];
    Object.assign(process.env, env);
    // A developer's own .env (hardhat loads it) must not decide what this test sees.
    for (const k of ["SURETY_NETWORK", "ARBITER_KEY", "PROVIDER_ADDRESS", "PAY_TO_ADDRESS", "DEMO_KEY", "USDC_ADDRESS", "RPC_URL", "EXPLORER_URL"]) {
      if (!(k in env)) delete process.env[k];
    }
    delete require.cache[require.resolve("../app")];
    try {
      return require("../app");
    } finally {
      process.env = saved;
    }
  };
  const serve = async (app, pathname) => {
    const server = require("http").createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`);
      return { status: res.status, body: await res.json() };
    } finally {
      await new Promise((r) => server.close(r));
    }
  };

  it("explains itself instead of crashing when settings are missing", async () => {
    const r = await serve(load({}), "/health");
    expect(r.status).to.equal(500);
    expect(r.body.error).to.equal("surety_not_configured");
  });

  it("exports a working app when configured, with the SLA at the public address", async () => {
    const app = load({
      PRIVATE_KEY: ethers.Wallet.createRandom().privateKey, VAULT_ADDRESS: ethers.Wallet.createRandom().address,
      PUBLIC_URL: "https://surety.example/", VERCEL: "1",
    });
    expect((await serve(app, "/health")).body.ok).to.equal(true);
    const sla = (await serve(app, "/.well-known/surety.json")).body;
    expect(sla.baseUrl).to.equal("https://surety.example");
    expect((await serve(app, "/trust/not-an-address")).status).to.equal(400); // relay routes are mounted
  });
});

describe("homepage", () => {
  it("gives browsers a page and agents JSON from the same address", async () => {
    const { buildSuretyApp } = require("../start");
    const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
    const vaultAddress = ethers.Wallet.createRandom().address;
    const { app } = buildSuretyApp({
      wallet, vaultAddress, usdcAddress: ethers.ZeroAddress, network: "eip155:31337",
      facilitatorUrl: "http://127.0.0.1:9", reader: {}, publicUrl: "https://surety.example", dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "surety-home-")),
    });
    const server = require("http").createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}/`;
    try {
      const html = await fetch(base, { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } });
      expect(html.headers.get("content-type")).to.contain("text/html");
      const page = await html.text();
      expect(page).to.contain("Refunds for AI agents when a paid API fails.");
      expect(page).to.contain(wallet.address).and.to.contain(vaultAddress);
      expect(page).to.contain(`/trust/${wallet.address}`);
      expect(page).to.not.contain("undefined");
      const json = await fetch(base, { headers: { accept: "application/json" } });
      expect((await json.json()).name).to.equal("Surety Market Data API");
      expect((await (await fetch(base)).json()).endpoints).to.have.length(2); // no Accept header: JSON
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("site generator and scheduled publishing", () => {
  const { build } = require("../scripts/generate");
  const { createCronPublish } = require("../site/cron");
  const md = (title, date, extra = "") => `---\ntitle: ${title}\ndescription: About ${title}.\ndate: ${date}\n${extra}---\n\n## Heading\n\nBody of ${title} with a [link](/#demo).\n`;

  it("builds article pages with search tags, a list, sitemap, feed and robots; holds back drafts and future dates", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surety-gen-"));
    const src = path.join(dir, "content"), out = path.join(dir, "public"), scheduleFile = path.join(dir, "schedule.json");
    const pagesSrc = path.join(dir, "pages");
    fs.mkdirSync(src);
    fs.mkdirSync(pagesSrc);
    fs.writeFileSync(path.join(pagesSrc, "faq.md"), "---\ntitle: Questions\ndescription: Answers.\nnav: faq\ntype: faq\n---\n\n## Is it real?\n\nNo, it is a **test**.\n\n## Who runs it?\n\nOne person.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    fs.writeFileSync(path.join(src, "older-post.md"), md("Older post", "2026-01-05"));
    fs.writeFileSync(path.join(src, "newer-post.md"), md("Newer <post> & more", "2026-02-10"));
    fs.writeFileSync(path.join(src, "a-draft.md"), md("A draft", "2026-02-01", "draft: true\n"));
    fs.writeFileSync(path.join(src, "next-month.md"), md("Next month", "2026-03-20"));
    fs.mkdirSync(path.join(out, "articles", "deleted-post"), { recursive: true }); // stale output from a removed article
    fs.writeFileSync(path.join(out, "articles", "deleted-post", "index.html"), "old");

    const r = build({ src, out, scheduleFile, pagesSrc, today: "2026-02-15", log: () => {} });
    const faq = fs.readFileSync(path.join(out, "faq", "index.html"), "utf8");
    expect(faq).to.contain('"@type":"FAQPage"').and.to.contain('"name":"Is it real?"').and.to.contain('"text":"No, it is a test."');
    expect(faq).to.contain('<div class="tbl"><table>'); // wide tables scroll inside their own box on phones
    expect(faq).to.contain('href="/faq/"').and.to.contain('href="/bond/"'); // shared nav and footer
    expect(fs.readFileSync(path.join(out, "sitemap.xml"), "utf8")).to.contain("<loc>https://www.surety.buzz/faq/</loc>");
    expect(r.published.map((a) => a.slug)).to.deep.equal(["newer-post", "older-post"]); // newest first
    expect(r.scheduled).to.deep.equal([{ slug: "next-month", date: "2026-03-20" }]);
    expect(JSON.parse(fs.readFileSync(scheduleFile, "utf8")).scheduled).to.have.length(1);
    for (const gone of ["a-draft", "next-month", "deleted-post"]) {
      expect(fs.existsSync(path.join(out, "articles", gone)), gone).to.equal(false);
    }

    const page = fs.readFileSync(path.join(out, "articles", "newer-post", "index.html"), "utf8");
    expect(page).to.contain("<title>Newer &lt;post&gt; &amp; more | Surety</title>"); // escaped
    expect(page).to.contain('<link rel="canonical" href="https://www.surety.buzz/articles/newer-post/">');
    expect(page).to.contain('property="og:type" content="article"').and.to.contain('"@type":"Article"');
    expect(page).to.contain('<nav class="site"').and.to.contain('<footer class="site"');
    expect(page).to.contain('<h2 id="heading">Heading</h2>').and.to.contain("Keep reading"); // headings are linkable
    expect(page).to.not.contain("undefined");

    const list = fs.readFileSync(path.join(out, "articles", "index.html"), "utf8");
    expect(list.indexOf("Newer")).to.be.lessThan(list.indexOf("Older post"));
    const map = fs.readFileSync(path.join(out, "sitemap.xml"), "utf8");
    expect(map).to.contain("<loc>https://www.surety.buzz/</loc>").and.to.contain("/articles/older-post/");
    expect(map).to.not.contain("next-month");
    expect(fs.readFileSync(path.join(out, "rss.xml"), "utf8")).to.contain("<title>Newer &lt;post&gt; &amp; more</title>");
    expect(fs.readFileSync(path.join(out, "robots.txt"), "utf8")).to.contain("Sitemap: https://www.surety.buzz/sitemap.xml");
  });

  it("rejects an article with a bad header instead of publishing it broken", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surety-gen-bad-"));
    const src = path.join(dir, "content");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "no-date.md"), "---\ntitle: T\ndescription: D\n---\nbody");
    const opts = { out: path.join(dir, "public"), scheduleFile: path.join(dir, "s.json"), pagesSrc: path.join(dir, "pages"), log: () => {} };
    expect(() => build({ src, ...opts })).to.throw(/needs "date"/);
    fs.rmSync(path.join(src, "no-date.md"));
    fs.mkdirSync(opts.pagesSrc);
    fs.writeFileSync(path.join(opts.pagesSrc, "providers.md"), "---\ntitle: T\ndescription: D\n---\nbody");
    expect(() => build({ src, ...opts })).to.throw(/already in use/); // a page can't shadow a live route
  });

  it("the daily job rebuilds only when an article is due, and only for the real scheduler", async () => {
    const call = async (opts, auth) => {
      let out;
      const res = { status(c) { out = { status: c }; return this; }, set() { return this; }, json(b) { out.body = b; } };
      await createCronPublish(opts)({ headers: auth ? { authorization: auth } : {} }, res);
      return out;
    };
    const schedule = { scheduled: [{ slug: "next-month", date: "2026-03-20" }] };
    const hits = [];
    const hook = async (url, init) => { hits.push([url, init.method]); return { ok: true, status: 201 }; };
    const env = { CRON_SECRET: "s3cret", DEPLOY_HOOK_URL: "https://hook.example/x" };

    expect((await call({ schedule, env: {}, fetch: hook })).status).to.equal(503); // not configured
    expect((await call({ schedule, env, fetch: hook }, "Bearer wrong")).status).to.equal(401);
    const early = await call({ schedule, env, fetch: hook, today: () => "2026-03-19" }, "Bearer s3cret");
    expect(early.body).to.deep.equal({ ok: true, due: 0, waiting: 1 });
    expect(hits).to.have.length(0);
    const onDay = await call({ schedule, env, fetch: hook, today: () => "2026-03-20" }, "Bearer s3cret");
    expect(onDay.body.rebuilding).to.equal(true);
    expect(hits).to.deep.equal([["https://hook.example/x", "POST"]]);
    const noHook = await call({ schedule, env: { CRON_SECRET: "s3cret" }, fetch: hook, today: () => "2026-03-20" }, "Bearer s3cret");
    expect(noHook.status).to.equal(500);
  });
});

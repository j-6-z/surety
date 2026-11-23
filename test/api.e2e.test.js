const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("hardhat");
const { createRelay } = require("../verifier/relay");
const { createSuretyClient } = require("../sdk");
const { createPayingFetch } = require("../examples/x402-client");
const { startFakeFacilitator } = require("../examples/fake-facilitator");
const { createPriceReader, priceFromSqrt } = require("../api/prices");
const { createMarketApi } = require("../api/server");
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

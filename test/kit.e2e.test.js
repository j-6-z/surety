// The provider kit, end to end: a newcomer builds an API with kit/surety.js,
// bonds it with kit/bond.js against a Surety server, and is covered by the relay.
const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const { ethers } = require("hardhat");
const { createRelay } = require("../verifier/relay");
const { validateSlaDoc } = require("../verifier/sla");
const { createBondApi } = require("../site/bond-api");
const { startFakeFacilitator } = require("../examples/fake-facilitator");
const { createBondedApi } = require("../kit/surety");
const { bond } = require("../kit/bond");
const { tryCall } = require("../kit/try");
const { check } = require("../kit/check");

const usd = (n) => ethers.parseUnits(String(n), 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("Provider kit", function () {
  this.timeout(60_000);
  let s;

  before(async () => {
    const [owner, arbiter, treasury, newcomer, payTo] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const usdcAddr = await usdc.getAddress();
    const vault = await (await ethers.getContractFactory("SuretyVault")).deploy(
      usdcAddr, owner.address, arbiter.address, treasury.address, usd(0.5), 7 * 86400, 500
    );
    const vaultAddr = await vault.getAddress();
    const { chainId } = await ethers.provider.getNetwork();
    const network = `eip155:${chainId}`;

    const agent = ethers.Wallet.createRandom().connect(ethers.provider);
    await ethers.provider.send("hardhat_setBalance", [agent.address, "0x56BC75E2D63100000"]);
    await usdc.mint(agent.address, usd(10));
    await usdc.mint(newcomer.address, usd(3));
    const facilitator = await startFakeFacilitator({ usdc, network, wallets: { [agent.address.toLowerCase()]: agent } });

    // The newcomer's API, written the way kit/app.js is.
    const api = createBondedApi({
      name: "Test API", settleReserveMs: 300, payTo: payTo.address, network, usdc: usdcAddr, price: "$0.01",
      facilitatorUrl: `http://127.0.0.1:${facilitator.address().port}`,
      endpoints: [
        { path: "/v1/shout/:word", maxLatencyMs: 5000,
          responseSchema: { type: "object", required: ["shout"], properties: { shout: { type: "string" } } },
          validate: (req) => (/^[a-z]+$/i.test(req.params.word) ? null : "letters only"),
          handler: (req) => ({ shout: req.params.word.toUpperCase() }) },
        { path: "/v1/slow", maxLatencyMs: 200, price: "$0.02", handler: async () => (await sleep(500), { late: true }) },
        { path: "/v1/wrong", maxLatencyMs: 5000, responseSchema: { type: "object", required: ["shout"] }, handler: () => ({ nope: 1 }) },
        { path: "/v1/guarded", maxLatencyMs: 500, handler: async () => (await sleep(450), { late: true }) }, // gives up at 200 ms
        { path: "/v1/down", maxLatencyMs: 5000, handler: () => { throw new Error("database is gone"); } },
      ],
    });
    const apiUrl = await api.listen();

    // The Surety server: the relay plus the bonding routes bond.js talks to.
    const relay = createRelay({
      vaultAddress: vaultAddr, usdcAddress: usdcAddr, signer: arbiter,
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "surety-kit-")), allowInsecure: true,
    });
    const bondApi = createBondApi({ provider: ethers.provider, vaultAddress: vaultAddr, usdcAddress: usdcAddr, chainId: Number(chainId), allowInsecure: true });
    const site = express();
    site.use((req, res, next) => (req.url.startsWith("/call/") || req.url.startsWith("/trust/") ? relay.handle(req, res) : next()));
    site.get("/bond/sla-check", bondApi.slaCheck);
    site.get("/bond/account", bondApi.account);
    const server = await new Promise((r) => { const h = site.listen(0, "127.0.0.1", () => r(h)); });
    const suretyUrl = `http://127.0.0.1:${server.address().port}`;
    const call = (p) => tryCall({ suretyUrl, provider: newcomer.address, path: p, privateKey: agent.privateKey, network, usdc: usdcAddr });
    s = { usdc, vault, vaultAddr, agent, newcomer, payTo, api, apiUrl, facilitator, server, suretyUrl, call };
  });

  after(async () => {
    await s.api.close();
    await new Promise((r) => s.server.close(r));
    await new Promise((r) => s.facilitator.close(r));
  });

  it("stands alone: nothing in kit/ reaches outside its own folder", () => {
    const dir = path.join(__dirname, "..", "kit");
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
      expect(fs.readFileSync(path.join(dir, f), "utf8"), f).to.not.match(/require\(["']\.\.\//);
    }
    const deps = Object.keys(require("../kit/package.json").dependencies);
    for (const f of ["surety.js", "bond.js", "try.js", "app.js", "check.js"]) {
      for (const m of fs.readFileSync(path.join(dir, f), "utf8").matchAll(/require\(["']([^."'][^"']*)["']\)/g)) {
        const pkg = m[1].startsWith("@") ? m[1].split("/").slice(0, 2).join("/") : m[1].split("/")[0];
        expect(deps, `${f} needs ${pkg}`).to.include(pkg);
      }
    }
  });

  it("publishes an SLA document the relay accepts", async () => {
    const doc = await (await fetch(s.api.slaUrl())).json();
    const sla = validateSlaDoc(doc);
    expect(sla.baseUrl).to.equal(s.apiUrl);
    expect(sla.payTo).to.equal(s.payTo.address);
    expect(sla.endpoints.map((e) => e.path)).to.deep.equal(["/v1/shout/:word", "/v1/slow", "/v1/wrong", "/v1/guarded", "/v1/down"]);
    expect(sla.endpoints[1].responseSchema).to.equal(undefined);
  });

  it("refuses a badly described endpoint at startup, in plain words", () => {
    const base = { payTo: s.payTo.address };
    const mk = (e) => () => createBondedApi({ ...base, endpoints: [e] });
    expect(mk({ path: "v1/x", maxLatencyMs: 1, handler() {} })).to.throw('path must start with "/"');
    expect(mk({ path: "/v1/x", handler() {} })).to.throw("maxLatencyMs");
    expect(mk({ path: "/v1/x", maxLatencyMs: 100 })).to.throw("handler");
    expect(mk({ path: "/health", maxLatencyMs: 100, handler() {} })).to.throw("reserved");
    expect(() => createBondedApi({ payTo: "nope", endpoints: [] })).to.throw("PAY_TO_ADDRESS");
    const twice = { path: "/a", maxLatencyMs: 1, handler() {} };
    expect(() => createBondedApi({ ...base, endpoints: [twice, twice] })).to.throw("listed twice");
  });

  it("is paywalled, and rejects bad input before asking for money", async () => {
    expect((await fetch(`${s.apiUrl}/v1/shout/hello`)).status).to.equal(402);
    const bad = await fetch(`${s.apiUrl}/v1/shout/123`);
    expect(bad.status).to.equal(400);
    expect(await bad.json()).to.deep.equal({ error: "letters only" });
    expect((await fetch(`${s.apiUrl}/health`)).status).to.equal(200);
    expect((await fetch(`${s.apiUrl}/nothing`)).status).to.equal(404);
  });

  it("is not covered before bonding", async () => {
    const r = await s.call("/v1/shout/hello");
    expect(r.status).to.not.equal(200); // not listed on the vault yet, so the relay will not carry the call
    expect(r.verdict).to.not.equal("pass");
  });

  it("bond.js lists the API and posts the minimum bond, approving only what it needs", async () => {
    const lines = [];
    const out = await bond({ url: s.apiUrl, wallet: s.newcomer, suretyUrl: s.suretyUrl, vaultAddress: s.vaultAddr, log: (m) => lines.push(m) });
    expect(out.active).to.equal(true);
    expect(out.bond).to.equal(usd(0.5));
    const p = await s.vault.providers(s.newcomer.address);
    expect(p.metadataURI).to.equal(s.api.slaUrl());
    expect(await s.usdc.allowance(s.newcomer.address, s.vaultAddr)).to.equal(0n);
    expect(lines.join("\n")).to.contain("ACTIVE: your paid calls are covered").and.to.contain(`/call/${s.newcomer.address}/v1/shout/:word`);
  });

  it("running it again changes nothing, and a bigger target tops the bond up", async () => {
    const lines = [];
    await bond({ url: s.apiUrl, wallet: s.newcomer, suretyUrl: s.suretyUrl, log: (m) => lines.push(m) });
    expect(lines.join("\n")).to.contain("Already listed");
    expect((await s.vault.providers(s.newcomer.address)).bond).to.equal(usd(0.5));
    await bond({ url: s.apiUrl, wallet: s.newcomer, suretyUrl: s.suretyUrl, amount: "2", log() {} });
    expect((await s.vault.providers(s.newcomer.address)).bond).to.equal(usd(2));
  });

  it("stops with a clear reason instead of sending a bad transaction", async () => {
    const run = (o) => bond({ url: s.apiUrl, wallet: s.newcomer, suretyUrl: s.suretyUrl, log() {}, ...o }).then(() => "ran", (e) => e.message);
    expect(await run({ amount: "0.1" })).to.contain("minimum bond is 0.5");
    expect(await run({ amount: "500" })).to.contain("more USDC");
    expect(await run({ url: s.apiUrl.replace("127.0.0.1", "localhost") })).to.contain("thinks its address is");
    expect(await run({ vaultAddress: s.payTo.address })).to.contain("Stopping");
    expect(await run({ url: "" })).to.contain("public address");
  });

  it("a good paid call passes and the provider is paid", async () => {
    const before = await s.usdc.balanceOf(s.payTo.address);
    const r = await s.call("/v1/shout/hello");
    expect(r.status).to.equal(200);
    expect(JSON.parse(r.body)).to.deep.equal({ shout: "HELLO" });
    expect(r.verdict).to.equal("pass");
    expect((await s.usdc.balanceOf(s.payTo.address)) - before).to.equal(usd(0.01));
  });

  it("a slow call is refunded from the newcomer's bond, at that endpoint's own price", async () => {
    const [agentBefore, bondBefore] = [await s.usdc.balanceOf(s.agent.address), (await s.vault.providers(s.newcomer.address)).bond];
    const r = await s.call("/v1/slow");
    expect(r.verdict).to.equal("fail");
    expect(r.reason).to.equal("too_slow");
    expect(r.claim).to.equal("paid");
    expect(await s.usdc.balanceOf(s.agent.address)).to.equal(agentBefore);
    expect(bondBefore - (await s.vault.providers(s.newcomer.address)).bond).to.equal(usd(0.021)); // refund + 5% fee
  });

  it("a wrong-shape answer is refunded too", async () => {
    const before = await s.usdc.balanceOf(s.agent.address);
    const r = await s.call("/v1/wrong");
    expect(r.reason).to.equal("schema_mismatch");
    expect(await s.usdc.balanceOf(s.agent.address)).to.equal(before);
  });

  it("a handler that would run late gives up early, so nobody is charged and the bond is untouched", async () => {
    const [agentBefore, bondBefore] = [await s.usdc.balanceOf(s.agent.address), (await s.vault.providers(s.newcomer.address)).bond];
    const r = await s.call("/v1/guarded");
    expect(r.status).to.equal(504);
    expect(JSON.parse(r.body)).to.deep.equal({ error: "too_slow_not_charged" });
    expect(r.latencyMs).to.be.below(450);
    expect(await s.usdc.balanceOf(s.agent.address)).to.equal(agentBefore);
    expect((await s.vault.providers(s.newcomer.address)).bond).to.equal(bondBefore);
  });

  it("the SLA document can be cached by the relay and by browsers", async () => {
    expect((await fetch(s.api.slaUrl())).headers.get("cache-control")).to.contain("max-age=60");
  });

  it("npm run check finds the endpoints that would cost refunds, without any payment", async () => {
    const before = await s.usdc.balanceOf(s.agent.address);
    const r = Object.fromEntries((await check(s.api, { runs: 2 })).map((x) => [x.endpoint.split(" ")[1], x]));
    expect(r["/v1/shout/:word"].note).to.contain("example"); // a :parameter path needs an example to try
    expect(r["/v1/slow"]).to.include({ ok: true, level: "tight" }); // promise shorter than settlement
    expect(r["/v1/wrong"].note).to.contain("does not match responseSchema");
    expect(r["/v1/guarded"].note).to.contain("gives up");
    expect(r["/v1/down"].note).to.contain("database is gone"); // shown to the owner, never to callers
    expect(await s.usdc.balanceOf(s.agent.address)).to.equal(before);

    const good = createBondedApi({ payTo: s.payTo.address, endpoints: [
      { path: "/v1/shout/:word", example: "/v1/shout/hello?loud=1", maxLatencyMs: 4000,
        responseSchema: { type: "object", required: ["shout"] },
        validate: (req) => (req.query.loud ? null : "loud is required"),
        handler: (req) => ({ shout: req.params.word.toUpperCase() }) },
      { path: "/v1/busy", maxLatencyMs: 2100, handler: async () => (await sleep(80), {}) }, // 80 of 100 ms
    ] });
    const [fine, busy] = await check(good, { runs: 2 });
    expect(fine).to.include({ ok: true, level: "ok", budgetMs: 2000 });
    expect(busy).to.include({ ok: true, level: "tight" });
  });

  it("the starter app.js passes its own shape checks", () => {
    process.env.PAY_TO_ADDRESS = s.payTo.address;
    const starter = require("../kit/app").api;
    expect(starter.endpoints.map((e) => e.path)).to.deep.equal(["/v1/block", "/v1/shout/:word"]);
    expect(() => validateSlaDoc({ ...starter.sla(), baseUrl: "https://x.example" })).to.not.throw();
    expect(starter.endpoints.every((e) => e.deadlineMs === 2000)).to.equal(true);
  });

  it("a handler that throws charges nobody", async () => {
    const before = await s.usdc.balanceOf(s.agent.address);
    const r = await s.call("/v1/down");
    expect(r.status).to.equal(502);
    expect(JSON.parse(r.body)).to.deep.equal({ error: "upstream_error" }); // the real error message stays private
    expect(await s.usdc.balanceOf(s.agent.address)).to.equal(before);
  });
});

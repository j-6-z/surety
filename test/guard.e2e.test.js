// Surety Guard under the REAL x402 client: every limit is checked against the
// payment the client actually signed, before it leaves the process.
const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("hardhat");
const { createRelay } = require("../verifier/relay");
const { createSuretyClient, createGuard, SuretyGuardError } = require("../sdk");
const { toAtomic, toUsdc } = require("../sdk/guard");
const { createBondedApi } = require("../kit/surety");
const { createPayingFetch } = require("../examples/x402-client");
const { startFakeFacilitator } = require("../examples/fake-facilitator");

const usd = (n) => ethers.parseUnits(String(n), 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("Surety Guard (spending limits)", function () {
  this.timeout(60_000);
  let s;

  before(async () => {
    const [owner, arbiter, treasury, good, unbonded, payTo] = await ethers.getSigners();
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
    await usdc.mint(good.address, usd(10));
    const facilitator = await startFakeFacilitator({ usdc, network, wallets: { [agent.address.toLowerCase()]: agent } });

    const api = createBondedApi({
      payTo: payTo.address, network, usdc: usdcAddr, price: "$0.01", settleReserveMs: 0,
      facilitatorUrl: `http://127.0.0.1:${facilitator.address().port}`,
      endpoints: [
        { path: "/cheap", maxLatencyMs: 5000, handler: () => ({ ok: true }) },
        { path: "/pricey", price: "$0.50", maxLatencyMs: 5000, handler: () => ({ ok: true }) },
        { path: "/slow", maxLatencyMs: 150, guard: false, handler: async () => (await sleep(400), { ok: true }) },
        { path: "/down", maxLatencyMs: 5000, handler: () => { throw new Error("x"); } },
      ],
    });
    await api.listen();
    for (const p of [good, unbonded]) await vault.connect(p).register(api.slaUrl());
    await usdc.connect(good).approve(await vault.getAddress(), ethers.MaxUint256);
    await vault.connect(good).depositBond(usd(5));

    const relay = createRelay({
      vaultAddress: await vault.getAddress(), usdcAddress: usdcAddr, signer: arbiter,
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "surety-guard-")), allowInsecure: true,
    });
    await new Promise((r) => relay.listen(0, "127.0.0.1", r));
    const relayUrl = `http://127.0.0.1:${relay.address().port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surety-guardlog-"));

    /// An agent wired the documented way: guard under the x402 payer, Surety client on top.
    const agentWith = (limits) => {
      const guard = createGuard({ relayUrl, token: usdcAddr, ...limits });
      const pay = createPayingFetch(agent.privateKey, network, usdcAddr, "1000000", guard.fetch);
      return { guard, pay: pay.fetch, surety: createSuretyClient({ relayUrl, fetch: pay.fetch }) };
    };
    const blocked = (p) => p.then(() => { throw new Error("was not blocked"); }, (e) => (expect(e).to.be.instanceOf(SuretyGuardError), e));
    const balance = () => usdc.balanceOf(agent.address);
    s = { usdc, agent, good: good.address, unbonded: unbonded.address, relay, api, facilitator, relayUrl, dir, agentWith, blocked, balance, usdcAddr, network };
  });

  after(async () => {
    await new Promise((r) => s.relay.close(r));
    await s.api.close();
    await new Promise((r) => s.facilitator.close(r));
  });

  it("converts amounts exactly", () => {
    expect(toAtomic("0.01")).to.equal(10000n);
    expect(toAtomic(1)).to.equal(1000000n);
    expect(toUsdc(10500n)).to.equal("0.0105");
    expect(toUsdc(2000000n)).to.equal("2");
    expect(toUsdc(0n)).to.equal("0");
    expect(() => toAtomic("1e3", "x")).to.throw("USDC amount");
    expect(() => toAtomic("-1", "x")).to.throw("USDC amount");
    expect(() => createGuard({ relayUrl: s.relayUrl, providers: ["nope"] })).to.throw("not an address");
  });

  it("lets a call inside every limit through, and logs it", async () => {
    const a = s.agentWith({ maxPerCall: "0.05", dailyBudget: "1", logFile: path.join(s.dir, "ok.jsonl") });
    const before = await s.balance();
    const r = await a.surety.call(s.good, "/cheap");
    expect(r.verdict).to.equal("pass");
    expect(before - (await s.balance())).to.equal(usd(0.01));
    expect(a.guard.spentToday()).to.equal("0.01");
    expect(a.guard.remainingToday()).to.equal("0.99");
    const [entry] = a.guard.log();
    expect(entry).to.include({ provider: s.good, path: "/cheap", paid: "0.01", verdict: "pass" });
    expect(entry.paymentTx).to.match(/^0x[0-9a-f]{64}$/);
    expect(JSON.parse(fs.readFileSync(path.join(s.dir, "ok.jsonl"), "utf8").trim())).to.deep.equal(entry);
  });

  it("blocks a call over the per-call cap before any money moves", async () => {
    const a = s.agentWith({ maxPerCall: "0.05" });
    const before = await s.balance();
    const e = await s.blocked(a.surety.call(s.good, "/pricey"));
    expect(e.code).to.equal("over_call_cap");
    expect(e.message).to.contain("costs 0.5 USDC").and.to.contain("limit per call is 0.05");
    expect(await s.balance()).to.equal(before);
    expect(a.guard.log()[0]).to.include({ blocked: "over_call_cap", amount: "0.5" });
    expect(a.guard.spentToday()).to.equal("0");
  });

  it("stops a runaway loop at the daily budget, then opens again the next day", async () => {
    let clock = Date.parse("2026-11-24T23:59:00Z");
    const a = s.agentWith({ dailyBudget: "0.03", now: () => clock });
    const before = await s.balance();
    let paid = 0, stop = null;
    for (let i = 0; i < 10 && !stop; i++) {
      await a.surety.call(s.good, "/cheap").then(() => paid++, (e) => (stop = e));
    }
    expect(paid).to.equal(3);
    expect(stop.code).to.equal("over_daily_budget");
    expect(stop.message).to.contain("only 0 of today's 0.03 is left");
    expect(before - (await s.balance())).to.equal(usd(0.03));
    expect(a.guard.remainingToday()).to.equal("0");
    clock += 2 * 60_000; // past midnight UTC
    expect(a.guard.remainingToday()).to.equal("0.03");
    expect((await a.surety.call(s.good, "/cheap")).verdict).to.equal("pass");
  });

  it("does not let parallel calls slip past the budget together", async () => {
    // A stand-in provider that settles every payment after a pause, so all six calls are in flight at once.
    let sent = 0;
    const slowSettle = async (req) => {
      if (String(req.url || req).includes("/trust/")) return Response.json({ active: true, score: 50 });
      sent++;
      await sleep(60);
      return new Response("{}", { headers: { "payment-response": Buffer.from(JSON.stringify({ success: true, transaction: "0x" + "ab".repeat(32) })).toString("base64") } });
    };
    const guard = createGuard({ relayUrl: s.relayUrl, token: s.usdcAddr, dailyBudget: "0.02", fetch: slowSettle });
    const payment = Buffer.from(JSON.stringify({ accepted: { asset: s.usdcAddr }, payload: { authorization: { to: s.good, value: "10000" } } })).toString("base64");
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => guard.fetch(`${s.relayUrl}/call/${s.good}/cheap`, { headers: { "PAYMENT-SIGNATURE": payment } }))
    );
    expect(results.filter((r) => r.status === "fulfilled").length).to.equal(2);
    expect(results.filter((r) => r.status === "rejected").every((r) => r.reason.code === "over_daily_budget")).to.equal(true);
    expect(sent).to.equal(2); // the other four never left the process
    expect(guard.spentToday()).to.equal("0.02");
  });

  it("gives a refunded call back to the budget", async () => {
    const a = s.agentWith({ dailyBudget: "0.01" });
    const r = await a.surety.call(s.good, "/slow");
    expect(r.verdict).to.equal("fail");
    expect(r.claim).to.not.equal(null);
    expect(a.guard.spentToday()).to.equal("0");
    expect(a.guard.log()[0]).to.include({ paid: "0.01", refunded: "0.01", reason: "too_slow" });
    expect((await a.surety.call(s.good, "/cheap")).verdict).to.equal("pass"); // the budget was not used up
  });

  it("does not count a call the provider never charged for", async () => {
    const a = s.agentWith({ dailyBudget: "0.01" });
    const r = await a.surety.call(s.good, "/down");
    expect(r.response.status).to.equal(502);
    expect(a.guard.spentToday()).to.equal("0");
    expect(a.guard.log()).to.have.length(0);
  });

  it("only pays providers on the list", async () => {
    const a = s.agentWith({ providers: [s.unbonded], bondedOnly: false });
    const e = await s.blocked(a.surety.call(s.good, "/cheap"));
    expect(e.code).to.equal("provider_not_allowed");
  });

  it("refuses providers with no bond, and providers under the trust score", async () => {
    const before = await s.balance();
    let e = await s.blocked(s.agentWith({}).surety.call(s.unbonded, "/cheap"));
    expect(e.code).to.equal("provider_not_bonded");
    e = await s.blocked(s.agentWith({ minTrustScore: 99 }).surety.call(s.good, "/cheap"));
    expect(e.code).to.equal("trust_too_low");
    expect(e.message).to.contain("You require 99");
    expect(await s.balance()).to.equal(before);
    expect((await s.agentWith({ minTrustScore: 10 }).surety.call(s.good, "/cheap")).verdict).to.equal("pass");
  });

  it("refuses to pay around the relay, where nothing could be refunded", async () => {
    const a = s.agentWith({});
    const before = await s.balance();
    const direct = s.api.slaUrl().replace("/.well-known/surety.json", "/cheap");
    const e = await s.blocked(a.pay(direct));
    expect(e.code).to.equal("not_through_surety");
    expect(await s.balance()).to.equal(before);
    expect((await a.pay(s.api.slaUrl())).status).to.equal(200); // free requests are left alone
  });

  it("refuses a payment in a token you did not allow, or one it cannot read", async () => {
    const guard = createGuard({ relayUrl: s.relayUrl }); // default token: Monad testnet USDC, not this test token
    const pay = createPayingFetch(s.agent.privateKey, s.network, s.usdcAddr, "1000000", guard.fetch);
    const e = await s.blocked(createSuretyClient({ relayUrl: s.relayUrl, fetch: pay.fetch }).call(s.good, "/cheap"));
    expect(e.code).to.equal("wrong_token");
    const junk = await s.blocked(guard.fetch(`${s.relayUrl}/call/${s.good}/cheap`, { headers: { "PAYMENT-SIGNATURE": "not-a-payment" } }));
    expect(junk.code).to.equal("unreadable_payment");
  });

  it("fails closed when the provider's record cannot be read", async () => {
    const guard = createGuard({ relayUrl: s.relayUrl, token: s.usdcAddr, fetch: (req) => (String(req.url || req).includes("/trust/") ? Promise.reject(new Error("down")) : fetch(req)) });
    const pay = createPayingFetch(s.agent.privateKey, s.network, s.usdcAddr, "1000000", guard.fetch);
    const before = await s.balance();
    const e = await s.blocked(createSuretyClient({ relayUrl: s.relayUrl, fetch: pay.fetch }).call(s.good, "/cheap"));
    expect(e.code).to.equal("trust_unavailable");
    expect(await s.balance()).to.equal(before);
  });

  it("remembers today's spending across a restart", async () => {
    const logFile = path.join(s.dir, "restart.jsonl");
    const first = s.agentWith({ dailyBudget: "0.02", logFile });
    await first.surety.call(s.good, "/cheap");
    await first.surety.call(s.good, "/slow"); // refunded, so it does not count
    const second = s.agentWith({ dailyBudget: "0.02", logFile }); // a fresh process reading the same file
    expect(second.guard.spentToday()).to.equal("0.01");
    await second.surety.call(s.good, "/cheap");
    expect((await s.blocked(second.surety.call(s.good, "/cheap"))).code).to.equal("over_daily_budget");
    expect(fs.readFileSync(logFile, "utf8").trim().split("\n")).to.have.length(4); // 3 payments and the block
  });
});

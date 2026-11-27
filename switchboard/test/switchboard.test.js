// End to end on localhost: mock providers (real 402 answers), a mock Surety relay and
// directory, a mock vault, then the real registry, server and SDK.
const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const { createRegistry } = require("../registry");
const { buildApp } = require("../server");
const { createSwitchboard, SwitchboardError } = require("../sdk");
const { parseAccepts, pickPrice, usdToAtomic } = require("../price");

const CAIP = "eip155:143";
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const A = "0x1111111111111111111111111111111111111111"; // cheap, fails its promise
const B = "0x2222222222222222222222222222222222222222"; // pricier, healthy
const C = "0x3333333333333333333333333333333333333333"; // cheapest, but not covered
const D = "0x4444444444444444444444444444444444444444"; // covered, but down
const E = "0x5555555555555555555555555555555555555555"; // own capability name in its SLA

const listen = (app) => new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r({ s, url: `http://127.0.0.1:${s.address().port}` })); });

// A provider whose paid endpoints answer 402 (x402 v2 header) with its price.
function providerApp(priceAtomic, payTo) {
  const app = express();
  const required = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: CAIP, asset: USDC, amount: String(priceAtomic), payTo }] })).toString("base64");
  app.use((req, res) => res.status(402).set("payment-required", required).json({}));
  return app;
}

let servers = [];
let ctx;
test.before(async () => {
  const pa = await listen(providerApp(1000, A)); // $0.001
  const pb = await listen(providerApp(2000, B)); // $0.002
  const pc = await listen(providerApp(500, C)); // $0.0005
  const pe = await listen(providerApp(3000, E));
  servers.push(pa.s, pb.s, pc.s, pe.s);
  const sla = (baseUrl, endpoints) => `data:application/json;base64,${Buffer.from(JSON.stringify({ version: 1, baseUrl, payTo: A, endpoints })).toString("base64")}`;
  const priceEp = [{ method: "GET", path: "/v1/price/mon", maxLatencyMs: 4000 }, { method: "GET", path: "/v1/demo/slow", maxLatencyMs: 500 }];
  const records = {
    [A]: sla(pa.url, priceEp),
    [B]: sla(pb.url, priceEp),
    [C]: sla(pc.url, priceEp),
    [D]: sla("http://127.0.0.1:1", priceEp), // nothing listening
    [E]: sla(pe.url, [{ method: "GET", path: "/quote", capability: "price.eth", maxLatencyMs: 900 }]),
  };
  const vault = { providers: async (a) => ({ registered: true, metadataURI: records[a] }) };

  // Mock Surety: directory + relay. A's calls fail and get refunded; B's pass.
  const surety = express();
  const trust = (provider, active, score) => ({ provider, active, score, calls: 30, passRate: 0.9, committedCover: "10000000", claimCount: 0 });
  surety.get("/providers.json", (_q, res) => res.json({ providers: [trust(A, true, 70), trust(B, true, 80), trust(C, false, 0), trust(D, true, 90)] }));
  surety.get("/trust/:a", (req, res) => res.json(trust(req.params.a, true, 50)));
  surety.get("/call/:provider/*rest", (req, res) => {
    if (req.params.provider === A) {
      return res.status(200).set({ "x-surety-verdict": "fail", "x-surety-reason": "too_slow", "x-surety-claim": "paid", "x-surety-claim-id": "0xabc", "x-surety-claim-tx": "0xdef", "x-surety-claim-payout": "1000" }).json({ late: true });
    }
    res.set({ "x-surety-verdict": "pass", "x-surety-reason": "ok", "x-surety-latency-ms": "120" }).json({ symbol: "MON", priceUsd: 1.23 });
  });
  const su = await listen(surety);
  servers.push(su.s);

  const registry = createRegistry({ suretyUrl: su.url, caip: CAIP, usdc: USDC, vault, extraProviders: [E], allowInsecure: true, probeTimeoutMs: 800 });
  let paywallHits = 0;
  const { app } = buildApp({ registry, suretyUrl: su.url, caip: CAIP, usdc: USDC, label: "test", paywall: (a) => a.use("/v1/route", (_q, _r, next) => { paywallHits++; next(); }) });
  const sb = await listen(app);
  servers.push(sb.s);
  ctx = { registry, url: sb.url, paywallHits: () => paywallHits, records, suretyUrl: su.url };
});
test.after(() => servers.forEach((s) => s.close()));

test("price parsing: v2 header, v1 body, dollars", () => {
  const h = new Headers({ "payment-required": Buffer.from(JSON.stringify({ accepts: [{ network: CAIP, asset: USDC, amount: "700" }] })).toString("base64") });
  assert.equal(pickPrice(parseAccepts(h, ""), { caip: CAIP, usdc: USDC }).amount, 700n);
  const v1 = JSON.stringify({ accepts: [{ network: "monad", asset: USDC, maxAmountRequired: "900" }, { network: "monad", asset: USDC, maxAmountRequired: "400" }] });
  assert.equal(pickPrice(parseAccepts(new Headers(), v1), { caip: CAIP, usdc: USDC }).amount, 400n);
  assert.equal(usdToAtomic("$0.0001"), 100n);
  assert.equal(usdToAtomic("1.5"), 1_500_000n);
});

test("registry ranks covered, live providers by price and skips the rest", async () => {
  const r = await ctx.registry.rank("price.mon");
  assert.deepEqual(r.map((x) => x.provider), [A, B]); // C not covered, D down, demo path skipped
  assert.equal(r[0].price, "1000");
  assert.deepEqual((await ctx.registry.rank("price.mon", { maxPrice: 1500n })).map((x) => x.provider), [A]);
  assert.deepEqual((await ctx.registry.rank("price.mon", { minTrust: 75 })).map((x) => x.provider), [B]);
  assert.deepEqual((await ctx.registry.rank("price.eth")).map((x) => x.provider), [E]); // capability from the SLA itself
});

test("with Tally set, ranking uses its chain-verified scores and never routes to a demo provider", async () => {
  const records = ctx.records;
  const vault = { providers: async (a) => ({ registered: true, metadataURI: records[a] }) };
  let updatedAt = Math.floor(Date.now() / 1000);
  let up = true;
  const tally = express();
  tally.get("/scores.json", (_q, res) =>
    up
      ? res.json({ updatedAt, providers: [
          { provider: A.toLowerCase(), score: 91.5, flags: [] }, // the relay says 70
          { provider: B, score: 40.7, flags: ["pay_to_changed"] }, // the relay says 80
          { provider: E, score: 99, flags: ["demo"] },
          { provider: "not-an-address", score: 100, flags: [] },
          { provider: D, score: 500, flags: [] }, // out of range: ignored
        ] })
      : res.status(503).end()
  );
  const t = await listen(tally);
  servers.push(t.s);
  const mk = () => createRegistry({ suretyUrl: ctx.suretyUrl, caip: CAIP, usdc: USDC, vault, extraProviders: [E], allowInsecure: true, probeTimeoutMs: 800, tallyUrl: t.url, ttlMs: 0 });

  const reg = mk();
  const ranked = await reg.rank("price.mon");
  assert.deepEqual(ranked.map((x) => [x.provider, x.score, x.scoreSource]), [[A, 91.5, "tally"], [B, 40.7, "tally"]]);
  assert.deepEqual((await reg.rank("price.mon", { minTrust: 75 })).map((x) => x.provider), [A]); // was B on the relay's scores
  assert.deepEqual(await reg.rank("price.eth"), []); // E is a demo provider
  assert.equal((await reg.capabilities()).scores, "tally");

  // Stale or unreachable: back to the relay's scores, and it says so.
  updatedAt -= 25 * 3600;
  const stale = mk();
  assert.deepEqual((await stale.rank("price.mon")).map((x) => [x.score, x.scoreSource]), [[70, "relay"], [80, "relay"]]);
  assert.deepEqual((await stale.rank("price.eth")).map((x) => x.provider), [E]);
  const caps = await stale.capabilities();
  assert.equal(caps.scores, "relay");
  assert.match(caps.errors[0].error, /tally_unavailable_or_stale/);
  up = false;
  assert.deepEqual((await mk().rank("price.mon", { minTrust: 75 })).map((x) => x.provider), [B]);
});

test("server: bad input and empty answers are refused before the paywall", async () => {
  const before = ctx.paywallHits();
  assert.equal((await fetch(`${ctx.url}/v1/route?capability=BAD!`)).status, 400);
  assert.equal((await fetch(`${ctx.url}/v1/route?capability=price.mon&maxPrice=abc`)).status, 400);
  assert.equal((await fetch(`${ctx.url}/v1/route?capability=nothing.here`)).status, 404);
  assert.equal(ctx.paywallHits(), before);
  const ok = await fetch(`${ctx.url}/v1/route?capability=price.mon`);
  assert.equal(ok.status, 200);
  assert.equal(ctx.paywallHits(), before + 1);
  const body = await ok.json();
  assert.equal(body.candidates[0].provider, A);
  assert.equal(body.candidates[0].scoreSource, "relay"); // no Tally configured here
  assert.match(body.candidates[0].callUrl, new RegExp(`/call/${A}/v1/price/mon$`));
  const caps = await (await fetch(`${ctx.url}/v1/capabilities`)).json();
  assert.equal(caps.capabilities.find((c) => c.capability === "price.mon").bestPrice, "1000");
  const html = await (await fetch(`${ctx.url}/`, { headers: { accept: "text/html" } })).text();
  assert.match(html, /Switchboard/);
});

test("SDK: a failed call is refunded and the next provider answers", async () => {
  const sb = createSwitchboard({ url: ctx.url });
  const r = await sb.call("price.mon");
  assert.equal(r.provider, B);
  assert.equal(r.verdict, "pass");
  assert.deepEqual(await r.response.json(), { symbol: "MON", priceUsd: 1.23 });
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[0].provider, A);
  assert.equal(r.attempts[0].claim.tx, "0xdef");
});

test("SDK: reuses a lookup inside the cache window, errors clearly when nothing answers", async () => {
  let lookups = 0;
  const counting = (u, i) => { if (String(u).includes("/v1/route")) lookups++; return fetch(u, i); };
  const sb = createSwitchboard({ url: ctx.url, fetch: counting });
  await sb.call("price.mon");
  await sb.call("price.mon");
  assert.equal(lookups, 1);
  await assert.rejects(sb.call("price.mon", { maxPrice: "0.0015" }), (e) => e instanceof SwitchboardError && e.attempts.length === 1);
  await assert.rejects(sb.call("pool.v3", { params: {} }), SwitchboardError); // no provider indexed for it
});

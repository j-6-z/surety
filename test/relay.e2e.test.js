const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { startLocalStack, usd } = require("../examples/local-stack");
const { validateSlaDoc, checkResponse } = require("../verifier/sla");
const { parseReceipt } = require("../verifier/payment");
const { assertPublicUrl, isPrivateIp } = require("../verifier/netguard");

describe("Relay end to end", function () {
  this.timeout(30_000);
  let s;
  beforeEach(async () => {
    s = await startLocalStack();
  });
  afterEach(async () => {
    await s.close();
  });

  it("a healthy paid call passes and no claim is filed", async () => {
    const before = await s.usdc.balanceOf(s.agent.address);
    const r = await s.client.call(s.provider, "/quote");
    expect(r.response.status).to.equal(200);
    expect(await r.response.json()).to.deep.equal({ symbol: "MON", price: 1.23 });
    expect(r.verdict).to.equal("pass");
    expect(r.claim).to.equal(null);
    expect(before - (await s.usdc.balanceOf(s.agent.address))).to.equal(s.price); // agent paid, kept paying
    expect((await s.vault.providers(s.provider)).claimCount).to.equal(0n);
  });

  it("a slow paid call is refunded from the provider's bond", async () => {
    const before = await s.usdc.balanceOf(s.agent.address);
    const r = await s.client.call(s.provider, "/slow");
    expect(r.verdict).to.equal("fail");
    expect(r.reason).to.equal("too_slow");
    expect(r.claim.payout).to.equal(s.price.toString());
    expect(await s.usdc.balanceOf(s.agent.address)).to.equal(before); // paid 2, got 2 back
    const p = await s.vault.providers(s.provider);
    expect(p.bond).to.equal(usd(200) - usd(2) - usd(0.1)); // payout + 5% fee
    expect(p.claimCount).to.equal(1n);
  });

  it("a wrong-shape response is refunded and the evidence is stored", async () => {
    const r = await s.client.call(s.provider, "/broken");
    expect(r.verdict).to.equal("fail");
    expect(r.reason).to.equal("schema_mismatch");
    expect(await s.vault.claimPaid(r.claim.id)).to.equal(true);
    const file = path.join(s.dataDir, "evidence", `${r.claim.id}.json`);
    const evidence = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(evidence.reason).to.equal("schema_mismatch");
    expect(evidence.payer).to.equal(s.agent.address);
  });

  it("an unpaid call passes the 402 through and never pays a claim", async () => {
    const res = await fetch(`${s.relayUrl}/call/${s.provider}/slow`); // plain fetch, no payment
    expect(res.status).to.equal(402);
    expect(res.headers.get("x-surety-verdict")).to.equal("unpaid");
    expect((await s.vault.providers(s.provider)).claimCount).to.equal(0n);
  });

  it("spills into backers when the bond can't cover the claim", async () => {
    await s.close();
    s = await startLocalStack({ bond: usd(100), backing: usd(50), price: usd(98) });
    const r = await s.client.call(s.provider, "/slow");
    expect(r.claim.payout).to.equal(usd(98).toString());
    const p = await s.vault.providers(s.provider);
    expect(p.bond).to.equal(0n);
    expect(p.backingAssets).to.equal(usd(50) - usd(2.9)); // 102.90 owed, 100 from bond
  });

  it("a provider under its minimum bond is not covered, and the call still goes through", async () => {
    await s.close();
    s = await startLocalStack({ bond: usd(50), backing: usd(500) });
    const r = await s.client.call(s.provider, "/slow");
    expect(r.response.status).to.equal(200);
    expect(r.verdict).to.equal("uncovered");
    expect(r.reason).to.equal("provider_inactive");
    expect((await s.vault.providers(s.provider)).backingAssets).to.equal(usd(500)); // backers untouched
  });

  it("coverage stops once claims pull the bond under the minimum", async () => {
    await s.close();
    s = await startLocalStack({ bond: usd(101) });
    expect((await s.client.call(s.provider, "/slow")).claim).to.not.equal(null); // bond -> 98.90
    const second = await s.client.call(s.provider, "/slow");
    expect(second.verdict).to.equal("uncovered");
    expect((await s.vault.providers(s.provider)).claimCount).to.equal(1n);
  });

  it("a provider that queues its bond for exit loses coverage straight away", async () => {
    await s.vault.connect(s.providerOp).requestBondWithdraw(usd(200));
    const r = await s.client.call(s.provider, "/slow");
    expect(r.verdict).to.equal("uncovered");
    expect((await s.client.trust(s.provider)).score).to.equal(0);
  });

  it("one payment can't be refunded twice", async () => {
    const r = await s.client.call(s.provider, "/slow");
    await expect(
      s.vault.connect(s.arbiter).payClaim(r.claim.id, s.provider, s.agent.address, usd(2), ethers.ZeroHash)
    ).to.be.revertedWithCustomError(s.vault, "ClaimAlreadyPaid");
  });

  it("rejects unknown providers and bad addresses", async () => {
    const stranger = ethers.Wallet.createRandom().address;
    expect((await fetch(`${s.relayUrl}/call/${stranger}/quote`)).status).to.equal(404);
    expect((await fetch(`${s.relayUrl}/call/not-an-address/quote`)).status).to.equal(400);
  });

  it("trust score reflects committed cover and paid call history only", async () => {
    const t0 = await s.client.trust(s.provider);
    expect(t0.active).to.equal(true);
    expect(t0.committedCover).to.equal(usd(250).toString());
    expect(t0.score).to.equal(40); // 60 * 0.5 (too few calls) + 40 * 250/1000
    await fetch(`${s.relayUrl}/call/${s.provider}/quote`); // unpaid: must not count
    expect((await s.client.trust(s.provider)).calls).to.equal(0);
    await s.client.call(s.provider, "/quote");
    await s.client.call(s.provider, "/slow");
    const t1 = await s.client.trust(s.provider);
    expect(t1.calls).to.equal(2);
    expect(t1.passRate).to.equal(0.5);
    expect(t1.claimCount).to.equal(1);
  });

  it("handles a burst of concurrent failing calls without losing or doubling a refund", async () => {
    const before = await s.usdc.balanceOf(s.agent.address);
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await s.client.call(s.provider, "/broken")); // payments settle in turn
    const again = await Promise.all([0, 1, 2, 3].map(() => s.client.call(s.provider, "/quote")));
    expect(results.every((r) => r.claim)).to.equal(true);
    expect(new Set(results.map((r) => r.claim.id)).size).to.equal(3);
    expect(again.every((r) => r.verdict === "pass")).to.equal(true);
    expect(before - (await s.usdc.balanceOf(s.agent.address))).to.equal(usd(8)); // only the 4 good calls cost money
  });
});

describe("SLA and receipt parsing", () => {
  const endpoint = { maxLatencyMs: 100, responseSchema: { type: "object", required: ["a"] } };

  it("checks status, latency and schema in that order", () => {
    expect(checkResponse(endpoint, { status: 500, latencyMs: 1, bodyText: "{}" }).reason).to.equal("bad_status");
    expect(checkResponse(endpoint, { status: 200, latencyMs: 101, bodyText: '{"a":1}' }).reason).to.equal("too_slow");
    expect(checkResponse(endpoint, { status: 200, latencyMs: 1, bodyText: "nope" }).reason).to.equal("invalid_json");
    expect(checkResponse(endpoint, { status: 200, latencyMs: 1, bodyText: "{}" }).reason).to.equal("schema_mismatch");
    expect(checkResponse(endpoint, { status: 200, latencyMs: 1, bodyText: '{"a":1}' }).pass).to.equal(true);
  });

  it("rejects malformed SLA documents", () => {
    const ok = { version: 1, baseUrl: "https://a.dev", payTo: ethers.ZeroAddress, endpoints: [{ path: "/x", maxLatencyMs: 5 }] };
    expect(validateSlaDoc(ok).endpoints[0].method).to.equal("GET");
    expect(() => validateSlaDoc({ ...ok, payTo: "0x123" })).to.throw();
    expect(() => validateSlaDoc({ ...ok, endpoints: [] })).to.throw();
    expect(() => validateSlaDoc({ ...ok, endpoints: [{ path: "x", maxLatencyMs: 5 }] })).to.throw();
  });

  it("reads v2 and v1 receipt headers and ignores junk", () => {
    const tx = "0x" + "ab".repeat(32);
    const b64 = Buffer.from(JSON.stringify({ success: true, transaction: tx })).toString("base64");
    expect(parseReceipt(new Headers({ "payment-response": b64 })).transaction).to.equal(tx);
    expect(parseReceipt(new Headers({ "x-payment-response": b64 })).transaction).to.equal(tx);
    expect(parseReceipt(new Headers({ "payment-response": "garbage" }))).to.equal(null);
    expect(parseReceipt(new Headers({}))).to.equal(null);
    const failed = Buffer.from(JSON.stringify({ success: false, transaction: tx })).toString("base64");
    expect(parseReceipt(new Headers({ "payment-response": failed }))).to.equal(null);
  });

  it("refuses provider URLs that point at internal addresses", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateIp(ip), ip).to.equal(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "2606:4700::1"]) expect(isPrivateIp(ip), ip).to.equal(false);
    const lookup = async (host) => [{ address: host === "evil.test" ? "10.0.0.5" : "93.184.216.34" }];
    const fails = async (url) => assertPublicUrl(url, false, lookup).then(() => false, () => true);
    expect(await fails("http://good.test/x")).to.equal(true); // not https
    expect(await fails("https://evil.test/x")).to.equal(true); // resolves to a private address
    expect(await fails("https://169.254.169.254/latest")).to.equal(true);
    expect(await fails("https://good.test/x")).to.equal(false);
  });
});

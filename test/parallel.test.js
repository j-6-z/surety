// The parallel-execution analysis (scripts/parallel.js): the figures in PARALLEL.md come from
// this, so the test pins them. If a contract change alters what a block conflicts on, this fails.
const { expect } = require("chai");
const { run } = require("../scripts/parallel");

describe("What Monad would have to run twice", function () {
  this.timeout(120_000);
  let rows;
  before(async function () {
    rows = Object.fromEntries((await run(5)).map((r) => [r.name, r]));
  });
  const slots = (r) => r.shared.map((s) => s.slot);

  it("every vault deposit after the first collides on the vault's USDC balance", function () {
    for (const name of ["bond deposits, each from a different provider", "backers staking, each behind a different provider"]) {
      expect(rows[name].rerun, name).to.equal(4);
      expect(slots(rows[name]), name).to.deep.equal(["USDC balance of the vault"]);
      expect(rows[name].sameSender, name).to.equal(0);
    }
  });

  it("refunds against different providers still collide, on the vault's and the treasury's balance", function () {
    const r = rows["refunds, each against a different provider"];
    expect(r.rerun).to.equal(4);
    expect(slots(r).sort()).to.deep.equal(["USDC balance of the treasury", "USDC balance of the vault"]);
    expect(r.sameSender).to.equal(4); // one arbiter key sends them all
  });

  it("refunds against one provider collide on that provider's own records too", function () {
    const r = rows["refunds, all against one provider"];
    expect(r.rerun).to.equal(4);
    expect(slots(r)).to.include.members(["vault record of provider 1", "today's refund count for provider 1"]);
  });

  it("the re-entrancy lock is not a conflict: it ends each transaction at the value it started with", function () {
    for (const r of Object.values(rows)) expect(slots(r).join()).to.not.include("re-entrancy");
  });

  it("pooled custody collides and one escrow per provider does not", function () {
    expect(rows["design probe: pooled custody, a refund per provider"].rerun).to.equal(4);
    const isolated = rows["design probe: one escrow per provider, a refund per provider"];
    expect(isolated.rerun).to.equal(0);
    expect(isolated.shared).to.deep.equal([]);
  });
});

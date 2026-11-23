// How much time does the relay add to a healthy call?  npx hardhat run scripts/bench.js
// Compares calling the mock provider directly vs through the relay, with the
// relay's caches off and on.
const { startLocalStack } = require("../examples/local-stack");
const { mockPayingFetch } = require("../examples/mock-provider");

const N = 150;
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { mean: s.reduce((a, b) => a + b, 0) / s.length, p95: s[Math.floor(s.length * 0.95)] };
};
async function time(fn) {
  for (let i = 0; i < 10; i++) await fn(); // warm up
  const out = [];
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    await fn();
    out.push(performance.now() - t);
  }
  return stats(out);
}

async function main() {
  const pay = mockPayingFetch();
  const rows = [];
  for (const [label, relayOpts] of [
    ["relay, caches off", { slaTtlMs: 0, statusTtlMs: 0 }],
    ["relay, caches on (default)", { slaTtlMs: 60_000, statusTtlMs: 5_000 }],
  ]) {
    const s = await startLocalStack({ price: 10_000n, relayOpts }); // 0.01 USDC per call
    if (!rows.length) rows.push(["direct to provider", await time(async () => (await pay(`${s.providerUrl}/quote`)).text())]);
    rows.push([label, await time(async () => (await s.client.call(s.provider, "/quote")).response.text())]);
    await s.close();
  }
  const base = rows[0][1].mean;
  for (const [l, r] of rows) {
    console.log(l.padEnd(28), `mean ${r.mean.toFixed(2)}ms  p95 ${r.p95.toFixed(2)}ms  overhead ${(r.mean - base).toFixed(2)}ms`);
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

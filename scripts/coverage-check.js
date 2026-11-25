// Fails unless the Foundry tests cover every line, statement, branch and function of
// SuretyVault.sol and the cross-chain contracts.   npm run coverage:sol:check
const { forge } = require("./forge");

const FILES = ["contracts/SuretyVault.sol", "contracts/crosschain/SuretyBeacon.sol", "contracts/crosschain/SuretyMirror.sol", "contracts/crosschain/CoverageCodec.sol"];

const run = forge(["coverage", "--report", "summary", "--no-match-coverage", "test|Mock"], { capture: true });
const out = `${run.stdout}\n${run.stderr}`;
let short = 0;
for (const file of FILES) {
  const row = out.split("\n").find((l) => l.includes(`${file} `));
  if (!row) {
    console.error(out.slice(-1200));
    console.error(`\nSTOPPED: no coverage figures for ${file}.`);
    process.exit(1);
  }
  const counts = [...row.matchAll(/(\d+\.\d+)% \((\d+)\/(\d+)\)/g)].map((m) => ({ pct: Number(m[1]), hit: Number(m[2]), of: Number(m[3]) }));
  console.log(`${file}\n${["lines", "statements", "branches", "functions"].map((n, i) => `  ${n} ${counts[i].pct}% (${counts[i].hit}/${counts[i].of})`).join("\n")}`);
  short += counts.filter((c) => c.hit !== c.of).length;
}
if (short) {
  console.error("\nSTOPPED: a contract is no longer fully covered. Add a test for the new code.");
  process.exit(1);
}
console.log("\nEvery contract is fully covered.");

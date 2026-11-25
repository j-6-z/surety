// Fails unless the Foundry tests cover every line, statement, branch and function
// of SuretyVault.sol.   npm run coverage:sol:check
const { forge } = require("./forge");

const run = forge(["coverage", "--report", "summary", "--no-match-coverage", "test|Mock"], { capture: true });
const out = `${run.stdout}\n${run.stderr}`;
const row = out.split("\n").find((l) => l.includes("contracts/SuretyVault.sol"));
if (!row) {
  console.error(out.slice(-1200));
  console.error("\nSTOPPED: no coverage figures for SuretyVault.sol.");
  process.exit(1);
}
const [lines, statements, branches, functions] = [...row.matchAll(/(\d+\.\d+)% \((\d+)\/(\d+)\)/g)].map((m) => ({ pct: Number(m[1]), hit: Number(m[2]), of: Number(m[3]) }));
const show = (name, c) => `${name} ${c.pct}% (${c.hit}/${c.of})`;
console.log(["lines", "statements", "branches", "functions"].map((n, i) => show(n, [lines, statements, branches, functions][i])).join("\n"));
const short = [lines, statements, branches, functions].filter((c) => c.hit !== c.of);
if (short.length) {
  console.error("\nSTOPPED: SuretyVault.sol is no longer fully covered. Add a test for the new code.");
  process.exit(1);
}
console.log("\nSuretyVault.sol is fully covered.");

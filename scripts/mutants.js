// Mutation check: does the Foundry suite actually notice when the contract is wrong?
//
//   npm run test:mutants
//
// Plants one deliberate bug at a time in a copy of SuretyVault.sol, runs the fuzz and
// invariant tests, and reports whether they failed (good: the bug was caught) or still
// passed (bad: a gap in the tests). The real file is restored afterwards, even on Ctrl+C.
// Takes about 20 seconds per bug.
const fs = require("fs");
const path = require("path");
const { forge } = require("./forge");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "contracts", "SuretyVault.sol");

// [what the bug is, the exact text to find, what to put in its place]
const MUTANTS = [
  ["the daily limit never refuses a claim", "        if (d.slashed >= limit) revert DailyLimitReached(limit);\n", ""],
  ["the day's refunds are not added up", "        d.slashed = (uint256(d.slashed) + amount).toUint112();\n", ""],
  ["a top-up raises today's limit", "        uint256 limit = (uint256(d.startCover) * maxDailySlashBps) / BPS;\n        if (d.slashed >= limit)", "        uint256 limit = (cover * maxDailySlashBps) / BPS;\n        if (d.slashed > limit)"],
  ["a claim can be paid twice", "        claimPaid[claimId] = true;\n", ""],
  ["no cap on a single claim", "        if (payout > maxClaimPayout) revert PayoutTooLarge(payout, maxClaimPayout);\n", ""],
  ["anyone can pay a claim", "        whenNotPaused\n        onlyArbiter\n", "        whenNotPaused\n"],
  ["the fee is paid out twice", "        if (fee != 0) usdc.safeTransfer(treasury, fee);", "        if (fee != 0) usdc.safeTransfer(treasury, fee * 2);"],
  ["the fee is not cut when cover is short", "            fee = cover - payout;\n", "            fee = fee;\n"],
  ["an exit ignores the unbonding delay", "        if (block.timestamp < readyAt) revert StillUnbonding(readyAt);\n", ""],
  ["the exit window never closes", "        if (block.timestamp > readyAt + EXIT_WINDOW) revert ExitWindowClosed(readyAt + EXIT_WINDOW);\n", ""],
  ["unstaking does not reduce the backing", "        p.backingAssets -= uint128(assets); // _toAssets never exceeds backingAssets\n", ""],
  ["a slash leaves more bond queued than exists", "        if (p.bondPendingWithdraw > newBond) p.bondPendingWithdraw = newBond;\n", ""],
  ["backers are slashed before the bond", "        fromBond = total < bond ? total : bond;", "        fromBond = total < bond ? total / 2 : bond;"],
  ["shares round in the backer's favour", "        return Math.mulDiv(shares, uint256(p.backingAssets) + 1, p.backingShares + VIRTUAL_SHARES);", "        return Math.mulDiv(shares, uint256(p.backingAssets) + 1, p.backingShares + VIRTUAL_SHARES, Math.Rounding.Ceil);"],
  ["cancelling an unstake leaves it in the queue total", "        providers[provider].backingSharesPending -= u.shares;\n", ""],
  ["the claim counter is skipped", "        p.claimCount += 1;\n", ""],
  ["a bond deposit is credited twice", "        providers[msg.sender].bond += amount.toUint128();", "        providers[msg.sender].bond += amount.toUint128() * 2;"],
  ["anyone can change the daily limit", "    function setMaxDailySlashBps(uint16 _maxDailySlashBps) external onlyOwner {", "    function setMaxDailySlashBps(uint16 _maxDailySlashBps) external {"],
];

function main() {
  const original = fs.readFileSync(SRC, "utf8").replace(/\r\n/g, "\n");
  const restore = () => fs.writeFileSync(SRC, original);
  process.on("SIGINT", () => { restore(); process.exit(130); });
  // A planted bug only counts as caught if the suite passes without it.
  const clean = forge(["test"], { capture: true });
  if (clean.status !== 0 || /\[FAIL/.test(clean.stdout)) {
    console.error(`The tests do not pass on the unchanged contract, so this check would prove nothing.\n${`${clean.stdout}\n${clean.stderr}`.slice(-800)}`);
    process.exit(1);
  }
  console.log("Unchanged contract: all tests pass. Planting bugs...\n");
  let caught = 0;
  const survivors = [];
  try {
    for (const [what, find, replace] of MUTANTS) {
      if (original.split(find).length !== 2) throw new Error(`Cannot plant "${what}": the contract has changed. Update the text in scripts/mutants.js.`);
      fs.writeFileSync(SRC, original.replace(find, replace));
      const run = forge(["test"], { capture: true });
      const out = `${run.stdout}\n${run.stderr}`;
      const failed = /\[FAIL/.test(out);
      const ran = /tests? passed|Suite result/.test(out);
      if (!ran) throw new Error(`forge did not run for "${what}":\n${out.slice(-600)}`);
      const by = (out.match(/\[FAIL: ([^\];]{0,80})/) || [])[1];
      console.log(`${failed ? "caught  " : "MISSED  "} ${what}${failed && by ? `\n            by: ${by}` : ""}`);
      if (failed) caught++;
      else survivors.push(what);
    }
  } finally {
    restore();
  }
  console.log(`\n${caught} of ${MUTANTS.length} planted bugs were caught.`);
  if (survivors.length) {
    console.log(`Not caught: ${survivors.join("; ")}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { MUTANTS };

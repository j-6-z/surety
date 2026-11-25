// Mutation check: does the Foundry suite actually notice when the contract is wrong?
//
//   npm run test:mutants
//
// Plants one deliberate bug at a time in a contract, runs the Foundry tests, and reports
// whether they failed (good: the bug was caught) or still passed (bad: a gap in the tests).
// The real file is restored afterwards, even on Ctrl+C. Covers SuretyVault.sol and the
// cross-chain contracts. Takes a few minutes.
const fs = require("fs");
const path = require("path");
const { forge } = require("./forge");

const ROOT = path.join(__dirname, "..");
const VAULT = "contracts/SuretyVault.sol";
const BEACON = "contracts/crosschain/SuretyBeacon.sol";
const MIRROR = "contracts/crosschain/SuretyMirror.sol";
const CODEC = "contracts/crosschain/CoverageCodec.sol";
// The cross-chain contracts have their own test contract; running only that keeps this quick.
const TESTS = (file) => (file === VAULT ? ["test", "--no-match-contract", "CrosschainTest"] : ["test", "--match-contract", "CrosschainTest"]);

// [what the bug is, the exact text to find, what to put in its place, which file (default: the vault)]
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

  ["the mirror lets an older report replace a newer one", "        if (observedAt < c.observedAt || (observedAt == c.observedAt && nonce <= c.nonce)) {", "        if (false) {", MIRROR],
  ["same-second reports are not ordered by nonce", "(observedAt == c.observedAt && nonce <= c.nonce)", "(observedAt == c.observedAt && nonce == c.nonce)", MIRROR],
  ["a repeated message is applied again", "(observedAt == c.observedAt && nonce <= c.nonce)", "(observedAt == c.observedAt && nonce < c.nonce)", MIRROR],
  ["a stale report is still trusted", "        return observedAt != 0 && block.timestamp <= uint256(observedAt) + maxAge;", "        return observedAt != 0;", MIRROR],
  ["the freshness window is one second short", "block.timestamp <= uint256(observedAt) + maxAge;", "block.timestamp < uint256(observedAt) + maxAge;", MIRROR],
  ["the mirror accepts a peer on any chain", "        if (origin.srcEid != hubEid) revert NotFromHub(origin.srcEid);\n", "", MIRROR],
  ["the claim ceiling can go backwards", "        if (observedAt > lastObservedAt || (observedAt == lastObservedAt && nonce > lastNonce)) {", "        if (true) {", MIRROR],
  ["anyone can change the freshness window", "    function setMaxAge(uint64 _maxAge) external onlyOwner {", "    function setMaxAge(uint64 _maxAge) external {", MIRROR],
  ["the freshness window has no lower bound", "        if (_maxAge < MIN_MAX_AGE || _maxAge > MAX_MAX_AGE) revert MaxAgeOutOfRange();", "        if (_maxAge > MAX_MAX_AGE) revert MaxAgeOutOfRange();", MIRROR],
  ["the mirror's ownership moves in one step", "        Ownable2Step.transferOwnership(newOwner);\n    }\n\n    function _transferOwnership", "        Ownable._transferOwnership(newOwner);\n    }\n\n    function _transferOwnership", MIRROR],

  ["the beacon says every provider is covered", "                        covered: vault.isCovered(provider),", "                        covered: true,", BEACON],
  ["queued-to-leave cover is reported as committed", "                        committedCover: vault.committedCoverOf(provider).toUint128(),", "                        committedCover: vault.coverOf(provider).toUint128(),", BEACON],
  ["today's allowance is reported as the whole cover", "                        dailyAllowance: vault.dailyAllowance(provider).toUint128()", "                        dailyAllowance: vault.coverOf(provider).toUint128()", BEACON],
  ["no limit on the batch size", "        if (size > MAX_BATCH) revert BatchTooLarge(size, MAX_BATCH);\n", "", BEACON],
  ["an empty batch is sent", "        if (size == 0) revert EmptyBatch();\n", "", BEACON],
  ["destination gas does not grow with the batch", "uint256(g.perProvider) * count;", "uint256(g.perProvider);", BEACON],
  ["anyone can change the gas settings", "    function setReceiveGas(uint32 dstEid, uint64 base, uint64 perProvider) external onlyOwner {", "    function setReceiveGas(uint32 dstEid, uint64 base, uint64 perProvider) external {", BEACON],
  ["the gas settings have no upper bound", "base == 0 || base > MAX_BASE_GAS || perProvider == 0 || perProvider > MAX_GAS_PER_PROVIDER", "base == 0 || perProvider == 0", BEACON],
  ["the caller's change is not returned", "            payable(msg.sender)\n", "            payable(address(0xdead))\n", BEACON],
  ["the beacon's ownership moves in one step", "        Ownable2Step.transferOwnership(newOwner);\n    }\n\n    function _transferOwnership", "        Ownable._transferOwnership(newOwner);\n    }\n\n    function _transferOwnership", BEACON],

  ["a message with a ragged tail is accepted", "length < HEADER_SIZE + REPORT_SIZE || (length - HEADER_SIZE) % REPORT_SIZE != 0", "length < HEADER_SIZE + REPORT_SIZE", CODEC],
  ["a message with no reports is accepted", "length < HEADER_SIZE + REPORT_SIZE || (length - HEADER_SIZE) % REPORT_SIZE != 0", "length < HEADER_SIZE || (length - HEADER_SIZE) % REPORT_SIZE != 0", CODEC],
  ["an unknown message version is accepted", "        if (version != VERSION) revert UnsupportedVersion(version);\n", "", CODEC],
  ["the allowance is read from the wrong bytes", "        r.dailyAllowance = uint128(bytes16(message[o + 53:o + 69]));", "        r.dailyAllowance = uint128(bytes16(message[o + 37:o + 53]));", CODEC],
  ["only the first report in a batch is read", "        uint256 o = HEADER_SIZE + index * REPORT_SIZE;", "        uint256 o = HEADER_SIZE;", CODEC],
];

function main() {
  const files = [...new Set(MUTANTS.map((m) => m[3] || VAULT))];
  const originals = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\r\n/g, "\n")]));
  const restore = () => files.forEach((f) => fs.writeFileSync(path.join(ROOT, f), originals[f]));
  process.on("SIGINT", () => { restore(); process.exit(130); });
  // A planted bug only counts as caught if the suite passes without it.
  const clean = forge(["test"], { capture: true });
  if (clean.status !== 0 || /\[FAIL/.test(clean.stdout)) {
    console.error(`The tests do not pass on the unchanged contracts, so this check would prove nothing.\n${`${clean.stdout}\n${clean.stderr}`.slice(-800)}`);
    process.exit(1);
  }
  console.log("Unchanged contracts: all tests pass. Planting bugs...\n");
  let caught = 0;
  const survivors = [];
  try {
    for (const [what, find, replace, file = VAULT] of MUTANTS) {
      const original = originals[file];
      if (original.split(find).length !== 2) throw new Error(`Cannot plant "${what}": ${file} has changed. Update the text in scripts/mutants.js.`);
      fs.writeFileSync(path.join(ROOT, file), original.replace(find, replace));
      const run = forge(TESTS(file), { capture: true });
      fs.writeFileSync(path.join(ROOT, file), original);
      const out = `${run.stdout}\n${run.stderr}`;
      const failed = /\[FAIL/.test(out);
      const ran = /tests? passed|Suite result/.test(out);
      // A planted bug that stops the contracts compiling proves nothing about the tests.
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

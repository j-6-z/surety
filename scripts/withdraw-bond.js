// Take your bond out of a vault (for example an older vault you no longer use).
//
//   node scripts/withdraw-bond.js <vaultAddress>            show where the bond stands
//   node scripts/withdraw-bond.js <vaultAddress> request    queue all of it for withdrawal
//   node scripts/withdraw-bond.js <vaultAddress> complete   collect it once the wait is over
//
// PRIVATE_KEY in .env is the wallet that posted the bond. Uses SURETY_NETWORK (default: testnet).
// Queuing a withdrawal ends your coverage on that vault straight away.
require("dotenv").config({ quiet: true });
const { ethers } = require("ethers");
const net = require("../networks").networkFromEnv();

const ABI = [
  "function providers(address) view returns (bool registered, uint64 bondReadyAt, uint64 claimCount, uint128 bond, uint128 bondPendingWithdraw, uint128 backingAssets, uint128 claimsPaid, uint256 backingShares, uint256 backingSharesPending, string metadataURI)",
  "function EXIT_WINDOW() view returns (uint64)",
  "function requestBondWithdraw(uint256)",
  "function completeBondWithdraw()",
];
const fmt = (v) => `${ethers.formatUnits(v, 6)} USDC`;
const when = (t) => new Date(Number(t) * 1000).toLocaleString();

/** @param {{wallet: import("ethers").Signer, vaultAddress: string, action?: string, log?: (m: string) => void, now?: () => number}} c */
async function withdrawBond(c) {
  const log = c.log || console.log;
  const vault = new ethers.Contract(c.vaultAddress, ABI, c.wallet);
  const me = await c.wallet.getAddress();
  const now = c.now ? c.now() : Math.floor(Date.now() / 1000);
  let p = await vault.providers(me);
  if (!p.registered) throw new Error(`${me} has no listing on vault ${c.vaultAddress}.`);
  const window = await vault.EXIT_WINDOW();

  if (c.action === "request") {
    if (p.bond === 0n) throw new Error("There is no bond left in this vault.");
    if (p.bondPendingWithdraw === p.bond) log("All of it is already queued.");
    else {
      await (await vault.requestBondWithdraw(p.bond)).wait();
      log(`Queued ${fmt(p.bond)} for withdrawal.`);
    }
  } else if (c.action === "complete") {
    if (p.bondPendingWithdraw === 0n) throw new Error("Nothing is queued. Run this with  request  first.");
    if (now < Number(p.bondReadyAt)) throw new Error(`Not yet. It can be collected from ${when(p.bondReadyAt)}.`);
    if (now > Number(p.bondReadyAt + window)) throw new Error("The collection window has passed. Run this with  request  again, then wait once more.");
    await (await vault.completeBondWithdraw()).wait();
    log(`Collected. ${fmt(p.bondPendingWithdraw)} is back in ${me}.`);
  } else if (c.action) {
    throw new Error(`Unknown action "${c.action}". Use request or complete.`);
  }

  p = await vault.providers(me);
  log(`Bond in this vault: ${fmt(p.bond)}, of which ${fmt(p.bondPendingWithdraw)} is queued.`);
  if (p.bondPendingWithdraw > 0n) {
    log(`Collect it between ${when(p.bondReadyAt)} and ${when(p.bondReadyAt + window)} with:  node scripts/withdraw-bond.js ${c.vaultAddress} complete`);
  }
  return p;
}

module.exports = { withdrawBond };

if (require.main === module) {
  const [vaultAddress, action] = process.argv.slice(2);
  (async () => {
    if (!ethers.isAddress(vaultAddress || "")) throw new Error("Usage: node scripts/withdraw-bond.js <vaultAddress> [request|complete]");
    if (!process.env.PRIVATE_KEY) throw new Error("Put the bonding wallet's key in .env as PRIVATE_KEY.");
    const key = process.env.PRIVATE_KEY.startsWith("0x") ? process.env.PRIVATE_KEY : `0x${process.env.PRIVATE_KEY}`;
    console.log(`Network: ${net.fullName}`);
    await withdrawBond({ wallet: new ethers.Wallet(key, new ethers.JsonRpcProvider(net.rpc)), vaultAddress, action });
  })().then(
    () => process.exit(0),
    (e) => {
      console.error(`STOPPED: ${e.shortMessage || e.message}`);
      process.exit(1);
    }
  );
}

// Give the homepage's slow demo a provider of its own.
//
// The slow demo fails on purpose, so every run is a refund. Listed under the real API, those
// refunds land on the real API's on-chain record. This lists and bonds a second provider just
// for the demo, so the real API's record only shows real calls.
//
//   node scripts/demo-provider.js https://your-domain.example            show where it stands
//   node scripts/demo-provider.js https://your-domain.example setup      list it and bond it
//   node scripts/demo-provider.js https://your-domain.example setup 2    ...with a 2 USDC bond
//
// DEMO_KEY in .env is the demo wallet: it becomes the demo provider. It needs a little MON for
// gas and enough USDC for the bond. Every refund the demo triggers is paid back to this same
// wallet, so the bond only shrinks by the protocol fee.
// For mainnet, set SURETY_NETWORK=mainnet in .env first. VAULT_ADDRESS is read from .env too.
const { ethers } = require("ethers");

const VAULT_ABI = [
  "function minProviderBond() view returns (uint256)",
  "function isActive(address) view returns (bool)",
  "function providers(address) view returns (bool registered, uint64 bondReadyAt, uint64 claimCount, uint128 bond, uint128 bondPendingWithdraw, uint128 backingAssets, uint128 claimsPaid, uint256 backingShares, uint256 backingSharesPending, string metadataURI)",
  "function register(string)",
  "function setMetadata(string)",
  "function depositBond(uint256)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
];
const fmt = (v) => `${ethers.formatUnits(v, 6)} USDC`;
const DEMO_SLA = "/.well-known/surety-demo.json";

/// What the host is serving at the demo SLA address: "ok", "missing" (not switched on yet), or a thrown reason.
async function checkDemoSla(url, f = globalThis.fetch) {
  const res = await f(url + DEMO_SLA, { redirect: "manual", headers: { accept: "application/json" } }).catch(() => null);
  if (!res || res.status === 404) return "missing";
  if (!res.ok) throw new Error(`${url + DEMO_SLA} answered ${res.status}.`);
  const sla = await res.json().catch(() => null);
  if (!sla || sla.demo !== true || !Array.isArray(sla.endpoints)) throw new Error(`${url + DEMO_SLA} is not a demo SLA document.`);
  if (sla.baseUrl !== url) throw new Error(`The host says its address is "${sla.baseUrl}", not "${url}". Use the address it gives, or fix PUBLIC_URL on the host.`);
  if (sla.endpoints.some((e) => !String(e.path).startsWith("/v1/demo/"))) throw new Error("The demo SLA lists an endpoint that is not a demo endpoint.");
  return "ok";
}

/**
 * @param {object} c
 * @param {import("ethers").Wallet} c.wallet   the demo wallet: becomes the demo provider
 * @param {string} c.vaultAddress @param {string} c.usdcAddress
 * @param {string} c.url                       the host's public address, no trailing slash
 * @param {boolean} [c.setup]                  false: only report
 * @param {bigint} [c.bond]                    target bond in USDC base units (default: minimum + 0.1 USDC)
 * @param {(m: string) => void} [c.log] @param {typeof fetch} [c.fetch]
 * @returns {Promise<{provider: string, slaUrl: string, registered: boolean, bond: bigint, active: boolean, hostReady: boolean}>}
 */
async function demoProvider(c) {
  const log = c.log || console.log;
  const me = c.wallet.address;
  const slaUrl = c.url + DEMO_SLA;
  const vault = new ethers.Contract(c.vaultAddress, VAULT_ABI, c.wallet);
  const usdc = new ethers.Contract(c.usdcAddress, ERC20_ABI, c.wallet);

  const hostReady = (await checkDemoSla(c.url, c.fetch)) === "ok";
  let [p, minBond] = await Promise.all([vault.providers(me), vault.minProviderBond()]);
  const target = c.bond ?? minBond + 100_000n;
  if (target < minBond) throw new Error(`A bond of ${fmt(target)} is under the vault's minimum of ${fmt(minBond)}.`);

  if (c.setup) {
    const need = p.bond < target ? target - p.bond : 0n;
    // Check everything before sending anything, so a run never stops halfway.
    if ((await c.wallet.provider.getBalance(me)) === 0n) throw new Error(`The demo wallet ${me} has no MON for gas. Send it a little and run this again.`);
    const have = await usdc.balanceOf(me);
    if (have < need) throw new Error(`The demo wallet ${me} holds ${fmt(have)} and needs ${fmt(need)} more for the bond.`);

    if (!p.registered) {
      await (await vault.register(slaUrl)).wait();
      log("Listed the demo provider.");
    } else if (p.metadataURI !== slaUrl) {
      await (await vault.setMetadata(slaUrl)).wait();
      log("Pointed the demo provider at this host.");
    }
    if (need > 0n) {
      if ((await usdc.allowance(me, c.vaultAddress)) < need) await (await usdc.approve(c.vaultAddress, need)).wait(); // exactly the bond, nothing more
      await (await vault.depositBond(need)).wait();
      log(`Bonded ${fmt(need)}.`);
    }
    p = await vault.providers(me);
  }

  const active = await vault.isActive(me);
  log(`  demo provider ${me}`);
  log(`  ${p.registered ? `listed at ${p.metadataURI}` : "not listed yet"}`);
  log(`  bond ${fmt(p.bond)} (minimum ${fmt(minBond)})  ${active ? "ACTIVE" : "NOT ACTIVE"}  refunds so far: ${p.claimCount}`);
  if (!hostReady) {
    log(`\nThe host is not using it yet. In the host's settings add:\n  DEMO_PROVIDER_ADDRESS=${me}\nthen redeploy. From then on the slow demo's refunds come out of this bond.`);
  } else if (p.registered && p.metadataURI === slaUrl && active) {
    log("\nAll set: the slow demo runs against this provider.");
  } else if (!c.setup) {
    log("\nRun this again with  setup  to list and bond it.");
  }
  return { provider: me, slaUrl, registered: p.registered, bond: p.bond, active, hostReady };
}

module.exports = { demoProvider, checkDemoSla };

if (require.main === module) {
  require("dotenv").config({ quiet: true });
  const net = require("../networks").networkFromEnv();
  let url = (process.argv[2] || "").trim().replace(/\/+$/, "");
  if (url && !/^https?:\/\//.test(url)) url = `https://${url}`;
  const action = process.argv[3];
  const { DEMO_KEY } = process.env;
  const usage = "Usage: node scripts/demo-provider.js https://your-domain.example [setup [bondUsdc]]   (needs DEMO_KEY in .env)";
  if (!/^https:\/\//.test(url) || !DEMO_KEY || (action && action !== "setup")) {
    console.error(usage);
    process.exit(1);
  }
  let bond;
  if (process.argv[4] !== undefined) {
    if (!/^\d+(\.\d{1,6})?$/.test(process.argv[4])) {
      console.error(`The bond must be a USDC amount such as 1.5, not "${process.argv[4]}".`);
      process.exit(1);
    }
    bond = ethers.parseUnits(process.argv[4], 6);
  }
  const key = DEMO_KEY.trim().replace(/^["']|["']$/g, "");
  const hex = key.startsWith("0x") ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    // Never print the value: it may be a key with a typo in it.
    const what = /^[0-9a-fA-F]{40}$/.test(hex)
      ? "It looks like a wallet ADDRESS (40 hex characters). DEMO_KEY must be the wallet's PRIVATE KEY (64 hex characters)."
      : `A private key is 64 hex characters, with or without 0x in front. This one has ${hex.length} characters after the 0x.`;
    console.error(`DEMO_KEY in .env is not a private key. ${what}`);
    process.exit(1);
  }
  const wallet = new ethers.Wallet(`0x${hex}`, new ethers.JsonRpcProvider(net.rpc));
  console.log(`Network: ${net.fullName}   vault ${net.vault}\n`);
  demoProvider({ wallet, vaultAddress: net.vault, usdcAddress: net.usdc, url, setup: action === "setup", bond }).then(
    () => process.exit(0),
    (e) => {
      console.error(`STOPPED: ${e.shortMessage || e.message}`);
      process.exit(1);
    }
  );
}

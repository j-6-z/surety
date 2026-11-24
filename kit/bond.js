// Post a bond for your hosted API so its calls are covered by Surety.
//
//   npm run bond -- https://your-api.example          bond the minimum
//   npm run bond -- https://your-api.example 5        bond 5 USDC in total
//
// Run this on your own computer. It needs PRIVATE_KEY in .env: a wallet holding
// a little MON (for fees) and the USDC you are bonding. The hosted API never needs that key.
const { ethers } = require("ethers");

const VAULT_ABI = [
  "function register(string)",
  "function setMetadata(string)",
  "function depositBond(uint256)",
  "function isActive(address) view returns (bool)",
  "function minProviderBond() view returns (uint256)",
  "function providers(address) view returns (bool registered, uint64 bondReadyAt, uint64 claimCount, uint128 bond, uint128 bondPendingWithdraw, uint128 backingAssets, uint128 claimsPaid, uint256 backingShares, uint256 backingSharesPending, string metadataURI)",
];
const ERC20_ABI = [
  "function approve(address, uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
];
const fmt = (v) => ethers.formatUnits(v, 6);
const stop = (message) => Object.assign(new Error(message), { expected: true });

async function getJson(url, what, opts = {}) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000), ...opts });
  } catch (e) {
    throw stop(`Could not reach ${what} at ${url} (${e.cause?.code || e.message}).`);
  }
  if (res.status >= 300 && res.status < 400) throw stop(`${url} redirects to ${res.headers.get("location")}. Use the address it redirects to.`);
  if (!res.ok) throw stop(`${what} at ${url} answered ${res.status}.`);
  try {
    return await res.json();
  } catch {
    throw stop(`${what} at ${url} did not answer with JSON.`);
  }
}

/**
 * @param {object} c
 * @param {string} c.url                       public address of your API
 * @param {import("ethers").Signer} c.wallet   connected to the payment network
 * @param {string} [c.suretyUrl]               the Surety relay you are joining
 * @param {string} [c.amount]                  total bond wanted, in USDC (default: the vault minimum)
 * @param {string} [c.vaultAddress]            pin the vault instead of trusting the relay's answer
 * @param {(m: string) => void} [c.log]
 */
async function bond(c) {
  const log = c.log || console.log;
  const suretyUrl = (c.suretyUrl || "https://www.surety.buzz").replace(/\/+$/, "");
  let url = String(c.url || "").trim().replace(/\/+$/, "");
  if (url && !/^https?:\/\//.test(url)) url = `https://${url}`;
  if (!url) throw stop("Give the public address of your API:  npm run bond -- https://your-api.example");
  const slaUrl = `${url}/.well-known/surety.json`;
  const me = await c.wallet.getAddress();

  // 1. Your API is up and describes itself correctly.
  const doc = await getJson(slaUrl, "your API", { redirect: "manual" });
  if (doc.baseUrl !== url) {
    throw stop(`Your API thinks its address is "${doc.baseUrl}", not ${url}. Set PUBLIC_URL to ${url} on your host and redeploy.`);
  }
  // 2. The relay can read it too. This is the same check it runs before covering a call.
  const check = await getJson(`${suretyUrl}/bond/sla-check?url=${encodeURIComponent(slaUrl)}`, "Surety");
  if (!check.ok) throw stop(`Surety could not accept your SLA document: ${check.error}`);
  log(`SLA accepted: ${check.endpoints.length} endpoint(s), payments go to ${check.payTo}`);

  // 3. Where the vault is, and where this wallet stands.
  const net = await getJson(`${suretyUrl}/bond/account?address=${me}`, "Surety");
  if (!net.ok) throw stop(`Surety could not read the vault: ${net.error}`);
  const { chainId } = await c.wallet.provider.getNetwork();
  if (Number(chainId) !== net.chainId) throw stop(`Your wallet is connected to chain ${chainId}, but this vault is on chain ${net.chainId}.`);
  if (c.vaultAddress && ethers.getAddress(c.vaultAddress) !== ethers.getAddress(net.vault)) {
    throw stop(`Surety reports vault ${net.vault}, but VAULT_ADDRESS is ${c.vaultAddress}. Stopping.`);
  }
  const vault = new ethers.Contract(net.vault, VAULT_ABI, c.wallet);
  const usdc = new ethers.Contract(net.usdc, ERC20_ABI, c.wallet);
  log(`Vault ${net.vault} on chain ${net.chainId}, wallet ${me}`);

  // 4. List the API, or repoint an existing listing.
  let p = await vault.providers(me);
  if (!p.registered) {
    await (await vault.register(slaUrl)).wait();
    log("Listed your API on the vault.");
  } else if (p.metadataURI !== slaUrl) {
    await (await vault.setMetadata(slaUrl)).wait();
    log("Pointed your listing at this address.");
  } else {
    log("Already listed at this address.");
  }

  // 5. Top the bond up to the target.
  const minBond = await vault.minProviderBond();
  const target = c.amount ? ethers.parseUnits(String(c.amount), 6) : minBond;
  if (target < minBond) throw stop(`The minimum bond is ${fmt(minBond)} USDC.`);
  p = await vault.providers(me);
  const missing = target - p.bond;
  if (missing > 0n) {
    const balance = await usdc.balanceOf(me);
    if (balance < missing) throw stop(`You need ${fmt(missing)} more USDC to bond, and this wallet holds ${fmt(balance)}.`);
    if ((await usdc.allowance(me, net.vault)) < missing) {
      await (await usdc.approve(net.vault, missing)).wait(); // exactly this much, nothing open-ended
    }
    await (await vault.depositBond(missing)).wait();
    log(`Bonded ${fmt(missing)} USDC.`);
  }
  const [after, active] = await Promise.all([vault.providers(me), vault.isActive(me)]);
  log(`Bond ${fmt(after.bond)} USDC. ${active ? "ACTIVE: your paid calls are covered." : "NOT ACTIVE: calls are not covered yet."}`);

  const callUrls = check.endpoints.map((e) => `${e.method} ${suretyUrl}/call/${me}${e.path}`);
  log(`\nAgents call you through the relay:`);
  for (const line of callUrls) log(`  ${line}`);
  log(`Your record:  ${suretyUrl}/trust/${me}`);
  log(`Directory:    ${suretyUrl}/providers/`);
  return { provider: me, active, bond: after.bond, slaUrl, vault: net.vault, callUrls };
}

module.exports = { bond };

if (require.main === module) {
  require("dotenv").config();
  const env = process.env;
  (async () => {
    if (!env.PRIVATE_KEY) throw stop("Put your wallet key in .env as PRIVATE_KEY=... (copy .env.example to .env first).");
    const key = env.PRIVATE_KEY.startsWith("0x") ? env.PRIVATE_KEY : `0x${env.PRIVATE_KEY}`;
    const wallet = new ethers.Wallet(key, new ethers.JsonRpcProvider(require("./surety").networkFromEnv(env).rpc));
    await bond({ url: process.argv[2], amount: process.argv[3], wallet, suretyUrl: env.SURETY_URL, vaultAddress: env.VAULT_ADDRESS });
  })().then(
    () => process.exit(0),
    (e) => {
      const m = e.expected ? e.message
        : e.code === "INSUFFICIENT_FUNDS" ? "This wallet has no MON to pay the network fee. Get some from the Monad testnet faucet."
        : e.shortMessage || e.message;
      console.error(`STOPPED: ${m}`);
      process.exit(1);
    }
  );
}

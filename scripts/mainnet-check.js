// Before real money: check a mainnet setup, then (with --live) prove the whole
// loop with three tiny real payments.
//
//   npm run check:mainnet            read-only: nothing is spent
//   npm run check:mainnet -- --live  bonds the minimum and makes three $0.001 calls
//
// PRIVATE_KEY in .env must be the ARBITER wallet (the relay's key). For the live
// run it also plays provider and paying agent, so it needs a little MON for fees
// and the minimum bond plus about 0.15 USDC. The vault OWNER is a different
// wallet and is never needed here.
const { ethers } = require("ethers");
const { NETWORKS, networkFromEnv } = require("../networks");

const VAULT_ABI = [
  "function owner() view returns (address)",
  "function arbiter() view returns (address)",
  "function treasury() view returns (address)",
  "function usdc() view returns (address)",
  "function paused() view returns (bool)",
  "function minProviderBond() view returns (uint256)",
  "function maxClaimPayout() view returns (uint256)",
  "function unbondingDelay() view returns (uint64)",
  "function slashFeeBps() view returns (uint16)",
];
const TOKEN_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
];
const fmt = (v) => `${ethers.formatUnits(v, 6)} USDC`;

/**
 * Read-only checks. Returns { problems, warnings, facts, tokenDomain }.
 * @param {object} c
 * @param {import("ethers").Provider} c.provider
 * @param {object} c.net                 a profile from networks.js
 * @param {string} [c.vaultAddress]
 * @param {string} [c.wallet]            address of the arbiter wallet whose key is in .env
 * @param {typeof fetch} [c.fetch] @param {(m: string) => void} [c.log]
 */
async function preflight(c) {
  const log = c.log || console.log;
  const f = c.fetch || fetch;
  const problems = [], warnings = [], facts = {};
  const ok = (m) => log(`  ok       ${m}`);
  const bad = (m) => { problems.push(m); log(`  PROBLEM  ${m}`); };
  const warn = (m) => { warnings.push(m); log(`  warning  ${m}`); };

  log(`Network: ${c.net.label} (chain ${c.net.chainId})`);
  const { chainId } = await c.provider.getNetwork();
  if (Number(chainId) !== c.net.chainId) bad(`The RPC at ${c.net.rpc} is chain ${chainId}, not ${c.net.chainId}.`);
  else ok("the RPC answers on the right chain");

  // ---- the token
  let tokenDomain = null;
  const token = new ethers.Contract(c.net.usdc, TOKEN_ABI, c.provider);
  if ((await c.provider.getCode(c.net.usdc)) === "0x") {
    bad(`Nothing is deployed at the USDC address ${c.net.usdc}.`);
  } else {
    const [decimals, symbol, name, version] = await Promise.all([
      token.decimals(), token.symbol(), token.name(), token.version().catch(() => null),
    ]);
    if (Number(decimals) !== 6) bad(`The token has ${decimals} decimals. Surety assumes 6.`);
    if (version === null) bad("The token does not report a signing version, so x402 payments cannot be signed for it. Set USDC_ADDRESS to the right token.");
    else {
      tokenDomain = { name, version };
      ok(`token ${symbol} at ${c.net.usdc}, signs as "${name}" version ${version}`);
      if (name !== "USDC" || version !== "2") log(`           set on the server:  USDC_DOMAIN_NAME="${name}"  USDC_DOMAIN_VERSION=${version}`);
    }
  }

  // ---- the payment facilitator
  try {
    const res = await f(`${c.net.facilitatorUrl}/supported`, { signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    if (!res.ok) bad(`The payment facilitator answered ${res.status}.`);
    else if (!text.includes(c.net.caip)) bad(`The payment facilitator at ${c.net.facilitatorUrl} does not list ${c.net.caip}.`);
    else ok(`the payment facilitator settles on ${c.net.caip}`);
  } catch (e) {
    bad(`Could not reach the payment facilitator at ${c.net.facilitatorUrl} (${e.message}).`);
  }

  // ---- the vault
  if (!c.vaultAddress) {
    log("  (no VAULT_ADDRESS yet: deploy first with  npm run deploy:mainnet )");
    return { problems, warnings, facts, tokenDomain };
  }
  if (!ethers.isAddress(c.vaultAddress)) {
    bad(`VAULT_ADDRESS "${c.vaultAddress}" is not a valid address.`);
    return { problems, warnings, facts, tokenDomain };
  }
  if ((await c.provider.getCode(c.vaultAddress)) === "0x") {
    bad(`Nothing is deployed at VAULT_ADDRESS ${c.vaultAddress} on this network.`);
    return { problems, warnings, facts, tokenDomain };
  }
  const vault = new ethers.Contract(c.vaultAddress, VAULT_ABI, c.provider);
  const [owner, arbiter, treasury, vaultToken, paused, minBond, maxClaim, delay, feeBps] = await Promise.all([
    vault.owner(), vault.arbiter(), vault.treasury(), vault.usdc(), vault.paused(),
    vault.minProviderBond(), vault.maxClaimPayout(), vault.unbondingDelay(), vault.slashFeeBps(),
  ]);
  Object.assign(facts, { owner, arbiter, treasury, minBond, maxClaim, delay, feeBps, paused });
  log(`Vault ${c.vaultAddress}`);
  log(`  owner ${owner}\n  arbiter ${arbiter}\n  treasury ${treasury}`);
  log(`  minimum bond ${fmt(minBond)}, largest single refund ${fmt(maxClaim)}, fee ${Number(feeBps) / 100}%, withdrawal wait ${Number(delay) / 86400} days`);
  if (vaultToken.toLowerCase() !== c.net.usdc.toLowerCase()) bad(`The vault was built for token ${vaultToken}, not ${c.net.usdc}.`);
  if (owner === arbiter) bad("The owner and the arbiter are the same wallet. The arbiter key sits on a server, so whoever breaks in would own the vault. Redeploy with separate wallets.");
  else ok("the owner and the arbiter are different wallets");
  if (paused) bad("The vault is paused.");
  if (maxClaim > minBond) warn(`One refund can take ${fmt(maxClaim)}, more than the minimum bond. A stolen arbiter key could drain bonds faster.`);
  if (c.net.real && minBond > 100_000_000n) warn(`The minimum bond is ${fmt(minBond)}. For an unaudited beta, keep it small.`);
  if (c.wallet) {
    if (c.wallet === owner) bad("The key in .env is the vault OWNER. Take it out. Only the arbiter key belongs in .env or on the server.");
    if (c.wallet !== arbiter) bad(`The key in .env is ${c.wallet}, but the vault's arbiter is ${arbiter}. The relay could not pay refunds.`);
    else ok("the key in .env is the arbiter");
    const [mon, usdcBal] = await Promise.all([c.provider.getBalance(c.wallet), token.balanceOf(c.wallet).catch(() => 0n)]);
    Object.assign(facts, { mon, usdcBal });
    log(`  arbiter wallet holds ${ethers.formatEther(mon)} MON and ${fmt(usdcBal)}`);
    if (mon === 0n) bad("The arbiter wallet has no MON. Every refund needs a little for the network fee.");
  }
  return { problems, warnings, facts, tokenDomain };
}

module.exports = { preflight };

if (require.main === module) {
  require("dotenv").config();
  const env = process.env;
  const live = process.argv.includes("--live");
  (async () => {
    const net = networkFromEnv({ ...env, SURETY_NETWORK: "mainnet" });
    if (!env.PRIVATE_KEY) throw new Error("Put the ARBITER wallet's key in .env as PRIVATE_KEY.");
    const key = env.PRIVATE_KEY.startsWith("0x") ? env.PRIVATE_KEY : `0x${env.PRIVATE_KEY}`;
    const wallet = new ethers.Wallet(key, new ethers.JsonRpcProvider(net.rpc));
    const r = await preflight({ provider: wallet.provider, net, vaultAddress: env.VAULT_ADDRESS, wallet: wallet.address });
    if (r.problems.length) throw new Error(`${r.problems.length} problem(s) above. Fix them before going further.`);
    if (!env.VAULT_ADDRESS) return;
    if (!live) {
      const cost = r.facts.minBond + 150_000n;
      console.log(`\nPreflight passed. Nothing was spent.`);
      console.log(`The live run locks ${fmt(r.facts.minBond)} as a bond (yours to withdraw after ${Number(r.facts.delay) / 86400} days) and spends well under 0.01 USDC.`);
      console.log(`It needs ${fmt(cost)} in the arbiter wallet. When ready:  npm run check:mainnet -- --live`);
      return;
    }
    console.log("\nLive run: three real paid calls on mainnet.\n");
    const { main } = require("./testnet-check");
    await main({
      wallet, vaultAddress: env.VAULT_ADDRESS, usdcAddress: net.usdc, network: net.caip,
      facilitatorUrl: net.facilitatorUrl, explorer: net.explorer, tokenDomain: r.tokenDomain,
      ownerElsewhere: true, fundsHint: `Send USDC on Monad mainnet to ${wallet.address}, then run this again.`,
    });
  })().then(
    () => process.exit(0),
    (e) => {
      console.error(`\nSTOPPED: ${e.shortMessage || e.message}`);
      process.exit(1);
    }
  );
}

// The homepage demo: runs REAL paid calls through the relay, paid for by the
// server's own wallet, so a visitor can watch a pass and a refund without a wallet.
//
//   POST /demo/run?kind=good   pays for the live price endpoint (should pass)
//   POST /demo/run?kind=slow   pays for an endpoint built to miss its promise (gets refunded)
//   GET  /demo/last            the most recent result of each kind
//
// Every run spends real (testnet) funds, so runs are spaced out, capped per day,
// and the slow demo stops before it could pull the bond under its minimum.
const { ethers } = require("ethers");
const { createSuretyClient } = require("./sdk");
const { createPayingFetch } = require("./examples/x402-client");
const { parseReceipt } = require("./verifier/payment");

const VAULT_ABI = [
  "function minProviderBond() view returns (uint256)",
  "function providers(address) view returns (bool registered, uint64 bondReadyAt, uint64 claimCount, uint128 bond, uint128 bondPendingWithdraw, uint128 backingAssets, uint128 claimsPaid, uint256 backingShares, uint256 backingSharesPending, string metadataURI)",
];
const PATHS = { good: "/v1/price/mon", slow: "/v1/demo/slow" };

/**
 * @param {object} c
 * @param {import("ethers").Wallet} c.wallet  pays for demo calls
 * @param {string} [c.providerAddress]       the provider being called (default: the same wallet)
 * @param {string} c.vaultAddress @param {string} c.usdcAddress @param {string} c.network
 * @param {string} c.publicUrl               where the relay is reachable
 * @param {string} [c.explorer]              block explorer base for transaction links
 * @param {{good?: number, slow?: number}} [c.cooldownMs]  minimum gap between fresh runs
 * @param {{good?: number, slow?: number}} [c.dailyCap]
 * @param {bigint} [c.bondMargin]            keep at least this much bond above the minimum
 */
function createDemo(c) {
  const provider = c.providerAddress || c.wallet.address; // the provider being called; the wallet only pays
  const client = createSuretyClient({
    relayUrl: c.publicUrl,
    fetch: createPayingFetch(c.wallet.privateKey, c.network, c.usdcAddress).fetch,
  });
  const vault = new ethers.Contract(c.vaultAddress, VAULT_ABI, c.wallet.provider);
  const cooldown = { good: 8_000, slow: 45_000, ...c.cooldownMs };
  const cap = { good: 150, slow: 25, ...c.dailyCap };
  const margin = c.bondMargin ?? 10_000n; // 0.01 USDC
  const explorer = c.explorer || "https://testnet.monadvision.com";

  const last = { good: null, slow: null };
  const used = { day: "", good: 0, slow: 0 };
  let running = false;
  let promises = null;

  async function promisedMs(kind) {
    if (!promises) {
      const sla = await (await fetch(`${c.publicUrl}/.well-known/surety.json`)).json();
      promises = Object.fromEntries(sla.endpoints.map((e) => [e.path, e.maxLatencyMs]));
    }
    return promises[PATHS[kind]] ?? null;
  }

  const replay = (kind, note) => (last[kind] ? { ...last[kind], replay: true, note } : null);

  async function run(kind) {
    if (!PATHS[kind]) return { http: 400, body: { error: "kind must be good or slow" } };
    if (running) return { http: 429, body: { error: "A demo call is already running. Try again in a few seconds." } };
    const today = new Date().toISOString().slice(0, 10);
    if (used.day !== today) Object.assign(used, { day: today, good: 0, slow: 0 });

    if (last[kind] && Date.now() - last[kind].at < cooldown[kind]) {
      return { http: 200, body: replay(kind, "Showing the run from a moment ago. Fresh runs are spaced out because each one spends real test funds.") };
    }
    if (used[kind] >= cap[kind]) {
      const r = replay(kind, "Today's demo budget is used up, so this is the most recent run.");
      return r ? { http: 200, body: r } : { http: 429, body: { error: "Today's demo budget is used up. Come back tomorrow." } };
    }

    running = true;
    try {
      if (kind === "slow") {
        const [p, min] = await Promise.all([vault.providers(provider), vault.minProviderBond()]);
        if (p.bond - p.bondPendingWithdraw < min + margin) {
          const r = replay(kind, "The bond is close to its minimum, so no new refund was triggered. This is the most recent one.");
          return r
            ? { http: 200, body: r }
            : { http: 409, body: { error: "The bond is too close to its minimum to demo another refund right now." } };
        }
      }
      const r = await client.call(provider, PATHS[kind]);
      const data = await r.response.json().catch(() => null);
      const receipt = parseReceipt(r.response.headers);
      used[kind] += 1;
      last[kind] = {
        kind,
        at: Date.now(),
        status: r.response.status,
        verdict: r.verdict,
        reason: r.reason,
        latencyMs: r.latencyMs,
        promisedMs: await promisedMs(kind).catch(() => null),
        paymentTx: receipt ? receipt.transaction : null,
        refund: r.claim ? { tx: r.claim.tx, payout: r.claim.payout } : null,
        claimError: r.claimError,
        data: kind === "good" && data && data.priceUsd ? { priceUsd: data.priceUsd, pool: data.pool, block: data.block } : null,
        explorer,
      };
      return { http: 200, body: last[kind] };
    } catch (e) {
      return { http: 502, body: { error: `The demo call failed: ${String(e.shortMessage || e.message).slice(0, 200)}` } };
    } finally {
      running = false;
    }
  }

  /// Express-style handlers.
  const send = (res, http, body) => res.status(http).set("cache-control", "no-store").json(body);
  return {
    run,
    handleRun: async (req, res) => {
      const out = await run(String(req.query.kind || ""));
      send(res, out.http, out.body);
    },
    handleLast: (_req, res) => send(res, 200, { good: last.good, slow: last.slow }),
  };
}

module.exports = { createDemo };

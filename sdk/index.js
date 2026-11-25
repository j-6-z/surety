// Surety agent SDK.
//
//   const { createSuretyClient } = require("./sdk");
//   const surety = createSuretyClient({ relayUrl: "https://relay.example", fetch: payingFetch });
//   const { response, verdict, claim } = await surety.call(providerAddress, "/quote");
//
// Pass your x402-enabled fetch (for example one wrapped by @x402/fetch) as `fetch`
// and payments keep working exactly as before: the relay forwards the 402
// handshake and the payment headers untouched.
//
// To cap what the agent can spend, put a guard under the payer (see guard.js):
//   const guard = createGuard({ relayUrl, maxPerCall: "0.01", dailyBudget: "1" });
//   const payingFetch = wrapFetchWithPayment(guard.fetch, x402client);

/**
 * @param {object} o
 * @param {string} o.relayUrl
 * @param {typeof fetch} [o.fetch]
 */
function createSuretyClient({ relayUrl, fetch: f = globalThis.fetch }) {
  const base = relayUrl.replace(/\/+$/, "");

  /** Call a bonded provider through the relay. `path` starts with "/". */
  async function call(provider, path, init) {
    const response = await f(`${base}/call/${provider}${path}`, init);
    const h = response.headers;
    const claimState = h.get("x-surety-claim");
    return {
      response,
      verdict: h.get("x-surety-verdict"), // pass | fail | unpaid | uncovered
      reason: h.get("x-surety-reason"),
      latencyMs: Number(h.get("x-surety-latency-ms")) || null,
      claim:
        claimState === "paid"
          ? {
              id: h.get("x-surety-claim-id"),
              tx: h.get("x-surety-claim-tx"),
              payout: h.get("x-surety-claim-payout"),
              // Set only when you paid on another chain: the refund is paid there, and arrives
              // with the next batch ("queued") or is already on its way ("sent").
              ...(h.get("x-surety-claim-settles-on") ? { settlesOn: h.get("x-surety-claim-settles-on"), delivery: h.get("x-surety-claim-delivery") } : {}),
            }
          : null,
      claimError: claimState && claimState !== "paid" ? claimState : null,
    };
  }

  /** Trust score and cover for a provider. Check this before paying. */
  async function trust(provider) {
    const res = await f(`${base}/trust/${provider}`);
    if (!res.ok) throw new Error(`trust lookup failed (${res.status})`);
    return res.json();
  }

  return { call, trust };
}

const { createGuard, SuretyGuardError } = require("./guard");

module.exports = { createSuretyClient, createGuard, SuretyGuardError };

// Surety agent SDK.
//
//   const { createSuretyClient } = require("./sdk");
//   const surety = createSuretyClient({ relayUrl: "https://relay.example", fetch: payingFetch });
//   const { response, verdict, claim } = await surety.call(providerAddress, "/quote");
//
// Pass your x402-enabled fetch (for example one wrapped by @x402/fetch) as `fetch`
// and payments keep working exactly as before: the relay forwards the 402
// handshake and the payment headers untouched.

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
          ? { id: h.get("x-surety-claim-id"), tx: h.get("x-surety-claim-tx"), payout: h.get("x-surety-claim-payout") }
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

module.exports = { createSuretyClient };

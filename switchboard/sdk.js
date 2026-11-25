// Switchboard agent SDK.
//
//   const { createSwitchboard } = require("./sdk");
//   const sb = createSwitchboard({ url: "https://<switchboard-host>", fetch: payingFetch });
//   const r = await sb.call("price.mon", { maxPrice: "0.01", minTrust: 30 });
//   r.response, r.provider, r.verdict, r.claim, r.attempts
//
// `fetch` is your x402-paying fetch (for example from @x402/fetch, optionally on top of a
// Surety guard). It pays for the lookup and for each provider call. Calls go through the
// Surety relay, so a failed paid call is refunded from the provider's bond, and the SDK
// moves on to the next provider.

class SwitchboardError extends Error {
  constructor(message, attempts = []) {
    super(message);
    this.name = "SwitchboardError";
    this.attempts = attempts;
  }
}

/**
 * @param {object} o
 * @param {string} o.url                 Switchboard server
 * @param {typeof fetch} [o.fetch]       x402-paying fetch
 * @param {number} [o.cacheMs]           reuse a lookup this long (default 30 s), so you pay once per window
 */
function createSwitchboard({ url, fetch: f = globalThis.fetch, cacheMs = 30_000, now = Date.now }) {
  const base = url.replace(/\/+$/, "");
  const cache = new Map();

  /** Ranked candidates for a capability. Paid per lookup; cached for cacheMs. */
  async function route(capability, { maxPrice, minTrust, limit } = {}) {
    const q = new URLSearchParams({ capability });
    if (maxPrice != null) q.set("maxPrice", String(maxPrice));
    if (minTrust != null) q.set("minTrust", String(minTrust));
    if (limit != null) q.set("limit", String(limit));
    const key = q.toString();
    const hit = cache.get(key);
    if (hit && now() - hit.at < cacheMs) return hit.body;
    const res = await f(`${base}/v1/route?${key}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new SwitchboardError(`route lookup failed (${res.status} ${body.error || ""})`.trim());
    }
    const body = await res.json();
    cache.set(key, { at: now(), body });
    return body;
  }

  /**
   * Calls the best provider for `capability`, falling back down the list.
   * @param {string} capability
   * @param {object} [o]
   * @param {Record<string,string>} [o.params]  fills ":name" path segments, e.g. { address: "0x..." }
   * @param {Record<string,string>} [o.query]
   * @param {RequestInit} [o.init]
   * @param {string|number} [o.maxPrice]        dollars per call
   * @param {number} [o.minTrust]               0 to 100
   * @param {number} [o.attempts]               providers to try at most (default 3)
   */
  async function call(capability, { params = {}, query, init, maxPrice, minTrust, attempts = 3 } = {}) {
    const r = await route(capability, { maxPrice, minTrust, limit: Math.max(attempts, 1) });
    const tried = [];
    for (const c of r.candidates.slice(0, attempts)) {
      const path = c.path.replace(/:([A-Za-z_]\w*)/g, (_m, name) => {
        if (params[name] == null) throw new SwitchboardError(`missing param "${name}" for ${c.path}`);
        return encodeURIComponent(String(params[name]));
      });
      const qs = query ? `?${new URLSearchParams(query)}` : "";
      let response;
      try {
        response = await f(`${r.relay}/call/${c.provider}${path}${qs}`, init);
      } catch (e) {
        tried.push({ provider: c.provider, error: String(e.message || e) });
        continue;
      }
      const h = response.headers;
      const verdict = h.get("x-surety-verdict");
      const claim =
        h.get("x-surety-claim") === "paid"
          ? { id: h.get("x-surety-claim-id"), tx: h.get("x-surety-claim-tx"), payout: h.get("x-surety-claim-payout") }
          : null;
      const attempt = { provider: c.provider, host: c.host, status: response.status, verdict, reason: h.get("x-surety-reason"), latencyMs: Number(h.get("x-surety-latency-ms")) || null, claim };
      tried.push(attempt);
      if (response.ok && verdict !== "fail") return { ...attempt, response, attempts: tried };
      await response.arrayBuffer().catch(() => {}); // free the connection before trying the next one
    }
    cache.clear(); // the ranking let us down: look again next time
    throw new SwitchboardError(`no provider answered "${capability}" (${tried.length} tried)`, tried);
  }

  return { route, call };
}

module.exports = { createSwitchboard, SwitchboardError };

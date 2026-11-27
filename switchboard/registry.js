// The registry: every bonded provider Switchboard can route to, grouped by capability.
//
// Where the data comes from:
//   1. Surety's /providers.json        which providers exist, their trust score and cover
//   2. the vault on-chain              each provider's SLA link (metadataURI)
//   3. each provider's SLA document    its endpoints, and optionally a "capability" per endpoint
//   4. an unpaid probe of the endpoint is it up, how fast, and what it charges (the 402 answer)
//   5. Tally's /scores.json (optional) a trust score rebuilt from chain data alone. When Tally is set
//                                      and fresh, its score replaces the relay's, so ranking no longer
//                                      takes the relay's word for how reliable a provider is
//
// Nothing here pays or signs. A probe is a normal request without payment: the provider
// answers 402 with its price and nobody is charged.
const { ethers } = require("ethers");
const { assertPublicUrl } = require("./netguard");
const { parseAccepts, pickPrice } = require("./price");
const defaultCatalog = require("./capabilities.json");

const VAULT_ABI = [
  "function providers(address) view returns (bool registered, uint64 bondReadyAt, uint64 claimCount, uint128 bond, uint128 bondPendingWithdraw, uint128 backingAssets, uint128 claimsPaid, uint256 backingShares, uint256 backingSharesPending, string metadataURI)",
];
const PROBE_ADDRESS = "0x0000000000000000000000000000000000000001";

/**
 * @param {object} o
 * @param {string} o.suretyUrl            the Surety relay agents' calls go through
 * @param {string} o.caip                 payment network, e.g. "eip155:143"
 * @param {string} o.usdc                 payment token
 * @param {{ providers(addr: string): Promise<any> }} [o.vault]   reads metadataURI; built from rpc+vaultAddress if absent
 * @param {string} [o.rpc] @param {string} [o.vaultAddress]
 * @param {string[]} [o.extraProviders]   addresses to index even if Surety's directory doesn't list them
 * @param {string} [o.tallyUrl]           a Tally server: rank by its chain-verified score instead of the relay's
 * @param {number} [o.tallyMaxAgeMs]      ignore Tally scores older than this (default 24 hours)
 * @param {object} [o.catalog]            capability -> { description, paths, params }
 * @param {typeof fetch} [o.fetch]
 * @param {number} [o.ttlMs]              how long an index stays fresh
 * @param {number} [o.probeTimeoutMs]
 * @param {boolean} [o.allowInsecure]     allow http:// and private addresses (local tests only)
 * @param {() => number} [o.now]
 */
function createRegistry(o) {
  const f = o.fetch || globalThis.fetch;
  const now = o.now || Date.now;
  const ttlMs = o.ttlMs ?? 60_000;
  const probeTimeoutMs = o.probeTimeoutMs ?? 5_000;
  const catalog = o.catalog || defaultCatalog;
  const surety = o.suretyUrl.replace(/\/+$/, "");
  const tally = o.tallyUrl ? o.tallyUrl.replace(/\/+$/, "") : null;
  const tallyMaxAgeMs = o.tallyMaxAgeMs ?? 24 * 3_600_000;

  /// Tally's scores by provider address, or null when Tally is not set, unreachable, or stale.
  /// Whether a provider is covered right now is still read live from Surety: Tally is a snapshot.
  async function loadTally() {
    if (!tally) return null;
    try {
      const d = await getJson(`${tally}/scores.json`, 5_000);
      if (!Array.isArray(d.providers) || !Number.isFinite(d.updatedAt)) return null;
      if (now() - d.updatedAt * 1000 > tallyMaxAgeMs) return null;
      const byAddr = new Map();
      for (const p of d.providers) {
        const score = Number(p.score);
        if (ethers.isAddress(p.provider) && Number.isFinite(score) && score >= 0 && score <= 100) {
          byAddr.set(ethers.getAddress(p.provider), { score, demo: Array.isArray(p.flags) && p.flags.includes("demo") });
        }
      }
      return byAddr;
    } catch {
      return null;
    }
  }
  const vault =
    o.vault || new ethers.Contract(o.vaultAddress, VAULT_ABI, new ethers.JsonRpcProvider(o.rpc, undefined, { staticNetwork: true }));

  // Which catalog capability a provider endpoint path serves.
  const byPath = new Map();
  for (const [cap, def] of Object.entries(catalog)) for (const p of def.paths || []) byPath.set(p, cap);
  const CAP_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  const capabilityOf = (e) => (typeof e.capability === "string" && CAP_RE.test(e.capability) ? e.capability : byPath.get(e.path) || null);

  async function getJson(url, ms = 10_000) {
    const res = await f(url, { signal: AbortSignal.timeout(ms), redirect: "error", headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res.json();
  }

  async function loadSlaDoc(uri) {
    if (uri.startsWith("data:application/json;base64,")) return JSON.parse(Buffer.from(uri.slice(29), "base64").toString("utf8"));
    await assertPublicUrl(uri, o.allowInsecure);
    return getJson(uri);
  }

  /// Unpaid request: up?, latency, and the price from the 402 answer.
  async function probe(baseUrl, path) {
    const filled = path.replace(/:([A-Za-z_]\w*)/g, (_m, name) => (/address/i.test(name) ? PROBE_ADDRESS : "probe"));
    const started = performance.now();
    try {
      await assertPublicUrl(baseUrl + filled, o.allowInsecure);
      const res = await f(baseUrl + filled, { signal: AbortSignal.timeout(probeTimeoutMs), redirect: "manual", headers: { accept: "application/json" } });
      const latencyMs = Math.round(performance.now() - started);
      const text = await res.text();
      if (res.status !== 402) return { up: res.status < 500, latencyMs, price: null, payTo: null, note: `status_${res.status}` };
      const best = pickPrice(parseAccepts(res.headers, text), { caip: o.caip, usdc: o.usdc });
      return best
        ? { up: true, latencyMs, price: best.amount, payTo: best.payTo, note: "ok" }
        : { up: true, latencyMs, price: null, payTo: null, note: "no_usdc_option" };
    } catch (e) {
      return { up: false, latencyMs: null, price: null, payTo: null, note: String(e.message || e).slice(0, 80) };
    }
  }

  async function indexProvider(t, tallyScores) {
    const addr = ethers.getAddress(t.provider);
    const verified = tallyScores ? tallyScores.get(addr) : null;
    if (verified && verified.demo) return []; // says itself that it fails on purpose
    const rec = await vault.providers(addr);
    if (!rec.registered || !rec.metadataURI) return [];
    const doc = await loadSlaDoc(rec.metadataURI);
    if (!doc || doc.version !== 1 || !Array.isArray(doc.endpoints)) return [];
    const baseUrl = new URL(doc.baseUrl).origin;
    const routes = [];
    for (const e of doc.endpoints) {
      const method = String(e.method || "GET").toUpperCase();
      if (method !== "GET" || typeof e.path !== "string" || !e.path.startsWith("/")) continue; // MVP: GET only
      if (e.path.startsWith("/v1/demo/")) continue; // Surety's own deliberately-failing demo
      const capability = capabilityOf(e);
      if (!capability) continue;
      const p = await probe(baseUrl, e.path);
      routes.push({
        capability,
        provider: addr,
        host: new URL(baseUrl).host,
        method,
        path: e.path,
        params: [...e.path.matchAll(/:([A-Za-z_]\w*)/g)].map((m) => m[1]),
        maxLatencyMs: e.maxLatencyMs,
        price: p.price == null ? null : p.price.toString(),
        up: p.up,
        probeLatencyMs: p.latencyMs,
        probe: p.note,
        active: Boolean(t.active),
        // Tally's score when it has one for this provider; the relay's own otherwise.
        score: verified ? verified.score : Number(t.score) || 0,
        scoreSource: verified ? "tally" : "relay",
        passRate: t.passRate ?? null,
        calls: Number(t.calls) || 0,
        committedCover: String(t.committedCover ?? "0"),
        claimCount: Number(t.claimCount) || 0,
      });
    }
    return routes;
  }

  let state = { at: 0, routes: [], providers: 0, errors: [], scores: "relay" };
  let inflight = null;

  async function refresh() {
    const listed = await getJson(`${surety}/providers.json`).then((d) => d.providers || []).catch(() => []);
    const seen = new Set(listed.map((p) => ethers.getAddress(p.provider)));
    const extra = (o.extraProviders || []).map((a) => ethers.getAddress(a)).filter((a) => !seen.has(a));
    const extraTrust = await Promise.all(extra.map((a) => getJson(`${surety}/trust/${a}`).catch(() => null)));
    const all = [...listed, ...extraTrust.filter(Boolean)];
    const tallyScores = await loadTally();
    const errors = [];
    if (tally && !tallyScores) errors.push({ provider: null, error: "tally_unavailable_or_stale: ranking by the relay's scores" });
    const results = await Promise.all(
      all.map((t) =>
        indexProvider(t, tallyScores).catch((e) => {
          errors.push({ provider: t.provider, error: String(e.message || e).slice(0, 120) });
          return [];
        })
      )
    );
    state = { at: now(), routes: results.flat(), providers: all.length, errors, scores: tallyScores ? "tally" : "relay" };
    return state;
  }

  /// The current index. Serves a stale copy while a refresh runs in the background.
  async function snapshot() {
    const fresh = now() - state.at < ttlMs;
    if (fresh) return state;
    if (!inflight) inflight = refresh().finally(() => (inflight = null));
    return state.at ? state : inflight;
  }

  /**
   * Routable providers for a capability, best first: covered, up, priced, trusted enough,
   * under the price cap. Sorted by price, then trust score, then probe latency.
   */
  async function rank(capability, { maxPrice = null, minTrust = 0, limit = 5 } = {}) {
    const s = await snapshot();
    return s.routes
      .filter((r) => r.capability === capability && r.active && r.up && r.price != null)
      .filter((r) => r.score >= minTrust && (maxPrice == null || BigInt(r.price) <= maxPrice))
      .sort(
        (a, b) =>
          (BigInt(a.price) < BigInt(b.price) ? -1 : BigInt(a.price) > BigInt(b.price) ? 1 : 0) ||
          b.score - a.score ||
          (a.probeLatencyMs ?? 1e9) - (b.probeLatencyMs ?? 1e9)
      )
      .slice(0, limit);
  }

  /// One line per capability for the dashboard and /v1/capabilities.
  async function capabilities() {
    const s = await snapshot();
    const out = {};
    for (const [cap, def] of Object.entries(catalog)) out[cap] = { capability: cap, description: def.description, providers: 0, routable: 0, bestPrice: null };
    for (const r of s.routes) {
      const c = (out[r.capability] ||= { capability: r.capability, description: null, providers: 0, routable: 0, bestPrice: null });
      c.providers += 1;
      if (r.active && r.up && r.price != null) {
        c.routable += 1;
        if (c.bestPrice == null || BigInt(r.price) < BigInt(c.bestPrice)) c.bestPrice = r.price;
      }
    }
    return { indexedAt: s.at ? new Date(s.at).toISOString() : null, providers: s.providers, scores: s.scores, capabilities: Object.values(out), errors: s.errors };
  }

  return { rank, capabilities, snapshot, refresh, probe };
}

module.exports = { createRegistry, VAULT_ABI };

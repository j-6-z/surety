// Surety Guard: spending limits for an agent that pays over x402.
//
//   const guard = createGuard({ relayUrl, maxPerCall: "0.01", dailyBudget: "1", minTrustScore: 30 });
//   const payingFetch = wrapFetchWithPayment(guard.fetch, x402client);   // the guard sits UNDER the payer
//   const surety = createSuretyClient({ relayUrl, fetch: payingFetch });
//
// The guard reads every payment the x402 client has signed, before it leaves this
// process, and refuses to send one that breaks a rule:
//   - more than `maxPerCall`, or more than is left of today's `dailyBudget`
//   - to a provider that is not on your list, not bonded, or under your trust score
//   - not through the Surety relay (so it could not be refunded), or in another token
//
// WHAT THIS IS NOT: it is a guardrail against bugs and runaway loops, not a vault.
// Anyone holding the agent's key can sign payments without going through it.
const fs = require("fs");
const path = require("path");

const MONAD_TESTNET_USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

class SuretyGuardError extends Error {
  /** @param {string} code  @param {string} message  @param {object} [detail] */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "SuretyGuardError";
    this.code = code;
    Object.assign(this, detail);
  }
}

/// "0.01" (USDC) -> 10000n (base units, 6 decimals). Rejects anything that is not a plain amount.
function toAtomic(v, what) {
  const s = String(v).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`${what} must be a USDC amount like "0.01" (at most 6 decimals).`);
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}
const toUsdc = (a) => {
  const s = (a < 0n ? -a : a).toString().padStart(7, "0");
  return `${a < 0n ? "-" : ""}${s.slice(0, -6)}.${s.slice(-6)}`.replace(/\.?0+$/, "") || "0";
};

/// The signed payment the x402 client attached: who is paid, how much, in which token.
function readPayment(headers) {
  const raw = headers.get("payment-signature") || headers.get("x-payment");
  if (!raw) return null;
  try {
    const p = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    const auth = p.payload && p.payload.authorization;
    const accepted = p.accepted || {};
    const value = auth && auth.value !== undefined ? auth.value : accepted.amount ?? accepted.maxAmountRequired;
    if (!/^\d+$/.test(String(value))) return { unreadable: true };
    return { amount: BigInt(value), payTo: (auth && auth.to) || accepted.payTo || null, asset: accepted.asset || null };
  } catch {
    return { unreadable: true };
  }
}

/// True if the response carries an x402 settlement receipt (the payment went through).
function settledTx(headers) {
  const raw = headers.get("payment-response") || headers.get("x-payment-response");
  if (!raw) return null;
  for (const text of [raw, Buffer.from(raw, "base64").toString("utf8")]) {
    try {
      const o = JSON.parse(text);
      if (o && o.success !== false && typeof (o.transaction || o.txHash) === "string") return o.transaction || o.txHash;
    } catch {
      /* try the other encoding */
    }
  }
  return null;
}

/**
 * @param {object} o
 * @param {string} o.relayUrl                 the Surety relay your agent calls through
 * @param {string|number} [o.maxPerCall]      most one call may cost, in USDC
 * @param {string|number} [o.dailyBudget]     most the agent may spend per UTC day, in USDC, net of refunds
 * @param {string[]} [o.providers]            if set, only these provider addresses may be paid
 * @param {boolean} [o.bondedOnly]            only pay providers whose calls are covered right now (default true)
 * @param {number} [o.minTrustScore]          only pay providers at or above this score, 0 to 100 (default 0)
 * @param {string} [o.tallyUrl]               a Tally server. minTrustScore is then checked against Tally's score,
 *                                            which is rebuilt from the chain alone, instead of the relay's own.
 *                                            A provider Tally marks as a demo is never paid.
 * @param {"relay"|"block"} [o.tallyFallback] when Tally cannot be read, is stale, or has no score for a provider:
 *                                            "relay" uses the relay's score (default), "block" refuses the payment
 * @param {number} [o.tallyMaxAgeMs]          how old Tally's scores may be (default 24 hours)
 * @param {string} [o.token]                  the only token payments may be made in (default: Monad testnet USDC)
 * @param {string} [o.logFile]                where to keep the spend log; also makes the daily budget survive restarts
 * @param {number} [o.trustTtlMs]             how long a provider's record is reused (default 60 s)
 * @param {typeof fetch} [o.fetch] @param {() => number} [o.now]
 */
function createGuard(o) {
  if (!o || !o.relayUrl) throw new Error("relayUrl is required.");
  const relay = new URL(o.relayUrl);
  const f = o.fetch || globalThis.fetch;
  const now = o.now || Date.now;
  const maxPerCall = o.maxPerCall === undefined ? null : toAtomic(o.maxPerCall, "maxPerCall");
  const dailyBudget = o.dailyBudget === undefined ? null : toAtomic(o.dailyBudget, "dailyBudget");
  const bondedOnly = o.bondedOnly !== false;
  const minTrustScore = o.minTrustScore ?? 0;
  const token = (o.token || MONAD_TESTNET_USDC).toLowerCase();
  const trustTtlMs = o.trustTtlMs ?? 60_000;
  const tally = o.tallyUrl ? new URL(o.tallyUrl) : null;
  const tallyFallback = o.tallyFallback || "relay";
  if (tallyFallback !== "relay" && tallyFallback !== "block") throw new Error('tallyFallback must be "relay" or "block".');
  const tallyMaxAgeMs = o.tallyMaxAgeMs ?? 24 * 3_600_000;
  let allow = null;
  if (o.providers) {
    for (const a of o.providers) if (!ADDRESS.test(a)) throw new Error(`providers: "${a}" is not an address.`);
    allow = new Set(o.providers.map((a) => a.toLowerCase()));
  }

  // ---- today's spending (UTC day). `pending` covers payments sent but not yet answered.
  const today = () => new Date(now()).toISOString().slice(0, 10);
  let day = today(), spent = 0n, pending = 0n;
  const entries = [];
  if (o.logFile && fs.existsSync(o.logFile)) {
    for (const line of fs.readFileSync(o.logFile, "utf8").split("\n")) {
      if (!line.startsWith(`{"at":"${day}`)) continue;
      try {
        const e = JSON.parse(line);
        if (e.paid) spent += toAtomic(e.paid, "log") - toAtomic(e.refunded || "0", "log");
        entries.push(e);
      } catch {
        /* a torn line from a crash: skip it */
      }
    }
  }
  if (o.logFile) fs.mkdirSync(path.dirname(path.resolve(o.logFile)), { recursive: true });
  function rollDay() {
    if (today() !== day) { day = today(); spent = 0n; }
  }
  function record(e) {
    const entry = { at: new Date(now()).toISOString(), ...e };
    entries.push(entry);
    if (entries.length > 1000) entries.shift();
    if (o.logFile) fs.appendFileSync(o.logFile, JSON.stringify(entry) + "\n");
    return entry;
  }

  // ---- provider records, from the relay
  const trustCache = new Map();
  async function trustOf(provider) {
    const hit = trustCache.get(provider);
    if (hit && now() - hit.at < trustTtlMs) return hit.value;
    let value;
    try {
      const res = await f(new URL(`/trust/${provider}`, relay));
      if (!res.ok) throw new Error(String(res.status));
      value = await res.json();
    } catch {
      throw new SuretyGuardError("trust_unavailable", "Could not read this provider's record from the relay, so the payment was not sent.", { provider });
    }
    trustCache.set(provider, { at: now(), value });
    return value;
  }

  // ---- Tally's scores (one small free file for every provider), reused like the relay's records
  let tallyCache = null;
  /// { score, demo } for this provider, or null when Tally cannot vouch for it right now.
  async function tallyOf(provider) {
    if (!tallyCache || now() - tallyCache.at >= trustTtlMs) {
      let byAddr = null;
      try {
        const res = await f(new URL("/scores.json", tally));
        if (!res.ok) throw new Error(String(res.status));
        const d = await res.json();
        if (Array.isArray(d.providers) && Number.isFinite(d.updatedAt) && now() - d.updatedAt * 1000 <= tallyMaxAgeMs) {
          byAddr = new Map();
          for (const p of d.providers) {
            const score = Number(p.score);
            if (ADDRESS.test(p.provider || "") && Number.isFinite(score) && score >= 0 && score <= 100) {
              byAddr.set(p.provider.toLowerCase(), { score, demo: Array.isArray(p.flags) && p.flags.includes("demo") });
            }
          }
        }
      } catch {
        /* unreachable: treated like stale */
      }
      tallyCache = { at: now(), byAddr };
    }
    return tallyCache.byAddr ? tallyCache.byAddr.get(provider.toLowerCase()) || null : null;
  }

  /** Use this as the fetch underneath your x402 client. Free requests pass straight through. */
  async function guardedFetch(input, init) {
    const req = new Request(input, init);
    const pay = readPayment(req.headers);
    if (!pay) return f(req); // nothing is being paid on this request

    const url = new URL(req.url);
    const parts = url.pathname.split("/");
    const viaRelay = url.origin === relay.origin && parts[1] === "call" && ADDRESS.test(parts[2] || "");
    const provider = viaRelay ? parts[2] : null;
    const callPath = viaRelay ? "/" + parts.slice(3).join("/") : url.pathname;
    const block = (code, message, detail = {}) => {
      record({ blocked: code, provider, path: callPath, ...(pay.amount !== undefined ? { amount: toUsdc(pay.amount) } : {}) });
      return new SuretyGuardError(code, message, { provider, path: callPath, ...detail });
    };

    if (pay.unreadable) throw block("unreadable_payment", "The payment attached to this call could not be read, so it was not sent.");
    if (!viaRelay) throw block("not_through_surety", `Payments must go through ${relay.origin}/call/<provider>/… so a failed call can be refunded.`);
    if (pay.asset && pay.asset.toLowerCase() !== token) throw block("wrong_token", `This call asks to be paid in ${pay.asset}, which is not the token you allow.`);
    if (allow && !allow.has(provider.toLowerCase())) throw block("provider_not_allowed", `${provider} is not on your list of providers.`);
    if (maxPerCall !== null && pay.amount > maxPerCall) {
      throw block("over_call_cap", `This call costs ${toUsdc(pay.amount)} USDC. Your limit per call is ${toUsdc(maxPerCall)}.`, { amount: toUsdc(pay.amount) });
    }
    if (bondedOnly || minTrustScore > 0 || tally) {
      const t = await trustOf(provider);
      if (bondedOnly && !t.active) throw block("provider_not_bonded", `${provider} has no active bond, so a failed call would not be refunded.`);
      // Whether the bond is live is always the relay's to say. The score is Tally's when you asked for that.
      let score = Number(t.score), source = "relay";
      if (tally) {
        const v = await tallyOf(provider);
        if (v && v.demo) throw block("demo_provider", `${provider} is a demo provider that fails on purpose.`);
        if (v) { score = v.score; source = "tally"; }
        else if (tallyFallback === "block") throw block("tally_unavailable", `Tally has no current score for ${provider}, so the payment was not sent.`);
      }
      if (score < minTrustScore) throw block("trust_too_low", `${provider} has a trust score of ${score}. You require ${minTrustScore}.`, { score, scoreSource: source });
    }
    rollDay();
    if (dailyBudget !== null && spent + pending + pay.amount > dailyBudget) {
      const left = dailyBudget - spent - pending;
      throw block("over_daily_budget", `This call costs ${toUsdc(pay.amount)} USDC and only ${toUsdc(left > 0n ? left : 0n)} of today's ${toUsdc(dailyBudget)} is left.`, { amount: toUsdc(pay.amount) });
    }

    pending += pay.amount;
    let res;
    try {
      res = await f(req);
    } finally {
      pending -= pay.amount;
    }
    const paymentTx = settledTx(res.headers);
    if (!paymentTx) return res; // the provider did not take the money (an error answer, or a rejected payment)
    const h = (n) => res.headers.get(`x-surety-${n}`);
    const refunded = h("claim") === "paid" && /^\d+$/.test(h("claim-payout") || "") ? BigInt(h("claim-payout")) : 0n;
    rollDay();
    spent += pay.amount - refunded;
    record({
      provider, path: callPath, paid: toUsdc(pay.amount), paymentTx, verdict: h("verdict"), reason: h("reason"),
      ...(refunded ? { refunded: toUsdc(refunded), refundTx: h("claim-tx") } : {}),
    });
    return res;
  }

  const net = () => (rollDay(), spent);
  return {
    fetch: guardedFetch,
    /** Net USDC spent today (UTC), after refunds. */
    spentToday: () => toUsdc(net()),
    /** USDC left in today's budget, or null if no budget is set. */
    remainingToday: () => (dailyBudget === null ? null : toUsdc(dailyBudget - net() > 0n ? dailyBudget - net() : 0n)),
    /** Payments and blocked attempts, oldest first (the last 1000; the full history is in logFile). */
    log: () => entries.slice(),
    limits: {
      maxPerCall: maxPerCall === null ? null : toUsdc(maxPerCall),
      dailyBudget: dailyBudget === null ? null : toUsdc(dailyBudget),
      providers: allow ? [...allow] : null, bondedOnly, minTrustScore, token,
      scoreSource: tally ? "tally" : "relay",
    },
  };
}

module.exports = { createGuard, SuretyGuardError, toAtomic, toUsdc, readPayment };

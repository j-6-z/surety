// Reads what an x402 endpoint charges from its 402 answer, without paying.
//   x402 v2: PAYMENT-REQUIRED header, base64 JSON { accepts: [{ amount, asset, network, payTo }] }
//   x402 v1: JSON body                         { accepts: [{ maxAmountRequired, asset, network, payTo }] }

function decode(raw) {
  if (!raw) return null;
  for (const text of [raw, safeBase64(raw)]) {
    if (!text) continue;
    try {
      return JSON.parse(text);
    } catch {
      /* try the next encoding */
    }
  }
  return null;
}
function safeBase64(s) {
  try {
    return Buffer.from(s, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/// All payment options a 402 response offers, normalised. `bodyText` is used for v1.
function parseAccepts(headers, bodyText) {
  const doc = decode(headers.get("payment-required")) || decode(bodyText);
  const list = doc && Array.isArray(doc.accepts) ? doc.accepts : [];
  return list
    .map((a) => {
      const amount = a.amount ?? a.maxAmountRequired;
      if (amount == null || !/^\d+$/.test(String(amount))) return null;
      return {
        scheme: a.scheme || "exact",
        network: String(a.network || ""),
        asset: String(a.asset || ""),
        payTo: String(a.payTo || ""),
        amount: BigInt(amount),
      };
    })
    .filter(Boolean);
}

/// The cheapest option payable in `usdc` on `caip`, or null. v1 used names like "monad", so a
/// missing CAIP match falls back to any option in the right asset.
function pickPrice(accepts, { caip, usdc }) {
  const inAsset = accepts.filter((a) => a.asset.toLowerCase() === usdc.toLowerCase());
  const exact = inAsset.filter((a) => a.network === caip);
  const pool = exact.length ? exact : inAsset;
  if (!pool.length) return null;
  return pool.reduce((m, a) => (a.amount < m.amount ? a : m));
}

/// "$0.001" / "0.001" -> atomic USDC (6 decimals) as BigInt.
function usdToAtomic(v) {
  const s = String(v).trim().replace(/^\$/, "");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`not a dollar amount: ${v}`);
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
}
const atomicToUsd = (a) => Number(a) / 1e6;

module.exports = { parseAccepts, pickPrice, usdToAtomic, atomicToUsd };

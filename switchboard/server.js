// The Switchboard server.
//
//   GET /                       dashboard (browsers) or a description (agents)
//   GET /v1/capabilities        free: what can be routed, how many providers, best price
//   GET /v1/route?capability=   PAID per lookup (x402): ranked, callable bonded providers
//   GET /v1/stats               free: lookups served since this instance started
//   GET /health
//
// Switchboard never touches the agent's call or its money. It answers "who should I call",
// the agent pays that provider directly through the Surety relay, and Surety refunds a failed
// call from the provider's bond. Switchboard's own revenue is the small fee on each lookup.
const express = require("express");
const { paymentMiddleware, x402ResourceServer } = require("@x402/express");
const { HTTPFacilitatorClient } = require("@x402/core/server");
const { ExactEvmScheme } = require("@x402/evm/exact/server");
const { usdToAtomic, atomicToUsd } = require("./price");
const { dashboardPage } = require("./page");

const CAP_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * @param {object} c
 * @param {ReturnType<import("./registry").createRegistry>} c.registry
 * @param {string} c.suretyUrl        relay agents call through
 * @param {string} c.caip @param {string} c.usdc @param {string} c.label
 * @param {string} [c.payTo]          wallet that receives lookup fees. No payTo: lookups are free.
 * @param {string} [c.routePrice]     per lookup, e.g. "$0.0001"
 * @param {string} [c.facilitatorUrl]
 * @param {{name: string, version: string}} [c.tokenDomain]
 * @param {string} [c.explorer]
 * @param {(app: import("express").Express) => void} [c.paywall]   tests can replace the x402 paywall
 */
function buildApp(c) {
  const routePrice = c.routePrice || "$0.0001";
  const charging = Boolean(c.payTo);
  const stats = { since: new Date().toISOString(), lookups: 0, byCapability: {} };

  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set("access-control-allow-origin", "*");
    res.set("access-control-expose-headers", "payment-required, payment-response, x-payment-response");
    next();
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.get("/", async (req, res) => {
    if (req.accepts(["json", "html"]) === "html") {
      res.vary("Accept").set("cache-control", "public, max-age=0, s-maxage=30, stale-while-revalidate=300");
      return res.type("html").send(dashboardPage({ label: c.label, suretyUrl: c.suretyUrl, routePrice: charging ? routePrice : "free", explorer: c.explorer }));
    }
    res.vary("Accept").json({
      name: "Switchboard",
      description: "Routes x402 calls to the best Surety-bonded provider on Monad. Failed calls are refunded from the provider's bond.",
      network: c.caip,
      relay: c.suretyUrl,
      pricePerLookup: charging ? routePrice : "free",
      endpoints: ["GET /v1/capabilities", "GET /v1/route?capability=<name>&maxPrice=<usd>&minTrust=<0-100>", "GET /v1/stats"],
      sdk: "npm: see README, createSwitchboard({ url, fetch })",
    });
  });

  app.get("/v1/capabilities", async (_req, res) => {
    try {
      res.set("cache-control", "public, max-age=15").json(await c.registry.capabilities());
    } catch (e) {
      res.status(502).json({ error: "index_unavailable" });
    }
  });

  app.get("/v1/stats", (_req, res) => res.json(stats));

  // Check the request and find candidates BEFORE the paywall: nobody pays for a typo
  // or for an empty answer.
  app.get("/v1/route", async (req, res, next) => {
    const capability = String(req.query.capability || "");
    if (!CAP_RE.test(capability)) return res.status(400).json({ error: "bad_capability" });
    let maxPrice = null;
    if (req.query.maxPrice != null && req.query.maxPrice !== "") {
      try {
        maxPrice = usdToAtomic(req.query.maxPrice);
      } catch {
        return res.status(400).json({ error: "bad_max_price", hint: "dollars, e.g. maxPrice=0.01" });
      }
    }
    const minTrust = req.query.minTrust == null ? 0 : Number(req.query.minTrust);
    if (!Number.isFinite(minTrust) || minTrust < 0 || minTrust > 100) return res.status(400).json({ error: "bad_min_trust" });
    const limit = Math.min(10, Math.max(1, Number(req.query.limit) || 3));
    try {
      const candidates = await c.registry.rank(capability, { maxPrice, minTrust, limit });
      if (!candidates.length) return res.status(404).json({ error: "no_route", capability, hint: "see /v1/capabilities" });
      res.locals.route = { capability, candidates };
      next();
    } catch {
      res.status(502).json({ error: "index_unavailable" });
    }
  });

  if (c.paywall) c.paywall(app);
  else if (charging) {
    const scheme = new ExactEvmScheme();
    scheme.registerMoneyParser(async (amount, network) =>
      network === c.caip
        ? { amount: Math.floor(amount * 1_000_000).toString(), asset: c.usdc, extra: c.tokenDomain || { name: "USDC", version: "2" } }
        : null
    );
    const x402 = new x402ResourceServer(new HTTPFacilitatorClient({ url: c.facilitatorUrl })).register(c.caip, scheme);
    app.use(
      paymentMiddleware(
        {
          "GET /v1/route": {
            accepts: { scheme: "exact", network: c.caip, payTo: c.payTo, price: routePrice },
            description: "Ranked Surety-bonded providers for one capability",
            mimeType: "application/json",
          },
        },
        x402
      )
    );
  }

  app.get("/v1/route", (_req, res) => {
    const { capability, candidates } = res.locals.route;
    stats.lookups += 1;
    stats.byCapability[capability] = (stats.byCapability[capability] || 0) + 1;
    res.json({
      capability,
      relay: c.suretyUrl,
      network: c.caip,
      ttlSec: 30,
      candidates: candidates.map((r) => ({
        provider: r.provider,
        host: r.host,
        path: r.path,
        params: r.params,
        callUrl: `${c.suretyUrl}/call/${r.provider}${r.path}`,
        price: r.price,
        priceUsd: atomicToUsd(r.price),
        maxLatencyMs: r.maxLatencyMs,
        score: r.score,
        scoreSource: r.scoreSource,
        passRate: r.passRate,
        calls: r.calls,
        committedCover: r.committedCover,
      })),
    });
  });

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  return { app, stats };
}

module.exports = { buildApp };

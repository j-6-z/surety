// Surety provider kit: turn a list of endpoints into a paid x402 API that
// publishes its own promise (the SLA document Surety checks every call against).
//
// You should not need to edit this file. Your endpoints live in app.js.
const express = require("express");
const { paymentMiddleware, x402ResourceServer } = require("@x402/express");
const { HTTPFacilitatorClient } = require("@x402/core/server");
const { ExactEvmScheme } = require("@x402/evm/exact/server");

const MONAD_TESTNET = {
  network: "eip155:10143",
  usdc: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
  facilitatorUrl: "https://x402-facilitator.molandak.org",
};
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/// The public https address of this server, from settings or from the host's own variables.
function publicUrlFromEnv(env = process.env) {
  const host = env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL || env.RAILWAY_PUBLIC_DOMAIN;
  return (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || (host && `https://${host}`) || "").replace(/\/+$/, "");
}

/**
 * @param {object} o
 * @param {string} o.name                 shown at "/"
 * @param {string} o.payTo                wallet that receives the payments
 * @param {Array<{
 *   method?: string, path: string, description?: string, price?: string,
 *   maxLatencyMs: number, responseSchema?: object, example?: string, guard?: boolean,
 *   validate?: (req: import("express").Request) => string | null | undefined,
 *   handler: (req: import("express").Request) => any
 * }>} o.endpoints
 * @param {string} [o.description]
 * @param {string} [o.price]              default price per call, e.g. "$0.001"
 * @param {string} [o.publicUrl]          where the API is reachable; needed once it is hosted
 * @param {number} [o.settleReserveMs]    time kept back for payment settlement (default 2000). A handler still
 *                                        running when only this much of its promise is left answers 504 instead:
 *                                        the caller is not charged, so nothing comes out of your bond.
 * @param {string} [o.network] @param {string} [o.usdc] @param {string} [o.facilitatorUrl]
 */
function createBondedApi(o) {
  if (!ADDRESS.test(o.payTo || "")) throw new Error("payTo must be a wallet address (set PAY_TO_ADDRESS).");
  if (!Array.isArray(o.endpoints) || o.endpoints.length === 0) throw new Error("Add at least one endpoint.");
  const network = o.network || MONAD_TESTNET.network;
  const usdc = o.usdc || MONAD_TESTNET.usdc;
  const defaultPrice = o.price || "$0.001";
  const settleReserveMs = o.settleReserveMs ?? 2000;
  let baseUrl = (o.publicUrl || "").replace(/\/+$/, "");

  const seen = new Set();
  const endpoints = o.endpoints.map((e, i) => {
    const method = String(e.method || "GET").toUpperCase();
    const where = `Endpoint ${i + 1} (${method} ${e.path})`;
    if (typeof e.path !== "string" || !e.path.startsWith("/")) throw new Error(`${where}: path must start with "/".`);
    if (e.path.startsWith("/.well-known/") || e.path === "/" || e.path === "/health") throw new Error(`${where}: that path is reserved.`);
    if (!Number.isFinite(e.maxLatencyMs) || e.maxLatencyMs <= 0) throw new Error(`${where}: maxLatencyMs must be a number of milliseconds.`);
    if (typeof e.handler !== "function") throw new Error(`${where}: handler must be a function.`);
    if (seen.has(`${method} ${e.path}`)) throw new Error(`${where}: listed twice.`);
    seen.add(`${method} ${e.path}`);
    // Promises shorter than the reserve cannot be guarded: there is no time left to give up in.
    const deadlineMs = e.guard !== false && e.maxLatencyMs > settleReserveMs ? e.maxLatencyMs - settleReserveMs : null;
    return { ...e, method, price: e.price || defaultPrice, deadlineMs };
  });

  const scheme = new ExactEvmScheme();
  scheme.registerMoneyParser(async (amount, net) =>
    net === network ? { amount: Math.round(amount * 1_000_000).toString(), asset: usdc, extra: { name: "USDC", version: "2" } } : null
  );
  const x402 = new x402ResourceServer(new HTTPFacilitatorClient({ url: o.facilitatorUrl || MONAD_TESTNET.facilitatorUrl })).register(network, scheme);

  /// Runs one handler under its deadline. Used by the paid routes and by "npm run check".
  const LATE = Symbol("late");
  async function run(e, req) {
    if (!e.deadlineMs) return e.handler(req);
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(resolve, e.deadlineMs, LATE); });
    try {
      const work = Promise.resolve().then(() => e.handler(req));
      work.catch(() => {}); // a failure after the deadline has nowhere to go
      const out = await Promise.race([work, late]);
      if (out === LATE) throw Object.assign(new Error("too_slow_not_charged"), { status: 504 });
      return out;
    } finally {
      clearTimeout(timer);
    }
  }

  /// The promise Surety holds this API to. Served at /.well-known/surety.json.
  const sla = () => ({
    version: 1,
    baseUrl,
    payTo: o.payTo,
    endpoints: endpoints.map((e) => ({
      method: e.method,
      path: e.path,
      maxLatencyMs: e.maxLatencyMs,
      ...(e.responseSchema ? { responseSchema: e.responseSchema } : {}),
    })),
  });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));
  const cached = (res) => res.set("cache-control", "public, max-age=60");
  app.get("/", (_req, res) =>
    cached(res).json({
      name: o.name || "Bonded x402 API",
      ...(o.description ? { description: o.description } : {}),
      paymentNetwork: network,
      endpoints: endpoints.map((e) => ({ method: e.method, path: e.path, price: e.price, maxLatencyMs: e.maxLatencyMs, description: e.description })),
      sla: `${baseUrl}/.well-known/surety.json`,
    })
  );
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/.well-known/surety.json", (_req, res) => cached(res).json(sla()));

  // Bad input is rejected BEFORE the paywall, so nobody pays for a typo.
  for (const e of endpoints) {
    if (!e.validate) continue;
    app[e.method.toLowerCase()](e.path, (req, res, next) => {
      const problem = e.validate(req);
      problem ? res.status(400).json({ error: problem }) : next();
    });
  }
  app.use(
    paymentMiddleware(
      Object.fromEntries(
        endpoints.map((e) => [
          `${e.method} ${e.path}`,
          { accepts: { scheme: "exact", network, payTo: o.payTo, price: e.price }, description: e.description || e.path, mimeType: "application/json" },
        ])
      ),
      x402
    )
  );
  // A handler that throws answers with an error status. x402 only settles on success, so the caller is not charged.
  for (const e of endpoints) {
    app[e.method.toLowerCase()](e.path, async (req, res) => {
      try {
        res.json(await run(e, req));
      } catch (err) {
        res.status(err.status || 502).json({ error: err.status ? err.message : "upstream_error" });
      }
    });
  }
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));

  let httpServer;
  const listen = (port = 0, host = "127.0.0.1") =>
    new Promise((resolve) => {
      httpServer = app.listen(port, host, () => {
        if (!baseUrl) baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
        resolve(baseUrl);
      });
    });
  return { app, sla, endpoints, run, settleReserveMs, listen, close: () => new Promise((r) => httpServer.close(r)), slaUrl: () => `${baseUrl}/.well-known/surety.json` };
}

module.exports = { createBondedApi, publicUrlFromEnv, MONAD_TESTNET };

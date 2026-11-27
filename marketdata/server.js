// Surety Market Data API: Monad prices read on-chain, sold per call over x402.
//
//   GET /v1/price/mon        MON price in USD from the deepest WMON/USDC pool
//   GET /v1/pool/:address    price and reserves for any Uniswap-V3-style pool
//
// Free: GET / (what this is), /health, /.well-known/surety.json (the SLA).
const express = require("express");
const { ethers } = require("ethers");
const { paymentMiddleware, x402ResourceServer } = require("@x402/express");
const { HTTPFacilitatorClient } = require("@x402/core/server");
const { ExactEvmScheme } = require("@x402/evm/exact/server");
const { createPriceReader, MONAD_MAINNET } = require("./prices");
const { landingPage } = require("./landing");

const PRICE_SCHEMA = {
  type: "object",
  required: ["symbol", "priceUsd", "pool", "block", "timestamp"],
  properties: {
    symbol: { type: "string" },
    priceUsd: { type: "number", exclusiveMinimum: 0 },
    pool: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
    block: { type: "integer", minimum: 1 },
    timestamp: { type: "string" },
  },
};
const POOL_SCHEMA = {
  type: "object",
  required: ["pool", "token0", "token1", "price0In1", "block", "timestamp"],
  properties: {
    pool: { type: "string" },
    price0In1: { type: "number", minimum: 0 },
    block: { type: "integer", minimum: 1 },
    token0: { type: "object", required: ["address", "symbol", "reserve"] },
    token1: { type: "object", required: ["address", "symbol", "reserve"] },
  },
};

/**
 * @param {object} o
 * @param {object} o.reader           from createPriceReader
 * @param {string} o.network          CAIP-2 id payments settle on
 * @param {string} o.usdc             payment token on that network
 * @param {string} o.payTo
 * @param {string} o.facilitatorUrl
 * @param {string} [o.price]          per call, e.g. "$0.001"
 * @param {{name: string, version: string}} [o.tokenDomain]  the token's EIP-712 name and version (default: USDC, 2)
 * @param {number} [o.maxLatencyMs]   what the SLA promises (includes payment settlement time)
 * @param {string} [o.publicUrl]      where the API is reachable; defaults to the local address
 * @param {{slowMs?: number, promiseMs?: number, payTo?: string}} [o.demo]
 *        when set, adds GET /v1/demo/slow: a paid endpoint built to miss its promise, for the homepage demo.
 *        With demo.payTo the demo is its own provider: the endpoint leaves this API's SLA, gets an SLA
 *        document of its own at /.well-known/surety-demo.json, and is paid to demo.payTo. Its refunds
 *        then come out of the demo provider's bond and never touch this API's record.
 * @param {{id?: string, registry?: string}} [o.agent]
 *        ERC-8004 identity. `registry` is the Identity Registry as "eip155:<chain>:<address>". With an
 *        `id`, the SLA carries "agentId", which is how a reputation service links the agent to the bond.
 * @param {{provider: string, vaultAddress: string, repoUrl?: string}} [o.landing]
 *        when set, browsers get a homepage at "/" (agents asking for JSON still get JSON)
 */
function createMarketApi(o) {
  const price = o.price || "$0.001";
  const maxLatencyMs = o.maxLatencyMs ?? 4000; // measured on testnet: 1.3 to 1.6 s including payment settlement
  let baseUrl = o.publicUrl || "";

  const scheme = new ExactEvmScheme();
  scheme.registerMoneyParser(async (amount, network) =>
    network === o.network
      ? { amount: Math.floor(amount * 1_000_000).toString(), asset: o.usdc, extra: o.tokenDomain || { name: "USDC", version: "2" } }
      : null
  );
  const x402 = new x402ResourceServer(new HTTPFacilitatorClient({ url: o.facilitatorUrl })).register(o.network, scheme);
  const demoApart = Boolean(o.demo && o.demo.payTo);
  const paid = (description, payTo = o.payTo) => ({
    accepts: { scheme: "exact", network: o.network, payTo, price },
    description,
    mimeType: "application/json",
  });

  const sla = () => ({
    version: 1,
    baseUrl,
    payTo: o.payTo,
    ...(o.agent && o.agent.id ? { agentId: o.agent.id } : {}),
    endpoints: [
      { method: "GET", path: "/v1/price/mon", maxLatencyMs, responseSchema: PRICE_SCHEMA },
      { method: "GET", path: "/v1/pool/:address", maxLatencyMs, responseSchema: POOL_SCHEMA },
      ...(o.demo && !demoApart ? [demoEndpoint()] : []),
    ],
  });
  // ERC-8004 registration file: what the agent's on-chain record points at.
  const agentFile = () => ({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Surety Market Data API",
    description: "Monad prices read on-chain, sold per call over x402. Bonded on Surety: a call that misses its SLA is refunded on-chain from the bond.",
    image: `${baseUrl}/og.png`,
    services: [{ name: "web", endpoint: baseUrl }, { name: "surety-sla", endpoint: `${baseUrl}/.well-known/surety.json`, version: "1" }],
    x402Support: true,
    active: true,
    registrations: o.agent && o.agent.id && o.agent.registry ? [{ agentId: Number(o.agent.id), agentRegistry: o.agent.registry }] : [],
    supportedTrust: ["reputation", "crypto-economic"],
  });
  const demoEndpoint = () => ({ method: "GET", path: "/v1/demo/slow", maxLatencyMs: o.demo.promiseMs ?? 500 });
  // "demo": true tells anyone scoring providers that this one fails on purpose.
  const demoSla = () => ({ version: 1, demo: true, baseUrl, payTo: o.demo.payTo, endpoints: [demoEndpoint()] });

  const app = express();
  app.disable("x-powered-by");
  app.get("/", (req, res) => {
    if (o.landing && req.accepts(["json", "html"]) === "html") {
      res.set("cache-control", "public, max-age=0, s-maxage=300, stale-while-revalidate=86400").vary("Accept");
      return res.type("html").send(
        landingPage({ url: baseUrl, price, repoUrl: "https://github.com/j-6-z/surety", ...o.landing })
      );
    }
    res.vary("Accept").json({
      name: "Surety Market Data API",
      description: "Monad prices read on-chain, pay per call with x402. Bonded on Surety.",
      pricePerCall: price,
      paymentNetwork: o.network,
      endpoints: ["GET /v1/price/mon", "GET /v1/pool/:address"],
      sla: `${baseUrl}/.well-known/surety.json`,
    });
  });
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/.well-known/surety.json", (_req, res) => res.json(sla()));
  app.get("/.well-known/agent-registration.json", (_req, res) => res.json(agentFile()));
  if (demoApart) app.get("/.well-known/surety-demo.json", (_req, res) => res.json(demoSla()));

  // Reject bad input BEFORE the paywall, so nobody pays for a typo.
  app.get("/v1/pool/:address", (req, res, next) =>
    ethers.isAddress(req.params.address) ? next() : res.status(400).json({ error: "bad_pool_address" })
  );
  app.use(
    paymentMiddleware(
      {
        "GET /v1/price/mon": paid("MON price in USD, on-chain"),
        "GET /v1/pool/:address": paid("Pool price and reserves, on-chain"),
        ...(o.demo ? { "GET /v1/demo/slow": paid("Demo: deliberately slower than its promise", o.demo.payTo || o.payTo) } : {}),
      },
      x402
    )
  );

  // A handler that answers with an error status is never charged: x402 only settles on success.
  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      res.status(e.status || 502).json({ error: e.status ? e.message : "upstream_error", detail: e.detail });
    }
  };
  app.get("/v1/price/mon", handle(() => o.reader.monPrice()));
  app.get("/v1/pool/:address", handle((req) => o.reader.readPool(req.params.address)));
  if (o.demo) {
    app.get("/v1/demo/slow", (_req, res) =>
      setTimeout(() => res.json({ demo: true, note: "This endpoint is slow on purpose." }), o.demo.slowMs ?? 1200)
    );
  }

  let httpServer;
  const listen = (port = 0) =>
    new Promise((resolve) => {
      httpServer = app.listen(port, "127.0.0.1", () => {
        if (!o.publicUrl) baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
        resolve(baseUrl);
      });
    });
  return {
    app, listen, close: () => new Promise((r) => httpServer.close(r)),
    slaUrl: () => `${baseUrl}/.well-known/surety.json`,
    demoSlaUrl: () => (demoApart ? `${baseUrl}/.well-known/surety-demo.json` : null),
  };
}

module.exports = { createMarketApi, PRICE_SCHEMA, POOL_SCHEMA };

if (require.main === module) {
  require("dotenv").config();
  const env = process.env;
  if (!env.PAY_TO_ADDRESS) {
    console.error("Set PAY_TO_ADDRESS in .env (the wallet that receives API payments).");
    process.exit(1);
  }
  const reader = createPriceReader({
    provider: new ethers.JsonRpcProvider(env.DATA_RPC || MONAD_MAINNET.rpc),
    factories: MONAD_MAINNET.factories,
    wmon: MONAD_MAINNET.wmon,
    usdc: MONAD_MAINNET.usdc,
    minUsdcDepth: Number(env.MIN_POOL_USDC || 1000),
  });
  const api = createMarketApi({
    reader,
    network: env.X402_NETWORK || "eip155:10143",
    usdc: env.USDC_ADDRESS || "0x534b2f3A21130d7a60830c2Df862319e593943A3",
    payTo: env.PAY_TO_ADDRESS,
    facilitatorUrl: env.FACILITATOR_URL || "https://x402-facilitator.molandak.org",
    price: env.API_PRICE || "$0.001",
    publicUrl: env.API_PUBLIC_URL,
  });
  api.listen(Number(env.API_PORT || 4021)).then((url) => console.log(`Surety Market Data API on ${url}`));
}

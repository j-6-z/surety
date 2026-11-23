// A REAL x402-paid API (the official @x402/express middleware), with three
// endpoints for exercising Surety: /quote (healthy), /slow (misses its latency
// SLA) and /broken (wrong response shape). It also serves its own SLA document.
const express = require("express");
const { paymentMiddleware, x402ResourceServer } = require("@x402/express");
const { HTTPFacilitatorClient } = require("@x402/core/server");
const { ExactEvmScheme } = require("@x402/evm/exact/server");

const QUOTE_SCHEMA = {
  type: "object",
  required: ["symbol", "price"],
  properties: { symbol: { type: "string" }, price: { type: "number" } },
};

/**
 * @param {object} o
 * @param {string} o.network         CAIP-2 id, e.g. "eip155:10143"
 * @param {string} o.usdc            USDC token address on that network
 * @param {string} o.payTo           wallet that receives payments
 * @param {string} o.facilitatorUrl
 * @param {string} [o.price]         e.g. "$0.001"
 * @param {number} [o.slowMs]        how long /slow sleeps
 * @param {number} [o.slowMaxMs]     latency /slow promises in its SLA
 * @param {number} [o.okMaxMs]       latency the other endpoints promise
 */
function createX402Provider(o) {
  const price = o.price || "$0.001";
  const slowMs = o.slowMs ?? 6000;
  const slowMaxMs = o.slowMaxMs ?? 2000;
  const okMaxMs = o.okMaxMs ?? 15000;
  let baseUrl = "";

  const scheme = new ExactEvmScheme();
  scheme.registerMoneyParser(async (amount, network) =>
    network === o.network
      ? { amount: Math.floor(amount * 1_000_000).toString(), asset: o.usdc, extra: { name: "USDC", version: "2" } }
      : null
  );
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: o.facilitatorUrl })).register(o.network, scheme);

  const paid = (description) => ({
    accepts: { scheme: "exact", network: o.network, payTo: o.payTo, price },
    description,
    mimeType: "application/json",
  });

  const app = express();
  app.get("/.well-known/surety.json", (_req, res) =>
    res.json({
      version: 1,
      baseUrl,
      payTo: o.payTo,
      endpoints: [
        { method: "GET", path: "/quote", maxLatencyMs: okMaxMs, responseSchema: QUOTE_SCHEMA },
        { method: "GET", path: "/slow", maxLatencyMs: slowMaxMs, responseSchema: QUOTE_SCHEMA },
        { method: "GET", path: "/broken", maxLatencyMs: okMaxMs, responseSchema: QUOTE_SCHEMA },
      ],
    })
  );
  app.use(
    paymentMiddleware(
      { "GET /quote": paid("Price quote"), "GET /slow": paid("Slow price quote"), "GET /broken": paid("Broken price quote") },
      server
    )
  );
  app.get("/quote", (_req, res) => res.json({ symbol: "MON", price: 1.23 }));
  app.get("/slow", (_req, res) => setTimeout(() => res.json({ symbol: "MON", price: 1.23 }), slowMs));
  app.get("/broken", (_req, res) => res.json({ oops: "not what the SLA promised" }));

  let httpServer;
  const listen = (port = 0) =>
    new Promise((resolve) => {
      httpServer = app.listen(port, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
        resolve(baseUrl);
      });
    });
  return { listen, close: () => new Promise((r) => httpServer.close(r)), slaUrl: () => `${baseUrl}/.well-known/surety.json` };
}

module.exports = { createX402Provider };

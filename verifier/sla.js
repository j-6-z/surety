// SLA documents and the objective checks run against each response.
//
// A provider hosts an SLA document and registers its URL on-chain as metadataURI:
// {
//   "version": 1,
//   "baseUrl": "https://api.example.com",
//   "payTo": "0x...",                       // wallet that receives x402 payments
//   "endpoints": [
//     { "method": "GET", "path": "/quote", "maxLatencyMs": 800,
//       "responseSchema": { ...JSON Schema for a 2xx body... } }
//   ]
// }
const Ajv = require("ajv");
const { ethers } = require("ethers");

const ajv = new Ajv({ allErrors: true, strict: false });
const compiled = new WeakMap();

function validateSlaDoc(doc) {
  if (!doc || typeof doc !== "object") throw new Error("SLA: not an object");
  if (doc.version !== 1) throw new Error("SLA: unsupported version");
  const baseUrl = new URL(doc.baseUrl); // throws if invalid
  if (!ethers.isAddress(doc.payTo)) throw new Error("SLA: payTo is not an address");
  if (!Array.isArray(doc.endpoints) || doc.endpoints.length === 0) throw new Error("SLA: no endpoints");
  const endpoints = doc.endpoints.map((e, i) => {
    if (typeof e.path !== "string" || !e.path.startsWith("/")) throw new Error(`SLA: endpoint ${i} path`);
    if (!Number.isFinite(e.maxLatencyMs) || e.maxLatencyMs <= 0) throw new Error(`SLA: endpoint ${i} maxLatencyMs`);
    if (e.responseSchema !== undefined) ajv.compile(e.responseSchema); // throws on a bad schema
    return {
      method: String(e.method || "GET").toUpperCase(),
      path: e.path,
      maxLatencyMs: e.maxLatencyMs,
      responseSchema: e.responseSchema,
    };
  });
  return { version: 1, baseUrl: baseUrl.origin, payTo: ethers.getAddress(doc.payTo), endpoints };
}

function matchEndpoint(sla, method, pathname) {
  return sla.endpoints.find((e) => e.method === method.toUpperCase() && e.path === pathname) || null;
}

/// Objective checks only: status, latency, JSON shape. Never "was the answer good".
function checkResponse(endpoint, { status, latencyMs, bodyText }) {
  if (status < 200 || status >= 300) return { pass: false, reason: "bad_status" };
  if (latencyMs > endpoint.maxLatencyMs) return { pass: false, reason: "too_slow" };
  if (endpoint.responseSchema) {
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return { pass: false, reason: "invalid_json" };
    }
    let validate = compiled.get(endpoint);
    if (!validate) {
      validate = ajv.compile(endpoint.responseSchema);
      compiled.set(endpoint, validate);
    }
    if (!validate(body)) return { pass: false, reason: "schema_mismatch" };
  }
  return { pass: true, reason: "ok" };
}

module.exports = { validateSlaDoc, matchEndpoint, checkResponse };

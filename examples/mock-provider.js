// A fake paid API for local testing. It imitates the x402 flow:
//   no payment header  -> 402
//   payment header     -> "settles" (moves USDC from the agent to payTo), then responds
//                         with a PAYMENT-RESPONSE receipt header
// Settlement here is a plain transfer signed by the test agent. On a real
// network the x402 facilitator does this step.
//
// Endpoints: /quote (healthy), /slow (misses its latency SLA), /broken (wrong shape)
const http = require("http");

const QUOTE_SCHEMA = {
  type: "object",
  required: ["symbol", "price"],
  properties: { symbol: { type: "string" }, price: { type: "number" } },
};

/// `network` overrides the chain named on the receipt, for tests that pretend the payment
/// settled somewhere else (give `usdc` that chain's token).
function createMockProvider({ usdc, agentSigner, payTo, price, chainId, network }) {
  let baseUrl = "";
  const sla = () => ({
    version: 1,
    baseUrl,
    payTo,
    endpoints: [
      { method: "GET", path: "/quote", maxLatencyMs: 1500, responseSchema: QUOTE_SCHEMA },
      { method: "GET", path: "/slow", maxLatencyMs: 150, responseSchema: QUOTE_SCHEMA },
      { method: "GET", path: "/broken", maxLatencyMs: 1500, responseSchema: QUOTE_SCHEMA },
    ],
  });

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://x").pathname;
    const reply = (status, headers, obj) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };
    if (pathname === "/.well-known/surety.json") return reply(200, {}, sla());
    if (!["/quote", "/slow", "/broken"].includes(pathname)) return reply(404, {}, { error: "not_found" });
    if (!req.headers["payment-signature"]) return reply(402, {}, { x402Version: 2, error: "payment required" });

    const tx = await usdc.connect(agentSigner).transfer(payTo, price);
    await tx.wait();
    const receipt = Buffer.from(
      JSON.stringify({ success: true, transaction: tx.hash, network: network || `eip155:${chainId}`, payer: agentSigner.address })
    ).toString("base64");
    const paid = { "payment-response": receipt };

    if (pathname === "/slow") await new Promise((r) => setTimeout(r, 400));
    if (pathname === "/broken") return reply(200, paid, { oops: "not what the SLA promised" });
    reply(200, paid, { symbol: "MON", price: 1.23 });
  });

  const listen = () =>
    new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve(baseUrl);
      })
    );
  return { server, listen, slaUrl: () => `${baseUrl}/.well-known/surety.json` };
}

/// Stand-in for an x402 client: on a 402, retry once with a payment header.
function mockPayingFetch(f = globalThis.fetch) {
  return async (url, init = {}) => {
    const first = await f(url, init);
    if (first.status !== 402) return first;
    return f(url, { ...init, headers: { ...(init.headers || {}), "payment-signature": "mock" } });
  };
}

module.exports = { createMockProvider, mockPayingFetch };

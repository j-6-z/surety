// Call the hosted Surety Market Data API as an outside agent.
//
//   AGENT_KEY=0x... node examples/call-api.js https://<surety-host> <providerAddress>
//
// AGENT_KEY is any wallet holding a little Monad testnet USDC (https://faucet.circle.com).
// It pays $0.001 for the call. No gas needed.
const { createSuretyClient } = require("../sdk");
const { createPayingFetch } = require("./x402-client");

require("dotenv").config({ quiet: true });
const [host, provider] = process.argv.slice(2);
// Falls back to PRIVATE_KEY from .env, so the project owner can test without typing a key.
const agentKey = process.env.AGENT_KEY || process.env.PRIVATE_KEY;
if (!host || !provider || !agentKey) {
  console.error("Usage: AGENT_KEY=0x... node examples/call-api.js https://<surety-host> <providerAddress>");
  process.exit(1);
}
const USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3"; // Monad testnet USDC

(async () => {
  const agent = createPayingFetch(agentKey, "eip155:10143", USDC);
  const surety = createSuretyClient({ relayUrl: host, fetch: agent.fetch });
  console.log("Agent:", agent.address);
  console.log("Provider trust:", await surety.trust(provider));
  const r = await surety.call(provider, "/v1/price/mon");
  console.log("Status:", r.response.status, " verdict:", r.verdict, " latency:", r.latencyMs, "ms");
  console.log("Data:", await r.response.json());
  if (r.claim) console.log("Refunded:", r.claim);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

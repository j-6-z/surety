// Call a capability through Switchboard as an agent.
//
//   AGENT_KEY=0x... node examples/call.js https://<switchboard-host> price.mon
//
// AGENT_KEY holds a little USDC on Monad (real money on mainnet). No gas needed.
// It pays the lookup fee (if any) plus the provider's price per call.
require("dotenv").config({ quiet: true });
const { privateKeyToAccount } = require("viem/accounts");
const { wrapFetchWithPayment, x402Client } = require("@x402/fetch");
const { ExactEvmScheme } = require("@x402/evm/exact/client");
const { networkFromEnv } = require("../networks");
const { createSwitchboard } = require("../sdk");

const [host, capability = "price.mon"] = process.argv.slice(2);
const key = process.env.AGENT_KEY;
if (!host || !key) {
  console.error("Usage: AGENT_KEY=0x... node examples/call.js https://<switchboard-host> [capability]");
  process.exit(1);
}
const net = networkFromEnv();
const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
const client = new x402Client()
  .register(net.caip, new ExactEvmScheme(account))
  .setSpendControls({ allowedAssets: [{ network: net.caip, asset: net.usdc, maxAmountPerPayment: "10000" }] }); // $0.01 cap per payment
const sb = createSwitchboard({ url: host, fetch: wrapFetchWithPayment(fetch, client) });

(async () => {
  console.log("Agent:", account.address, "on", net.label);
  const r = await sb.call(capability, { maxPrice: "0.01", minTrust: 0 });
  console.log("Provider:", r.host, r.provider);
  console.log("Verdict:", r.verdict, " latency:", r.latencyMs, "ms", " tries:", r.attempts.length);
  console.log("Data:", await r.response.json());
  for (const a of r.attempts.filter((a) => a.claim)) console.log("Refunded on an earlier try:", a.claim);
})().catch((e) => {
  console.error(e.message);
  if (e.attempts) console.error(e.attempts);
  process.exit(1);
});

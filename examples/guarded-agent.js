// An agent with spending limits: the same paid call as call-api.js, but nothing
// leaves this process unless it fits the rules below.
//
//   AGENT_KEY=0x... node examples/guarded-agent.js https://<surety-host> <providerAddress> [calls]
//
// Try `calls` larger than the budget allows (for example 8) to watch it stop itself.
const path = require("path");
const { createSuretyClient, createGuard } = require("../sdk");
const { createPayingFetch } = require("./x402-client");

require("dotenv").config({ quiet: true });
const [host, provider, calls = "3"] = process.argv.slice(2);
const agentKey = process.env.AGENT_KEY || process.env.PRIVATE_KEY;
if (!host || !provider || !agentKey) {
  console.error("Usage: AGENT_KEY=0x... node examples/guarded-agent.js https://<surety-host> <providerAddress> [calls]");
  process.exit(1);
}
const net = require("../networks").networkFromEnv(); // testnet unless SURETY_NETWORK=mainnet
const USDC = net.usdc;

(async () => {
  const guard = createGuard({
    relayUrl: host,
    maxPerCall: "0.002",    // no single call may cost more than this
    dailyBudget: "0.005",   // and no more than this per day, after refunds
    bondedOnly: true,       // only providers whose calls are covered right now
    minTrustScore: 20,
    token: USDC,
    logFile: path.join(__dirname, "..", "data", "spend-log.jsonl"),
  });
  const agent = createPayingFetch(agentKey, net.caip, USDC, "1000000", guard.fetch); // the guard sits under the payer
  const surety = createSuretyClient({ relayUrl: host, fetch: agent.fetch });
  console.log(`Agent ${agent.address}. Spent today ${guard.spentToday()} USDC, ${guard.remainingToday()} left.`);

  for (let i = 1; i <= Number(calls); i++) {
    try {
      const r = await surety.call(provider, "/v1/price/mon");
      console.log(`call ${i}: ${r.verdict}, ${r.latencyMs} ms${r.claim ? ", refunded" : ""}. ${guard.remainingToday()} USDC left today.`);
    } catch (e) {
      if (e.name !== "SuretyGuardError") throw e;
      console.log(`call ${i}: BLOCKED (${e.code}). ${e.message}`);
      break;
    }
  }
  console.log("\nSpend log:");
  for (const e of guard.log()) console.log(" ", JSON.stringify(e));
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

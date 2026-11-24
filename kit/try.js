// Make one real paid call to your API through the Surety relay and show the verdict.
//
//   npm run try -- https://your-api.example/v1/block
//
// Pays from PRIVATE_KEY in .env (a fraction of a cent, no network fee).
const { privateKeyToAccount } = require("viem/accounts");
const { wrapFetchWithPayment, x402Client } = require("@x402/fetch");
const { ExactEvmScheme } = require("@x402/evm/exact/client");
const { networkFromEnv } = require("./surety");

/// Calls `path` on `provider` through the relay, paying from `privateKey`.
async function tryCall({ suretyUrl, provider, path, privateKey, network = networkFromEnv().network, usdc = networkFromEnv().usdc }) {
  const account = privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
  const client = new x402Client()
    .register(network, new ExactEvmScheme(account))
    .setSpendControls({ allowedAssets: [{ network, asset: usdc, maxAmountPerPayment: "100000" }] }); // never more than $0.10
  const res = await wrapFetchWithPayment(fetch, client)(`${suretyUrl.replace(/\/+$/, "")}/call/${provider}${path}`);
  const h = (name) => res.headers.get(`x-surety-${name}`);
  return {
    status: res.status, body: await res.text(),
    verdict: h("verdict"), reason: h("reason"), latencyMs: Number(h("latency-ms")), claim: h("claim"), claimTx: h("claim-tx"),
  };
}

module.exports = { tryCall };

if (require.main === module) {
  require("dotenv").config();
  const env = process.env;
  (async () => {
    let target;
    try {
      target = new URL(process.argv[2]);
    } catch {
      throw new Error("Give the full address of one endpoint:  npm run try -- https://your-api.example/v1/block");
    }
    if (!env.PRIVATE_KEY) throw new Error("Put your wallet key in .env as PRIVATE_KEY=...");
    const provider = env.PROVIDER_ADDRESS || privateKeyToAccount(env.PRIVATE_KEY.startsWith("0x") ? env.PRIVATE_KEY : `0x${env.PRIVATE_KEY}`).address;
    const r = await tryCall({ suretyUrl: env.SURETY_URL || "https://www.surety.buzz", provider, path: target.pathname + target.search, privateKey: env.PRIVATE_KEY });
    console.log(`status   ${r.status}`);
    console.log(`verdict  ${r.verdict} (${r.reason}), ${r.latencyMs} ms`);
    console.log(`refund   ${r.claim}${r.claimTx ? `  ${r.claimTx}` : ""}`);
    console.log(`body     ${r.body.slice(0, 400)}`);
  })().then(
    () => process.exit(0),
    (e) => {
      console.error(`STOPPED: ${e.shortMessage || e.message}`);
      process.exit(1);
    }
  );
}

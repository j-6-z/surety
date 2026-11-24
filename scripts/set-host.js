// Point your on-chain provider record at a hosted Surety server. Run once after
// deploying (and again if the address changes):
//   node scripts/set-host.js https://your-domain.example
require("dotenv").config();
const { ethers } = require("ethers");
const { pointProviderAt } = require("../start");

let url = (process.argv[2] || "").trim().replace(/\/+$/, "");
if (url && !/^https?:\/\//.test(url)) url = `https://${url}`; // "my-app.vercel.app" is fine too
const { PRIVATE_KEY, VAULT_ADDRESS } = process.env;
if (!/^https:\/\//.test(url) || !PRIVATE_KEY || !VAULT_ADDRESS) {
  console.error("Usage: node scripts/set-host.js https://your-domain.example   (needs PRIVATE_KEY and VAULT_ADDRESS in .env)");
  process.exit(1);
}

(async () => {
  for (const [name, path] of [["health", "/health"], ["SLA", "/.well-known/surety.json"]]) {
    const res = await fetch(url + path);
    if (!res.ok) throw new Error(`${name} check failed: ${url + path} answered ${res.status} ${(await res.text()).slice(0, 200)}`);
    if (name === "SLA") {
      const sla = await res.json();
      if (sla.baseUrl !== url) throw new Error(`The server thinks its address is ${sla.baseUrl}, not ${url}. Set PUBLIC_URL to ${url} on the host and redeploy.`);
    }
    console.log(`  ${name} check passed`);
  }
  const key = PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
  const wallet = new ethers.Wallet(key, new ethers.JsonRpcProvider(process.env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz"));
  await pointProviderAt(wallet, VAULT_ADDRESS, `${url}/.well-known/surety.json`);
  console.log(`\nAgents call:  ${url}/call/${wallet.address}/v1/price/mon`);
  console.log(`Try it:       AGENT_KEY=0x... node examples/call-api.js ${url} ${wallet.address}`);
})().then(
  () => process.exit(0),
  (e) => {
    console.error(`STOPPED: ${e.shortMessage || e.message}`);
    process.exit(1);
  }
);

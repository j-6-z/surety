// Monad networks Switchboard can index. Pick one with SWITCHBOARD_NETWORK (default: mainnet).
// Same values as Surety's networks.js, so both projects always agree on the chain.
const NETWORKS = {
  mainnet: {
    key: "mainnet", label: "Monad mainnet", real: true,
    caip: "eip155:143", rpc: "https://rpc.monad.xyz",
    usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    vault: "0x8b8d4a18D9abB59Cc499c62DC46032A1AbB95415",
    surety: "https://www.surety.buzz",
    explorer: "https://monadvision.com",
  },
  testnet: {
    key: "testnet", label: "Monad testnet", real: false,
    caip: "eip155:10143", rpc: "https://testnet-rpc.monad.xyz",
    usdc: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
    vault: "0xf3F9e32De47a143149F7398f25f264b98a01273C",
    surety: "https://surety-beta.vercel.app",
    explorer: "https://testnet.monadvision.com",
  },
};
const FACILITATOR = "https://x402-facilitator.molandak.org";

function networkFromEnv(env = process.env) {
  const key = String(env.SWITCHBOARD_NETWORK || "mainnet").toLowerCase();
  const base = NETWORKS[key];
  if (!base) throw new Error(`SWITCHBOARD_NETWORK must be "mainnet" or "testnet", not "${env.SWITCHBOARD_NETWORK}".`);
  return {
    ...base,
    rpc: env.RPC_URL || base.rpc,
    usdc: env.USDC_ADDRESS || base.usdc,
    vault: env.VAULT_ADDRESS || base.vault,
    surety: (env.SURETY_URL || base.surety).replace(/\/+$/, ""),
    facilitatorUrl: env.FACILITATOR_URL || FACILITATOR,
  };
}

module.exports = { NETWORKS, networkFromEnv, FACILITATOR };

// The networks Surety can run on. Pick one with SURETY_NETWORK (default: testnet).
// Everything that differs between them lives here, so nothing else hardcodes a chain.
const NETWORKS = {
  testnet: {
    key: "testnet", label: "Monad testnet", fullName: "Monad testnet", chainName: "Monad Testnet", real: false,
    vault: "0xf3F9e32De47a143149F7398f25f264b98a01273C", minBond: "0.5", status: "Experimental, not audited",
    chainId: 10143, caip: "eip155:10143",
    rpc: "https://testnet-rpc.monad.xyz",
    usdc: "0x534b2f3A21130d7a60830c2Df862319e593943A3", usdcLabel: "test USDC",
    explorer: "https://testnet.monadvision.com",
    hardhat: "monadTestnet",
  },
  mainnet: {
    key: "mainnet", label: "Monad mainnet", fullName: "Monad mainnet", chainName: "Monad", real: true,
    vault: "0x93188873562a01344d3C5f0dCBFc3D6F2E482B29", minBond: "1", status: "Beta, not audited",
    chainId: 143, caip: "eip155:143",
    rpc: "https://rpc.monad.xyz",
    usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", usdcLabel: "USDC",
    explorer: "https://monadvision.com",
    hardhat: "monadMainnet",
  },
};
const FACILITATOR = "https://x402-facilitator.molandak.org";

/// The chosen network, with any overrides from the environment applied.
function networkFromEnv(env = process.env) {
  const key = String(env.SURETY_NETWORK || "testnet").toLowerCase();
  const base = NETWORKS[key];
  if (!base) throw new Error(`SURETY_NETWORK must be "testnet" or "mainnet", not "${env.SURETY_NETWORK}".`);
  const rpcOverride = env.RPC_URL || (key === "testnet" ? env.MONAD_TESTNET_RPC : env.MONAD_MAINNET_RPC);
  return {
    ...base,
    rpc: rpcOverride || base.rpc,
    usdc: env.USDC_ADDRESS || base.usdc,
    vault: env.VAULT_ADDRESS || base.vault,
    explorer: (env.EXPLORER_URL || base.explorer).replace(/\/+$/, ""),
    facilitatorUrl: env.FACILITATOR_URL || FACILITATOR,
  };
}

/// The profile for a CAIP-2 id such as "eip155:143", or null if it is not one of ours.
const networkByCaip = (caip) => Object.values(NETWORKS).find((n) => n.caip === caip) || null;

module.exports = { NETWORKS, networkFromEnv, networkByCaip, FACILITATOR };

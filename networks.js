// The networks Surety can run on. Pick one with SURETY_NETWORK (default: testnet).
// Everything that differs between them lives here, so nothing else hardcodes a chain.
const NETWORKS = {
  testnet: {
    key: "testnet", label: "Monad testnet", chainName: "Monad Testnet", real: false,
    chainId: 10143, caip: "eip155:10143",
    rpc: "https://testnet-rpc.monad.xyz",
    usdc: "0x534b2f3A21130d7a60830c2Df862319e593943A3", usdcLabel: "test USDC",
    explorer: "https://testnet.monadvision.com",
    hardhat: "monadTestnet",
  },
  mainnet: {
    key: "mainnet", label: "Monad", chainName: "Monad", real: true,
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
    explorer: (env.EXPLORER_URL || base.explorer).replace(/\/+$/, ""),
    facilitatorUrl: env.FACILITATOR_URL || FACILITATOR,
  };
}

module.exports = { NETWORKS, networkFromEnv, FACILITATOR };

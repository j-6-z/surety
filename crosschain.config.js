// LayerZero V2 addresses for the chains Surety's cross-chain contracts run on.
//
// Source: LayerZero's own deployment package, @layerzerolabs/lz-evm-sdk-v2 3.1.21
// (deployments/<chain>/*.json), and @layerzerolabs/lz-definitions 4.0.10 for the endpoint ids.
// Nothing here is trusted blindly: `node scripts/crosschain.js status` asks each endpoint
// on-chain for its id and stops if it is not the one written here.
//
// An endpoint id (eid) is LayerZero's own number for a chain. It is not the chain id.
const CHAINS = {
  monad: {
    name: "Monad", chainId: 143, eid: 30390, rpc: "https://rpc.monad.xyz", rpcEnv: "MONAD_MAINNET_RPC",
    explorer: "https://monadvision.com", native: "MON",
    endpoints: ["0x6F475642a6e85809B1c36Fa62763669b1b48DD5B"],
    sendUln302: "0xC39161c743D0307EB9BCc9FEF03eeb9Dc4802de7",
    receiveUln302: "0xe1844c5D63a9543023008D332Bd3d2e6f1FE1043",
    executor: "0x4208D6E27538189bB48E603D6123A94b8Abe0A0b",
    dvns: { "LayerZero Labs": "0x282b3386571f7f794450d5789911a9804FA346b4", Nethermind: "0xacde1f22eeab249d3ca6ba8805c8fee9f52a16e7" },
    deadDvn: "0x6788f52439ACA6BFF597d3eeC2DC9a44B8FEE842",
  },
  base: {
    name: "Base", chainId: 8453, eid: 30184, rpc: "https://mainnet.base.org", rpcEnv: "BASE_RPC",
    explorer: "https://basescan.org", native: "ETH",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Circle's USDC on Base; deploy-refunds checks symbol and decimals on-chain
    endpoints: ["0x1a44076050125825900e736c501f859c50fE728c"],
    sendUln302: "0xB5320B0B3a13cC860893E2Bd79FCd7e13484Dda2",
    receiveUln302: "0xc70AB6f32772f59fBfc23889Caf4Ba3376C84bAf",
    executor: "0x2CCA08ae69E0C44b18a57Ab2A87644234dAebaE4",
    dvns: { "LayerZero Labs": "0x9e059a54699a285714207b43B055483E78FAac25", Nethermind: "0xcd37CA043f8479064e10635020c65FfC005d36f6" },
    deadDvn: "0x6498b0632f3834D7647367334838111c8C889703",
  },
  // LayerZero lists two Monad testnets. The script uses whichever one is really deployed on
  // chain 10143 and answers with a matching id.
  monadTestnet: {
    name: "Monad testnet", chainId: 10143, eid: 40204, rpc: "https://testnet-rpc.monad.xyz", rpcEnv: "MONAD_TESTNET_RPC",
    explorer: "https://testnet.monadvision.com", native: "test MON",
    endpoints: ["0x6C7Ab2202C98C4227C5c46f1417D81144DA716Ff", "0x3aCAAf60502791D199a5a5F0B173D78229eBFe32"],
    eids: [40204, 40442],
    dvns: { "LayerZero Labs": "0x88B27057A9e00c5F05DDa29241027afF63f9e6e0" },
    deadDvn: "0xF49d162484290EAeAd7bb8C2c7E3a6f8f52e32d6",
  },
  baseSepolia: {
    name: "Base Sepolia", chainId: 84532, eid: 40245, rpc: "https://sepolia.base.org", rpcEnv: "BASE_SEPOLIA_RPC",
    explorer: "https://sepolia.basescan.org", native: "test ETH",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Circle's test USDC on Base Sepolia
    endpoints: ["0x6EDCE65403992e310A62460808c4b910D972f10f"],
    dvns: { "LayerZero Labs": "0xe1a12515F9AB2764b887bF60B923Ca494EBbB2d6" },
    deadDvn: "0x78551ADC2553EF1858a558F5300F7018Aad2FA7e",
  },
};

// Which pair of chains each Surety network uses: the hub holds the vault and the beacon,
// the spoke holds the mirror.
const PAIRS = {
  mainnet: { hub: "monad", spoke: "base", scan: "https://layerzeroscan.com" },
  testnet: { hub: "monadTestnet", spoke: "baseSepolia", scan: "https://testnet.layerzeroscan.com" },
};

/// The hub and spoke for a Surety network, with RPC overrides from the environment applied.
function pairFor(network, env = process.env) {
  const pair = PAIRS[network];
  if (!pair) throw new Error(`No cross-chain pair for network "${network}".`);
  const chain = (key) => ({ key, ...CHAINS[key], rpc: env[CHAINS[key].rpcEnv] || CHAINS[key].rpc });
  return { hub: chain(pair.hub), spoke: chain(pair.spoke), scan: pair.scan };
}

module.exports = { CHAINS, PAIRS, pairFor };

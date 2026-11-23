// Run the relay against a live network:
//   node verifier/server.js
// Needs in .env: VAULT_ADDRESS, ARBITER_KEY (the vault's arbiter wallet).
require("dotenv").config();
const { ethers } = require("ethers");
const { createRelay } = require("./relay");

const MONAD_TESTNET_USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";

const { VAULT_ADDRESS, ARBITER_KEY, PRIVATE_KEY } = process.env;
const key = ARBITER_KEY || PRIVATE_KEY;
if (!VAULT_ADDRESS || !key) {
  console.error("Set VAULT_ADDRESS and ARBITER_KEY (or PRIVATE_KEY) in .env");
  process.exit(1);
}

const rpc = process.env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz";
const signer = new ethers.Wallet(key, new ethers.JsonRpcProvider(rpc));
const port = Number(process.env.RELAY_PORT || 8402);

createRelay({
  vaultAddress: VAULT_ADDRESS,
  usdcAddress: process.env.USDC_ADDRESS || MONAD_TESTNET_USDC,
  signer,
  dataDir: process.env.DATA_DIR,
  allowInsecure: process.env.ALLOW_INSECURE === "1",
}).listen(port, () => console.log(`Surety relay on :${port}  arbiter ${signer.address}  rpc ${rpc}`));

// Deploy SuretyVault.
//   Local:          npx hardhat run scripts/deploy.js
//   Monad testnet:  npx hardhat run scripts/deploy.js --network monadTestnet
//   Monad mainnet:  npm run deploy:mainnet     (read the checks below first)
const { ethers, network } = require("hardhat");

const { NETWORKS } = require("../networks");

// Monad testnet USDC (from docs.monad.xyz x402 guide). Override with USDC_ADDRESS.
const MONAD_TESTNET_USDC = NETWORKS.testnet.usdc;

/// Mainnet holds real money, so the roles must be split before anything is deployed.
/// Returns the reasons this setup is not safe; an empty list means go.
function mainnetProblems(env, deployer) {
  const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
  const out = [];
  if (!ethers.isAddress(env.OWNER_ADDRESS || "")) out.push("Set OWNER_ADDRESS: the wallet that controls the vault's settings. Use a hardware wallet or a multisig, never a key stored on a server.");
  if (!ethers.isAddress(env.ARBITER_ADDRESS || "")) out.push("Set ARBITER_ADDRESS: the wallet the relay signs refunds with. This is the only key that goes on the server.");
  if (same(env.OWNER_ADDRESS, env.ARBITER_ADDRESS)) out.push("OWNER_ADDRESS and ARBITER_ADDRESS must be different wallets. If the server is ever broken into, the owner must still be able to pause the vault and replace the arbiter.");
  if (same(env.OWNER_ADDRESS, deployer)) out.push("OWNER_ADDRESS is the wallet you are deploying from, whose key is in .env. Deploy from a throwaway wallet and name a safer one as owner.");
  if (!/^\d+(\.\d+)?$/.test(env.MIN_BOND_USDC || "")) out.push("Set MIN_BOND_USDC explicitly. For a first beta, 1 keeps everyone's exposure small. A single refund can never exceed this amount.");
  else if (Number(env.MIN_BOND_USDC) > 10 && env.ALLOW_LARGE_MIN_BOND !== "yes") out.push(`MIN_BOND_USDC is ${env.MIN_BOND_USDC}. That is the least every provider must lock up, and the most one refund can take. For this beta use 1. Check .env for a second MIN_BOND_USDC line. (To really use ${env.MIN_BOND_USDC}, set ALLOW_LARGE_MIN_BOND=yes.)`);
  if (env.I_UNDERSTAND_UNAUDITED !== "yes") out.push("This contract has not been audited. Set I_UNDERSTAND_UNAUDITED=yes to confirm you are deploying it with real money anyway.");
  return out;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account. Set PRIVATE_KEY in .env");

  const mainnet = network.name === "monadMainnet";
  if (mainnet) {
    const problems = mainnetProblems(process.env, deployer.address);
    if (problems.length) throw new Error(`Not deploying to mainnet yet:\n  - ${problems.join("\n  - ")}`);
  }
  let usdc = process.env.USDC_ADDRESS;
  if (!usdc && network.name === "monadTestnet") usdc = MONAD_TESTNET_USDC;
  if (!usdc && mainnet) usdc = NETWORKS.mainnet.usdc;
  if (!usdc && network.name === "hardhat") {
    const mock = await (await ethers.getContractFactory("MockUSDC")).deploy();
    usdc = await mock.getAddress();
    console.log("MockUSDC:", usdc);
  }
  if (!usdc) throw new Error("Set USDC_ADDRESS for this network");

  const owner = process.env.OWNER_ADDRESS || deployer.address;
  const arbiter = process.env.ARBITER_ADDRESS || deployer.address;
  const treasury = process.env.TREASURY_ADDRESS || (mainnet ? owner : deployer.address);
  if (mainnet) {
    // The token must really be there, and really be 6-decimal USDC, before a vault is built around it.
    const token = new ethers.Contract(usdc, ["function decimals() view returns (uint8)", "function symbol() view returns (string)"], deployer);
    if ((await ethers.provider.getCode(usdc)) === "0x") throw new Error(`Nothing is deployed at ${usdc} on this network.`);
    const [decimals, symbol] = await Promise.all([token.decimals(), token.symbol()]);
    if (Number(decimals) !== 6) throw new Error(`${usdc} has ${decimals} decimals. Surety assumes 6.`);
    console.log(`Token: ${symbol} at ${usdc}`);
  }
  const minBond = ethers.parseUnits(process.env.MIN_BOND_USDC || "100", 6);
  const delay = BigInt(process.env.UNBONDING_DAYS || "7") * 86400n;
  const feeBps = Number(process.env.SLASH_FEE_BPS || "500");

  console.log(`Network: ${network.name}  Deployer: ${deployer.address}`);
  console.log(`Owner ${owner}\nArbiter ${arbiter}\nMinimum bond ${ethers.formatUnits(minBond, 6)} USDC, fee ${feeBps / 100}%, withdrawal wait ${Number(delay) / 86400} days`);
  const vault = await (await ethers.getContractFactory("SuretyVault")).deploy(
    usdc, owner, arbiter, treasury, minBond, delay, feeBps
  );
  await vault.waitForDeployment();
  console.log("SuretyVault:", await vault.getAddress());
  console.log({ usdc, owner, arbiter, treasury, minBond: minBond.toString(), delay: delay.toString(), feeBps });
  if (mainnet) {
    console.log("\nNext: put VAULT_ADDRESS in .env, then run  npm run check:mainnet");
    console.log("One refund can take at most 5% of the minimum bond, and a day's refunds at most 20% of a provider's cover. Only the owner can change that.");
  }
}

module.exports = { mainnetProblems };

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exitCode = 1;
  });
}

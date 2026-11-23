// Deploy SuretyVault.
//   Local:          npx hardhat run scripts/deploy.js
//   Monad testnet:  npx hardhat run scripts/deploy.js --network monadTestnet
const { ethers, network } = require("hardhat");

// Monad testnet USDC (from docs.monad.xyz x402 guide). Override with USDC_ADDRESS.
const MONAD_TESTNET_USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account. Set PRIVATE_KEY in .env");

  let usdc = process.env.USDC_ADDRESS;
  if (!usdc && network.name === "monadTestnet") usdc = MONAD_TESTNET_USDC;
  if (!usdc && network.name === "hardhat") {
    const mock = await (await ethers.getContractFactory("MockUSDC")).deploy();
    usdc = await mock.getAddress();
    console.log("MockUSDC:", usdc);
  }
  if (!usdc) throw new Error("Set USDC_ADDRESS for this network");

  const owner = process.env.OWNER_ADDRESS || deployer.address;
  const arbiter = process.env.ARBITER_ADDRESS || deployer.address;
  const treasury = process.env.TREASURY_ADDRESS || deployer.address;
  const minBond = ethers.parseUnits(process.env.MIN_BOND_USDC || "100", 6);
  const delay = BigInt(process.env.UNBONDING_DAYS || "7") * 86400n;
  const feeBps = Number(process.env.SLASH_FEE_BPS || "500");

  console.log(`Network: ${network.name}  Deployer: ${deployer.address}`);
  const vault = await (await ethers.getContractFactory("SuretyVault")).deploy(
    usdc, owner, arbiter, treasury, minBond, delay, feeBps
  );
  await vault.waitForDeployment();
  console.log("SuretyVault:", await vault.getAddress());
  console.log({ usdc, owner, arbiter, treasury, minBond: minBond.toString(), delay: delay.toString(), feeBps });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

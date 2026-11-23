// Prints gas used by the main vault operations:  npx hardhat run scripts/gas.js
const { ethers } = require("hardhat");
const usd = (n) => ethers.parseUnits(String(n), 6);

async function main() {
  const [owner, arbiter, treasury, provider, backer, agent] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const vault = await (await ethers.getContractFactory("SuretyVault")).deploy(
    await usdc.getAddress(), owner.address, arbiter.address, treasury.address, usd(100), 7 * 86400, 500
  );
  if (vault.setMaxClaimPayout) await vault.setMaxClaimPayout(usd(1_000_000));
  for (const s of [provider, backer]) {
    await usdc.mint(s.address, usd(100_000));
    await usdc.connect(s).approve(await vault.getAddress(), ethers.MaxUint256);
  }
  const rows = [];
  const gas = async (label, txp) => rows.push([label, Number((await (await txp).wait()).gasUsed)]);
  const id = (s) => ethers.id(s);

  await gas("register", vault.connect(provider).register("https://api.example.com/.well-known/surety.json"));
  await gas("depositBond (first)", vault.connect(provider).depositBond(usd(1_000)));
  await gas("depositBond (top up)", vault.connect(provider).depositBond(usd(1_000)));
  await gas("back (first)", vault.connect(backer).back(provider.address, usd(1_000)));
  await gas("back (again)", vault.connect(backer).back(provider.address, usd(1_000)));
  await gas("payClaim (first, bond)", vault.connect(arbiter).payClaim(id("a"), provider.address, agent.address, usd(2), id("e")));
  await gas("payClaim (typical, bond)", vault.connect(arbiter).payClaim(id("b"), provider.address, agent.address, usd(2), id("e")));
  await gas("payClaim (spills to backers)", vault.connect(arbiter).payClaim(id("c"), provider.address, agent.address, usd(2_100), id("e")));
  await gas("requestUnstake", vault.connect(backer).requestUnstake(provider.address, await vault.backerShares(provider.address, backer.address)));
  await ethers.provider.send("evm_increaseTime", [7 * 86400]);
  await gas("completeUnstake", vault.connect(backer).completeUnstake(provider.address));

  for (const [l, g] of rows) console.log(l.padEnd(30), String(g).padStart(8));
  console.log("TOTAL".padEnd(30), String(rows.reduce((a, r) => a + r[1], 0)).padStart(8));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

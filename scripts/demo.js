// One-command local demo of the whole loop:
//   npx hardhat run scripts/demo.js
// An agent makes three paid calls through the relay. The healthy one costs it
// money as normal; the slow one and the broken one are refunded from the bond.
const { ethers } = require("hardhat");
const { startLocalStack } = require("../examples/local-stack");

const fmt = (v) => `${ethers.formatUnits(v, 6)} USDC`;

async function main() {
  const s = await startLocalStack();
  const bal = () => s.usdc.balanceOf(s.agent.address);
  console.log(`Provider ${s.provider} bonded. Price per call: ${fmt(s.price)}`);
  console.log("Trust before:", await s.client.trust(s.provider), "\n");

  for (const path of ["/quote", "/slow", "/broken"]) {
    const before = await bal();
    const r = await s.client.call(s.provider, path);
    const net = (await bal()) - before;
    console.log(
      `${path.padEnd(8)} verdict=${r.verdict.padEnd(4)} reason=${String(r.reason).padEnd(15)} ` +
        `latency=${r.latencyMs}ms  agent net=${fmt(net)}` + (r.claim ? `  refund tx=${r.claim.tx.slice(0, 12)}…` : "")
    );
  }

  const p = await s.vault.providers(s.provider);
  console.log(`\nBond left: ${fmt(p.bond)}  claims paid: ${p.claimCount} (${fmt(p.claimsPaid)})`);
  console.log("Trust after:", await s.client.trust(s.provider));
  await s.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

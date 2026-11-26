// Which Surety transactions can Monad run in parallel, and which make it do the work twice?
//
//   npm run bench:parallel
//
// Monad executes the transactions of a block at the same time, each one assuming the state it
// read is still current. Results are then committed in order. If a transaction read a storage
// slot whose value an earlier transaction in the block changed, its result is thrown away and it
// is executed again. (docs.monad.xyz, "Parallel Execution".)
//
// This script measures exactly that for real Surety transactions, on a local chain:
//   1. From one starting state, run each transaction of a would-be block on its own and trace
//      every storage slot it reads, with the value it saw. Those are its inputs.
//   2. Run the same transactions in order. Before each one, compare its inputs with the state
//      as it now stands. Any input that changed means Monad would have had to re-execute it.
//
// It does not measure speed. Re-execution cannot be seen from outside a Monad node, so a wall-
// clock benchmark against a public network would not show it. What this shows is the cause:
// which slots are shared, and what a design that avoids them would gain.
const hre = require("hardhat");
const { ethers } = hre;

const usd = (n) => ethers.parseUnits(String(n), 6);
const word = (x) => ethers.zeroPadValue(ethers.toBeHex(BigInt(x)), 32);
const mapSlot = (key, slot) => ethers.keccak256(ethers.concat([ethers.zeroPadValue(key, 32), word(slot)]));
const add = (slot, n) => word(BigInt(slot) + BigInt(n));
const REENTRANCY_SLOT = "0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00";

/// Every storage slot one transaction read before writing it, with the value it saw.
async function inputsOf(txHash, to) {
  const trace = await hre.network.provider.send("debug_traceTransaction", [txHash, { disableMemory: true, disableStorage: true }]);
  const logs = trace.structLogs;
  const at = [null, to.toLowerCase()]; // storage owner at each call depth (depth starts at 1)
  const inputs = new Map();
  const written = new Set();
  for (let i = 0; i < logs.length; i++) {
    const { op, depth, stack } = logs[i];
    const top = (n) => `0x${stack[stack.length - n].replace(/^0x/, "").padStart(64, "0")}`;
    if (op === "CALL" || op === "STATICCALL") at[depth + 1] = `0x${top(2).slice(26)}`;
    else if (op === "DELEGATECALL" || op === "CALLCODE") at[depth + 1] = at[depth];
    else if (op === "SLOAD") {
      const key = `${at[depth]}:${top(1)}`;
      const next = logs[i + 1];
      if (!inputs.has(key) && !written.has(key)) inputs.set(key, `0x${next.stack[next.stack.length - 1].replace(/^0x/, "").padStart(64, "0")}`);
    } else if (op === "SSTORE") written.add(`${at[depth]}:${top(1)}`);
  }
  return inputs;
}

/**
 * Take a would-be block and say which of its transactions Monad would have to run twice.
 * @param {{from: import("ethers").Signer, to: string, send: () => Promise<any>}[]} txs
 * @param {(address: string, slot: string) => string} label  a human name for a storage slot
 */
async function analyse(txs, label = (a, s) => `${a}:${s}`) {
  const provider = hre.network.provider;
  const start = await provider.send("evm_snapshot", []);
  let snapshot = start;
  const inputs = [];
  for (const tx of txs) {
    const receipt = await (await tx.send()).wait();
    inputs.push(await inputsOf(receipt.hash, tx.to));
    await provider.send("evm_revert", [snapshot]);
    snapshot = await provider.send("evm_snapshot", []);
  }
  const rerun = [];
  const shared = new Map();
  const senders = new Set();
  let sameSender = 0;
  for (let i = 0; i < txs.length; i++) {
    const changed = [];
    for (const [key, seen] of inputs[i]) {
      const [address, slot] = key.split(":");
      if ((await ethers.provider.getStorage(address, slot)) !== seen) changed.push(label(address, slot));
    }
    if (changed.length) rerun.push(i);
    for (const name of changed) shared.set(name, (shared.get(name) || 0) + 1);
    const from = (await tx(txs[i]).getAddress()).toLowerCase();
    if (senders.has(from)) sameSender++;
    senders.add(from);
    await (await txs[i].send()).wait();
  }
  return { transactions: txs.length, rerun: rerun.length, sameSender, shared: [...shared].sort((a, b) => b[1] - a[1]).map(([slot, times]) => ({ slot, times })) };
}
const tx = (t) => t.from;

// ------------------------------------------------------------------ the blocks being measured

/// The real vault with `n` bonded providers, plus the people each scenario needs.
async function world(n) {
  const [owner, arbiter, treasury] = await ethers.getSigners();
  // Fresh local wallets for everyone else, so a block can be any size.
  const people = [];
  for (let i = 0; i < 3 * n; i++) {
    const wallet = new ethers.Wallet(ethers.id(`surety-parallel-${i}`), ethers.provider);
    await hre.network.provider.send("hardhat_setBalance", [wallet.address, "0x56BC75E2D63100000"]);
    people.push(wallet);
  }
  const providers = people.slice(0, n);
  const agents = people.slice(n, 2 * n);
  const backers = people.slice(2 * n, 3 * n);
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const vault = await (await ethers.getContractFactory("SuretyVault")).deploy(usdc, owner.address, arbiter.address, treasury.address, usd(100), 7 * 86400, 500);
  await vault.setMaxClaimPayout(usd(50));
  for (const who of [...providers, ...backers]) {
    await usdc.mint(who.address, usd(10_000));
    await usdc.connect(who).approve(vault, ethers.MaxUint256);
  }
  for (const p of providers) {
    await vault.connect(p).register("ipfs://sla");
    await vault.connect(p).depositBond(usd(1_000));
    await vault.connect(backers[providers.indexOf(p)]).back(p.address, usd(10)); // so each backing slot is warm
  }
  // One earlier claim per provider and one payment to the treasury, so the measured block is
  // ordinary traffic and not the first-ever write to anything.
  for (const [i, p] of providers.entries()) await vault.connect(arbiter).payClaim(ethers.id(`warm${i}`), p.address, agents[i].address, usd(1), ethers.ZeroHash);

  const vaultAddress = (await vault.getAddress()).toLowerCase();
  const usdcAddress = (await usdc.getAddress()).toLowerCase();
  const names = new Map([[vaultAddress, "the vault"], [treasury.address.toLowerCase(), "the treasury"], [arbiter.address.toLowerCase(), "the arbiter"]]);
  providers.forEach((p, i) => names.set(p.address.toLowerCase(), `provider ${i + 1}`));
  agents.forEach((a, i) => names.set(a.address.toLowerCase(), `agent ${i + 1}`));
  backers.forEach((b, i) => names.set(b.address.toLowerCase(), `backer ${i + 1}`));

  // Names for the slots that matter, worked out from the contracts' storage layouts.
  const slots = new Map();
  const VAULT_FIXED = ["owner", "pendingOwner / paused", "arbiter", "treasury", "minProviderBond", "maxClaimPayout", "delay / fee / daily limit"];
  VAULT_FIXED.forEach((n2, i) => slots.set(`${vaultAddress}:${word(i)}`, `vault setting: ${n2}`));
  slots.set(`${vaultAddress}:${REENTRANCY_SLOT}`, "vault re-entrancy lock");
  for (const [address, who] of names) {
    slots.set(`${usdcAddress}:${mapSlot(address, 0)}`, `USDC balance of ${who}`);
    const record = mapSlot(address, 7);
    for (let k = 0; k < 6; k++) slots.set(`${vaultAddress}:${add(record, k)}`, `vault record of ${who}`);
    slots.set(`${vaultAddress}:${mapSlot(address, 11)}`, `today's refund count for ${who}`);
  }
  const label = (address, slot) => slots.get(`${address}:${slot}`) || `${names.get(address) || address} slot ${slot.slice(0, 10)}…`;
  return { owner, arbiter, treasury, providers, agents, backers, usdc, vault, vaultAddress, label, names, slots, usdcAddress };
}

const SCENARIOS = {
  "bond deposits, each from a different provider": async (n) => {
    const w = await world(n);
    return { label: w.label, txs: w.providers.map((p) => ({ from: p, to: w.vaultAddress, send: () => w.vault.connect(p).depositBond(usd(5)) })) };
  },
  "backers staking, each behind a different provider": async (n) => {
    const w = await world(n);
    return { label: w.label, txs: w.providers.map((p, i) => ({ from: w.backers[i], to: w.vaultAddress, send: () => w.vault.connect(w.backers[i]).back(p.address, usd(5)) })) };
  },
  "refunds, each against a different provider": async (n) => {
    const w = await world(n);
    return { label: w.label, txs: w.providers.map((p, i) => ({ from: w.arbiter, to: w.vaultAddress, send: () => w.vault.connect(w.arbiter).payClaim(ethers.id(`c${i}`), p.address, w.agents[i].address, usd(2), ethers.ZeroHash) })) };
  },
  "refunds, all against one provider": async (n) => {
    const w = await world(n);
    return { label: w.label, txs: w.agents.map((a, i) => ({ from: w.arbiter, to: w.vaultAddress, send: () => w.vault.connect(w.arbiter).payClaim(ethers.id(`c${i}`), w.providers[0].address, a.address, usd(2), ethers.ZeroHash) })) };
  },
  // The two probes below are not Surety. They isolate one design question: pooled custody, as the
  // vault does it, against one escrow per provider. Each claim is sent by a different account so
  // that only storage is being compared.
  "design probe: pooled custody, a refund per provider": async (n) => {
    const w = await world(n);
    const pool = await (await ethers.getContractFactory("PooledBondsProbe")).deploy(w.usdc, w.treasury.address);
    const address = (await pool.getAddress()).toLowerCase();
    w.slots.set(`${w.usdcAddress}:${mapSlot(address, 0)}`, "USDC balance of the pool");
    for (const p of w.providers) {
      await w.usdc.connect(p).approve(pool, ethers.MaxUint256);
      await pool.connect(p).deposit(usd(100));
      w.slots.set(`${address}:${mapSlot(p.address, 0)}`, `pool record of ${w.names.get(p.address.toLowerCase())}`);
    }
    await pool.claim(w.providers[0].address, w.agents[0].address, usd(1)); // warm the treasury's balance
    return { label: w.label, txs: w.providers.map((p, i) => ({ from: w.backers[i], to: address, send: () => pool.connect(w.backers[i]).claim(p.address, w.agents[i].address, usd(2)) })) };
  },
  "design probe: one escrow per provider, a refund per provider": async (n) => {
    const w = await world(n);
    const Escrow = await ethers.getContractFactory("ProviderEscrowProbe");
    const escrows = [];
    for (const [i, p] of w.providers.entries()) {
      const escrow = await Escrow.deploy(w.usdc, w.treasury.address);
      await w.usdc.connect(p).approve(escrow, ethers.MaxUint256);
      await escrow.connect(p).deposit(usd(100));
      await escrow.claim(w.agents[i].address, usd(1)); // warm the fee counter
      escrows.push(escrow);
    }
    const txs = [];
    for (const [i, escrow] of escrows.entries()) txs.push({ from: w.backers[i], to: await escrow.getAddress(), send: () => escrow.connect(w.backers[i]).claim(w.agents[i].address, usd(2)) });
    return { label: w.label, txs };
  },
};

/// Run every scenario with `n` transactions in the block. Returns one row per scenario.
async function run(n = 10) {
  const rows = [];
  for (const [name, build] of Object.entries(SCENARIOS)) {
    const scenario = await build(n);
    rows.push({ name, ...(await analyse(scenario.txs, scenario.label)) });
  }
  return rows;
}

module.exports = { run, analyse, inputsOf, SCENARIOS };

if (require.main === module) {
  const n = Number(process.env.BLOCK_SIZE || 10);
  run(n).then((rows) => {
    console.log(`A block of ${n} transactions of each kind. "Run twice" = Monad's first attempt would be thrown away.\n`);
    for (const r of rows) {
      console.log(`${r.name}\n  run twice: ${r.rerun} of ${r.transactions}${r.sameSender ? `   (and ${r.sameSender} share a sender with an earlier one, so they queue behind it anyway)` : ""}`);
      for (const s of r.shared) console.log(`    because of: ${s.slot}  (${s.times}x)`);
      console.log("");
    }
  }, (e) => {
    console.error(`STOPPED: ${e.message}`);
    process.exit(1);
  });
}

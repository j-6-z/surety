// Surety across chains: a beacon beside the vault on Monad, a mirror on Base, LayerZero between.
//
//   node scripts/crosschain.js status              read-only: is everything in place? Run this first.
//   node scripts/crosschain.js deploy              deploy both contracts and point them at each other
//   node scripts/crosschain.js send [0xProvider…]  send the vault's view of these providers to the mirror
//   node scripts/crosschain.js read [0xProvider…]  what the mirror holds, next to what the vault says now
//   node scripts/crosschain.js pin                 fix which verifiers (DVNs) the pair uses, instead of defaults
//
// Stage two, refunds paid on Base (see CROSSCHAIN.md before using any of these on mainnet):
//   node scripts/crosschain.js deploy-refunds      deploy the router (Monad) and outpost (Base), wired and pinned
//   node scripts/crosschain.js refunds [0xAgent…]  what is queued, sent, in the float, and owed to these agents
//   node scripts/crosschain.js float <usdc>        add USDC from your wallet to the outpost's float on Base
//   node scripts/crosschain.js flush               send the next batch of queued refunds
//   node scripts/crosschain.js refund-test         testnet only: file one made-up remote claim against your own bond
//
// Uses SURETY_NETWORK (testnet: Monad testnet <-> Base Sepolia, mainnet: Monad <-> Base).
// PRIVATE_KEY in .env pays on both chains, so that wallet needs a little gas on each.
// With no providers named, `send` and `read` use PROVIDER_ADDRESS from .env.
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");
const { networkFromEnv } = require("../networks");
const { pairFor } = require("../crosschain.config");

const ROOT = path.join(__dirname, "..");
const DEPLOYMENTS = path.join(ROOT, "crosschain.deployments.json");
const CONFIG_TYPE_EXECUTOR = 1;
const CONFIG_TYPE_ULN = 2;
const NO_OPTIONAL_DVNS = 255; // LayerZero's "none", as opposed to 0 which means "whatever the default is"

const ENDPOINT_ABI = [
  "function eid() view returns (uint32)",
  "function getSendLibrary(address sender, uint32 dstEid) view returns (address)",
  "function isDefaultSendLibrary(address sender, uint32 dstEid) view returns (bool)",
  "function getReceiveLibrary(address receiver, uint32 srcEid) view returns (address lib, bool isDefault)",
  "function setSendLibrary(address oapp, uint32 eid, address lib)",
  "function setReceiveLibrary(address oapp, uint32 eid, address lib, uint256 gracePeriod)",
  "function setConfig(address oapp, address lib, (uint32 eid, uint32 configType, bytes config)[] params)",
  "function getConfig(address oapp, address lib, uint32 eid, uint32 configType) view returns (bytes)",
];
const ULN_TUPLE = "tuple(uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs)";
const ULN_ABI = [`function getUlnConfig(address oapp, uint32 remoteEid) view returns (${ULN_TUPLE})`];
const DVN_ABI = ["function getFee(uint32 dstEid, uint64 confirmations, address sender, bytes options) view returns (uint256)"];
const VAULT_ABI = [
  "function isCovered(address) view returns (bool)",
  "function coverOf(address) view returns (uint256)",
  "function committedCoverOf(address) view returns (uint256)",
  "function dailyAllowance(address) view returns (uint256)",
  "function maxClaimPayout() view returns (uint256)",
];

const b32 = (address) => ethers.zeroPadValue(address, 32);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const usdc = (v) => `${ethers.formatUnits(v, 6)} USDC`;
const why = (e) => e.shortMessage || e.reason || e.message;

/// The compiled contract, building it first if this is a fresh checkout.
function artifact(name) {
  const file = path.join(ROOT, "artifacts", "contracts", "crosschain", `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(file)) {
    const r = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["hardhat", "compile"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
    if (r.status !== 0 || !fs.existsSync(file)) throw new Error("Could not compile the contracts. Run  npx hardhat compile  and look at the error.");
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
const contractAt = (name, address, runner) => new ethers.Contract(address, artifact(name).abi, runner);

/// LayerZero type-2 config: which DVNs must sign off a message, and after how many block confirmations.
function encodeUlnConfig(confirmations, requiredDVNs) {
  const sorted = [...requiredDVNs].map((a) => ethers.getAddress(a)).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  if (!sorted.length) throw new Error("At least one DVN is required.");
  if (new Set(sorted.map((a) => a.toLowerCase())).size !== sorted.length) throw new Error("The same DVN is listed twice.");
  return ethers.AbiCoder.defaultAbiCoder().encode([ULN_TUPLE], [[confirmations, sorted.length, NO_OPTIONAL_DVNS, 0, sorted, []]]);
}

/// The endpoint on this chain, confirmed by asking it for its own id.
async function findEndpoint(chain, provider) {
  const chainId = Number(await provider.send("eth_chainId", []).catch((e) => { throw new Error(`Could not reach ${chain.name} at ${chain.rpc} (${why(e)}).`); }));
  if (chainId !== chain.chainId) throw new Error(`${chain.rpc} is chain ${chainId}, not ${chain.name} (${chain.chainId}).`);
  const wanted = chain.eids || [chain.eid];
  for (const address of chain.endpoints) {
    if ((await provider.getCode(address)) === "0x") continue;
    const eid = Number(await new ethers.Contract(address, ENDPOINT_ABI, provider).eid().catch(() => 0));
    if (wanted.includes(eid)) return { address, eid, contract: new ethers.Contract(address, ENDPOINT_ABI, provider) };
  }
  throw new Error(`No LayerZero endpoint answered on ${chain.name} at ${chain.endpoints.join(" or ")}.`);
}

/// What secures one direction of the pair, as the endpoint sees it for this app right now.
async function pathway(endpoint, side, app, remoteEid, chain) {
  try {
    const lib = side === "send" ? await endpoint.contract.getSendLibrary(app, remoteEid) : (await endpoint.contract.getReceiveLibrary(app, remoteEid))[0];
    const c = await new ethers.Contract(lib, ULN_ABI, endpoint.contract.runner).getUlnConfig(app, remoteEid);
    const name = (a) => Object.entries(chain.dvns || {}).find(([, known]) => same(known, a))?.[0] || (same(a, chain.deadDvn) ? "DEAD (placeholder)" : "unlisted");
    const required = [...c.requiredDVNs].map((address) => ({ address, name: name(address) }));
    // LayerZero ships some routes with a placeholder "dead" DVN as the default. The route exists,
    // but nothing is delivered until the app names real DVNs itself (the pin step).
    return { ok: true, dead: required.some((d) => same(d.address, chain.deadDvn)), lib, confirmations: Number(c.confirmations), required, optional: Number(c.optionalDVNCount) };
  } catch (e) {
    return { ok: false, error: why(e) };
  }
}

/// What the two directions add up to: "none" (no route), "unpinned" (route exists, placeholder
/// verifiers, pin before sending), "mismatch" (the sides disagree), or "ready".
function routeState(out, back) {
  if (!out.ok || !back.ok) return "none";
  if (out.dead || back.dead) return "unpinned";
  if (out.required.length !== back.required.length) return "mismatch";
  return "ready";
}

/// The DVNs listed for both chains that are deployed on both and quote a fee for this route.
async function usableDvns(c) {
  const names = [];
  for (const name of Object.keys(c.pair.hub.dvns)) {
    const [hubDvn, spokeDvn] = [c.pair.hub.dvns[name], c.pair.spoke.dvns[name]];
    if (!spokeDvn) continue;
    const [hubCode, spokeCode] = await Promise.all([c.hubProvider.getCode(hubDvn), c.spokeProvider.getCode(spokeDvn)]);
    if (hubCode === "0x" || spokeCode === "0x") continue;
    const serves = await new ethers.Contract(hubDvn, DVN_ABI, c.hubProvider).getFee(c.spokeEndpoint.eid, 1, ethers.ZeroAddress, "0x").then(() => true, () => false);
    if (serves) names.push(name);
  }
  return names;
}
const describe = (p) => (p.error ? `not available (${p.error})` : `${p.required.map((d) => `${d.name} ${d.address}`).join(", ")}; ${p.confirmations} confirmations${p.optional ? `; ${p.optional} optional` : ""}`);

const readSaved = () => (fs.existsSync(DEPLOYMENTS) ? JSON.parse(fs.readFileSync(DEPLOYMENTS, "utf8")) : {});
function writeSaved(network, entry) {
  fs.writeFileSync(DEPLOYMENTS, `${JSON.stringify({ ...readSaved(), [network]: entry }, null, 2)}\n`);
}

/// Everything a command needs: both chains, their endpoints, the wallet if there is a key.
async function connect(env = process.env) {
  const net = networkFromEnv(env);
  const pair = pairFor(net.key, env);
  // staticNetwork: fail at once if an RPC is unreachable, instead of retrying forever.
  const rpc = (chain) => new ethers.JsonRpcProvider(chain.rpc, chain.chainId, { staticNetwork: true });
  const hubProvider = rpc(pair.hub);
  const spokeProvider = rpc(pair.spoke);
  const [hubEndpoint, spokeEndpoint] = await Promise.all([findEndpoint(pair.hub, hubProvider), findEndpoint(pair.spoke, spokeProvider)]);
  const key = env.PRIVATE_KEY ? (env.PRIVATE_KEY.startsWith("0x") ? env.PRIVATE_KEY : `0x${env.PRIVATE_KEY}`) : null;
  return {
    net, pair, hubProvider, spokeProvider, hubEndpoint, spokeEndpoint,
    hubSigner: key && new ethers.Wallet(key, hubProvider),
    spokeSigner: key && new ethers.Wallet(key, spokeProvider),
    saved: readSaved()[net.key] || {},
  };
}
function needKey(c) {
  if (!c.hubSigner) throw new Error("Put the deploying wallet's key in .env as PRIVATE_KEY.");
}
function needDeployed(c) {
  if (!c.saved.beacon || !c.saved.mirror) throw new Error("Nothing is deployed for this network yet. Run  node scripts/crosschain.js deploy  first.");
}
function providersFrom(args, env = process.env) {
  const list = args.length ? args : [env.PROVIDER_ADDRESS].filter(Boolean);
  if (!list.length) throw new Error("Name at least one provider address, or set PROVIDER_ADDRESS in .env.");
  return list.map((a) => {
    if (!ethers.isAddress(a)) throw new Error(`"${a}" is not an address.`);
    return ethers.getAddress(a);
  });
}

// ------------------------------------------------------------------ the steps, usable from tests

/// Deploy what is missing and point the two contracts at each other. Safe to run again.
async function deployPair({ hubSigner, spokeSigner, hubEndpoint, spokeEndpoint, hubEid, spokeEid, vault, maxAge = 3600, saved = {}, save = () => {}, log = console.log }) {
  const state = { ...saved };
  const factory = (name, signer) => new ethers.ContractFactory(artifact(name).abi, artifact(name).bytecode, signer);
  if (!state.beacon) {
    const beacon = await factory("SuretyBeacon", hubSigner).deploy(hubEndpoint, await hubSigner.getAddress(), vault);
    await beacon.waitForDeployment();
    state.beacon = await beacon.getAddress();
    save(state);
    log(`Beacon deployed:  ${state.beacon}`);
  }
  if (!state.mirror) {
    const mirror = await factory("SuretyMirror", spokeSigner).deploy(spokeEndpoint, await spokeSigner.getAddress(), hubEid, maxAge);
    await mirror.waitForDeployment();
    state.mirror = await mirror.getAddress();
    save(state);
    log(`Mirror deployed:  ${state.mirror}`);
  }
  const beacon = contractAt("SuretyBeacon", state.beacon, hubSigner);
  const mirror = contractAt("SuretyMirror", state.mirror, spokeSigner);
  if (!same(await beacon.peers(spokeEid), b32(state.mirror))) {
    await (await beacon.setPeer(spokeEid, b32(state.mirror))).wait();
    log("Beacon now sends to the mirror.");
  }
  if (!same(await mirror.peers(hubEid), b32(state.beacon))) {
    await (await mirror.setPeer(hubEid, b32(state.beacon))).wait();
    log("Mirror now listens to the beacon.");
  }
  return { beacon, mirror, state };
}

/// Quote, then broadcast. Returns the transaction hash and LayerZero's id for the message.
async function sendReport({ beacon, dstEid, providers, log = console.log }) {
  const fee = await beacon.quote(dstEid, providers);
  const tx = await beacon.broadcast(dstEid, providers, { value: fee });
  const receipt = await tx.wait();
  const sent = receipt.logs.map((l) => { try { return beacon.interface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === "Broadcast");
  log(`Sent ${providers.length} provider${providers.length === 1 ? "" : "s"}. LayerZero fee: ${ethers.formatEther(fee)}`);
  return { hash: receipt.hash, guid: sent.args.guid, nonce: Number(sent.args.nonce), fee };
}

/// For each provider: what the mirror holds, and (if a vault is given) what the vault says now.
async function readMirror({ mirror, vault, providers }) {
  return Promise.all(providers.map(async (provider) => {
    const [[c, fresh], covered] = await Promise.all([mirror.coverageOf(provider), mirror.isCovered(provider)]);
    const row = { provider, mirror: { covered, fresh, reportedCovered: c.covered, cover: c.cover, dailyAllowance: c.dailyAllowance, observedAt: Number(c.observedAt), nonce: Number(c.nonce) } };
    if (vault) row.vault = { covered: await vault.isCovered(provider), cover: await vault.coverOf(provider) };
    return row;
  }));
}

// ------------------------------------------------------------------ commands

async function status({ log = console.log, env = process.env } = {}) {
  const c = await connect(env);
  const problems = [];
  const who = c.hubSigner ? c.hubSigner.address : ethers.ZeroAddress;
  log(`Network: ${c.net.fullName}   ${c.pair.hub.name} (eid ${c.hubEndpoint.eid})  ->  ${c.pair.spoke.name} (eid ${c.spokeEndpoint.eid})`);
  log(`Endpoints: ${c.hubEndpoint.address} on ${c.pair.hub.name}, ${c.spokeEndpoint.address} on ${c.pair.spoke.name}`);

  const vault = new ethers.Contract(c.net.vault, VAULT_ABI, c.hubProvider);
  const vaultOk = await Promise.all([vault.isCovered(ethers.ZeroAddress), vault.dailyAllowance(ethers.ZeroAddress), vault.maxClaimPayout()]).then(() => true, () => false);
  log(`Vault ${c.net.vault}: ${vaultOk ? "ok" : "too old for the beacon"}`);
  if (!vaultOk) problems.push(`The vault at ${c.net.vault} has no isCovered / dailyAllowance. Deploy the current SuretyVault on ${c.pair.hub.name} and set VAULT_ADDRESS to it.`);

  const out = await pathway(c.hubEndpoint, "send", c.saved.beacon || who, c.spokeEndpoint.eid, c.pair.hub);
  const back = await pathway(c.spokeEndpoint, "receive", c.saved.mirror || who, c.hubEndpoint.eid, c.pair.spoke);
  log(`Sending from ${c.pair.hub.name} is verified by:   ${describe(out)}`);
  log(`Receiving on ${c.pair.spoke.name} is verified by: ${describe(back)}`);
  const route = routeState(out, back);
  const dvns = await usableDvns(c);
  log(`Verifiers that serve this route: ${dvns.length ? dvns.join(", ") : "none found"}`);
  if (route === "none") problems.push(`LayerZero has no route between ${c.pair.hub.name} and ${c.pair.spoke.name} right now${c.net.real ? "" : " (testnet routes come and go; mainnet may still be fine)"}.`);
  else if (!dvns.length) problems.push("None of the verifiers in crosschain.config.js quotes a fee for this route, so there is nothing to pin.");
  else if (route === "unpinned") log(`Route: exists, but LayerZero's default verifier here is a placeholder. ${c.saved.beacon ? "Run  pin  before sending." : "deploy  will name real verifiers as its last step."}`);
  else if (route === "mismatch") problems.push("The two sides name a different number of verifiers, so messages would not be delivered. Run the  pin  command.");

  if (c.hubSigner) {
    const [hubBalance, spokeBalance] = await Promise.all([c.hubProvider.getBalance(who), c.spokeProvider.getBalance(who)]);
    log(`Wallet ${who}: ${ethers.formatEther(hubBalance)} ${c.pair.hub.native}, ${ethers.formatEther(spokeBalance)} ${c.pair.spoke.native}`);
    if (hubBalance === 0n) problems.push(`The wallet has no ${c.pair.hub.native} on ${c.pair.hub.name} for gas and LayerZero fees.`);
    if (spokeBalance === 0n && !c.saved.mirror) problems.push(`The wallet has no ${c.pair.spoke.native} on ${c.pair.spoke.name} to deploy the mirror.`);
  } else log("Wallet: no PRIVATE_KEY in .env (fine for looking, needed to deploy or send).");

  if (c.saved.beacon && c.saved.mirror) {
    const beacon = contractAt("SuretyBeacon", c.saved.beacon, c.hubProvider);
    const mirror = contractAt("SuretyMirror", c.saved.mirror, c.spokeProvider);
    const linked = same(await beacon.peers(c.spokeEndpoint.eid), b32(c.saved.mirror)) && same(await mirror.peers(c.hubEndpoint.eid), b32(c.saved.beacon));
    log(`Beacon ${c.saved.beacon}\nMirror ${c.saved.mirror}\nPointed at each other: ${linked ? "yes" : "NO"}`);
    if (!linked) problems.push("The beacon and mirror are not pointed at each other. Run  deploy  again to finish.");
  } else log("Beacon and mirror: not deployed yet.");

  const next = !c.saved.mirror ? "deploy" : route === "ready" ? "send" : "pin";
  log(problems.length ? `\nNOT READY:\n  - ${problems.join("\n  - ")}` : `\nREADY. Next: node scripts/crosschain.js ${next}`);
  return { problems, connection: c, out, back, route, dvns };
}

async function deploy({ log = console.log, env = process.env } = {}) {
  const { problems, connection: c } = await status({ log, env });
  needKey(c);
  if (problems.length) throw new Error("Fix the points above first.");
  if (c.net.real && env.I_UNDERSTAND_UNAUDITED !== "yes") throw new Error("These contracts are not audited. Set I_UNDERSTAND_UNAUDITED=yes in .env to deploy them on mainnet anyway.");
  log("");
  const { state } = await deployPair({
    hubSigner: c.hubSigner, spokeSigner: c.spokeSigner,
    hubEndpoint: c.hubEndpoint.address, spokeEndpoint: c.spokeEndpoint.address,
    hubEid: c.hubEndpoint.eid, spokeEid: c.spokeEndpoint.eid,
    vault: c.net.vault, maxAge: Number(env.MIRROR_MAX_AGE || 3600),
    saved: c.saved, save: (s) => writeSaved(c.net.key, { ...s, vault: c.net.vault, hubEid: c.hubEndpoint.eid, spokeEid: c.spokeEndpoint.eid }), log,
  });
  log(`\nAddresses are saved in crosschain.deployments.json (commit that file).\n${c.pair.hub.explorer}/address/${state.beacon}\n${c.pair.spoke.explorer}/address/${state.mirror}\n`);
  // LayerZero's defaults are not relied on: the pair always names its own verifiers.
  await pin({ log, env });
  return state;
}

async function send(args, { log = console.log, env = process.env } = {}) {
  const c = await connect(env);
  needKey(c);
  needDeployed(c);
  const providers = providersFrom(args, env);
  log(`Network: ${c.net.fullName}`);
  const route = routeState(
    await pathway(c.hubEndpoint, "send", c.saved.beacon, c.spokeEndpoint.eid, c.pair.hub),
    await pathway(c.spokeEndpoint, "receive", c.saved.mirror, c.hubEndpoint.eid, c.pair.spoke)
  );
  if (route !== "ready") throw new Error("The route's verifiers are not set, so a message sent now would never arrive. Run  node scripts/crosschain.js pin  first.");
  const sent = await sendReport({ beacon: contractAt("SuretyBeacon", c.saved.beacon, c.hubSigner), dstEid: c.spokeEndpoint.eid, providers, log: (m) => log(`${m} ${c.pair.hub.native}`) });
  log(`Transaction: ${c.pair.hub.explorer}/tx/${sent.hash}\nFollow it across: ${c.pair.scan}/tx/${sent.hash}\nIt usually lands in a minute or two. Then: node scripts/crosschain.js read`);
  return sent;
}

async function read(args, { log = console.log, env = process.env } = {}) {
  const c = await connect(env);
  needDeployed(c);
  const providers = providersFrom(args, env);
  const rows = await readMirror({
    mirror: contractAt("SuretyMirror", c.saved.mirror, c.spokeProvider),
    vault: new ethers.Contract(c.net.vault, VAULT_ABI, c.hubProvider),
    providers,
  });
  log(`Mirror on ${c.pair.spoke.name}: ${c.saved.mirror}`);
  for (const r of rows) {
    const m = r.mirror;
    const seen = m.observedAt ? `reported ${new Date(m.observedAt * 1000).toLocaleString()} (message ${m.nonce})${m.fresh ? "" : ", now too old to trust"}` : "never reported";
    log(`\n${r.provider}\n  mirror: ${m.covered ? "COVERED" : "not covered"}, cover ${usdc(m.cover)}, today's allowance ${usdc(m.dailyAllowance)}; ${seen}\n  vault now: ${r.vault.covered ? "covered" : "not covered"}, cover ${usdc(r.vault.cover)}`);
  }
  return rows;
}

/// Stop relying on LayerZero's defaults (which LayerZero can change): name the library and the
/// DVNs this pair uses, on both sides. Both sides must name the same DVNs or nothing is delivered.
/// Name the library and DVNs for one sender on the hub and one receiver on the spoke.
async function pinApps(c, hubApp, spokeApp, log) {
  const names = await usableDvns(c);
  if (!names.length) throw new Error("None of the verifiers in crosschain.config.js is deployed on both chains and quotes a fee for this route.");
  const before = await pathway(c.hubEndpoint, "send", hubApp, c.spokeEndpoint.eid, c.pair.hub);
  if (before.error) throw new Error(`Cannot read the current setup: ${before.error}`);
  const confirmations = before.confirmations;
  log(`Pinning ${names.join(" + ")} with ${confirmations} confirmations.`);

  const hub = c.hubEndpoint.contract.connect(c.hubSigner);
  const sendLib = await hub.getSendLibrary(hubApp, c.spokeEndpoint.eid);
  if (await hub.isDefaultSendLibrary(hubApp, c.spokeEndpoint.eid)) await (await hub.setSendLibrary(hubApp, c.spokeEndpoint.eid, sendLib)).wait();
  const executor = await hub.getConfig(hubApp, sendLib, c.spokeEndpoint.eid, CONFIG_TYPE_EXECUTOR);
  await (await hub.setConfig(hubApp, sendLib, [
    { eid: c.spokeEndpoint.eid, configType: CONFIG_TYPE_EXECUTOR, config: executor },
    { eid: c.spokeEndpoint.eid, configType: CONFIG_TYPE_ULN, config: encodeUlnConfig(confirmations, names.map((n) => c.pair.hub.dvns[n])) },
  ])).wait();
  log(`${c.pair.hub.name} side set.`);

  const spoke = c.spokeEndpoint.contract.connect(c.spokeSigner);
  const [receiveLib, isDefault] = await spoke.getReceiveLibrary(spokeApp, c.hubEndpoint.eid);
  if (isDefault) await (await spoke.setReceiveLibrary(spokeApp, c.hubEndpoint.eid, receiveLib, 0)).wait();
  await (await spoke.setConfig(spokeApp, receiveLib, [
    { eid: c.hubEndpoint.eid, configType: CONFIG_TYPE_ULN, config: encodeUlnConfig(confirmations, names.map((n) => c.pair.spoke.dvns[n])) },
  ])).wait();
  log(`${c.pair.spoke.name} side set.`);
}

async function pin({ log = console.log, env = process.env } = {}) {
  const c = await connect(env);
  needKey(c);
  needDeployed(c);
  await pinApps(c, c.saved.beacon, c.saved.mirror, log);
  // The proof that the send side is right: the beacon can now price a real message.
  const fee = await contractAt("SuretyBeacon", c.saved.beacon, c.hubProvider).quote(c.spokeEndpoint.eid, [ethers.ZeroAddress]);
  log(`A one-provider report now costs ${ethers.formatEther(fee)} ${c.pair.hub.native}.\n`);
  return status({ log, env });
}

// ------------------------------------------------------------------ stage two: refunds on the spoke

const ERC20_ABI = ["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"];

/// Deploy the router and outpost if missing and point them at each other. Safe to run again.
/// This does NOT make the router the vault's arbiter; only the vault's owner can do that.
async function deployRefundPair({ hubSigner, spokeSigner, hubEndpoint, spokeEndpoint, hubEid, spokeEid, vault, relay, spokeUsdc, saved = {}, save = () => {}, log = console.log }) {
  const state = { ...saved };
  const factory = (name, signer) => new ethers.ContractFactory(artifact(name).abi, artifact(name).bytecode, signer);
  if (!state.router) {
    const router = await factory("SuretyRouter", hubSigner).deploy(hubEndpoint, await hubSigner.getAddress(), vault, relay);
    await router.waitForDeployment();
    state.router = await router.getAddress();
    save(state);
    log(`Router deployed:  ${state.router}`);
  }
  if (!state.outpost) {
    const outpost = await factory("SuretyOutpost", spokeSigner).deploy(spokeEndpoint, await spokeSigner.getAddress(), spokeUsdc, hubEid);
    await outpost.waitForDeployment();
    state.outpost = await outpost.getAddress();
    save(state);
    log(`Outpost deployed: ${state.outpost}`);
  }
  const router = contractAt("SuretyRouter", state.router, hubSigner);
  const outpost = contractAt("SuretyOutpost", state.outpost, spokeSigner);
  if (!same(await router.peers(spokeEid), b32(state.outpost))) {
    await (await router.setPeer(spokeEid, b32(state.outpost))).wait();
    log("Router now sends to the outpost.");
  }
  if (!same(await outpost.peers(hubEid), b32(state.router))) {
    await (await outpost.setPeer(hubEid, b32(state.router))).wait();
    log("Outpost now listens to the router.");
  }
  return { router, outpost, state };
}

/// Send the next batch of queued refunds. Anyone can; the caller pays the LayerZero fee.
async function flushRefunds({ router, dstEid, log = console.log }) {
  const fee = await router.quoteFlush(dstEid);
  const receipt = await (await router.flush(dstEid, { value: fee })).wait();
  const sent = receipt.logs.map((l) => { try { return router.interface.parseLog(l); } catch { return null; } }).find((l) => l && l.name === "Flushed");
  log(`Sent ${sent.args.refunds} refund${sent.args.refunds === 1n ? "" : "s"} worth ${usdc(sent.args.amount)}. LayerZero fee: ${ethers.formatEther(fee)}`);
  return { hash: receipt.hash, guid: sent.args.guid, refunds: Number(sent.args.refunds), amount: sent.args.amount, fee };
}

/// Where the money is: queued on the hub, reimbursable, spare on the spoke, and owed to each agent.
async function refundStatus({ router, outpost, spokeEid, agents = [] }) {
  const [[refunds, amount], reimbursable, spareFloat, totalCredit, totalPaid] = await Promise.all([
    router.pending(spokeEid), router.reimbursable(), outpost.spareFloat(), outpost.totalCredit(), outpost.totalPaid(),
  ]);
  const credits = await Promise.all(agents.map(async (agent) => ({ agent, amount: await outpost.credit(agent) })));
  return { pending: { refunds: Number(refunds), amount }, reimbursable, spareFloat, totalCredit, totalPaid, credits };
}

function needRefundsDeployed(c) {
  if (!c.saved.router || !c.saved.outpost) throw new Error("The router and outpost are not deployed for this network. Run  node scripts/crosschain.js deploy-refunds  first.");
}
const refundContracts = (c, write) => ({
  router: contractAt("SuretyRouter", c.saved.router, write ? c.hubSigner : c.hubProvider),
  outpost: contractAt("SuretyOutpost", c.saved.outpost, write ? c.spokeSigner : c.spokeProvider),
});

async function deployRefunds({ log = console.log, env = process.env } = {}) {
  const { problems, connection: c } = await status({ log, env });
  needKey(c);
  if (problems.length) throw new Error("Fix the points above first.");
  if (c.net.real && env.I_UNDERSTAND_UNAUDITED !== "yes") throw new Error("These contracts are not audited. Set I_UNDERSTAND_UNAUDITED=yes in .env to deploy them on mainnet anyway.");
  if (!c.pair.spoke.usdc) throw new Error(`No USDC address is listed for ${c.pair.spoke.name} in crosschain.config.js.`);
  // The token must really be USDC with 6 decimals before a contract that pays out in it is built.
  const token = new ethers.Contract(c.pair.spoke.usdc, ERC20_ABI, c.spokeProvider);
  const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]).catch(() => { throw new Error(`Nothing that looks like a token is at ${c.pair.spoke.usdc} on ${c.pair.spoke.name}.`); });
  if (symbol !== "USDC" || Number(decimals) !== 6) throw new Error(`${c.pair.spoke.usdc} on ${c.pair.spoke.name} is ${symbol} with ${decimals} decimals, not USDC with 6.`);
  // The relay's key is whichever key is the vault's arbiter today, unless RELAY_ADDRESS says otherwise.
  const arbiter = await new ethers.Contract(c.net.vault, ["function arbiter() view returns (address)"], c.hubProvider).arbiter();
  const relay = env.RELAY_ADDRESS ? ethers.getAddress(env.RELAY_ADDRESS) : arbiter;
  log(`\nRelay key (may file claims through the router): ${relay}`);
  const { state } = await deployRefundPair({
    hubSigner: c.hubSigner, spokeSigner: c.spokeSigner,
    hubEndpoint: c.hubEndpoint.address, spokeEndpoint: c.spokeEndpoint.address,
    hubEid: c.hubEndpoint.eid, spokeEid: c.spokeEndpoint.eid,
    vault: c.net.vault, relay, spokeUsdc: c.pair.spoke.usdc,
    saved: c.saved, save: (s) => writeSaved(c.net.key, s), log,
  });
  await pinApps(c, state.router, state.outpost, log);
  log(`\n${c.pair.hub.explorer}/address/${state.router}\n${c.pair.spoke.explorer}/address/${state.outpost}`);
  log(`\nDeployed and wired. Nothing has changed for the vault yet: its arbiter is still ${arbiter}.\nRefunds only flow through the router once the vault's owner calls setArbiter(${state.router}).`);
  return state;
}

async function refunds(args, { log = console.log, env = process.env } = {}) {
  const c = await connect(env);
  needRefundsDeployed(c);
  const agents = args.map((a) => ethers.getAddress(a));
  const s = await refundStatus({ ...refundContracts(c), spokeEid: c.spokeEndpoint.eid, agents });
  const arbiter = await new ethers.Contract(c.net.vault, ["function arbiter() view returns (address)"], c.hubProvider).arbiter();
  log(`Router ${c.saved.router} on ${c.pair.hub.name}: ${same(arbiter, c.saved.router) ? "is the vault's arbiter" : `NOT the vault's arbiter (that is ${arbiter})`}`);
  log(`  waiting to be sent: ${s.pending.refunds} refund${s.pending.refunds === 1 ? "" : "s"}, ${usdc(s.pending.amount)}`);
  log(`  sent, and yours to move across to refill the float: ${usdc(s.reimbursable)}`);
  log(`Outpost ${c.saved.outpost} on ${c.pair.spoke.name}:`);
  log(`  spare float: ${usdc(s.spareFloat)}   owed as credits: ${usdc(s.totalCredit)}   paid so far: ${usdc(s.totalPaid)}`);
  for (const credit of s.credits) log(`  ${credit.agent} is owed ${usdc(credit.amount)}`);
  return s;
}

async function float(args, { log = console.log, env = process.env } = {}) {
  const c = await connect(env);
  needKey(c);
  needRefundsDeployed(c);
  if (!/^\d+(\.\d+)?$/.test(args[0] || "")) throw new Error("Say how much USDC to add, for example:  node scripts/crosschain.js float 5");
  const amount = ethers.parseUnits(args[0], 6);
  const token = new ethers.Contract(c.pair.spoke.usdc, ERC20_ABI, c.spokeSigner);
  const have = await token.balanceOf(c.spokeSigner.address);
  if (have < amount) throw new Error(`The wallet holds ${usdc(have)} on ${c.pair.spoke.name}, less than ${usdc(amount)}.`);
  const tx = await token.transfer(c.saved.outpost, amount);
  await tx.wait();
  log(`Added ${usdc(amount)} to the float. ${c.pair.spoke.explorer}/tx/${tx.hash}`);
  return refunds([], { log, env });
}

async function flush({ log = console.log, env = process.env } = {}) {
  const c = await connect(env);
  needKey(c);
  needRefundsDeployed(c);
  const sent = await flushRefunds({ router: refundContracts(c, true).router, dstEid: c.spokeEndpoint.eid, log: (m) => log(`${m} ${c.pair.hub.native}`) });
  log(`Follow it across: ${c.pair.scan}/tx/${sent.hash}`);
  return sent;
}

/// Testnet only. Files one small made-up claim through the router against PROVIDER_ADDRESS (or
/// this wallet), so the whole path can be watched end to end without a real failed call.
async function refundTest({ log = console.log, env = process.env } = {}) {
  const c = await connect(env);
  needKey(c);
  needRefundsDeployed(c);
  if (c.net.real) throw new Error("refund-test invents a claim, so it only runs on testnet.");
  const { router } = refundContracts(c, true);
  const provider = ethers.getAddress(env.PROVIDER_ADDRESS || c.hubSigner.address);
  const claimId = ethers.id(`refund-test:${Date.now()}`);
  const tx = await router.payClaimRemote(claimId, provider, c.hubSigner.address, 1000n, ethers.ZeroHash, c.spokeEndpoint.eid);
  await tx.wait();
  log(`Filed a 0.001 USDC claim against ${provider}, to be paid to ${c.hubSigner.address} on ${c.pair.spoke.name}.`);
  await flush({ log, env });
  log(`When it lands: node scripts/crosschain.js refunds ${c.hubSigner.address}`);
}

module.exports = { deployPair, sendReport, readMirror, encodeUlnConfig, findEndpoint, providersFrom, routeState, status, deploy, send, read, pin, b32,
  deployRefundPair, flushRefunds, refundStatus, deployRefunds, refunds, float, flush, refundTest };

if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  const run = {
    status: () => status(), deploy: () => deploy(), send: () => send(args), read: () => read(args), pin: () => pin(),
    "deploy-refunds": () => deployRefunds(), refunds: () => refunds(args), float: () => float(args), flush: () => flush(), "refund-test": () => refundTest(),
  }[command];
  if (!run) {
    console.error("Usage: node scripts/crosschain.js status | deploy | send [0xProvider…] | read [0xProvider…] | pin\n       stage two: deploy-refunds | refunds [0xAgent…] | float <usdc> | flush | refund-test");
    process.exit(1);
  }
  run().then(
    () => process.exit(0),
    (e) => {
      console.error(`STOPPED: ${why(e)}`);
      process.exit(1);
    }
  );
}

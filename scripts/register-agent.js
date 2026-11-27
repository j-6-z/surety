// Give your provider an ERC-8004 agent identity, so reputation services (Tally, and anything
// else that reads the standard registries) can attach a score to it.
//
//   node scripts/register-agent.js https://your-domain.example                 show where it stands
//   node scripts/register-agent.js https://your-domain.example register        register a new agent
//   node scripts/register-agent.js https://your-domain.example register 123    point agent 123 at this host
//
// PRIVATE_KEY in .env must be the PROVIDER wallet: the agent has to belong to the provider's own
// address, or nobody can tell the agent and the bonded provider are the same thing.
// For mainnet, set SURETY_NETWORK=mainnet in .env first.
const { ethers } = require("ethers");

const IDENTITY_ABI = [
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "function balanceOf(address owner) view returns (uint256)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
];
const FILE = "/.well-known/agent-registration.json";
const TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

/**
 * @param {object} c
 * @param {import("ethers").Wallet} c.wallet     the provider wallet
 * @param {string} c.identityRegistry
 * @param {string} c.url                         the host's public address, no trailing slash
 * @param {boolean} [c.register]                 false: only report
 * @param {string} [c.agentId]                   an agent this wallet already owns
 * @param {(m: string) => void} [c.log] @param {typeof fetch} [c.fetch]
 * @returns {Promise<{agentId: string|null, uri: string, hostLists: boolean}>}
 */
async function registerAgent(c) {
  const log = c.log || console.log;
  const f = c.fetch || globalThis.fetch;
  const me = c.wallet.address;
  const uri = c.url + FILE;
  const identity = new ethers.Contract(c.identityRegistry, IDENTITY_ABI, c.wallet);

  const res = await f(uri, { redirect: "manual", headers: { accept: "application/json" } }).catch(() => null);
  if (!res || !res.ok) throw new Error(`${uri} did not answer${res ? ` (${res.status})` : ""}. Deploy the server first.`);
  const file = await res.json().catch(() => null);
  if (!file || file.type !== TYPE) throw new Error(`${uri} is not an ERC-8004 registration file.`);
  const listed = (file.registrations || []).map((r) => String(r.agentId));

  let agentId = c.agentId || null;
  if (agentId !== null) {
    if (!/^\d+$/.test(agentId)) throw new Error(`"${agentId}" is not an agent id.`);
    const owner = await identity.ownerOf(agentId).catch(() => null);
    if (owner !== me) throw new Error(`Agent ${agentId} does not belong to ${me}${owner ? ` (its owner is ${owner})` : " (no such agent)"}.`);
  }

  if (c.register) {
    if ((await c.wallet.provider.getBalance(me)) === 0n) throw new Error(`${me} has no MON for gas.`);
    if (agentId === null) {
      const owned = await identity.balanceOf(me);
      // A second agent for the same provider would split its reputation in two.
      if (owned > 0n) throw new Error(`${me} already owns ${owned} agent(s). Pass its id to point it here:  register <agentId>`);
      const receipt = await (await identity.register(uri)).wait();
      for (const l of receipt.logs) {
        const ev = l.address === c.identityRegistry ? identity.interface.parseLog(l) : null;
        if (ev && ev.name === "Registered") agentId = ev.args.agentId.toString();
      }
      if (agentId === null) throw new Error(`Registered (tx ${receipt.hash}) but could not read the new agent id. Look it up on a block explorer.`);
      log(`Registered agent ${agentId}.`);
    } else if ((await identity.tokenURI(agentId)) !== uri) {
      await (await identity.setAgentURI(agentId, uri)).wait();
      log(`Pointed agent ${agentId} at this host.`);
    } else {
      log(`Agent ${agentId} already points at this host.`);
    }
  }

  const hostLists = agentId !== null && listed.includes(agentId);
  log(`  provider ${me}`);
  log(`  agent    ${agentId ?? "none yet"}${agentId ? `  ->  ${await identity.tokenURI(agentId)}` : ""}`);
  if (agentId === null) log("\nRun this again with  register  to create the agent.");
  else if (!hostLists) log(`\nThe host does not name this agent yet. In the host's settings add:\n  AGENT_ID=${agentId}\nthen redeploy. Its SLA document will carry the id, which is how a scorer links the agent to the bond.`);
  else log("\nAll set: the host names this agent and the agent points at the host.");
  return { agentId, uri, hostLists };
}

module.exports = { registerAgent, FILE, TYPE };

if (require.main === module) {
  require("dotenv").config({ quiet: true });
  const net = require("../networks").networkFromEnv();
  let url = (process.argv[2] || "").trim().replace(/\/+$/, "");
  if (url && !/^https?:\/\//.test(url)) url = `https://${url}`;
  const action = process.argv[3];
  const { PRIVATE_KEY } = process.env;
  if (!/^https:\/\//.test(url) || !PRIVATE_KEY || (action && action !== "register")) {
    console.error("Usage: node scripts/register-agent.js https://your-domain.example [register [agentId]]   (needs PRIVATE_KEY in .env: the provider wallet)");
    process.exit(1);
  }
  const wallet = new ethers.Wallet(PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`, new ethers.JsonRpcProvider(net.rpc));
  console.log(`Network: ${net.fullName}   identity registry ${net.identityRegistry}\n`);
  registerAgent({ wallet, identityRegistry: net.identityRegistry, url, register: action === "register", agentId: process.argv[4] || process.env.AGENT_ID || undefined }).then(
    () => process.exit(0),
    (e) => {
      console.error(`STOPPED: ${e.shortMessage || e.message}`);
      process.exit(1);
    }
  );
}

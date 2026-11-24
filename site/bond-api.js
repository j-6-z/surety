// Server side of the self-serve "Bond your API" page. The browser never needs a
// crypto library: this checks the SLA, reads the account from the chain, and
// builds each transaction, so the wallet only has to sign what it is shown.
//
//   GET /bond/sla-check?url=…          is this SLA document valid?
//   GET /bond/account?address=…        registration, bond, USDC balance, allowance
//   GET /bond/tx?kind=…&url=…&amount=… the transaction for one step: { to, data }
const { ethers } = require("ethers");
const { validateSlaDoc } = require("../verifier/sla");
const { assertPublicUrl } = require("../verifier/netguard");

const VAULT = new ethers.Interface([
  "function register(string metadataURI)",
  "function setMetadata(string metadataURI)",
  "function depositBond(uint256 amount)",
  "function requestBondWithdraw(uint256 amount)",
  "function cancelBondWithdraw()",
  "function completeBondWithdraw()",
  "function minProviderBond() view returns (uint256)",
  "function unbondingDelay() view returns (uint64)",
  "function isActive(address) view returns (bool)",
  "function providers(address) view returns (bool registered, uint64 bondReadyAt, uint64 claimCount, uint128 bond, uint128 bondPendingWithdraw, uint128 backingAssets, uint128 claimsPaid, uint256 backingShares, uint256 backingSharesPending, string metadataURI)",
]);
const ERC20 = new ethers.Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
const MAX_BOND = 1_000_000n * 1_000_000n; // sanity cap on amounts typed into the form

/**
 * @param {object} c
 * @param {import("ethers").Provider} c.provider  read access to the payment network
 * @param {string} c.vaultAddress @param {string} c.usdcAddress
 * @param {number} c.chainId
 * @param {boolean} [c.allowInsecure]  local testing only: accept http:// SLA addresses
 * @param {(address: string) => void} [c.onSeen]  told about providers that show up here
 */
function createBondApi(c) {
  const vault = new ethers.Contract(c.vaultAddress, VAULT, c.provider);
  const usdc = new ethers.Contract(c.usdcAddress, ERC20, c.provider);
  const reply = (res, status, body) => res.status(status).set("cache-control", "no-store").json(body);
  const bad = (res, error) => reply(res, 400, { ok: false, error });
  let recent = []; // light brake on the one route that fetches outside addresses

  async function fetchSla(url) {
    const u = await assertPublicUrl(url, c.allowInsecure);
    const res = await fetch(u, { signal: AbortSignal.timeout(8000), redirect: "error" });
    if (!res.ok) throw new Error(`that address answered ${res.status}`);
    const text = await res.text();
    if (text.length > 200_000) throw new Error("the document is too large");
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new Error("the document is not valid JSON");
    }
    return validateSlaDoc(doc);
  }

  const explain = (e) =>
    ({
      url_must_be_https: "The address must start with https://",
      url_not_public: "That address points at a private network, so the relay could not reach it.",
    }[e.message] || String(e.message).replace(/^SLA: /, "").replace(/^fetch failed$/, "Nothing answered at that address."));

  return {
    slaCheck: async (req, res) => {
      const url = String(req.query.url || "").trim();
      if (!url) return bad(res, "Enter the address of your SLA document.");
      const now = Date.now();
      recent = recent.filter((t) => now - t < 60_000);
      if (recent.length >= 30) return reply(res, 429, { ok: false, error: "Too many checks at once. Try again in a minute." });
      recent.push(now);
      try {
        const sla = await fetchSla(url);
        reply(res, 200, {
          ok: true,
          baseUrl: sla.baseUrl,
          payTo: sla.payTo,
          endpoints: sla.endpoints.map((e) => ({ method: e.method, path: e.path, maxLatencyMs: e.maxLatencyMs, checksShape: !!e.responseSchema })),
        });
      } catch (e) {
        reply(res, 200, { ok: false, error: explain(e) });
      }
    },

    account: async (req, res) => {
      const address = String(req.query.address || "");
      if (!ethers.isAddress(address)) return bad(res, "That is not a wallet address.");
      try {
        const [p, active, minBond, delay, balance, allowance] = await Promise.all([
          vault.providers(address), vault.isActive(address), vault.minProviderBond(), vault.unbondingDelay(),
          usdc.balanceOf(address), usdc.allowance(address, c.vaultAddress),
        ]);
        if (p.registered && c.onSeen) c.onSeen(ethers.getAddress(address));
        reply(res, 200, {
          ok: true,
          address: ethers.getAddress(address),
          registered: p.registered,
          metadataURI: p.metadataURI,
          active,
          bond: p.bond.toString(),
          bondPendingWithdraw: p.bondPendingWithdraw.toString(),
          bondReadyAt: Number(p.bondReadyAt),
          minBond: minBond.toString(),
          unbondingDays: Number(delay) / 86400,
          usdcBalance: balance.toString(),
          allowance: allowance.toString(),
          chainId: c.chainId,
          vault: c.vaultAddress,
          usdc: c.usdcAddress,
        });
      } catch {
        reply(res, 502, { ok: false, error: "Could not read the vault just now. Try again." });
      }
    },

    tx: (req, res) => {
      const kind = String(req.query.kind || "");
      const url = String(req.query.url || "").trim();
      let amount = null;
      if (["approve", "deposit", "withdraw"].includes(kind)) {
        if (!/^\d{1,18}$/.test(String(req.query.amount || ""))) return bad(res, "Amount must be a whole number of USDC base units.");
        amount = BigInt(req.query.amount);
        if (amount <= 0n || amount > MAX_BOND) return bad(res, "That amount is out of range.");
      }
      if (["register", "setMetadata"].includes(kind)) {
        try {
          const u = new URL(url);
          if (u.protocol !== "https:" && !(c.allowInsecure && u.protocol === "http:")) throw 0;
          if (url.length > 300) throw 0;
        } catch {
          return bad(res, "The SLA address must be a full https:// address.");
        }
      }
      const build = {
        register: () => ({ to: c.vaultAddress, data: VAULT.encodeFunctionData("register", [url]), does: "Lists your API on the vault, pointing at your SLA document." }),
        setMetadata: () => ({ to: c.vaultAddress, data: VAULT.encodeFunctionData("setMetadata", [url]), does: "Changes the SLA address on your listing." }),
        approve: () => ({ to: c.usdcAddress, data: ERC20.encodeFunctionData("approve", [c.vaultAddress, amount]), does: "Allows the vault to take exactly this much USDC from your wallet, and no more." }),
        deposit: () => ({ to: c.vaultAddress, data: VAULT.encodeFunctionData("depositBond", [amount]), does: "Moves this much USDC from your wallet into your bond." }),
        withdraw: () => ({ to: c.vaultAddress, data: VAULT.encodeFunctionData("requestBondWithdraw", [amount]), does: "Queues this much of your bond for withdrawal. Your calls stop being covered if it takes you under the minimum." }),
        cancelWithdraw: () => ({ to: c.vaultAddress, data: VAULT.encodeFunctionData("cancelBondWithdraw", []), does: "Cancels your queued withdrawal." }),
        completeWithdraw: () => ({ to: c.vaultAddress, data: VAULT.encodeFunctionData("completeBondWithdraw", []), does: "Sends your queued bond back to your wallet." }),
      }[kind];
      if (!build) return bad(res, "Unknown step.");
      reply(res, 200, { ok: true, kind, chainId: c.chainId, ...build() });
    },
  };
}

module.exports = { createBondApi, VAULT, ERC20 };

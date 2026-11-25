// Surety verifier relay.
//
// Agents call a bonded provider THROUGH this relay:
//     <relay>/call/<providerAddress>/<path>
// The relay forwards the request untouched (x402 payment headers included),
// times it, checks the response against the provider's SLA, and if a PAID call
// failed, files payClaim on the vault so the agent is paid back from the bond.
//
// Because the relay sees the call itself, nobody has to take the agent's word
// for what happened.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { validateSlaDoc, matchEndpoint, checkResponse } = require("./sla");
const { parseReceipt, verifyTransfer } = require("./payment");
const { assertPublicUrl } = require("./netguard");

const VAULT_ABI = [
  "function providers(address) view returns (bool registered, uint64 bondReadyAt, uint64 claimCount, uint128 bond, uint128 bondPendingWithdraw, uint128 backingAssets, uint128 claimsPaid, uint256 backingShares, uint256 backingSharesPending, string metadataURI)",
  "function isActive(address) view returns (bool)",
  "function isCovered(address) view returns (bool)",
  "function coverOf(address) view returns (uint256)",
  "function committedCoverOf(address) view returns (uint256)",
  "function minProviderBond() view returns (uint256)",
  "function claimPaid(bytes32) view returns (bool)",
  "function payClaim(bytes32 claimId, address provider, address agent, uint256 payout, bytes32 evidenceHash)",
];
const ROUTER_ABI = [
  "function payClaim(bytes32 claimId, address provider, address agent, uint256 payout, bytes32 evidenceHash)",
  "function payClaimRemote(bytes32 claimId, address provider, address agent, uint256 payout, bytes32 evidenceHash, uint32 dstEid) returns (uint256)",
  "function pending(uint32 dstEid) view returns (uint256 refunds, uint256 amount)",
  "function quoteFlush(uint32 dstEid) view returns (uint256)",
  "function flush(uint32 dstEid) payable returns (bytes32, uint256)",
];

const SKIP_REQ = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"]);
const SKIP_RES = new Set(["connection", "content-length", "transfer-encoding", "content-encoding", "keep-alive"]);
const MAX_BODY = 1024 * 1024;

/**
 * @param {object} o
 * @param {string} o.vaultAddress
 * @param {string} o.usdcAddress
 * @param {import("ethers").Signer} o.signer   the vault's arbiter, connected to a provider
 * @param {string} [o.dataDir]                  where evidence + call log are stored
 * @param {boolean} [o.allowInsecure]           allow http:// SLA and provider URLs (local dev only)
 * @param {number} [o.hardTimeoutMs]            give up on a provider after this long
 * @param {number} [o.slaTtlMs]                 how long to cache an SLA document
 * @param {number} [o.statusTtlMs]              how long to cache a provider's active status
 * @param {string} [o.routerAddress]            a SuretyRouter that is the vault's arbiter. When set,
 *        every claim is filed through it, and payments made on a chain in `o.remote` can be refunded there
 * @param {Record<string, {provider: import("ethers").Provider, usdc: string, eid: number}>} [o.remote]
 *        other chains a payment may settle on, keyed by CAIP-2 id ("eip155:8453"): how to read that
 *        chain, its USDC, and its LayerZero endpoint id
 * @param {number} [o.flushAt]                  send a batch once this many refunds wait for a chain
 *        (default 20, a full batch; 0 never sends, leaving it to `crosschain.js flush`)
 * @param {(provider: string, path: string) => boolean} [o.skipStats]
 *        calls that should not count toward the trust score (the operator's own demo endpoint)
 */
function createRelay(o) {
  const provider = o.signer.provider;
  const vault = new ethers.Contract(o.vaultAddress, VAULT_ABI, o.signer);
  // With a router in front, the router is the arbiter and the relay files claims through it.
  const router = o.routerAddress ? new ethers.Contract(o.routerAddress, ROUTER_ABI, o.signer) : null;
  const remote = o.remote || {};
  const flushAt = o.flushAt ?? 20;
  const dataDir = o.dataDir || path.join(process.cwd(), "data");
  const hardTimeoutMs = o.hardTimeoutMs || 30_000;
  const slaTtlMs = o.slaTtlMs ?? 60_000;
  const statusTtlMs = o.statusTtlMs ?? 5_000;
  fs.mkdirSync(path.join(dataDir, "evidence"), { recursive: true });
  const callLog = path.join(dataDir, "calls.jsonl");
  let chainIdP = null; // looked up once
  const chainId = () => (chainIdP ||= provider.getNetwork().then((n) => n.chainId));

  // ---- call history (survives restarts via calls.jsonl)
  const stats = new Map();
  const bump = (addr, pass) => {
    const s = stats.get(addr) || { calls: 0, passed: 0 };
    s.calls += 1;
    if (pass) s.passed += 1;
    stats.set(addr, s);
  };
  if (fs.existsSync(callLog)) {
    for (const line of fs.readFileSync(callLog, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        bump(r.provider, r.pass);
      } catch {
        /* skip a corrupt line */
      }
    }
  }
  const logStream = fs.createWriteStream(callLog, { flags: "a" }); // buffered, never blocks a request
  const record = (addr, pass, extra) => {
    bump(addr, pass);
    logStream.write(JSON.stringify({ t: Date.now(), provider: addr, pass, ...extra }) + "\n");
  };

  // ---- SLA lookup: on-chain metadataURI -> hosted JSON document
  const slaCache = new Map();
  async function loadSla(addr) {
    const hit = slaCache.get(addr);
    if (hit && Date.now() - hit.at < slaTtlMs) return hit.sla;
    const p = await vault.providers(addr);
    if (!p.registered) throw httpError(404, "provider_not_registered");
    const sla = validateSlaDoc(await fetchSlaDoc(p.metadataURI));
    await assertPublicUrl(sla.baseUrl, o.allowInsecure);
    slaCache.set(addr, { at: Date.now(), sla });
    return sla;
  }
  async function fetchSlaDoc(uri) {
    if (uri.startsWith("data:application/json;base64,")) {
      return JSON.parse(Buffer.from(uri.slice(29), "base64").toString("utf8"));
    }
    const u = await assertPublicUrl(uri, o.allowInsecure);
    const res = await fetch(u, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!res.ok) throw new Error(`SLA fetch failed (${res.status})`);
    return res.json();
  }

  // ---- active status, cached briefly so a healthy call costs no extra RPC round trip
  const statusCache = new Map();
  async function isActive(addr) {
    const hit = statusCache.get(addr);
    if (hit && Date.now() - hit.at < statusTtlMs) return hit.active;
    const active = await covered(addr);
    statusCache.set(addr, { at: Date.now(), active });
    return active;
  }
  // Newer vaults also stop covering a provider once the day's refund limit is used up.
  // A vault deployed before that limit existed only knows isActive.
  let hasDailyLimit = null;
  async function covered(addr) {
    if (hasDailyLimit !== false) {
      try {
        const yes = await vault.isCovered(addr);
        hasDailyLimit = true;
        return yes;
      } catch (e) {
        if (hasDailyLimit) throw e; // a real read failure, not an old vault
        hasDailyLimit = false;
      }
    }
    return vault.isActive(addr);
  }

  // ---- claims are sent one at a time so the arbiter's nonces never collide
  let queue = Promise.resolve();
  const enqueue = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  async function fileClaim({ providerAddr, sla, receipt, evidence }) {
    // Where did the payment settle? A receipt that names one of the other chains this relay is
    // set up for is checked, and refunded, on that chain. Anything else is checked on ours, as
    // before, so a receipt naming a chain we do not serve simply fails to verify.
    const elsewhere = receipt.network && remote[receipt.network] && receipt.network !== `eip155:${await chainId()}` ? receipt.network : null;
    const chain = elsewhere ? remote[elsewhere] : null;
    if (chain && !router) throw new Error("router_not_configured");
    const { payer, amount } = await verifyTransfer({
      provider: chain ? chain.provider : provider,
      usdc: chain ? chain.usdc : o.usdcAddress,
      txHash: receipt.transaction,
      payTo: sla.payTo,
      payer: receipt.payer,
    });
    // The chain id is part of the claim id, so the same transaction hash on two chains is two claims.
    const paidOn = elsewhere ? BigInt(elsewhere.split(":")[1]) : await chainId();
    const claimId = ethers.solidityPackedKeccak256(["uint256", "bytes32"], [paidOn, receipt.transaction]);
    const bundle = { ...evidence, claimId, payer, amount: amount.toString(), paymentTx: receipt.transaction, ...(elsewhere ? { paymentChain: elsewhere } : {}) };
    const json = JSON.stringify(bundle, null, 2);
    const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes(json));
    return enqueue(async () => {
      if (await vault.claimPaid(claimId)) throw new Error("claim_already_paid");
      fs.writeFileSync(path.join(dataDir, "evidence", `${claimId}.json`), json);
      const tx = chain
        ? await router.payClaimRemote(claimId, providerAddr, payer, amount, evidenceHash, chain.eid)
        : await (router || vault).payClaim(claimId, providerAddr, payer, amount, evidenceHash);
      await tx.wait();
      statusCache.delete(providerAddr); // the bond just shrank
      const claim = { id: claimId, tx: tx.hash, payout: amount.toString(), agent: payer };
      if (!chain) return claim;
      // Settled: the bond is slashed and the refund is set aside in the router. It reaches the
      // agent's chain with the next batch, which goes out now if the queue is full.
      return { ...claim, settlesOn: elsewhere, delivery: await flushIfFull(chain.eid) };
    });
  }

  /// "sent" if a batch went out, otherwise "queued". Never fails the claim: the refund is
  /// already safe in the router, and anyone can send the batch later.
  async function flushIfFull(eid) {
    if (!flushAt) return "queued";
    try {
      const [waiting] = await router.pending(eid);
      if (waiting < BigInt(flushAt)) return "queued";
      await (await router.flush(eid, { value: await router.quoteFlush(eid) })).wait();
      return "sent";
    } catch {
      return "queued";
    }
  }

  // ---- trust score v0. Formula is public on purpose:
  //   inactive provider            -> 0
  //   reliability (60 pts)         -> pass rate over PAID calls seen by this relay (50% until 20 calls)
  //   cover (40 pts)               -> bond + backing not queued for exit, full marks at 10x the minimum bond
  async function trust(addr) {
    const [p, active, cover, minBond] = await Promise.all([
      vault.providers(addr),
      covered(addr),
      vault.committedCoverOf(addr),
      vault.minProviderBond(),
    ]);
    if (!p.registered) throw httpError(404, "provider_not_registered");
    const s = stats.get(addr) || { calls: 0, passed: 0 };
    const passRate = s.calls ? s.passed / s.calls : null;
    const reliability = s.calls >= 20 ? passRate : 0.5;
    const target = minBond * 10n;
    const coverFactor = target === 0n ? 1 : Math.min(1, Number((cover * 10_000n) / target) / 10_000);
    const score = active ? Math.round(60 * reliability + 40 * coverFactor) : 0;
    return {
      provider: addr,
      active,
      score,
      bond: p.bond.toString(),
      backing: p.backingAssets.toString(),
      committedCover: cover.toString(),
      calls: s.calls,
      passRate,
      claimsPaid: p.claimsPaid.toString(),
      claimCount: Number(p.claimCount),
    };
  }

  // ---- the proxied call
  async function handleCall(req, res, providerAddr, restPath, search) {
    const sla = await loadSla(providerAddr);
    // A provider under its minimum bond (or queuing its bond for exit) is not covered.
    // Checked BEFORE the call so a call made while covered is still honoured afterwards.
    const active = await isActive(providerAddr);
    const endpoint = active ? matchEndpoint(sla, req.method, restPath) : null;
    const uncoveredReason = active ? "endpoint_not_in_sla" : "provider_inactive";
    const body = ["GET", "HEAD"].includes(req.method) ? undefined : await readBody(req);

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!SKIP_REQ.has(k) && !k.startsWith("x-surety-")) headers[k] = v;
    }

    const started = performance.now();
    let upstream, bodyBuf;
    try {
      upstream = await fetch(sla.baseUrl + restPath + search, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(hardTimeoutMs),
      });
      bodyBuf = Buffer.from(await upstream.arrayBuffer());
    } catch {
      // No response means no settlement receipt, so there is nothing to refund.
      return send(res, 504, { "x-surety-verdict": endpoint ? "fail" : "uncovered", "x-surety-reason": "no_response" },
        JSON.stringify({ error: "provider did not respond" }));
    }
    const latencyMs = Math.round(performance.now() - started);

    const out = {};
    upstream.headers.forEach((v, k) => {
      if (!SKIP_RES.has(k)) out[k] = v;
    });
    out["x-surety-latency-ms"] = String(latencyMs);

    if (!endpoint) {
      out["x-surety-verdict"] = "uncovered";
      out["x-surety-reason"] = uncoveredReason;
    } else if (upstream.status === 402) {
      out["x-surety-verdict"] = "unpaid"; // normal x402 handshake, the client retries with payment
    } else {
      const check = checkResponse(endpoint, { status: upstream.status, latencyMs, bodyText: bodyBuf.toString("utf8") });
      out["x-surety-verdict"] = check.pass ? "pass" : "fail";
      out["x-surety-reason"] = check.reason;
      const receipt = parseReceipt(upstream.headers);
      // Only paid calls count toward the trust score: free calls are too cheap to fake.
      if (receipt && !(o.skipStats && o.skipStats(providerAddr, restPath))) {
        record(providerAddr, check.pass, { path: restPath, reason: check.reason, latencyMs, status: upstream.status });
      }

      if (!check.pass) {
        if (!receipt) {
          out["x-surety-claim"] = "none:no_payment_receipt";
        } else {
          try {
            const claim = await fileClaim({
              providerAddr,
              sla,
              receipt,
              evidence: {
                provider: providerAddr,
                at: new Date().toISOString(),
                reason: check.reason,
                request: { method: req.method, path: restPath + search, bodyHash: body ? ethers.keccak256(body) : null },
                response: { status: upstream.status, latencyMs, bodyHash: ethers.keccak256(bodyBuf) },
                sla: endpoint,
              },
            });
            out["x-surety-claim"] = "paid";
            out["x-surety-claim-id"] = claim.id;
            out["x-surety-claim-tx"] = claim.tx;
            out["x-surety-claim-payout"] = claim.payout;
            if (claim.settlesOn) {
              out["x-surety-claim-settles-on"] = claim.settlesOn; // the refund is paid on this chain
              out["x-surety-claim-delivery"] = claim.delivery; // queued | sent
            }
          } catch (e) {
            out["x-surety-claim"] = `error:${String(e.shortMessage || e.message).slice(0, 120)}`;
          }
        }
      }
    }
    send(res, upstream.status, out, bodyBuf);
  }

  const handle = async (req, res) => {
    try {
      const url = new URL(req.url, "http://relay");
      const parts = url.pathname.split("/");
      if (url.pathname === "/health") return send(res, 200, json(), JSON.stringify({ ok: true }));
      if (parts[1] === "trust" && req.method === "GET") {
        return send(res, 200, json(), JSON.stringify(await trust(parseAddr(parts[2]))));
      }
      if (parts[1] === "call") {
        const rest = "/" + parts.slice(3).join("/");
        return await handleCall(req, res, parseAddr(parts[2]), rest, url.search);
      }
      send(res, 404, json(), JSON.stringify({ error: "not_found" }));
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 502, json(), JSON.stringify({ error: e.message }));
    }
  };
  const server = http.createServer(handle);
  server.handle = handle; // lets another HTTP server mount the relay's routes
  server.trust = trust;
  server.sla = loadSla;
  server.known = () => [...slaCache.keys()]; // providers this relay has served since it started
  server.on("close", () => logStream.end());
  return server;
}

function parseAddr(s) {
  if (!ethers.isAddress(s)) throw httpError(400, "bad_provider_address");
  return ethers.getAddress(s);
}
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
function json() {
  return { "content-type": "application/json" };
}
function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(httpError(413, "body_too_large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = { createRelay, VAULT_ABI };

// One process, one port: the Surety relay and the Market Data API together.
// This is what runs on a host.   node start.js
//
//   /call/<provider>/<path>   the relay (agents call bonded providers through this)
//   /trust/<provider>         trust score
//   everything else           the Market Data API (/, /v1/price/mon, /v1/pool/:address, ...)
const http = require("http");
const os = require("os");
const path = require("path");
const express = require("express");
const { ethers } = require("ethers");
const { createRelay } = require("./verifier/relay");
const { createMarketApi } = require("./marketdata/server");
const { createPriceReader, MONAD_MAINNET } = require("./marketdata/prices");
const { createDemo } = require("./demo");
const { createCronPublish } = require("./site/cron");
const { directoryPage, notFoundPage } = require("./site/directory");
const { bondPage } = require("./site/bond-page");
const { createBondApi } = require("./site/bond-api");
const { networkFromEnv, networkByCaip } = require("./networks");
const { useNetwork } = require("./site/theme");

// Written by scripts/generate.js. Missing on a fresh checkout that hasn't been built yet.
let schedule = { scheduled: [] };
try {
  schedule = require("./site/schedule.json");
} catch {
  /* nothing scheduled */
}

const VAULT_ABI = [
  "function arbiter() view returns (address)",
  "function isActive(address) view returns (bool)",
  "function providers(address) view returns (bool registered, uint64 bondReadyAt, uint64 claimCount, uint128 bond, uint128 bondPendingWithdraw, uint128 backingAssets, uint128 claimsPaid, uint256 backingShares, uint256 backingSharesPending, string metadataURI)",
  "function register(string)",
  "function setMetadata(string)",
];

/// The address API payments go to, unless one is given: derived from the wallet key.
function derivePayTo(privateKey) {
  return new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes(`surety-payto:${privateKey}`))).address;
}

/**
 * Builds the combined request handler (an Express app) without listening or
 * touching the chain. Used by startSurety below and by app.js on Vercel.
 * @param {object} c  same fields as startSurety, with `publicUrl` required
 */
function buildSuretyApp(c) {
  const payTo = c.payTo || derivePayTo(c.wallet.privateKey);
  // The pages must describe the chain this server is on, whatever the build was told.
  const profile = networkByCaip(c.network);
  if (profile) useNetwork({ ...profile, usdc: c.usdcAddress, vault: c.vaultAddress, ...(c.explorer ? { explorer: c.explorer } : {}) });
  // Three roles that one test wallet can play, and that mainnet keeps apart:
  // the relay's signer (c.wallet), the provider being sold, and whoever pays for the homepage demo.
  const providerAddress = c.providerAddress || c.wallet.address;
  const demoWallet = c.demo === false ? null : c.demoWallet === undefined ? c.wallet : c.demoWallet;
  const api = createMarketApi({
    reader: c.reader, network: c.network, usdc: c.usdcAddress, payTo, tokenDomain: c.tokenDomain,
    facilitatorUrl: c.facilitatorUrl, price: c.price, publicUrl: c.publicUrl,
    landing: { provider: providerAddress, vaultAddress: c.vaultAddress, ...(c.repoUrl ? { repoUrl: c.repoUrl } : {}) },
    demo: demoWallet ? { ...c.demo } : undefined,
  });
  const relay = createRelay({
    vaultAddress: c.vaultAddress, usdcAddress: c.usdcAddress, signer: c.wallet,
    dataDir: c.dataDir, allowInsecure: c.allowInsecure,
    skipStats: (addr, p) => addr === providerAddress && p === "/v1/demo/slow",
  });
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) =>
    req.url.startsWith("/call/") || req.url.startsWith("/trust/") ? relay.handle(req, res) : next()
  );
  if (demoWallet) {
    const demo = createDemo({
      wallet: demoWallet, providerAddress, vaultAddress: c.vaultAddress, usdcAddress: c.usdcAddress, network: c.network,
      publicUrl: c.publicUrl, explorer: c.explorer, ...c.demo,
    });
    app.post("/demo/run", demo.handleRun);
    app.get("/demo/last", demo.handleLast);
  }
  // ---- provider directory: our own provider, any listed in settings, and any the relay has served
  const page = { url: c.publicUrl, vaultAddress: c.vaultAddress, ...(c.repoUrl ? { repoUrl: c.repoUrl } : {}) };
  const html = (res, body, status = 200) =>
    res.status(status).type("html").set("cache-control", "public, max-age=0, s-maxage=300, stale-while-revalidate=86400").send(body);
  const announced = new Set(); // providers that listed themselves through the bond page
  let directory = { at: 0, body: null };
  async function listProviders() {
    if (directory.body && Date.now() - directory.at < 15_000) return directory.body;
    const addrs = [...new Set([providerAddress, ...(c.directory || []), ...announced, ...relay.known()].map((a) => ethers.getAddress(a)))];
    const providers = (
      await Promise.all(
        addrs.map(async (addr) => {
          try {
            const [t, sla] = await Promise.all([relay.trust(addr), relay.sla(addr).catch(() => null)]);
            return {
              ...t,
              host: sla ? new URL(sla.baseUrl).host : null,
              endpoints: sla ? sla.endpoints.filter((e) => !e.path.startsWith("/v1/demo/")).map((e) => ({ method: e.method, path: e.path, maxLatencyMs: e.maxLatencyMs })) : [],
            };
          } catch {
            return null; // not registered, or the chain could not be read
          }
        })
      )
    ).filter(Boolean).sort((a, b) => Number(b.active) - Number(a.active) || b.score - a.score);
    directory = { at: Date.now(), body: { providers } };
    return directory.body;
  }
  app.get("/providers.json", async (_req, res) => {
    try {
      res.set("cache-control", "public, max-age=10").json(await listProviders());
    } catch (e) {
      res.status(502).json({ error: "could not read the vault" });
    }
  });
  app.get("/providers", (_req, res) => html(res, directoryPage(page)));

  // ---- self-serve bonding
  const chainId = Number(String(c.network).split(":")[1]);
  const bondApi = createBondApi({
    provider: c.wallet.provider, vaultAddress: c.vaultAddress, usdcAddress: c.usdcAddress, chainId,
    allowInsecure: c.allowInsecure,
    onSeen: (addr) => { if (announced.size < 500) announced.add(addr); directory.at = 0; },
  });
  app.get("/bond/sla-check", bondApi.slaCheck);
  app.get("/bond/account", bondApi.account);
  app.get("/bond/tx", bondApi.tx);
  app.get("/bond", (_req, res) => html(res, bondPage({ ...page, usdcAddress: c.usdcAddress, chainId, explorer: c.explorer })));

  app.get("/cron/publish", createCronPublish({ schedule }));
  // Generated pages (articles, sitemap, robots). Vercel serves public/ itself; this is for other hosts.
  app.use(express.static(path.join(__dirname, "public")));
  app.use(api.app);
  // Anything left over: a readable page for browsers, plain JSON for programs.
  app.use((req, res) =>
    req.accepts(["json", "html"]) === "html"
      ? res.status(404).type("html").send(notFoundPage(page))
      : res.status(404).json({ error: "not_found" })
  );
  return { app, payTo, slaUrl: `${c.publicUrl}/.well-known/surety.json` };
}

/// Points the on-chain provider record at `slaUrl`. Sends a transaction only if it needs changing.
async function pointProviderAt(wallet, vaultAddress, slaUrl, log = console.log) {
  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, wallet);
  const me = wallet.address;
  const [p, arbiter] = await Promise.all([vault.providers(me), vault.arbiter()]);
  if (arbiter !== me) log(`WARNING: this wallet is not the vault's arbiter (${arbiter}), so refunds will fail.`);
  if (!p.registered) {
    await (await vault.register(slaUrl)).wait();
    log("Registered as a provider.");
  } else if (p.metadataURI !== slaUrl) {
    await (await vault.setMetadata(slaUrl)).wait();
    log("Pointed the provider record at this server.");
  } else {
    log("Provider record already points at this server.");
  }
  const active = await vault.isActive(me);
  log(`  provider ${me}  bond ${ethers.formatUnits(p.bond, 6)} USDC  ${active ? "ACTIVE" : "NOT ACTIVE: bond is under the minimum, calls are not covered"}`);
  return active;
}

/**
 * Long-running server: listens on a port and registers itself on-chain at boot.
 * @param {object} c
 * @param {import("ethers").Wallet} c.wallet     arbiter + provider wallet, connected to the payment network
 * @param {string} c.vaultAddress
 * @param {string} c.usdcAddress                 payment token
 * @param {string} c.network                     CAIP-2 id payments settle on
 * @param {string} c.facilitatorUrl
 * @param {object} c.reader                      from createPriceReader
 * @param {number} [c.port]
 * @param {string} [c.publicUrl]                 public https address of this server
 * @param {string} [c.payTo]                     defaults to an address derived from the wallet key
 * @param {boolean} [c.allowInsecure]            local testing only
 * @param {string} [c.dataDir] @param {string} [c.price] @param {(m: string) => void} [c.log]
 */
async function startSurety(c) {
  const log = c.log || console.log;
  let onRequest = (_req, res) => res.writeHead(503).end("starting");
  const server = http.createServer((req, res) => onRequest(req, res));
  await new Promise((r) => server.listen(c.port ?? 0, c.host || "0.0.0.0", r));
  const url = (c.publicUrl || `http://127.0.0.1:${server.address().port}`).replace(/\/+$/, "");
  const built = buildSuretyApp({ ...c, publicUrl: url });
  onRequest = built.app;
  log(`Surety running at ${url}`);
  const provider = c.providerAddress || c.wallet.address;
  // The listing can only be updated by the provider's own wallet. When that key is kept off this
  // server (as on mainnet), update it from your own machine with scripts/set-host.js.
  if (provider === c.wallet.address) await pointProviderAt(c.wallet, c.vaultAddress, built.slaUrl, log);
  else log(`  provider ${provider} is a separate wallet: point its listing here with scripts/set-host.js`);
  log(`  agents call:  ${url}/call/${provider}/v1/price/mon`);
  return { url, provider, payTo: built.payTo, close: () => new Promise((r) => server.close(r)) };
}

/// Reads the standard settings from environment variables.
///
/// On testnet one PRIVATE_KEY can play every part. On mainnet (SURETY_NETWORK=mainnet)
/// the parts are separate settings, and the vault owner's key is never one of them:
///   ARBITER_KEY        the relay's signer. The only key the server must hold.
///   PROVIDER_ADDRESS   the wallet the Market Data API is listed and bonded under (address only).
///   PAY_TO_ADDRESS     where API payments land (address only).
///   DEMO_KEY           optional: a small wallet that pays for homepage demo calls. No key, no demo.
function configFromEnv(env = process.env) {
  const net = networkFromEnv(env);
  const arbiterKey = env.ARBITER_KEY || env.PRIVATE_KEY;
  if (!arbiterKey || !env.VAULT_ADDRESS) throw new Error("Set VAULT_ADDRESS and ARBITER_KEY (or PRIVATE_KEY on testnet).");
  const hex = (k) => (k.startsWith("0x") ? k : `0x${k}`);
  const rpc = new ethers.JsonRpcProvider(net.rpc);
  const wallet = new ethers.Wallet(hex(arbiterKey), rpc);
  if (net.real) {
    const missing = ["PROVIDER_ADDRESS", "PAY_TO_ADDRESS"].filter((k) => !ethers.isAddress(env[k] || ""));
    if (missing.length) throw new Error(`On mainnet, set ${missing.join(" and ")} (addresses, not keys).`);
    if (!env.ARBITER_KEY) throw new Error("On mainnet, name the relay's key ARBITER_KEY, so it is never confused with an owner key.");
  }
  const host = env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL || env.RAILWAY_PUBLIC_DOMAIN;
  const publicUrl = (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || (host && `https://${host}`) || "").replace(/\/+$/, "") || undefined;
  return {
    wallet,
    providerAddress: env.PROVIDER_ADDRESS ? ethers.getAddress(env.PROVIDER_ADDRESS) : wallet.address,
    // Testnet: the one wallet pays for demos too. Mainnet: only a wallet set aside for it.
    demoWallet: env.DEMO_KEY ? new ethers.Wallet(hex(env.DEMO_KEY), rpc) : net.real ? null : wallet,
    vaultAddress: env.VAULT_ADDRESS,
    usdcAddress: net.usdc,
    network: env.X402_NETWORK || net.caip,
    facilitatorUrl: net.facilitatorUrl,
    explorer: net.explorer,
    tokenDomain: env.USDC_DOMAIN_NAME ? { name: env.USDC_DOMAIN_NAME, version: env.USDC_DOMAIN_VERSION || "2" } : undefined,
    reader: createPriceReader({
      provider: new ethers.JsonRpcProvider(env.DATA_RPC || MONAD_MAINNET.rpc),
      factories: MONAD_MAINNET.factories, wmon: MONAD_MAINNET.wmon, usdc: MONAD_MAINNET.usdc,
      minUsdcDepth: Number(env.MIN_POOL_USDC || 1000),
    }),
    port: Number(env.PORT || 8402),
    publicUrl,
    payTo: env.PAY_TO_ADDRESS || undefined,
    price: env.API_PRICE || "$0.001",
    repoUrl: env.REPO_URL || undefined,
    directory: (env.DIRECTORY_PROVIDERS || "").split(",").map((a) => a.trim()).filter((a) => ethers.isAddress(a)),
    // Serverless hosts only allow writes under the temp folder.
    dataDir: env.DATA_DIR || (env.VERCEL ? path.join(os.tmpdir(), "surety") : undefined),
    allowInsecure: !publicUrl, // only when running locally with no public address
  };
}

module.exports = { startSurety, buildSuretyApp, pointProviderAt, configFromEnv, derivePayTo };

if (require.main === module) {
  require("dotenv").config();
  let config;
  try {
    config = configFromEnv();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  startSurety(config).catch((e) => {
    console.error(`STOPPED: ${e.shortMessage || e.message}`);
    process.exit(1);
  });
}

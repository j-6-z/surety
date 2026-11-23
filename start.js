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
  const api = createMarketApi({
    reader: c.reader, network: c.network, usdc: c.usdcAddress, payTo,
    facilitatorUrl: c.facilitatorUrl, price: c.price, publicUrl: c.publicUrl,
  });
  const relay = createRelay({
    vaultAddress: c.vaultAddress, usdcAddress: c.usdcAddress, signer: c.wallet,
    dataDir: c.dataDir, allowInsecure: c.allowInsecure,
  });
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) =>
    req.url.startsWith("/call/") || req.url.startsWith("/trust/") ? relay.handle(req, res) : next()
  );
  app.use(api.app);
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
  await pointProviderAt(c.wallet, c.vaultAddress, built.slaUrl, log);
  log(`  agents call:  ${url}/call/${c.wallet.address}/v1/price/mon`);
  return { url, provider: c.wallet.address, payTo: built.payTo, close: () => new Promise((r) => server.close(r)) };
}

/// Reads the standard settings from environment variables.
function configFromEnv(env = process.env) {
  if (!env.PRIVATE_KEY || !env.VAULT_ADDRESS) throw new Error("Set PRIVATE_KEY and VAULT_ADDRESS.");
  const key = env.PRIVATE_KEY.startsWith("0x") ? env.PRIVATE_KEY : `0x${env.PRIVATE_KEY}`;
  const host = env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL || env.RAILWAY_PUBLIC_DOMAIN;
  const publicUrl = (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || (host && `https://${host}`) || "").replace(/\/+$/, "") || undefined;
  return {
    wallet: new ethers.Wallet(key, new ethers.JsonRpcProvider(env.MONAD_TESTNET_RPC || "https://testnet-rpc.monad.xyz")),
    vaultAddress: env.VAULT_ADDRESS,
    usdcAddress: env.USDC_ADDRESS || "0x534b2f3A21130d7a60830c2Df862319e593943A3",
    network: env.X402_NETWORK || "eip155:10143",
    facilitatorUrl: env.FACILITATOR_URL || "https://x402-facilitator.molandak.org",
    reader: createPriceReader({
      provider: new ethers.JsonRpcProvider(env.DATA_RPC || MONAD_MAINNET.rpc),
      factories: MONAD_MAINNET.factories, wmon: MONAD_MAINNET.wmon, usdc: MONAD_MAINNET.usdc,
      minUsdcDepth: Number(env.MIN_POOL_USDC || 1000),
    }),
    port: Number(env.PORT || 8402),
    publicUrl,
    payTo: env.PAY_TO_ADDRESS || undefined,
    price: env.API_PRICE || "$0.001",
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

// Settings from environment variables. Switchboard holds no private key: it only needs an
// address to receive lookup fees (SWITCHBOARD_PAY_TO). Leave that unset and lookups are free.
const { ethers } = require("ethers");
const { networkFromEnv } = require("./networks");
const { createRegistry } = require("./registry");

function configFromEnv(env = process.env) {
  const net = networkFromEnv(env);
  const payTo = env.SWITCHBOARD_PAY_TO || "";
  if (payTo && !ethers.isAddress(payTo)) throw new Error("SWITCHBOARD_PAY_TO must be an address (not a key).");
  const extraProviders = (env.EXTRA_PROVIDERS || "").split(",").map((a) => a.trim()).filter((a) => ethers.isAddress(a));
  const registry = createRegistry({
    suretyUrl: net.surety, caip: net.caip, usdc: net.usdc, rpc: net.rpc, vaultAddress: net.vault,
    extraProviders, ttlMs: Number(env.INDEX_TTL_MS || 60_000),
  });
  return {
    registry,
    suretyUrl: net.surety,
    caip: net.caip,
    usdc: net.usdc,
    label: net.label,
    explorer: net.explorer,
    facilitatorUrl: net.facilitatorUrl,
    payTo: payTo ? ethers.getAddress(payTo) : undefined,
    routePrice: env.ROUTE_PRICE || "$0.0001",
    tokenDomain: env.USDC_DOMAIN_NAME ? { name: env.USDC_DOMAIN_NAME, version: env.USDC_DOMAIN_VERSION || "2" } : undefined,
    port: Number(env.PORT || 8403),
  };
}

module.exports = { configFromEnv };

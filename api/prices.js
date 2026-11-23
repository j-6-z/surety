// On-chain price reader. Prices come straight from Uniswap-V3-style pools on
// Monad, so there is no third-party data provider and nothing to license.
const { ethers } = require("ethers");

const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
];
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
];
const FEE_TIERS = [100, 500, 3000, 10000];
const Q192 = 2n ** 192n;

// Monad mainnet (chain 143). Sources: Uniswap deployment docs, Monad docs.
const MONAD_MAINNET = {
  rpc: "https://rpc.monad.xyz",
  factories: [{ dex: "uniswap-v3", address: "0x204faca1764b154221e35c0d20abb3c525710498" }],
  wmon: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A",
  usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
};

/// token1 per token0, as a JS number, from a V3 sqrtPriceX96.
function priceFromSqrt(sqrtPriceX96, decimals0, decimals1) {
  const ratio = sqrtPriceX96 * sqrtPriceX96; // token1/token0 in raw units, scaled by 2^192
  const scaled = (ratio * 10n ** BigInt(decimals0) * 10n ** 18n) / (Q192 * 10n ** BigInt(decimals1));
  return Number(scaled) / 1e18;
}

function createPriceReader({ provider, factories, wmon, usdc, minUsdcDepth = 1000, cacheMs = 1000 }) {
  const tokenMeta = new Map(); // decimals and symbols never change
  const meta = async (addr) => {
    const key = addr.toLowerCase();
    if (!tokenMeta.has(key)) {
      const t = new ethers.Contract(addr, ERC20_ABI, provider);
      tokenMeta.set(key, Promise.all([t.decimals(), t.symbol()]).then(([d, s]) => ({ decimals: Number(d), symbol: s })));
    }
    return tokenMeta.get(key);
  };
  const cache = new Map();
  const cached = (key, fn) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < cacheMs) return hit.value;
    const value = fn();
    cache.set(key, { at: Date.now(), value });
    value.catch(() => cache.delete(key));
    return value;
  };

  /// Everything about one V3-style pool.
  function readPool(address) {
    const addr = ethers.getAddress(address);
    return cached(`pool:${addr}`, async () => {
      const pool = new ethers.Contract(addr, POOL_ABI, provider);
      const [slot0, t0, t1, fee, block] = await Promise.all([
        pool.slot0(), pool.token0(), pool.token1(), pool.fee(), provider.getBlockNumber(),
      ]);
      const [m0, m1] = await Promise.all([meta(t0), meta(t1)]);
      const [b0, b1] = await Promise.all([
        new ethers.Contract(t0, ERC20_ABI, provider).balanceOf(addr),
        new ethers.Contract(t1, ERC20_ABI, provider).balanceOf(addr),
      ]);
      const price = priceFromSqrt(slot0.sqrtPriceX96, m0.decimals, m1.decimals);
      return {
        pool: addr,
        feeBps: Number(fee) / 100,
        token0: { address: t0, symbol: m0.symbol, reserve: Number(ethers.formatUnits(b0, m0.decimals)) },
        token1: { address: t1, symbol: m1.symbol, reserve: Number(ethers.formatUnits(b1, m1.decimals)) },
        price0In1: price,
        price1In0: price === 0 ? 0 : 1 / price,
        block,
        timestamp: new Date().toISOString(),
        source: "onchain",
      };
    });
  }

  /// MON price in USD: the deepest WMON/USDC pool across the configured factories.
  function monPrice() {
    return cached("mon", async () => {
      const lookups = factories.flatMap((f) =>
        FEE_TIERS.map(async (fee) => {
          const addr = await new ethers.Contract(f.address, FACTORY_ABI, provider).getPool(wmon, usdc, fee);
          return addr === ethers.ZeroAddress ? null : { dex: f.dex, address: addr };
        })
      );
      const found = (await Promise.all(lookups)).filter(Boolean);
      const pools = await Promise.all(found.map(async (f) => ({ ...(await readPool(f.address)), dex: f.dex })));
      const usdcSide = (p) => (p.token0.address.toLowerCase() === usdc.toLowerCase() ? "token0" : "token1");
      const best = pools.sort((a, b) => b[usdcSide(b)].reserve - a[usdcSide(a)].reserve)[0];
      if (!best || best[usdcSide(best)].reserve < minUsdcDepth) {
        const err = new Error("no_liquid_pool");
        err.status = 503;
        err.detail = { poolsFound: pools.length, deepestUsdc: best ? best[usdcSide(best)].reserve : 0, minUsdcDepth };
        throw err;
      }
      const usdcIs0 = usdcSide(best) === "token0";
      return {
        symbol: "MON",
        priceUsd: usdcIs0 ? best.price1In0 : best.price0In1,
        quote: "USDC",
        dex: best.dex,
        pool: best.pool,
        feeBps: best.feeBps,
        poolUsdc: best[usdcSide(best)].reserve,
        block: best.block,
        timestamp: best.timestamp,
        source: "onchain",
      };
    });
  }

  return { readPool, monPrice };
}

module.exports = { createPriceReader, priceFromSqrt, MONAD_MAINNET };

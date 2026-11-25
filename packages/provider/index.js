// surety-provider: a paid x402 API on Monad with a bond behind it.
//
//   const { serve } = require("surety-provider");
//   serve({
//     payTo: "0xYourWallet",
//     endpoints: [{ path: "/v1/hello", maxLatencyMs: 4000, handler: () => ({ hello: "world" }) }],
//   });
//
// Then post a bond so its calls are covered:   npx surety-provider bond https://your-api.example
const surety = require("./lib/surety");
const { bond, bondFromEnv } = require("./lib/bond");
const { check, report } = require("./lib/check");
const { tryCall, tryFromEnv } = require("./lib/try");

module.exports = { ...surety, bond, bondFromEnv, check, report, tryCall, tryFromEnv };

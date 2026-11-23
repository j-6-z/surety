// Vercel entry point. Vercel finds this file, sees it export an Express app,
// and runs it as one function. Same routes as start.js:
//
//   /call/<provider>/<path>, /trust/<provider>   the relay
//   everything else                              the Market Data API
//
// Set PRIVATE_KEY, VAULT_ADDRESS and PUBLIC_URL in the Vercel project settings.
// After the first deploy, run once from your own machine:
//   node scripts/set-host.js https://<your-domain>
const express = require("express");
const { buildSuretyApp, configFromEnv } = require("./start");

let app;
try {
  const config = configFromEnv();
  if (!config.publicUrl) throw new Error("Set PUBLIC_URL to this deployment's https address.");
  app = buildSuretyApp(config).app;
} catch (e) {
  // Misconfigured: answer every request with the reason instead of crashing.
  app = express();
  app.use((_req, res) => res.status(500).json({ error: "surety_not_configured", detail: e.message }));
}

module.exports = app;

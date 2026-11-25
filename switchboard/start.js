// Always-on / local server:   node start.js
require("dotenv").config({ quiet: true });
const { buildApp } = require("./server");
const { configFromEnv } = require("./config");

const c = configFromEnv();
const { app } = buildApp(c);
app.listen(c.port, () => {
  console.log(`Switchboard on http://localhost:${c.port}  (${c.label}, relay ${c.suretyUrl})`);
  console.log(c.payTo ? `  lookups cost ${c.routePrice}, paid to ${c.payTo}` : "  lookups are free (set SWITCHBOARD_PAY_TO to charge)");
  c.registry.refresh().then((s) => console.log(`  indexed ${s.providers} provider(s), ${s.routes.length} route(s)`)).catch((e) => console.log("  index failed:", e.message));
});

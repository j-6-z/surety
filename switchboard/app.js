// Vercel entry point: exports the Express app. Settings go in the Vercel project.
const express = require("express");
const { buildApp } = require("./server");
const { configFromEnv } = require("./config");

let app;
try {
  app = buildApp(configFromEnv()).app;
} catch (e) {
  app = express();
  app.use((_req, res) => res.status(500).json({ error: "switchboard_not_configured", detail: e.message }));
}
module.exports = app;

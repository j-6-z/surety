// Runs Foundry's `forge` for this project:   node scripts/forge.js test
//
// Foundry ships one ready-made program per operating system. This picks the right
// one and, the first time, downloads it from npm into node_modules (about 70 MB).
// Nothing is added to package.json, so the hosted site never installs it.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const VERSION = "1.7.1";
const ROOT = path.join(__dirname, "..");
const cpu = { x64: "amd64", arm64: "arm64" }[process.arch];
const os = { win32: "win32", linux: "linux", darwin: "darwin" }[process.platform];

/// Where the forge program is (downloading it first if needed).
function forgePath({ log = console.error } = {}) {
  if (process.env.FORGE_BIN) return process.env.FORGE_BIN; // use your own install instead
  if (!cpu || !os) throw new Error(`Foundry has no ready-made build for ${process.platform} ${process.arch}. Install it from https://getfoundry.sh and set FORGE_BIN to its path.`);
  const pkg = `@foundry-rs/forge-${os}-${cpu}`;
  const bin = path.join(ROOT, "node_modules", ...pkg.split("/"), "bin", os === "win32" ? "forge.exe" : "forge");
  if (!fs.existsSync(bin)) {
    log(`Getting Foundry ${VERSION} for ${os} ${cpu} (first run only)...`);
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const r = spawnSync(npm, ["install", "--no-save", "--no-audit", "--no-fund", `${pkg}@${VERSION}`], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" });
    if (r.status !== 0 || !fs.existsSync(bin)) throw new Error(`Could not install ${pkg}@${VERSION}. Check your internet connection and run this again.`);
  }
  return bin;
}

/// Runs forge with these arguments and returns { status, stdout, stderr } (captured when capture is true).
function forge(args, { capture = false } = {}) {
  return spawnSync(forgePath(), args, { cwd: ROOT, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
}

module.exports = { forge, forgePath, VERSION };

if (require.main === module) {
  try {
    const r = forge(process.argv.slice(2));
    if (r.error) throw r.error;
    process.exit(r.status ?? 1);
  } catch (e) {
    console.error(`STOPPED: ${e.message}`);
    process.exit(1);
  }
}

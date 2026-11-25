// The provider library lives in packages/provider/lib. The copy-and-go starter in kit/
// carries its own copy of those files so it works with nothing but `npm install`.
// This keeps the two identical:   npm run sync:kit      (a test fails if they drift)
const fs = require("fs");
const path = require("path");

const FILES = ["surety.js", "bond.js", "check.js", "try.js"];
const from = path.join(__dirname, "..", "packages", "provider", "lib");
const to = path.join(__dirname, "..", "kit");

/// Returns the names of files that differ. With write=true, copies them across first.
function syncKit({ write = false } = {}) {
  const changed = [];
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(from, f), "utf8");
    const dst = fs.existsSync(path.join(to, f)) ? fs.readFileSync(path.join(to, f), "utf8") : null;
    if (src.replace(/\r\n/g, "\n") !== (dst || "").replace(/\r\n/g, "\n")) {
      changed.push(f);
      if (write) fs.writeFileSync(path.join(to, f), src);
    }
  }
  return changed;
}

module.exports = { syncKit, FILES };

if (require.main === module) {
  const changed = syncKit({ write: true });
  console.log(changed.length ? `Updated kit/: ${changed.join(", ")}` : "kit/ already matches packages/provider/lib.");
}

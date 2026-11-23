// Stops the relay being used to reach internal services: provider-supplied URLs
// must be https and must not resolve to a private, loopback or link-local address.
// (allowInsecure turns this off for local development.)
const dns = require("dns").promises;
const net = require("net");

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7));
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

async function assertPublicUrl(url, allowInsecure = false, lookup = dns.lookup) {
  const u = new URL(url);
  if (allowInsecure && (u.protocol === "http:" || u.protocol === "https:")) return u;
  if (u.protocol !== "https:") throw new Error("url_must_be_https");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("url_not_public");
  return u;
}

module.exports = { assertPublicUrl, isPrivateIp };

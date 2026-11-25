// Time every endpoint against its own promise, before any money is involved.
//
//   npm run check
//
// Runs each handler a few times on this computer (no payment, no network fee)
// and tells you whether the promise in app.js is one you can keep.
const Ajv = require("ajv");

const ajv = new Ajv({ allErrors: true, strict: false }); // the same settings the relay checks with

/// Fills a fake request from an example path: "/v1/shout/:word" + "/v1/shout/hello" -> params.word = "hello".
function fakeRequest(e) {
  const example = e.example || (e.path.includes(":") ? null : e.path);
  if (!example) return null;
  const url = new URL(example, "http://check.local");
  const want = e.path.split("/"), got = url.pathname.split("/");
  if (want.length !== got.length) return null;
  const params = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(":")) params[want[i].slice(1)] = decodeURIComponent(got[i]);
    else if (want[i] !== got[i]) return null;
  }
  return { method: e.method, path: url.pathname, url: url.pathname + url.search, params, query: Object.fromEntries(url.searchParams), headers: {}, body: e.exampleBody ?? {} };
}

/**
 * @param {object} api  what createBondedApi returned
 * @param {object} [o]  @param {number} [o.runs] times each handler is called (default 3)
 * @returns {Promise<Array<{endpoint: string, ok: boolean, level: "ok"|"tight"|"fail", worstMs?: number, budgetMs?: number, note: string}>>}
 */
async function check(api, { runs = 3 } = {}) {
  const results = [];
  for (const e of api.endpoints) {
    const endpoint = `${e.method} ${e.path}`;
    const fail = (note, extra = {}) => results.push({ endpoint, ok: false, level: "fail", note, ...extra });
    const req = fakeRequest(e);
    if (!req) {
      fail(`add  example: "/a/real/path"  to this endpoint so it can be tried`);
      continue;
    }
    const problem = e.validate && e.validate(req);
    if (problem) {
      fail(`its own example is rejected by validate: ${problem}`);
      continue;
    }
    let validate = null;
    if (e.responseSchema) {
      try {
        validate = ajv.compile(e.responseSchema);
      } catch (err) {
        fail(`responseSchema is not valid JSON Schema: ${err.message}`);
        continue;
      }
    }
    // What the handler may use: the promise, less the time payment settlement takes.
    const budgetMs = Math.max(e.maxLatencyMs - api.settleReserveMs, 0);
    let worstMs = 0, error = null;
    for (let i = 0; i < runs && !error; i++) {
      const t = performance.now();
      try {
        const body = JSON.parse(JSON.stringify(await api.run(e, req) ?? null)); // as it would arrive over the wire
        if (validate && !validate(body)) error = `answer does not match responseSchema: ${ajv.errorsText(validate.errors)}`;
      } catch (err) {
        error = err.message === "too_slow_not_charged" ? `took longer than the ${e.deadlineMs} ms it has before the kit gives up` : `handler failed: ${err.message}`;
      }
      worstMs = Math.max(worstMs, Math.round(performance.now() - t));
    }
    if (error) fail(error, { worstMs, budgetMs });
    else if (budgetMs === 0) results.push({ endpoint, ok: true, level: "tight", worstMs, budgetMs, note: `promises ${e.maxLatencyMs} ms, less than payment settlement usually takes. Expect refunds` });
    else if (worstMs > budgetMs * 0.6) results.push({ endpoint, ok: true, level: "tight", worstMs, budgetMs, note: `uses over 60% of its time. Raise maxLatencyMs or speed it up` });
    else results.push({ endpoint, ok: true, level: "ok", worstMs, budgetMs, note: "comfortable" });
  }
  return results;
}

/**
 * Runs check() and prints one verdict per endpoint. Returns how many did not keep their promise.
 * @param {object} api  what createBondedApi returned
 * @param {{log?: (m: string) => void, tryCommand?: string}} [o]
 */
async function report(api, { log = console.log, tryCommand = "npm run try" } = {}) {
  const results = await check(api);
  const mark = { ok: "OK   ", tight: "TIGHT", fail: "FAIL " };
  for (const r of results) {
    const time = r.worstMs === undefined ? "" : `  slowest ${r.worstMs} ms of ${r.budgetMs} ms`;
    log(`${mark[r.level]}  ${r.endpoint}${time}\n       ${r.note}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  log(failed
    ? `\n${failed} endpoint(s) did not keep their promise. Fix them before you bond.`
    : `\nEvery endpoint keeps its promise from this computer. Your host may be slower, so run "${tryCommand}" once it is live.`);
  return failed;
}

module.exports = { check, report, fakeRequest };

if (require.main === module) {
  let api;
  try {
    api = require("./app").api;
  } catch (e) {
    console.error(`STOPPED: app.js could not start: ${e.message}`);
    process.exit(1);
  }
  report(api).then((failed) => process.exit(failed ? 1 : 0));
}

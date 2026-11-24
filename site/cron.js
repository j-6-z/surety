// Daily scheduled job: publishes articles on the date they were written for.
//
// Articles dated in the future are left out of a build and listed in
// site/schedule.json. Vercel calls /cron/publish once a day (see vercel.json).
// If an article has come due, this asks Vercel for a fresh deploy, and the
// rebuild picks it up. On days with nothing due it does nothing.
//
// Settings (Vercel project > Environment Variables):
//   CRON_SECRET       any long random string; Vercel sends it with each cron call
//   DEPLOY_HOOK_URL   a Deploy Hook URL (Project > Settings > Git > Deploy Hooks)

/**
 * @param {object} o
 * @param {{scheduled: {slug: string, date: string}[]}} o.schedule
 * @param {Record<string, string|undefined>} [o.env]
 * @param {typeof fetch} [o.fetch]
 * @param {() => string} [o.today]   YYYY-MM-DD in UTC
 */
function createCronPublish({ schedule, env = process.env, fetch: f = globalThis.fetch, today = () => new Date().toISOString().slice(0, 10) }) {
  return async (req, res) => {
    const reply = (status, body) => res.status(status).set("cache-control", "no-store").json(body);
    if (!env.CRON_SECRET) return reply(503, { error: "CRON_SECRET is not set, so the scheduled job is switched off." });
    if (req.headers.authorization !== `Bearer ${env.CRON_SECRET}`) return reply(401, { error: "unauthorized" });

    const due = (schedule.scheduled || []).filter((a) => a.date <= today());
    if (due.length === 0) {
      return reply(200, { ok: true, due: 0, waiting: (schedule.scheduled || []).length });
    }
    if (!env.DEPLOY_HOOK_URL) {
      return reply(500, { error: "Articles are due but DEPLOY_HOOK_URL is not set, so no rebuild was started.", due: due.map((a) => a.slug) });
    }
    try {
      const hook = await f(env.DEPLOY_HOOK_URL, { method: "POST" });
      if (!hook.ok) return reply(502, { error: `The deploy hook answered ${hook.status}.`, due: due.map((a) => a.slug) });
      return reply(200, { ok: true, due: due.length, rebuilding: true, articles: due.map((a) => a.slug) });
    } catch (e) {
      return reply(502, { error: `Could not reach the deploy hook: ${e.message}`, due: due.map((a) => a.slug) });
    }
  };
}

module.exports = { createCronPublish };

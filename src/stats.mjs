// Daily snapshot of the account (followers) and of each reel (total likes and comments).
// One snapshot per day per account is updated every time it is taken, so the last value of the day is the one that stays.
import { all, run, logEvent } from './db.mjs';
import { apiFor } from './platform.mjs';

// The last argument of each call is the account's platform ('instagram' | 'facebook').
const defaults = {
  getAccountStats: (host, token, id, type) => apiFor(type).getAccountStats(host, token, id),
  listMedia: (host, token, id, type) => apiFor(type).listMedia(host, token, id),
  listConversations: (host, token, id, limit, type) => apiFor(type).listConversations(host, token, id, limit),
  getMediaInsights: (host, token, mediaId, type) => apiFor(type).getMediaInsights(host, token, mediaId),
  getAccountInsights: (host, token, id, type) => apiFor(type).getAccountInsights(host, token, id),
};
const INSIGHT_REELS = 12; // only the most recent: old ones barely change, and this protects Meta's limits

// Stores the time of the last message each person wrote to us (to know who wrote back after receiving the resource)
export function saveFollowups(ch, conversations) {
  let n = 0;
  for (const conv of conversations || []) {
    for (const m of conv.messages?.data || []) {
      const from = String(m.from?.id ?? '');
      if (!from || from === String(ch.ig_user_id) || !m.created_time) continue;
      const at = new Date(Date.parse(String(m.created_time).replace(/([+-]\d\d)(\d\d)$/, '$1:$2'))).toISOString();
      run(`INSERT INTO followups(channel_id, igsid, last_in) VALUES (?,?,?)
           ON CONFLICT(channel_id, igsid) DO UPDATE SET last_in=MAX(last_in, excluded.last_in)`, ch.id, from, at);
      n++;
    }
  }
  return n;
}

// Uptime: one span each time the program starts; it is extended every minute while it stays on.
let spanId = null;
export function heartbeat(now = new Date()) {
  const t = now.toISOString();
  if (spanId == null) spanId = Number(run('INSERT INTO uptime(started, last) VALUES (?,?)', t, t).lastInsertRowid);
  else run('UPDATE uptime SET last=? WHERE id=?', t, spanId);
}
export const resetHeartbeat = () => { spanId = null; };
const lastErr = new Map();

export async function collectStats(deps = {}) {
  const d = { ...defaults, ...deps };
  const channels = all("SELECT * FROM channels WHERE token IS NOT NULL AND ig_user_id NOT LIKE 'demo_%'");
  let done = 0;
  for (const ch of channels) {
    try {
      const acc = await d.getAccountStats(ch.host, ch.token, ch.ig_user_id, ch.type);
      run(`INSERT INTO account_stats(channel_id, day, followers, media_count) VALUES (?, date('now','localtime'), ?, ?)
           ON CONFLICT(channel_id, day) DO UPDATE SET followers=excluded.followers, media_count=excluded.media_count`,
        ch.id, acc.followers_count ?? null, acc.media_count ?? null);
      const media = (await d.listMedia(ch.host, ch.token, ch.ig_user_id, ch.type)).data || [];
      for (const m of media) {
        run(`INSERT INTO media_stats(channel_id, media_id, day, likes, comments) VALUES (?,?,date('now','localtime'),?,?)
             ON CONFLICT(channel_id, media_id, day) DO UPDATE SET likes=excluded.likes, comments=excluded.comments`,
          ch.id, String(m.id), m.like_count ?? null, m.comments_count ?? null);
      }
      try { // insights of the account and recent reels (if the permission is missing, only warn once)
        const ai = await d.getAccountInsights(ch.host, ch.token, ch.ig_user_id, ch.type);
        run(`UPDATE account_stats SET reach=?, views=?, engaged=? WHERE channel_id=? AND day=date('now','localtime')`, ai.reach ?? null, ai.views ?? null, ai.accounts_engaged ?? null, ch.id);
        for (const m of media.slice(0, INSIGHT_REELS)) {
          const i = await d.getMediaInsights(ch.host, ch.token, m.id, ch.type);
          run(`UPDATE media_stats SET views=?, reach=?, saved=?, shares=?, interactions=?, watch_ms=? WHERE channel_id=? AND media_id=? AND day=date('now','localtime')`,
            i.views ?? null, i.reach ?? null, i.saved ?? null, i.shares ?? null, i.total_interactions ?? null, i.ig_reels_avg_watch_time ?? null, ch.id, String(m.id));
        }
        lastErr.delete('in' + ch.id);
      } catch (e) { if (lastErr.get('in' + ch.id) !== e.message) logEvent('warn', `Could not read insights of @${ch.username}: ${e.message}`); lastErr.set('in' + ch.id, e.message); }
      if (process.env.INBOX_ANALYTICS === 'on') try { saveFollowups(ch, (await d.listConversations(ch.host, ch.token, ch.ig_user_id, 50, ch.type)).data); }
      catch (e) { if (lastErr.get('dm' + ch.id) !== e.message) logEvent('warn', `Could not read DMs of @${ch.username}: ${e.message}`); lastErr.set('dm' + ch.id, e.message); }
      lastErr.delete(ch.id);
      done++;
    } catch (e) {
      if (lastErr.get(ch.id) !== e.message) logEvent('error', `Could not take statistics of @${ch.username}: ${e.message}`); // one warning per distinct error
      lastErr.set(ch.id, e.message);
    }
  }
  return done;
}

let timer = null, first = null, beat = null;
export function startStats(everyMinutes = Number(process.env.STATS_MINUTES || 30)) {
  const tick = () => collectStats().catch((e) => logEvent('error', `Statistics failed: ${e.message}`));
  first = setTimeout(tick, 20000);            // one 20 s after the program starts
  timer = setInterval(tick, everyMinutes * 60000);
}
export function startHeartbeat() { heartbeat(); beat = setInterval(() => { try { heartbeat(); } catch {} }, 60000); }
export const stopStats = () => { clearTimeout(first); clearInterval(timer); clearInterval(beat); timer = first = beat = null; };

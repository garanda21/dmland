// Periodic comment reading (an alternative to the webhook while Meta does not deliver it).
// No AI: it only queries the Meta API and reuses the same engine as the webhook.
import { all, logEvent, debugLog } from './db.mjs';
import { apiFor } from './platform.mjs';
import { handleComment, realSender, parseMetaTime, parseDbTime, throttle, sendingPaused, sendingRestriction, hasReplyBudget } from './engine.mjs';
import { pollDMs, captureCounts } from './capture.mjs';

const SEVEN_DAYS = 7 * 24 * 3600 * 1000; // Meta limit for replying to a comment
const MAX_PER_CYCLE = 10;                 // cap of replies per cycle; the hourly cap (max 200) is enforced separately
const RECENT_MEDIA = 5;                   // for "all posts" automations: the latest N

export const status = { enabled: false, running: false, lastRun: null, lastError: null, lastCount: 0, totalSent: 0, intervalSec: 60 };
export const getStatus = () => ({ ...status, restricted: sendingRestriction(), captures: captureCounts(), pausedUntil: throttle.until > Date.now() ? new Date(throttle.until).toISOString() : null, pauseReason: throttle.until > Date.now() ? throttle.reason : null });

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
// Spaces sends 2 to 5 s apart so they do not go out in a burst.
const jitter = () => sleepMs(2000 + Math.random() * 3000);

// deps inyectables para pruebas
// The last argument of each call is the account's platform ('instagram' | 'facebook').
const defaults = {
  listMedia: (host, token, id, type) => apiFor(type).listMedia(host, token, id),
  listComments: (host, token, mediaId, limit, after, type) => apiFor(type).listComments(host, token, mediaId, limit, after),
  makeSender: realSender,
  pause: jitter,
};

const MAX_PAGES = Number(process.env.MAX_PAGES || 10); // 10 pages x 50 = up to 500 comments per reel per minute

// Fetches a reel's comments page by page and stops as soon as a whole page
// is older than `cutoff` (what no automation will handle).
async function fetchComments(d, ch, mediaId, cutoff) {
  const out = [];
  let after = null, truncated = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await d.listComments(ch.host, ch.token, mediaId, 50, after, ch.type);
    const data = res.data || [];
    out.push(...data);
    after = res.paging?.next ? res.paging?.cursors?.after : null;
    if (!data.length || !after) return { comments: out, truncated: false };
    const newest = Math.max(...data.map((c) => parseMetaTime(c.timestamp)));
    if (newest < cutoff) return { comments: out, truncated: false }; // the rest is older: no need to continue
    truncated = page === MAX_PAGES - 1;
  }
  return { comments: out, truncated };
}

let lastTruncWarn = 0;

// Processes one account. The caps (per cycle and per hour) are PER ACCOUNT, like Meta's limits.
async function pollChannel(d, ch, now) {
  const autos = all('SELECT * FROM automations WHERE channel_id=? AND active=1', ch.id);
  if (!autos.length) { debugLog('poll', `@${ch.username}: no active automations`); return 0; }
  if (!hasReplyBudget(ch.ig_user_id)) { debugLog('poll', `@${ch.username}: hourly cap reached, waiting`); return 0; }
  // Which posts to look at: those with their own automation, plus the latest N if any is "all"
  const mediaIds = new Set(autos.filter((a) => a.media_id).map((a) => a.media_id));
  if (autos.some((a) => !a.media_id)) {
    const recent = await d.listMedia(ch.host, ch.token, ch.ig_user_id, ch.type);
    (recent.data || []).slice(0, RECENT_MEDIA).forEach((m) => mediaIds.add(m.id));
  }
  let launchedTotal = 0;
  for (const mediaId of mediaIds) {
    if (launchedTotal >= MAX_PER_CYCLE || sendingPaused()) break;
    // Since when a comment matters: the more recent of "7 days ago" and the oldest activation of this reel's automations
    const sinces = autos.filter((a) => !a.media_id || a.media_id === mediaId).map((a) => parseDbTime(a.since)).filter((t) => !Number.isNaN(t));
    const cutoff = Math.max(now - SEVEN_DAYS, sinces.length ? Math.min(...sinces) : 0);
    const { comments: raw, truncated } = await fetchComments(d, ch, mediaId, cutoff);
    if (truncated && Date.now() - lastTruncWarn > 3600e3) {
      lastTruncWarn = Date.now();
      logEvent('warn', `Reel ${mediaId} has more than ${MAX_PAGES * 50} new pending comments; they are handled in batches`);
    }
    const comments = raw
      .filter((c) => now - parseMetaTime(c.timestamp) <= SEVEN_DAYS)
      .sort((a, b) => parseMetaTime(a.timestamp) - parseMetaTime(b.timestamp)); // oldest first
    debugLog('poll', `@${ch.username} media ${mediaId}: ${raw.length} new comments read, ${comments.length} inside the 7-day window`);
    for (const c of comments) {
      if (launchedTotal >= MAX_PER_CYCLE || sendingPaused()) break;
      const launched = handleComment(
        ch,
        { id: c.id, text: c.text, timestamp: c.timestamp, username: c.username,
          from: { id: c.from?.id, username: c.from?.username ?? c.username }, media: { id: mediaId } },
        { sender: d.makeSender(ch.host, ch.token, ch.ig_user_id, ch.type), quiet: true },
      );
      if (!launched.length) continue;
      launchedTotal += launched.length;
      await Promise.all(launched.map((l) => l.done));
      status.totalSent += launched.length;
      await d.pause();
    }
  }
  debugLog('poll', `@${ch.username}: cycle done, ${mediaIds.size} posts checked, ${launchedTotal} replies launched`);
  return launchedTotal;
}

export async function pollOnce(deps = {}) {
  const d = { ...defaults, ...deps };
  const now = deps.now ?? Date.now();
  if (sendingPaused()) return 0; // Meta asked for a pause
  let total = 0;
  const channels = all("SELECT * FROM channels WHERE token IS NOT NULL AND ig_user_id NOT LIKE 'demo_%'");
  for (const ch of channels) {
    try {
      total += await pollChannel(d, ch, now);
      if (lastErr.delete(ch.id)) logEvent('poll', `Lectura de @${ch.username} recuperada`);
    } catch (e) { // an error in one brand does not stop the others
      status.lastError = `@${ch.username}: ${e.message}`;
      if (lastErr.get(ch.id) !== e.message) logEvent('error', `Reading @${ch.username} failed: ${e.message}`); // one warning per distinct error, not one per minute
      lastErr.set(ch.id, e.message);
    }
  }
  return total;
}
const lastErr = new Map();

let timer = null, dmTimer = null, dmRunning = false;
export function startPoller(intervalSec = 60) {
  status.enabled = true;
  status.intervalSec = intervalSec;
  // DM reading for email capture: every 30 s, and it only works if someone is waiting (otherwise it queries nothing)
  const dmTick = async () => {
    if (sendingPaused() || dmRunning || (!captureCounts().waiting && !captureCounts().gotEmail)) return;
    dmRunning = true;
    try { await pollDMs(); } catch (e) { logEvent('error', `Reading DMs failed: ${e.message}`); } finally { dmRunning = false; }
  };
  dmTimer = setInterval(dmTick, Number(process.env.DM_POLL_SECONDS || 30) * 1000);
  const tick = async () => {
    if (status.running) return; // never two cycles at once
    status.running = true;
    try {
      status.lastError = null; // pollOnce fills it again if any account fails in this cycle
      status.lastCount = await pollOnce();
    } catch (e) {
      status.lastError = e.message;
      logEvent('error', `Reading comments failed: ${e.message}`);
    } finally { status.lastRun = new Date().toISOString(); status.running = false; }
  };
  logEvent('poll', `Comment reading enabled: every ${intervalSec} s`);
  tick();
  timer = setInterval(tick, intervalSec * 1000);
}
export const stopPoller = () => { if (timer) clearInterval(timer); if (dmTimer) clearInterval(dmTimer); timer = dmTimer = null; status.enabled = false; };

// Email capture by DM:
//   1) the comment triggers the first DM that asks for the email (engine.mjs does that and leaves a row in `captures`)
//   2) here the DMs from waiting people are read, the email is extracted and the resource is sent.
// Meta only lets you write to someone within 24 h of their last message: exactly what we use.
import { all, get, run, logEvent } from './db.mjs';
import { apiFor } from './platform.mjs';
import { fill, json, addTag, isRateLimit, isBlocked, sendingPaused, pauseForMeta, parseMetaTime, withUtm, DEFAULT_RETRY } from './engine.mjs';

const EXPIRE_DAYS = 3;          // if they do not answer in 3 days, stop watching
const FOLLOWUP_WINDOW = 24 * 3_600_000;
const withinFollowupWindow = (lastMessageAt) => Date.now() - Date.parse(lastMessageAt) < FOLLOWUP_WINDOW;
const MAX_LOOKUPS = 10;         // individual lookups per cycle (Meta: 2 calls/second per account)
const MAX_RESOURCES = 20;       // resources sent per cycle and account
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
// Accepts "my email is Ana@Test.com!" and returns "ana@test.com"; null if there is no email.
export const extractEmail = (text) => {
  const m = String(text ?? '').match(EMAIL_RE);
  const e = m?.[0]?.toLowerCase();
  return e && e.length <= 254 ? e : null;
};

export const captureCounts = () => {
  const r = all("SELECT status, COUNT(*) AS n FROM captures WHERE status IN ('waiting','got_email') GROUP BY status");
  return { waiting: r.find((x) => x.status === 'waiting')?.n ?? 0, gotEmail: r.find((x) => x.status === 'got_email')?.n ?? 0 };
};

// The last argument of each call is the account's platform ('instagram' | 'facebook').
const defaults = {
  listConversations: (host, token, id, limit, type) => apiFor(type).listConversations(host, token, id, limit),
  conversationByUser: (host, token, id, userId, type) => apiFor(type).conversationByUser(host, token, id, userId),
  sendText: (host, token, id, to, text, type) => apiFor(type).sendText(host, token, id, to, text),
  sendButton: (host, token, id, to, text, title, url, type) => apiFor(type).sendButton(host, token, id, to, text, title, url),
  pause: () => sleep(600),
};

function saveEmail(capture, automation, email) {
  const contact = get('SELECT * FROM contacts WHERE id=?', capture.contact_id);
  if (!contact) return;
  const f = json(contact.fields, {});
  f.email = email; f.email_at = new Date().toISOString(); f.email_from = automation.name;
  run('UPDATE contacts SET fields=? WHERE id=?', JSON.stringify(f), contact.id);
}

// Sends the resource (final DM). Returns true if it went out or is definitively settled.
async function sendResource(d, ch, capture, automation) {
  if (sendingPaused() || !get('SELECT 1 FROM automations WHERE id=? AND active=1', automation.id)) return false;
  if (!withinFollowupWindow(capture.last_msg_at)) {
    run("UPDATE captures SET status='expired', error='The Instagram messaging window closed' WHERE id=?", capture.id);
    return true;
  } // Meta asked for a pause: retry on the next cycle
  const vars = { username: capture.username || '', first_name: capture.username || '' };
  const text = withUtm(fill(automation.dm_text, vars), automation, ch.type);
  const buttonUrl = withUtm(automation.button_url, automation, ch.type);
  try {
    if (automation.button_url) {
      try { await d.sendButton(ch, capture.igsid, text, automation.button_title || 'Abrir', buttonUrl); }
      catch (e) { if (e.code !== 100 || isRateLimit(e) || isBlocked(e) || sendingPaused() || !withinFollowupWindow(capture.last_msg_at)) throw e; await d.sendText(ch, capture.igsid, `${text}\n${buttonUrl}`); }
    } else {
      await d.sendText(ch, capture.igsid, text);
    }
  } catch (e) {
    if (isRateLimit(e) || isBlocked(e)) {
      pauseForMeta(e);
      return false;
    }
    run("UPDATE captures SET status='failed', error=? WHERE id=?", e.message, capture.id);
    logEvent('error', `Could not send the resource to @${capture.username}: ${e.message}`);
    return true;
  }
  run("UPDATE captures SET status='done', done_at=CURRENT_TIMESTAMP, error=NULL WHERE id=?", capture.id);
  const contact = get('SELECT * FROM contacts WHERE id=?', capture.contact_id);
  if (contact) addTag(contact, automation.tag);
  logEvent('run', `Email captured and resource sent to @${capture.username} ("${automation.name}")`); // the email is not written to the log
  return true;
}

// Messages from the person (not ours), oldest to newest, after `since`.
function newUserMessages(msgs, selfId, since) {
  return (msgs || [])
    .filter((m) => m.from?.id && String(m.from.id) !== String(selfId) && m.message)
    .filter((m) => parseMetaTime(m.created_time) > since)
    .sort((a, b) => parseMetaTime(a.created_time) - parseMetaTime(b.created_time));
}

async function handleReply(d, ch, capture, automation, msgs) {
  const fresh = newUserMessages(msgs, ch.ig_user_id, Date.parse(capture.last_msg_at));
  if (!fresh.length) return;
  const lastAt = new Date(parseMetaTime(fresh[fresh.length - 1].created_time)).toISOString();
  if (!withinFollowupWindow(lastAt) || sendingPaused()) return;
  // If any of their new messages contains an email, use it (even if they wrote something else first).
  const hit = fresh.map((m) => extractEmail(m.message)).find(Boolean);
  if (hit) {
    saveEmail(capture, automation, hit);
    run("UPDATE captures SET status='got_email', email=?, last_msg_at=? WHERE id=?", hit, lastAt, capture.id);
    capture.status = 'got_email'; capture.email = hit; capture.last_msg_at = lastAt;
    await sendResource(d, ch, capture, automation);
    return;
  }
  // They wrote but it was not an email: one more chance, then leave it.
  if (capture.retries < 1) {
    try {
      await d.sendText(ch, capture.igsid, fill(automation.retry_text || DEFAULT_RETRY, { username: capture.username || '' }));
      // mark as reviewed up to the later of "now" and their last message (in case Meta's clock runs ahead)
      const mark = new Date(Math.max(Date.now(), Date.parse(lastAt))).toISOString();
      run('UPDATE captures SET retries=retries+1, last_msg_at=? WHERE id=?', mark, capture.id);
    } catch (e) {
      if (isRateLimit(e) || isBlocked(e)) { pauseForMeta(e); return; }
      run("UPDATE captures SET status='failed', error=? WHERE id=?", e.message, capture.id);
      logEvent('error', `Could not ask @${capture.username} for the email again: ${e.message}`);
    }
  } else {
    run("UPDATE captures SET status='expired', error='Did not write a valid email', last_msg_at=? WHERE id=?", lastAt, capture.id);
  }
}

export async function pollDMs(deps = {}) {
  if (sendingPaused()) return 0;
  const d = { ...defaults, ...deps };
  run(`UPDATE captures SET status='expired', error='Did not reply in time' WHERE status='waiting' AND created_at < datetime('now','-${EXPIRE_DAYS} days')`);
  const open = all("SELECT * FROM captures WHERE status IN ('waiting','got_email') ORDER BY id");
  if (!open.length) return 0;
  let handled = 0;
  const byChannel = new Map();
  for (const c of open) (byChannel.get(c.channel_id) ?? byChannel.set(c.channel_id, []).get(c.channel_id)).push(c);

  for (const [channelId, caps] of byChannel) {
    const rawCh = get('SELECT * FROM channels WHERE id=?', channelId);
    if (!rawCh?.token) continue;
    // the senders receive the channel as first argument, so tests can replace them
    const ch = rawCh;
    const send = {
      sendText: (c, to, t) => d.sendText(c.host, c.token, c.ig_user_id, to, t, c.type),
      sendButton: (c, to, t, title, url) => d.sendButton(c.host, c.token, c.ig_user_id, to, t, title, url, c.type),
    };
    const dd = { ...d, ...send };
    try {
      // 1) people who already have an email and wait for the resource (sending had stalled or failed)
      let sent = 0;
      for (const cap of caps.filter((c) => c.status === 'got_email')) {
        if (sent >= MAX_RESOURCES) break;
        const a = get('SELECT * FROM automations WHERE id=? AND active=1', cap.automation_id);
        if (a && await sendResource(dd, ch, cap, a)) { sent++; handled++; }
      }
      // 2) people who have not answered yet: a single call brings everyone's recent conversations
      const waiting = caps.filter((c) => c.status === 'waiting');
      if (!waiting.length) continue;
      const list = (await d.listConversations(ch.host, ch.token, ch.ig_user_id, 30, ch.type)).data || [];
      const byUser = new Map(); // person id -> messages of their conversation
      for (const conv of list) {
        const msgs = conv.messages?.data || [];
        const uid = msgs.map((m) => String(m.from?.id ?? '')).find((id) => id && id !== String(ch.ig_user_id));
        if (uid) byUser.set(uid, msgs);
      }
      let lookups = 0;
      for (const cap of waiting) {
        const a = get('SELECT * FROM automations WHERE id=? AND active=1', cap.automation_id);
        if (!a) continue;
        let msgs = byUser.get(String(cap.igsid));
        if (!msgs && lookups < MAX_LOOKUPS) { // not in the recent list: ask for that person
          lookups++; await d.pause();
          const conv = (await d.conversationByUser(ch.host, ch.token, ch.ig_user_id, cap.igsid, ch.type)).data?.[0];
          msgs = conv?.messages?.data;
        }
        if (!msgs) continue;
        const before = cap.status;
        await handleReply(dd, ch, cap, a, msgs);
        if (before === 'waiting' && get('SELECT status FROM captures WHERE id=?', cap.id).status !== 'waiting') handled++;
      }
      lastErr.delete(channelId);
    } catch (e) {
      if (lastErr.get(channelId) !== e.message) logEvent('error', `Reading DMs of @${ch.username} failed: ${e.message}`); // one warning per distinct error
      lastErr.set(channelId, e.message);
    }
  }
  return handled;
}
const lastErr = new Map();

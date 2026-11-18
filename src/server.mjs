import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = process.env.ENV_FILE || join(root, '.env');

// --- minimal .env loader (no dependencies) ---
function loadEnv() {
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/).reverse()) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();
process.umask(0o077);
function ensureEnv(key, value) {
  if (process.env[key]) return;
  process.env[key] = value;
  writeFileSync(envPath, (existsSync(envPath) ? readFileSync(envPath, 'utf8').replace(/\s*$/, '\n') : '') + `${key}=${value}\n`, { mode: 0o600 });
}
ensureEnv('DASHBOARD_PASSWORD', randomBytes(9).toString('base64url'));
ensureEnv('WEBHOOK_VERIFY_TOKEN', randomBytes(12).toString('base64url'));
// The key can come from a file (e.g. a Docker secret) so it never sits next to the database.
if (!process.env.TOKEN_ENCRYPTION_KEY && !process.env.TOKEN_ENCRYPTION_KEY_FILE) ensureEnv('TOKEN_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
if (existsSync(envPath)) chmodSync(envPath, 0o600);

const { all, get, run, logEvent } = await import('./db.mjs');
const { sealToken, openToken, assertTokenKey } = await import('./tokens.mjs');
assertTokenKey();
for (const channel of all('SELECT id, token FROM channels WHERE token IS NOT NULL')) {
  const plain = openToken(channel.token);
  if (plain === channel.token) run('UPDATE channels SET token=? WHERE id=?', sealToken(plain), channel.id);
}

const meta = await import('./meta.mjs');
const { apiFor } = await import('./platform.mjs');
const { commentFromWebhook } = await import('./facebook.mjs');
const { handleComment, realSender, drySender, hourlyCap, resumeSending } = await import('./engine.mjs');
const poller = await import('./poller.mjs');
const { automationFields } = await import('./automations.mjs');
const stats = await import('./stats.mjs');
const { analytics } = await import('./analytics.mjs');

const HOST = process.env.HOST || '127.0.0.1';
const WEBHOOKS_ENABLED = process.env.WEBHOOKS_ENABLED === 'on';
const PORT = Number(process.env.PORT || 3000);
const mediaCache = new Map(); // channel -> { at, data }
const j = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const safeEq = (a, b) => { const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? '')); return x.length === y.length && timingSafeEqual(x, y); };

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type + '; charset=utf-8' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
async function readBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 256 * 1024) {
      req.resume();
      throw Object.assign(new Error('Request body is too large'), { status: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function authed(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
  return safeEq(pass, process.env.DASHBOARD_PASSWORD);
}

const publicChannel = (c) => ({ ...c, token: c.token ? '••••' + openToken(c.token).slice(-4) : null });
const aut = (a) => ({ ...a, keywords: j(a.keywords, []), exclude: j(a.exclude, []), public_replies: j(a.public_replies, []) });

// Interface languages: English is built in; every public/lang/<code>.json file adds one more.
const LANG_DIR = join(root, 'public', 'lang');
const langCodes = () => (existsSync(LANG_DIR) ? readdirSync(LANG_DIR).filter((f) => /^[a-z]{2,3}(-[A-Za-z]{2,4})?\.json$/.test(f)).map((f) => f.slice(0, -5)) : []);
const languages = () => [{ code: 'en', name: 'English' }, ...langCodes().map((code) => ({ code, name: j(readFileSync(join(LANG_DIR, code + '.json'), 'utf8'), {}).name || code }))];

async function api(req, res, url) {
  const m = req.method, p = url.pathname;
  let body = {};
  if (['POST', 'PUT', 'PATCH'].includes(m)) {
    if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      return send(res, 415, { error: 'Expected application/json' });
    }
    body = JSON.parse((await readBody(req)).toString() || '{}');
  }
  let r;

  if (p === '/api/config') return send(res, 200, { verify_token: process.env.WEBHOOK_VERIFY_TOKEN, app_secret_set: !!process.env.META_APP_SECRET });
  if (p === '/api/langs' && m === 'GET') return send(res, 200, languages());

  if (p === '/api/brands') {
    if (m === 'GET') return send(res, 200, all('SELECT * FROM brands ORDER BY id'));
    if (m === 'POST') { if (!body.name) throw new Error('Name is missing'); r = run('INSERT INTO brands(name) VALUES (?)', body.name); return send(res, 200, { id: Number(r.lastInsertRowid) }); }
  }
  let mt;
  if ((mt = p.match(/^\/api\/brands\/(\d+)$/)) && m === 'DELETE') { run('DELETE FROM brands WHERE id=?', mt[1]); return send(res, 200, { ok: true }); }

  if (p === '/api/channels') {
    if (m === 'GET') return send(res, 200, all('SELECT * FROM channels ORDER BY id').map(publicChannel));
    if (m === 'POST') {
      if (body.demo && body.brand_id) {
        run('INSERT INTO channels(brand_id, ig_user_id, username) VALUES (?,?,?)', Number(body.brand_id), 'demo_' + Date.now(), 'demo_account');
        return send(res, 200, { ok: true, demo: true });
      }
      if (!body.brand_id || !body.token) throw new Error('Brand or token is missing');
      // Strip the "Token:" prefix, whitespace, line breaks and quotes that sneak in when copying and pasting
      const token = String(body.token).replace(/^\s*token\s*:/i, '').replace(/[\s"'`]/g, '');
      if (token.length < 100 || !/^[A-Za-z0-9_-]+$/.test(token)) {
        throw new Error(`The pasted token does not look complete (${token.length} characters). A Meta token has more than 150 and starts with EAA. Copy it again with the Copy button.`);
      }
      // 'instagram' (account ID) or 'facebook' (Page ID). Both use the same Meta app and a token with access to that account.
      const type = body.platform === 'facebook' ? 'facebook' : 'instagram';
      const api = apiFor(type);
      let host, me, igId;
      if (!body.ig_user_id && (type === 'facebook' || !body.legacy)) {
        throw new Error(type === 'facebook'
          ? 'The Facebook Page ID is missing. Type it in the ID field (the grey text is only an example).'
          : 'The Instagram account ID is missing. Type it in the ID field (the grey text is only an example).');
      }
      if (body.ig_user_id) { // Unified Login: system user token + account ID
        host = meta.DEFAULT_HOST;
        igId = String(body.ig_user_id).trim();
        if (!/^\d+$/.test(igId)) throw new Error(type === 'facebook' ? 'The Facebook Page ID must contain numbers only' : 'The Instagram account ID must contain numbers only');
        me = await api.getAccount(host, token, igId);
      } else {               // Instagram Login (older apps)
        host = 'graph.instagram.com';
        me = await meta.getMe(host, token);
        igId = String(me.user_id || me.id);
      }
      let sub = 'disabled';
      if (WEBHOOKS_ENABLED) try { await api.subscribeWebhooks(host, token, igId); sub = 'ok'; } catch (e) { sub = `could not subscribe to webhooks: ${e.message}`; }
      run(`INSERT INTO channels(brand_id, ig_user_id, username, token, host, type) VALUES (?,?,?,?,?,?)
           ON CONFLICT(ig_user_id) DO UPDATE SET token=excluded.token, username=excluded.username, brand_id=excluded.brand_id, host=excluded.host, type=excluded.type, token_saved_at=CURRENT_TIMESTAMP`,
        Number(body.brand_id), igId, me.username, sealToken(token), host, type);
      logEvent('channel', `Connected ${type === 'facebook' ? 'Facebook Page ' : ''}@${me.username} (${igId}); webhooks: ${sub}`);
      return send(res, 200, { ok: true, username: me.username, ig_user_id: igId, platform: type, webhooks: sub });
    }
  }
  if ((mt = p.match(/^\/api\/channels\/(\d+)$/)) && m === 'DELETE') { run('DELETE FROM channels WHERE id=?', mt[1]); return send(res, 200, { ok: true }); }
  if ((mt = p.match(/^\/api\/channels\/(\d+)\/media$/)) && m === 'GET') {
    const c = get('SELECT * FROM channels WHERE id=?', mt[1]);
    if (!c) return send(res, 404, { error: 'Account does not exist' });
    // 2-minute cache: the dashboard asks for thumbnails on every screen and there is no need to bother Meta each time
    const hit = mediaCache.get(c.id);
    if (hit && Date.now() - hit.at < 120000) return send(res, 200, hit.data);
    const data = (await apiFor(c.type).listMedia(c.host, c.token, c.ig_user_id)).data || [];
    mediaCache.set(c.id, { at: Date.now(), data });
    return send(res, 200, data);
  }

  if (p === '/api/automations') {
    if (m === 'GET') return send(res, 200, all(`SELECT a.*, (SELECT COUNT(*) FROM runs r WHERE r.automation_id=a.id AND r.status='done') AS sent
      FROM automations a ORDER BY a.id DESC`).map(aut));
    if (m === 'POST') {
      r = run(`INSERT INTO automations(channel_id,name,active,media_id,match_mode,keywords,exclude,public_replies,dm_text,button_title,button_url,tag,delay_seconds,mode,ask_text,retry_text,skip_known,alt_ask_text,utm,since)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`, ...automationFields(body));
      return send(res, 200, { id: Number(r.lastInsertRowid) });
    }
  }
  if ((mt = p.match(/^\/api\/automations\/(\d+)$/))) {
    if (m === 'PUT') {
      run(`UPDATE automations SET channel_id=?,name=?,active=?,media_id=?,match_mode=?,keywords=?,exclude=?,public_replies=?,dm_text=?,button_title=?,button_url=?,tag=?,delay_seconds=?,mode=?,ask_text=?,retry_text=?,skip_known=?,alt_ask_text=?,utm=? WHERE id=?`,
        ...automationFields(body), mt[1]);
      return send(res, 200, { ok: true });
    }
    if (m === 'PATCH') {
      // When reactivated, only comments from that moment on count (nothing is answered for what happened while it was paused)
      run(`UPDATE automations SET active=?, since=CASE WHEN ?=1 THEN datetime('now') ELSE since END WHERE id=?`, body.active ? 1 : 0, body.active ? 1 : 0, mt[1]);
      return send(res, 200, { ok: true });
    }
    if (m === 'DELETE') { run('DELETE FROM automations WHERE id=?', mt[1]); return send(res, 200, { ok: true }); }
  }

  if (p === '/api/poller' && m === 'GET') return send(res, 200, poller.getStatus());
  if (p === '/api/sending/resume' && m === 'POST') {
    if (body.confirm !== 'RESUME') return send(res, 400, { error: 'Confirmation required' });
    resumeSending();
    return send(res, 200, poller.getStatus());
  }
  if (p === '/api/analytics' && m === 'GET') return send(res, 200, analytics({ brand: url.searchParams.get('brand'), range: url.searchParams.get('range') || 7 }));
  if (p === '/api/runs' && m === 'GET') return send(res, 200, all(`SELECT r.*, a.name AS automation, a.mode, a.channel_id, ch.brand_id, c.username, cp.status AS capture_status FROM runs r
    JOIN automations a ON a.id=r.automation_id JOIN channels ch ON ch.id=a.channel_id
    LEFT JOIN contacts c ON c.id=r.contact_id LEFT JOIN captures cp ON cp.run_id=r.id
    WHERE r.status != 'dry' ORDER BY r.id DESC LIMIT 200`));

  // Captured emails: CSV download (opens in Excel/Sheets). ?brand=ID filters by brand.
  if (p === '/api/export/emails.csv' && m === 'GET') {
    const b = url.searchParams.get('brand');
    const rows = all(`SELECT json_extract(c.fields,'$.email') AS email, c.username, br.name AS brand, json_extract(c.fields,'$.email_from') AS automation,
        json_extract(c.fields,'$.email_at') AS captured_at, c.tags, ch.type AS platform FROM contacts c JOIN channels ch ON ch.id=c.channel_id JOIN brands br ON br.id=ch.brand_id
        WHERE json_extract(c.fields,'$.email') IS NOT NULL ${b ? 'AND br.id=?' : ''} ORDER BY json_extract(c.fields,'$.email_at') DESC`, ...(b ? [Number(b)] : []));
    // A cell starting with = + - @ can run as a formula in Excel: prefix it with a quote
    const cell = (v) => { let s = String(v ?? '').replace(/"/g, '""'); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s}"`; };
    const csv = '﻿' + ['email,instagram_user,brand,automation,captured_at,tags,platform']
      .concat(rows.map((r) => [r.email, r.username ?? '', r.brand, r.automation, r.captured_at, j(r.tags, []).join(' '), r.platform].map(cell).join(','))).join('\r\n') + '\r\n';
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="emails-${new Date().toISOString().slice(0, 10)}.csv"` });
    return res.end(csv);
  }
  if (p === '/api/events' && m === 'GET') return send(res, 200, all('SELECT id,ts,kind,note FROM events ORDER BY id DESC LIMIT 100'));
  if (p === '/api/contacts' && m === 'GET') return send(res, 200, all(`SELECT c.*, ch.brand_id FROM contacts c JOIN channels ch ON ch.id=c.channel_id
    ORDER BY c.last_interaction DESC LIMIT 300`).map((c) => { const f = j(c.fields, {}); return { ...c, tags: j(c.tags, []), email: f.email || null, email_at: f.email_at || null }; }));

  // Home numbers. "Today" is your computer's local date. ?brand=ID filters by brand.
  if (p === '/api/stats' && m === 'GET') {
    const b = url.searchParams.get('brand');
    const brandSql = b ? 'AND ch.brand_id=?' : '';
    const bp = b ? [Number(b)] : [];
    const base = `FROM runs r JOIN automations a ON a.id=r.automation_id JOIN channels ch ON ch.id=a.channel_id WHERE r.status != 'dry' ${brandSql}`;
    const n = (extra) => all(`SELECT COUNT(*) AS n ${base} ${extra}`, ...bp)[0].n;
    const today = "AND date(r.created_at,'localtime')=date('now','localtime')";
    const days = all(`SELECT date(r.created_at,'localtime') AS d, COUNT(*) AS n ${base} AND r.status='done'
      AND date(r.created_at,'localtime') >= date('now','localtime','-6 days') GROUP BY d`, ...bp);
    const series = Array.from({ length: 7 }, (_, i) => {
      const d = all("SELECT date('now','localtime',?) AS d", `-${6 - i} days`)[0].d;
      return { date: d, n: days.find((x) => x.d === d)?.n ?? 0 };
    });
    const perBrand = all(`SELECT b.id, b.name, (SELECT COUNT(*) FROM runs r JOIN automations a ON a.id=r.automation_id JOIN channels c2 ON c2.id=a.channel_id
        WHERE c2.brand_id=b.id AND r.status='done' AND date(r.created_at,'localtime') >= date('now','localtime','-6 days')) AS n FROM brands b ORDER BY b.id`);
    const hourly = all(`SELECT ch.id, COUNT(*) AS n FROM reply_attempts r
      JOIN channels ch ON ch.ig_user_id=r.account_id
      WHERE r.attempted_at>? ${brandSql} GROUP BY ch.id`, Date.now() - 3_600_000, ...bp);
    return send(res, 200, {
      sentToday: n(`AND r.status='done' ${today}`),
      handledToday: n(today),
      errorsToday: n(`AND r.status='error' ${today}`),
      activeAutomations: all(`SELECT COUNT(*) AS n FROM automations a JOIN channels ch ON ch.id=a.channel_id WHERE a.active=1 ${brandSql}`, ...bp)[0].n,
      emails: all(`SELECT COUNT(*) AS n FROM contacts c JOIN channels ch ON ch.id=c.channel_id WHERE json_extract(c.fields,'$.email') IS NOT NULL ${brandSql}`, ...bp)[0].n,
      series, perBrand,
      hour: { sent: Math.max(0, ...hourly.map((h) => h.n)), cap: hourlyCap }, // the busiest account
    });
  }

  // Simulation without touching Instagram: tests keywords and replies.
  if (p === '/api/simulate' && m === 'POST') {
    const c = get('SELECT * FROM channels WHERE id=?', body.channel_id);
    if (!c) throw new Error('Account does not exist');
    const log = [];
    const id = 'sim_' + Date.now();
    const launched = handleComment(c, { id, text: body.text, from: { id: 'sim_user', username: body.username || 'test_user' }, media: body.media_id ? { id: body.media_id } : undefined },
      { sender: drySender(log), dry: true, instant: true });
    await Promise.all(launched.map((l) => l.done));
    return send(res, 200, { matched: launched.map((l) => l.automation), actions: log });
  }

  return send(res, 404, { error: 'Route not found' });
}

// --- Meta webhook ---
async function webhook(req, res, url) {
  if (req.method === 'GET') {
    const q = url.searchParams;
    if (q.get('hub.mode') === 'subscribe' && safeEq(q.get('hub.verify_token'), process.env.WEBHOOK_VERIFY_TOKEN)) {
      logEvent('webhook', 'Webhook verification OK');
      return send(res, 200, q.get('hub.challenge') || '', 'text/plain');
    }
    return send(res, 403, 'forbidden', 'text/plain');
  }
  return readBody(req).then(async (raw) => {
    const secret = process.env.META_APP_SECRET;
    const sig = String(req.headers['x-hub-signature-256'] || '');
    if (!secret) { logEvent('error', 'Webhook received but META_APP_SECRET is not set in .env; ignored'); return send(res, 503, 'secret not set', 'text/plain'); }
    const expected = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
    if (!sig || !safeEq(sig, expected)) { logEvent('error', 'Invalid webhook signature'); return send(res, 401, 'bad signature', 'text/plain'); }
    send(res, 200, 'EVENT_RECEIVED', 'text/plain'); // answer Meta quickly
    const data = j(raw.toString(), {});
    logEvent('webhook', `Event ${data.object}`);
    for (const entry of data.entry || []) {
      const channel = get('SELECT * FROM channels WHERE ig_user_id=?', String(entry.id));
      if (!channel) { logEvent('warn', `Event for an unconnected account: ${entry.id}`); continue; }
      for (const ch of entry.changes || []) {
        const sender = () => realSender(channel.host, channel.token, channel.ig_user_id, channel.type);
        if (ch.field === 'comments' && ch.value && !ch.value.parent_id) {
          const comment = ch.value;
          if (!comment.timestamp && comment.id) {
            try {
              const details = await meta.getComment(channel.host, channel.token, comment.id);
              comment.timestamp = details.timestamp;
            } catch (error) {
              logEvent('warn', 'Could not verify the Instagram comment timestamp: ' + error.message);
              continue;
            }
          }
          handleComment(channel, comment, { sender: sender() });
        } else if (ch.field === 'feed') { // Facebook Page: new comment on a post
          const comment = commentFromWebhook(ch.value);
          if (comment) handleComment(channel, comment, { sender: sender() });
        }
      }
    }
  });
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/webhooks/meta') {
      if (!WEBHOOKS_ENABLED) return send(res, 404, 'Not found', 'text/plain');
      return await webhook(req, res, url);
    }
    if (!authed(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="DMLand"' }); return res.end('Authentication required'); }
    if (req.headers['sec-fetch-site'] === 'cross-site' && !['GET', 'HEAD'].includes(req.method)) {
      return send(res, 403, { error: 'Cross-site requests are forbidden' });
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, readFileSync(join(root, 'public', 'index.html')), 'text/html');
    const lang = url.pathname.match(/^\/lang\/([a-z]{2,3}(?:-[A-Za-z]{2,4})?)\.json$/);
    if (lang && langCodes().includes(lang[1])) return send(res, 200, readFileSync(join(LANG_DIR, lang[1] + '.json')));
    send(res, 404, 'Not found', 'text/plain');
  } catch (e) {
    if (!res.headersSent) send(res, e.status === 413 ? 413 : 400, { error: e.message });
  }
}).listen(PORT, HOST, () => {
  console.log(`\nDMLand running at http://${HOST}:${PORT}`);
  console.log('Username: anything   Password: the DASHBOARD_PASSWORD line in your .env file\n');
  if (process.env.POLL !== 'off') poller.startPoller(Number(process.env.POLL_SECONDS || 60));
  if (process.env.POLL !== 'off') { stats.startStats(); stats.startHeartbeat(); } // daily snapshots + uptime log
});

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = process.env.DB_FILE || fileURLToPath(new URL('../data/app.db', import.meta.url));
mkdirSync(dirname(file), { recursive: true });
export const db = new DatabaseSync(file);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS brands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'instagram',
  ig_user_id TEXT NOT NULL UNIQUE,
  username TEXT,
  token TEXT,
  token_saved_at TEXT DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  media_id TEXT,                       -- NULL = all posts/reels
  match_mode TEXT NOT NULL DEFAULT 'contains', -- any | contains | word | exact
  keywords TEXT NOT NULL DEFAULT '[]',
  exclude TEXT NOT NULL DEFAULT '[]',
  public_replies TEXT NOT NULL DEFAULT '[]',
  dm_text TEXT NOT NULL,
  button_title TEXT,
  button_url TEXT,
  tag TEXT,
  delay_seconds INTEGER NOT NULL DEFAULT 3,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  username TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  fields TEXT NOT NULL DEFAULT '{}',
  first_seen TEXT DEFAULT CURRENT_TIMESTAMP,
  last_interaction TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(channel_id, external_id)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  comment_id TEXT NOT NULL,
  contact_id INTEGER,
  comment_text TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | done | error | dry
  public_reply_status TEXT,
  dm_status TEXT,
  error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(automation_id, comment_id)
);

CREATE TABLE IF NOT EXISTS reply_claims (
  account_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  author TEXT NOT NULL,
  PRIMARY KEY (account_id, comment_id),
  UNIQUE (account_id, media_id, author)
);

CREATE TABLE IF NOT EXISTS reply_attempts (
  account_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reply_attempts_time ON reply_attempts(attempted_at);

CREATE TABLE IF NOT EXISTS sending_stop (
  id INTEGER PRIMARY KEY CHECK (id=1),
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT CURRENT_TIMESTAMP,
  kind TEXT NOT NULL,
  note TEXT,
  payload TEXT
);
`);

// Migration: API host per channel (accounts created before Unified Login)
if (!db.prepare('PRAGMA table_info(channels)').all().some((c) => c.name === 'host')) {
  db.exec("ALTER TABLE channels ADD COLUMN host TEXT NOT NULL DEFAULT 'graph.instagram.com'");
}

// Migration: since when each automation applies (only later comments)
if (!db.prepare('PRAGMA table_info(automations)').all().some((c) => c.name === 'since')) {
  db.exec('ALTER TABLE automations ADD COLUMN since TEXT');
}
db.exec("UPDATE automations SET since=datetime('now') WHERE since IS NULL");

// Migration: "ask for email first" mode (mode='email'), its messages and the captures table
const autoCols = db.prepare('PRAGMA table_info(automations)').all().map((c) => c.name);
for (const [col, ddl] of [
  ['mode', "TEXT NOT NULL DEFAULT 'link'"],   // link = send the resource directly | email = ask for the email first
  ['ask_text', 'TEXT'],                       // first DM: asks for the email
  ['retry_text', 'TEXT'],                     // if what they wrote is not an email
  ['skip_known', 'INTEGER NOT NULL DEFAULT 1'], // if we already have their email, send the resource directly
]) if (!autoCols.includes(col)) db.exec(`ALTER TABLE automations ADD COLUMN ${col} ${ddl}`);

// Migration: automations created from the inbox carry the id they arrived with (avoids duplicates)
if (!db.prepare('PRAGMA table_info(automations)').all().some((c) => c.name === 'source_id')) {
  db.exec('ALTER TABLE automations ADD COLUMN source_id TEXT');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_source ON automations(source_id) WHERE source_id IS NOT NULL');

// Migration: data to analyze. Earlier rows stay NULL and the analytics treat them as "no data".
const addCols = (table, cols) => {
  const have = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  for (const [col, ddl] of cols) if (!have.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
};
addCols('runs', [
  ['comment_at', 'TEXT'],   // ISO: when the person commented (real comment time)
  ['media_id', 'TEXT'],     // exact reel of the comment (also for "all posts" automations)
  ['dm_at', 'TEXT'],        // ISO: when our DM went out (speed = dm_at - comment_at)
  ['variant', 'TEXT'],      // 'A' | 'B' in two-version tests
  ['igsid', 'TEXT'],        // person id for messages (to know whether they wrote back)
]);
addCols('automations', [
  ['alt_ask_text', 'TEXT'],                   // version B of the DM that asks for the email (A/B test)
  ['utm', 'INTEGER NOT NULL DEFAULT 0'],      // 1 = add UTM parameters to the links that are sent
]);
db.exec(`
CREATE TABLE IF NOT EXISTS account_stats (   -- daily account snapshot
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  day TEXT NOT NULL, followers INTEGER, media_count INTEGER,
  PRIMARY KEY (channel_id, day)
);
CREATE TABLE IF NOT EXISTS media_stats (     -- daily snapshot of each reel/post
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL, day TEXT NOT NULL, likes INTEGER, comments INTEGER,
  PRIMARY KEY (channel_id, media_id, day)
);
CREATE TABLE IF NOT EXISTS followups (       -- last DM each person wrote to us
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  igsid TEXT NOT NULL, last_in TEXT NOT NULL,  -- ISO
  PRIMARY KEY (channel_id, igsid)
);
CREATE TABLE IF NOT EXISTS uptime (          -- spans of time the program was on
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started TEXT NOT NULL, last TEXT NOT NULL    -- ISO
);
`);
// Insights (instagram_manage_insights permission): stored in the same daily snapshots
addCols('media_stats', [['views', 'INTEGER'], ['reach', 'INTEGER'], ['saved', 'INTEGER'], ['shares', 'INTEGER'], ['interactions', 'INTEGER'], ['watch_ms', 'INTEGER']]);
addCols('account_stats', [['reach', 'INTEGER'], ['views', 'INTEGER'], ['engaged', 'INTEGER']]);

db.exec(`
CREATE TABLE IF NOT EXISTS captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  contact_id INTEGER,
  run_id INTEGER,
  igsid TEXT NOT NULL,                 -- the person's Instagram id (who we write to)
  username TEXT,
  status TEXT NOT NULL DEFAULT 'waiting', -- waiting | got_email | done | expired | failed
  email TEXT,
  retries INTEGER NOT NULL DEFAULT 0,
  asked_at TEXT NOT NULL,              -- ISO: when the email was requested
  last_msg_at TEXT NOT NULL,           -- ISO: their last message already reviewed
  error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_captures_status ON captures(status);
`);

export const all =(sql, ...p) => db.prepare(sql).all(...p);
export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

export function logEvent(kind, note, payload) {
  run('INSERT INTO events(kind, note, payload) VALUES (?,?,?)', kind, note ?? null,
    payload === undefined ? null : JSON.stringify(payload).slice(0, 4000));
}

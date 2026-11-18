import assert from 'node:assert/strict';
process.env.DB_FILE = ':memory:';
const { run, get, all } = await import('../src/db.mjs');
const { pollOnce } = await import('../src/poller.mjs');
const { throttle, handleComment, hourlyCap } = await import('../src/engine.mjs');

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace('Z', '+0000'); // formato de Meta
const H = 3600e3, D = 24 * H;

run("INSERT INTO brands(name) VALUES ('T')");
run("INSERT INTO channels(brand_id, ig_user_id, username, token, host) VALUES (1,'IG1','account','tok','graph.facebook.com')");
run(`INSERT INTO automations(channel_id,name,media_id,keywords,public_replies,dm_text,tag,delay_seconds,since)
     VALUES (1,'A','M1','["montage"]','["ok {{username}}"]','hola {{username}}','lead',0, datetime('now','-1 hour'))`);

const sent = [];
const sender = () => ({
  replyToComment: async (id, t) => sent.push(['pub', id, t]),
  privateReplyText: async (id, t) => sent.push(['dm', id, t]),
  privateReplyButton: async (id, t) => sent.push(['dmb', id, t]),
});
const mk = (id, text, ago, user = 'ana') => ({ id, text, username: user, timestamp: iso(ago), from: { id: 'u_' + user, username: user } });
const deps = (comments, extra = {}) => ({ listComments: async () => ({ data: comments }), makeSender: sender, pause: async () => {}, ...extra });

// 1) Filters: new yes; before activation no; 8 days old no; own comment no; without the keyword no
let comments = [
  mk('c1', 'Montage', 5 * 60e3),
  mk('c2', 'montage', 2 * H),                 // before the automation was activated
  mk('c3', 'montage', 8 * D),                 // more than 7 days
  mk('c4', 'montage', 60e3, 'account'),        // own comment
  mk('c5', 'great video', 60e3),           // does not contain the keyword
];
assert.equal(await pollOnce(deps(comments)), 1, 'only the valid comment');
assert.deepEqual(sent.map((s) => s[0]), ['dm', 'pub'], 'DM first, then public reply');
assert.equal(sent[0][1], 'c1');
assert.equal(get("SELECT tags FROM contacts WHERE external_id='u_ana'").tags, '["lead"]');

// 2) Second read: no repeats and no duplicate events
const before = all("SELECT COUNT(*) n FROM events WHERE kind='duplicate'")[0].n;
assert.equal(await pollOnce(deps(comments)), 0, 'does not repeat the same comment');
assert.equal(sent.length, 2);
assert.equal(all("SELECT COUNT(*) n FROM events WHERE kind='duplicate'")[0].n, before, 'no noise in the log');

// 3) Per-cycle cap: 25 new comments -> 10, 10, 5
const many = Array.from({ length: 25 }, (_, i) => mk('m' + i, 'montage', 60e3, 'u' + i));
assert.equal(await pollOnce(deps(many)), 10);
assert.equal(await pollOnce(deps(many)), 10);
assert.equal(await pollOnce(deps(many)), 5);
assert.equal(await pollOnce(deps(many)), 0);

// 4) Meta slows us (code 4): pause, NOT marked as error, and the comment is retried later
const limited = [mk('r1', 'montage', 60e3, 'zed')];
const rateErr = Object.assign(new Error('Application request limit reached'), { code: 4 });
const failing = () => ({ replyToComment: async () => { throw new Error('must not happen'); }, privateReplyText: async () => { throw rateErr; }, privateReplyButton: async () => { throw rateErr; } });
const sentBefore = sent.length;
assert.equal(await pollOnce(deps(limited, { makeSender: failing })), 1);
assert.ok(throttle.until > Date.now(), 'stays paused');
assert.equal(get("SELECT COUNT(*) n FROM runs WHERE comment_id='r1'").n, 0, 'deleted so it can be retried');
assert.equal(sent.length, sentBefore, 'no public reply was posted');
assert.equal(await pollOnce(deps(limited)), 0, 'paused: does not send');
throttle.until = 0; // the pause ends
assert.equal(await pollOnce(deps(limited)), 1, 'after the pause it is retried');
assert.equal(get("SELECT status FROM runs WHERE comment_id='r1'").status, 'done');

// 5) Another error (not a limit): marked as error and NOT retried
const otherErr = () => ({ replyToComment: async () => {}, privateReplyText: async () => { throw Object.assign(new Error('user not available'), { code: 100 }); }, privateReplyButton: async () => {} });
assert.equal(await pollOnce(deps([mk('e1', 'montage', 60e3, 'bob')], { makeSender: otherErr })), 1);
assert.equal(get("SELECT status FROM runs WHERE comment_id='e1'").status, 'error');
assert.equal(await pollOnce(deps([mk('e1', 'montage', 60e3, 'bob')])), 0, 'does not retry definitive errors');

// 6) Pagination: follows pages while there are new comments and stops as soon as a whole page is old
run("INSERT INTO automations(channel_id,name,media_id,keywords,dm_text,delay_seconds,since) VALUES (1,'P','MP','[\"montage\"]','x',0, datetime('now','-1 hour'))");
run("UPDATE automations SET active=0 WHERE name='A'"); // only the automation of reel MP
const pages = [
  { data: [mk('p1', 'montage', 60e3, 'a1'), mk('p2', 'montage', 61e3, 'a2')], paging: { next: 'x', cursors: { after: 'C1' } } },
  { data: [mk('p3', 'montage', 62e3, 'a3'), mk('p4', 'montage', 63e3, 'a4')], paging: { next: 'x', cursors: { after: 'C2' } } },
  { data: [mk('p5', 'montage', 3 * H, 'a5'), mk('p6', 'montage', 4 * H, 'a6')], paging: { next: 'x', cursors: { after: 'C3' } } }, // before activation
  { data: [mk('p7', 'montage', 5 * H, 'a7')], paging: {} },
];
const asked = [];
const paged = { listComments: async (h, t, media, limit, after) => { asked.push(after); return pages[asked.length - 1]; }, makeSender: sender, pause: async () => {} };
assert.equal(await pollOnce(paged), 4, 'handles the 4 new ones from the first 2 pages');
assert.deepEqual(asked, [null, 'C1', 'C2'], 'asks for 3 pages and stops: the third is already older than the activation');

// Shared guard for direct webhook-style delivery and polling.
run(`INSERT INTO automations(channel_id,name,media_id,keywords,dm_text,delay_seconds,since)
     VALUES (1,'Overlapping','MP','["montage"]','x',0, datetime('now','-1 hour'))`);
const account = get('SELECT * FROM channels WHERE id=1');
const deliver = (id, user, makeSender = sender, age = 60e3) =>
  handleComment(account, { ...mk(id, 'montage', age, user), media: { id: 'MP' } }, { sender: makeSender() });
const first = deliver('overlap', 'tester');
assert.deepEqual(first.map((item) => item.automation), ['P']);
await first[0].done;
assert.equal(deliver('overlap', 'tester').length, 0);
assert.equal(deliver('repeat', 'tester').length, 0);
assert.equal(deliver('old', 'fresh', sender, 8 * D).length, 0);
run("DELETE FROM automations WHERE name='P'");
assert.equal(deliver('after-deleting-rule', 'tester').length, 0);

const blocked = () => ({ ...sender(), privateReplyText: async () => {
  throw Object.assign(new Error('Temporarily blocked'), { code: 368 });
} });
await deliver('blocked', 'another', blocked)[0].done;
assert.equal(get('SELECT reason FROM sending_stop').reason, 'Temporarily blocked');
assert.equal(deliver('different', 'other').length, 0);
assert.equal(await pollOnce(deps([mk('from-poller', 'montage', 60e3, 'other')])), 0);

run('DELETE FROM sending_stop');
run('DELETE FROM reply_attempts');
for (let i = 0; i < hourlyCap; i++) {
  run('INSERT INTO reply_attempts(account_id,attempted_at) VALUES (?,?)', account.ig_user_id, Date.now());
}
assert.equal(deliver('over-cap', 'other').length, 0);
assert.equal(await pollOnce(deps([mk('over-cap-poll', 'montage', 60e3, 'other')])), 0);

console.log('OK: poller tests passed');

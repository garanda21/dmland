import assert from 'node:assert/strict';
process.env.DB_FILE = ':memory:';
const { run, get, all } = await import('../src/db.mjs');
const { handleComment, throttle, DEFAULT_ASK, DEFAULT_RETRY } = await import('../src/engine.mjs');
const { pollDMs, extractEmail } = await import('../src/capture.mjs');

// ---- email extraction ----
assert.equal(extractEmail('my email is Ana@Test.COM!'), 'ana@test.com');
assert.equal(extractEmail('a.b+c@sub.dominio.mx.'), 'a.b+c@sub.dominio.mx');
assert.equal(extractEmail('hello, I have none'), null);
assert.equal(extractEmail('ana@test'), null);
assert.equal(extractEmail(''), null);
assert.equal(extractEmail(null), null);

// ---- setup ----
run("INSERT INTO brands(name) VALUES ('T')");
run("INSERT INTO channels(brand_id, ig_user_id, username, token, host) VALUES (1,'IG1','cuenta','tok','graph.facebook.com')");
run(`INSERT INTO automations(channel_id,name,keywords,public_replies,dm_text,tag,delay_seconds,since,mode,skip_known)
     VALUES (1,'Email','["montage"]','["listo"]','Here is the resource: https://x.com/r','lead',0, datetime('now','-1 hour'),'email',1)`);
const ch = get('SELECT * FROM channels WHERE id=1');

const sent = [];
const asker = (igsid) => ({
  privateReplyText: async (cid, t) => { sent.push(['ask', cid, t]); return { recipient_id: igsid, message_id: 'm' }; },
  privateReplyButton: async (cid, t) => { sent.push(['askb', cid, t]); return { recipient_id: igsid, message_id: 'm' }; },
  replyToComment: async (cid, t) => { sent.push(['pub', cid, t]); return {}; },
});
const comment = (id, user, uid, media = 'M1') => ({ id, timestamp: at(0), text: 'Montage', username: user, from: { id: uid, username: user }, media: { id: media } });
const comentar = async (c, igsid) => { const l = handleComment(ch, c, { sender: asker(igsid), instant: true }); await Promise.all(l.map((x) => x.done)); return l.length; };
const at = (msFromNow) => new Date(Date.now() + msFromNow).toISOString().replace('Z', '+0000');
const msg = (from, text, msFromNow) => ({ id: 'x' + Math.random(), from: { id: from }, message: text, created_time: at(msFromNow) });
const conv = (...messages) => ({ id: 'c' + Math.random(), messages: { data: messages } });

const out = [];
const deps = (conversations, extra = {}) => ({
  listConversations: async () => ({ data: conversations }),
  conversationByUser: async () => ({ data: [] }),
  sendText: async (h, t, i, to, text) => { out.push(['text', to, text]); return {}; },
  sendButton: async (h, t, i, to, text, title, url) => { out.push(['button', to, text, title, url]); return {}; },
  pause: async () => {}, ...extra,
});

// 1) The comment asks for the email (does not send the resource) and leaves a capture waiting
assert.equal(await comentar(comment('C1', 'ana', 'U1'), 'U1'), 1);
assert.deepEqual(sent.map((s) => s[0]), ['ask', 'pub']);
assert.equal(sent[0][2].includes('your email'), true, 'the first DM asks for the email');
assert.equal(sent[0][2].includes('https://x.com/r'), false, 'the resource is NOT sent yet');
let cap = get("SELECT * FROM captures WHERE igsid='U1'");
assert.equal(cap.status, 'waiting');
assert.equal(get('SELECT status FROM runs WHERE comment_id=?', 'C1').status, 'done');

// 2) Messages from before the question, our own messages and no answer: nothing happens
assert.equal(await pollDMs(deps([conv(msg('U1', 'viejo', -3600e3), msg('IG1', 'nuestro', 1000))])), 0);
assert.equal(out.length, 0);
assert.equal(get("SELECT status FROM captures WHERE igsid='U1'").status, 'waiting');

// 3) They answer something that is not an email -> asked once more
const hello = msg('U1', 'hello', 2000); // the same message always has the same time
await pollDMs(deps([conv(msg('IG1', 'question', 500), hello)]));
assert.deepEqual(out.at(-1), ['text', 'U1', DEFAULT_RETRY]);
assert.equal(get("SELECT retries FROM captures WHERE igsid='U1'").retries, 1);
// the same "hello" does not trigger anything again
const n = out.length;
await pollDMs(deps([conv(hello)]));
assert.equal(out.length, n, 'does not repeat the retry for the same message');

// 4) They send the email inside a sentence -> saved in lowercase and the resource goes out
await pollDMs(deps([conv(hello, msg('U1', 'my email is Ana@Test.COM!', 60000))]));
const last = out.at(-1);
assert.equal(last[0], 'text'); assert.equal(last[1], 'U1'); assert.ok(last[2].includes('https://x.com/r'), 'the resource is sent');
cap = get("SELECT * FROM captures WHERE igsid='U1'");
assert.equal(cap.status, 'done');
const contact = get("SELECT * FROM contacts WHERE external_id='U1'");
assert.equal(JSON.parse(contact.fields).email, 'ana@test.com');
assert.equal(contact.tags, '["lead"]');
assert.equal(all("SELECT note FROM events WHERE note LIKE '%ana@test.com%'").length, 0, 'the email is not written to the log');

// 5) If we already have their email: the resource goes out directly, without asking again
sent.length = 0;
assert.equal(await comentar(comment('C2', 'ana', 'U1', 'M2'), 'U1'), 1);
assert.equal(sent[0][0], 'ask'); // it is the private DM, but with the resource
assert.ok(sent[0][2].includes('https://x.com/r'), 'sends the resource directly');
assert.equal(all("SELECT * FROM captures WHERE igsid='U1'").length, 1, 'does not create another capture');

// 6) Two invalid answers -> stop insisting
await comentar(comment('C3', 'bob', 'U2'), 'U2');
out.length = 0;
const dunno = msg('U2', 'dunno', 3000);
await pollDMs(deps([conv(dunno)]));
assert.equal(out.length, 1);
await pollDMs(deps([conv(dunno, msg('U2', 'neither', 90000))]));
assert.equal(get("SELECT status FROM captures WHERE igsid='U2'").status, 'expired');
assert.equal(out.length, 1, 'no third attempt');

// 7) The person is not in the recent list -> ask for them directly
await comentar(comment('C4', 'cy', 'U3'), 'U3');
out.length = 0;
let asked = 0;
await pollDMs(deps([], { conversationByUser: async (h, t, i, id) => { asked++; assert.equal(id, 'U3'); return { data: [conv(msg('U3', 'cy@mail.com', 5000))] }; } }));
assert.equal(asked, 1); assert.ok(out.at(-1)[2].includes('https://x.com/r'));
assert.equal(get("SELECT status FROM captures WHERE igsid='U3'").status, 'done');

// 8) Meta slows the resource send -> the email stays saved and is retried later
await comentar(comment('C5', 'di', 'U4'), 'U4');
const limite = Object.assign(new Error('Application request limit reached'), { code: 4 });
await pollDMs(deps([conv(msg('U4', 'di@mail.com', 5000))], { sendText: async () => { throw limite; } }));
assert.equal(get("SELECT status FROM captures WHERE igsid='U4'").status, 'got_email', 'stays waiting, is not lost');
assert.ok(throttle.until > Date.now());
out.length = 0;
await pollDMs(deps([])); // paused: does not send
assert.equal(out.length, 0);
throttle.until = 0;
await pollDMs(deps([])); // the pause ended
assert.equal(get("SELECT status FROM captures WHERE igsid='U4'").status, 'done');
assert.ok(out.at(-1)[2].includes('https://x.com/r'));

// 9) Definitive error when sending the resource (e.g. 24 h window closed) -> failed, no endless retries
await comentar(comment('C6', 'ed', 'U5'), 'U5');
await pollDMs(deps([conv(msg('U5', 'ed@mail.com', 5000))], { sendText: async () => { throw Object.assign(new Error('Outside of allowed window'), { code: 10 }); } }));
assert.equal(get("SELECT status FROM captures WHERE igsid='U5'").status, 'failed');

// 10) Automation in normal mode: still sends the link directly and creates no captures
run(`INSERT INTO automations(channel_id,name,keywords,dm_text,delay_seconds,since,mode) VALUES (1,'Direct','["direct"]','direct link',0, datetime('now','-1 hour'),'link')`);
sent.length = 0;
const before = all('SELECT * FROM captures').length;
const l = handleComment(ch, { id: 'C7', timestamp: at(0), text: 'directo', username: 'zz', from: { id: 'U9', username: 'zz' }, media: { id: 'M1' } }, { sender: asker('U9'), instant: true });
await Promise.all(l.map((x) => x.done));
assert.equal(sent[0][2], 'direct link');
assert.equal(all('SELECT * FROM captures').length, before);

// Pending resources and delayed replies must expire locally without calling the Send API.
await comentar(comment('C8', 'old', 'U10'), 'U10');
await comentar(comment('C9', 'queued', 'U11'), 'U11');
run("UPDATE captures SET last_msg_at=? WHERE igsid='U10'", at(-26 * 3_600_000));
run("UPDATE captures SET status='got_email', last_msg_at=? WHERE igsid='U11'", at(-25 * 3_600_000));
out.length = 0;
await pollDMs(deps([conv(msg('U10', 'old@sample.test', -25 * 3_600_000))]));
assert.equal(out.length, 0);
assert.equal(get("SELECT status FROM captures WHERE igsid='U11'").status, 'expired');
assert.equal(get("SELECT email FROM captures WHERE igsid='U10'").email, null);

console.log('OK: email capture tests passed');

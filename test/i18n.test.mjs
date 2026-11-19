// Tests for the dashboard language layer (interface only). English is the base language; every file in
// public/lang/ is one extra language. The language block of public/index.html is extracted and run in isolation.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const a = html.indexOf('/* ---------- language (interface only) ---------- */');
const b = html.indexOf('async function setLang(l)');
assert.ok(a > 0 && b > a, 'language block not found');
const block = html.slice(a, html.indexOf('\n', b));

const load = (pack) => {
  const ctx = vm.runInNewContext(`${block}\n({ tr, T, trEvent, use(j) { PACK = j ? { dict: j.dict, rx: compile(j.patterns), ev: compile(j.events) } : null; }, pack: () => PACK })`, {
    store: { get: () => 'en', set() {} },
    document: { documentElement: {}, body: {} },
    MutationObserver: class { observe() {} },
    fetch: async () => { throw new Error('no network in tests'); },
  });
  ctx.use(pack);
  return ctx;
};

const dir = new URL('../public/lang/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
assert.ok(files.length >= 1, 'at least one extra language file ships with DMLand');
const langs = Object.fromEntries(files.map((f) => [f.slice(0, -5), JSON.parse(readFileSync(new URL(f, dir), 'utf8'))]));

// ---- English: nothing changes ----
const en = load(null);
for (const s of ['Home', 'Save', '5 min ago', '3 sent', 'any text']) assert.equal(en.tr(s), s);
const n = 7, p = 'the last 7 days';
assert.equal(en.T`${n} send errors in ${p}`, '7 send errors in the last 7 days', 'tagged templates format values in English');
assert.equal(en.T('Cancel'), 'Cancel');
assert.equal(en.trEvent('"X" ran for @y'), '"X" ran for @y');

// ---- Spanish (the bundled example language) ----
const es = load(langs.es);
assert.equal(es.tr('Home'), 'Inicio');
assert.equal(es.tr('5 min ago'), 'hace 5 min');
assert.equal(es.tr('1 contact'), '1 contacto'); assert.equal(es.tr('7 contacts'), '7 contactos');
assert.equal(es.tr('Export emails (3)'), 'Exportar emails (3)');
assert.equal(es.tr('Reading on · every 60 s'), 'Lectura activa · cada 60 s');
assert.equal(es.tr('2 accounts connected'), '2 cuentas conectadas');
assert.equal(es.T`${n} send errors in ${p}`, '7 errores de envío en the last 7 days', 'values are inserted untouched');
assert.equal(es.T('Cancel'), es.tr('Cancel'));
assert.equal(es.tr('The message with the resource is too long (Instagram allows 1000 bytes)'), 'El mensaje con el recurso es demasiado largo (Instagram permite 1000 bytes)', 'nested translation with $t1');
assert.equal(es.trEvent('"Activity" ran for @Errors'), '"Activity" ejecutada para @Errors', 'names inside a log line are left alone');
assert.equal(es.trEvent('Email captured and resource sent to @ana ("My auto")'), 'Email capturado y recurso enviado a @ana ("My auto")');
assert.equal(es.trEvent('Free text from the user'), 'Free text from the user', 'unknown log lines stay as they are');
assert.equal(es.tr('constructor'), 'constructor', 'JavaScript prototype words do not break the dictionary');
assert.equal(es.tr('Some text nobody translated'), 'Some text nobody translated', 'missing translations fall back to English');

// ---- every language file is well formed ----
for (const [code, j] of Object.entries(langs)) {
  assert.ok(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(code), `${code}: file name must be a language code`);
  assert.ok(j.name && typeof j.name === 'string', `${code}: missing "name"`);
  for (const [k, v] of Object.entries(j.dict)) {
    assert.ok(typeof v === 'string' && v.trim(), `${code}: empty translation for "${k}"`);
    const holes = (s) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join();
    assert.equal(holes(v), holes(k), `${code}: placeholders differ for "${k}"`);
  }
  for (const [re, tpl] of [...(j.patterns || []), ...(j.events || [])]) { new RegExp(re); assert.ok(tpl, `${code}: empty template for ${re}`); }
}

// ---- default DM texts that the editor fills in must be translatable ----
for (const name of ['DEFAULT_ASK', 'DEFAULT_RETRY']) {
  const m = html.match(new RegExp(`const ${name} = '((?:[^'\\\\]|\\\\.)*)';`)); assert.ok(m, `${name} not found`);
  const text = m[1].replace(/\\n/g, '\n');
  for (const [code, j] of Object.entries(langs)) assert.ok(j.dict[text], `${code}: ${name} has no translation`);
}

// ---- every piece of dashboard text is in the language files (or is a name/number that needs no translation) ----
const views = html.slice(html.indexOf('/* ---------- Home ---------- */'), html.indexOf('/* ---------- navigation ---------- */'));
const literals = new Set([...views.matchAll(/>([^<>{}$`]*[A-Za-z][^<>{}$`]*)</g)].map((m) => m[1].replace(/\\'/g, "'").trim()).filter((t) => t && !/[|?]|' \+|\(s ==/.test(t)));
for (const m of views.matchAll(/\bT\('((?:[^'\\]|\\.)*)'\)/g)) literals.add(m[1].replace(/\\'/g, "'"));
const NO_TRANSLATION = new Set(['Instagram', 'Meta', 'Webhook', 'Verify token', 'English', 'Español', 'CSV', 'A/B', 'UTM', 'DM', 'DMs', 'Email', 'Emails', 'OK', 'App Secret', 'ID', 'Token', 'Reel', 'reel', 'Reels', 'Tag', 'Tags', 'Total', 'Error', 'Likes', 'emails', 'US', 'Link (https://…)']);
for (const [code, j] of Object.entries(langs)) {
  const ctx = load(j);
  const missing = [...literals].filter((t) => !NO_TRANSLATION.has(t) && ctx.tr(t) === t);
  assert.deepEqual(missing, [], `${code}: dashboard texts missing from public/lang/${code}.json:\n${missing.join('\n')}`);
}

// ---- translating the DOM never touches user data: it must be marked translate="no" ----
for (const marker of ['esc(a.name)', 'esc(r.comment_text)', 'esc(r.automation)', 'esc(r.error)', 'esc(trEvent(e.note))', 'esc(k)', 'esc(t)', 'esc(b.name)']) {
  const spots = []; for (let i = html.indexOf(marker); i >= 0; i = html.indexOf(marker, i + 1)) spots.push(i);
  assert.ok(spots.length, `could not find ${marker}`);
  assert.ok(spots.some((i) => html.slice(Math.max(0, i - 300), i).includes('translate="no"')), `${marker} must sit inside translate="no"`);
}
assert.ok(/<h3 translate="no"><button[^>]*>\$\{esc\(a\.name\)\}<\/button><\/h3>/.test(html), 'the automation name must be translate="no"');
assert.ok(/<div id="phone" translate="no">/.test(html), 'the phone preview must be translate="no"');
assert.ok(/translate="no">\$\{esc\(r\.comment_text\)\}/.test(html), 'the comment must be translate="no"');

console.log('OK: language tests passed');

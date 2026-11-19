import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = mkdtempSync(join(tmpdir(), 'dmland-session-'));
const password = 'local-fixture-password';
const child = spawn(process.execPath, ['src/server.mjs'], {
  env: { ...process.env, ENV_FILE: join(temp, '.env'), DB_FILE: ':memory:', PORT: '0', HOST: '127.0.0.1', POLL: 'off',
    WEBHOOKS_ENABLED: 'off', DASHBOARD_PASSWORD: password, WEBHOOK_VERIFY_TOKEN: 'fixture',
    TOKEN_ENCRYPTION_KEY: '42'.repeat(32), TOKEN_ENCRYPTION_KEY_FILE: '' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const lines = createInterface({ input: child.stdout });
const timeout = setTimeout(() => child.kill(), 5000);

try {
  let base;
  for await (const line of lines) {
    base = line.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (base) break;
  }
  assert.ok(base, 'The fixture server must start');
  const request = (path, options) => fetch(base + path, { redirect: 'manual', ...options });
  const postLogin = (value, headers = {}) => request('/login', {
    method: 'POST', body: new URLSearchParams({ password: value }), headers,
  });

  const anonymous = await request('/');
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get('location'), '/login');
  assert.equal(anonymous.headers.get('www-authenticate'), null);
  assert.equal((await request('/api/brands')).status, 401);
  assert.match(await (await request('/login')).text(), /type="password"/);
  assert.equal((await request('/theme.css')).status, 200);
  assert.equal((await postLogin(password, { origin: 'http://other.example' })).status, 403);

  const wrong = await postLogin('wrong', { 'accept-language': 'es-ES' });
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /La contraseña es incorrecta/);

  const signedIn = await postLogin(password);
  assert.equal(signedIn.status, 303);
  assert.equal(signedIn.headers.get('location'), '/');
  const setCookie = signedIn.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly; SameSite=Strict/);
  const headers = { cookie: setCookie.split(';')[0] };
  assert.equal((await request('/', { headers })).status, 200);
  assert.equal((await request('/api/brands', { headers })).status, 200);
  assert.equal((await request('/logout', { method: 'POST', headers: { ...headers, origin: 'http://other.example' } })).status, 403);
  assert.equal((await request('/logout', { method: 'POST', headers })).headers.get('location'), '/login');
  assert.equal((await request('/api/brands', { headers })).status, 401);

  const authorization = 'Basic ' + Buffer.from('fixture:' + password).toString('base64');
  assert.equal((await request('/api/brands', { headers: { authorization } })).status, 200);
  for (let i = 0; i < 7; i++) assert.equal((await postLogin('wrong')).status, 401);
  assert.equal((await postLogin(password)).status, 429);
  console.log('OK: dashboard session tests passed');
} finally {
  clearTimeout(timeout);
  lines.close();
  child.kill();
  rmSync(temp, { recursive: true, force: true });
}

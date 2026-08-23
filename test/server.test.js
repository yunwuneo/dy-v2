import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startServer } from '../src/server.js';

let server;
let baseUrl;

before(async () => {
  server = startServer(0);
  if (!server.listening) {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  }
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('serves the Web UI and its assets', async () => {
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /抖音下载器/);

  const script = await fetch(`${baseUrl}/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
});

test('reports health and redacts sensitive configuration', async () => {
  const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
  assert.equal(health.status, 'ok');

  const response = await fetch(`${baseUrl}/api/config`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(typeof body.data.configured, 'boolean');
  assert.equal(typeof body.data.cookieConfigured, 'boolean');
  assert.ok(!('apiKey' in body.data));
  assert.ok(!('cookie' in body.data));
  assert.ok(!('watchers' in body.data));
});

test('exposes the local media library summary', async () => {
  const response = await fetch(`${baseUrl}/api/library`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.data.items));
  assert.equal(typeof body.data.summary.total, 'number');
  assert.equal(typeof body.data.summary.bytes, 'number');
  assert.ok(Array.isArray(body.data.summary.users));
});

test('rejects invalid list limits before making an upstream request', async () => {
  const response = await fetch(`${baseUrl}/api/list?identifier=test&limit=0`);
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.match(body.error, /limit/);
});

test('accepts collection requests without a user identifier', async () => {
  const response = await fetch(`${baseUrl}/api/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'collect', limit: 0 }),
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.match(body.error, /limit/);
});

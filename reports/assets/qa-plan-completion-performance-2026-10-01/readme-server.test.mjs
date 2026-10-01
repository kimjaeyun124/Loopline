import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';

const readme = await readFile('README.md', 'utf8');
const command = readme.match(/```sh\n([\s\S]*?)\n```/)?.[1];
const script = command?.match(/node -e '([\s\S]*)'/)?.[1];
assert.ok(script, 'README must contain an executable single-quoted node -e command');
const root = await mkdtemp(path.join(tmpdir(), 'readme-serve-'));
await writeFile(path.join(root, 'index.html'), '<h1>Focus Desk</h1>');
await writeFile(path.join(root, 'app.mjs'), 'export const ready = true;');
await writeFile(path.join(root, 'styles.css'), 'body { color: navy; }');
let handler;
const http = { createServer(fn) { handler = fn; return { listen() { return this; } }; } };
vm.runInNewContext(script, { require: n => { if (n === 'node:http') return http; if (n === 'node:fs') return fs; if (n === 'node:path') return path; throw new Error(`Unexpected dependency: ${n}`); }, process: { cwd: () => root }, console: { log() {} }, URL });
assert.equal(typeof handler, 'function');
const request = target => new Promise((resolve, reject) => {
  const result = { status: 200, headers: {}, body: '' };
  const res = { writeHead(status, headers = {}) { result.status = status; result.headers = headers; return this; }, end(body = '') { result.body = Buffer.isBuffer(body) ? body.toString() : String(body); resolve(result); return this; } };
  try { handler({ url: target }, res); } catch (error) { reject(error); }
});
test.after(async () => rm(root, { recursive: true, force: true }));
test('documented base address serves the entry HTML', async () => { const r = await request('/'); assert.equal(r.status, 200); assert.match(r.body, /Focus Desk/); assert.match(r.headers['Content-Type'], /text\/html/); });
test('module and style resources have executable MIME types', async () => { const m = await request('/app.mjs'); assert.equal(m.status, 200); assert.match(m.headers['Content-Type'], /javascript/); assert.match(m.body, /ready/); const c = await request('/styles.css'); assert.equal(c.status, 200); assert.match(c.headers['Content-Type'], /text\/css/); assert.match(c.body, /navy/); });
test('missing resources and decoded parent paths are rejected', async () => { assert.equal((await request('/missing.mjs')).status, 404); assert.equal((await request('/%2e%2e%2fsecret')).status, 403); });

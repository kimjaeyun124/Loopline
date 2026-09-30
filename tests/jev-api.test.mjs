import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiConnections } from '../api-connections.mjs';

const question = { type: 'choice', instructions: 'Does evidence pass?', criteria: { pass: 'yes', revise: 'no', uncertain: 'unknown' } };
const valid = () => ({ model: 'jev-test-version', answers: { goal: { type: 'choice', choice: 'pass', confidence: 0.95, probabilities: { pass: 0.98, revise: 0.01, uncertain: 0.01 } } }, usage: { input_tokens: 20, output_tokens: 3 } });
async function setup(t, reply = () => Response.json(valid())) {
  const dir = await mkdtemp(join(tmpdir(), 'loopline-jev-test-')); const calls = [];
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/models')) return Response.json({ models: [{ name: 'jev-latest' }] });
    return reply(options);
  });
  const api = new ApiConnections(dir);
  const connection = await api.connect({ name: 'Jev', baseUrl: 'https://api.typesafe.ai/v1', apiKey: 'test-only-secret' });
  return { dir, api, connection, calls, evaluate: (signal = new AbortController().signal, onUsage, timeoutMs) => api.evaluate(connection.id, 'jev-latest', { state: { diff: 'QA' }, questions: { goal: question } }, { signal, onUsage, timeoutMs }) };
}

async function setupChatConnection(t, reply) {
  const dir = await mkdtemp(join(tmpdir(), 'loopline-api-timeout-test-'));
  const calls = [];
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'qa-model', name: 'QA model' }] });
    return reply(options);
  });
  const api = new ApiConnections(dir);
  const connection = await api.connect({ name: 'QA API', baseUrl: 'https://api.example.test/v1', apiKey: 'test-only-secret' });
  return { api, connection, calls };
}
test('Jev native protocol preserves typed answers, accounts usage and never saves the session key', async (t) => {
  const f = await setup(t); let usage;
  const result = await f.evaluate(undefined, (value) => { usage = value; });
  assert.equal(f.connection.decisionOnly, true); assert.equal(f.connection.models[0].decisionOnly, true);
  assert.deepEqual(result, valid()); assert.deepEqual(usage, valid().usage);
  assert.equal(f.calls[1].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(f.calls[1].options.redirect, 'manual');
  assert.equal(JSON.parse(f.calls[1].options.body).questions.goal.type, 'choice');
  assert.ok(!(await readFile(join(f.dir, 'api-connections.json'), 'utf8')).includes('test-only-secret'));
  await assert.rejects(f.api.chat(f.connection.id, 'jev-latest', [], { signal: new AbortController().signal }), /판정 전용/);
});
test('missing or invalid Jev answers never count as successful decisions', async (t) => {
  const bad = [{}, { ...valid(), answers: {} }, { ...valid(), answers: { goal: { ...valid().answers.goal, choice: 'invented' } } }, { ...valid(), answers: { goal: { ...valid().answers.goal, probabilities: { pass: 0.1, revise: 0.8, uncertain: 0.1 } } } }];
  const f = await setup(t, () => Response.json(bad.shift()));
  for (let i = 0; i < 4; i++) await assert.rejects(f.evaluate(), /불완전/);
});
test('Jev authentication failures redact upstream bodies and redirects are refused', async (t) => {
  let status = 401; const f = await setup(t, () => new Response('test-only-secret', { status }));
  await assert.rejects(f.evaluate(), (error) => error.remoteStatus === 401 && !error.message.includes('test-only-secret'));
  status = 302; await assert.rejects(f.evaluate(), /다른 주소로 이동/);
});
test('Jev cancellation propagates and releases connection for removal', async (t) => {
  let started; const ready = new Promise((resolve) => { started = resolve; });
  const f = await setup(t, (options) => new Promise((resolve, reject) => { started(); options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); }));
  const controller = new AbortController(); const pending = f.evaluate(controller.signal); await ready;
  controller.abort(new Error('QA stopped')); await assert.rejects(pending, /QA stopped/);
  await f.api.remove(f.connection.id);
});

test('Jev supports a longer Harness timeout while retaining cancellation', async (t) => {
  const f = await setup(t, (options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  await assert.rejects(f.evaluate(new AbortController().signal, undefined, 25), /Jev 판정 시간이 초과되었습니다/);
  await f.api.remove(f.connection.id);
});

test('OpenAI-compatible model calls enforce the supplied Harness timeout', async (t) => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const f = await setupChatConnection(t, (options) => new Promise((resolve, reject) => {
    started(); options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  const controller = new AbortController();
  const pending = f.api.chat(f.connection.id, 'qa-model', [{ role: 'user', content: 'slow request' }], {
    signal: controller.signal, timeoutMs: 25, onDelta() {},
  });
  await ready;
  await assert.rejects(pending, /API 응답 시간이 초과되었습니다/);
  assert.equal(controller.signal.aborted, false, 'the configured timeout must not be mistaken for user cancellation');
  await f.api.remove(f.connection.id);
});

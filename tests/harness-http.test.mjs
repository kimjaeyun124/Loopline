import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startFixture } from './fixtures/harness-server.mjs';

async function until(check) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('Harness did not reach expected state');
}

test('the browser can load the provider-neutral automatic loop routing policy', async (t) => {
  const f = await startFixture(); t.after(f.close);
  const response = await fetch(`${f.url}/loop-policy.mjs`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.match(await response.text(), /selectAutomaticLoopModel/);
});

test('HTTP harness relays roles and supported effort, records usage and completes two verified rounds', async (t) => {
  const f = await startFixture(); t.after(f.close);
  const created = await f.request('/api/harness/runs', f.input);
  const run = await until(async () => { const value = await f.request(`/api/harness/runs/${created.id}`); return value.finishedAt ? value : null; });
  assert.equal(run.status, 'completed', run.summary); assert.equal(run.round, 2); assert.equal(run.applied, true);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'updated 2\n');
  assert.equal(f.calls.length, 9);
  assert.equal(f.calls[0].reasoning_effort, 'high'); assert.equal(f.calls[1].reasoning_effort, 'medium');
  assert.ok(f.calls.filter((call) => call.model === 'jev-qa').every((call) => !Object.hasOwn(call, 'reasoning_effort')));
  const ledger = (await readFile(join(f.data, 'token-usage.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(ledger.length, 9); assert.equal(ledger.reduce((sum, item) => sum + item.usage.totalTokens, 0), 135);
  assert.ok(run.events.some((event) => event.title.startsWith('검증') && event.status === 'failed'));
  assert.ok(!run.events.some((event) => event.status === 'running'));
  const patch = await fetch(`${f.url}/api/harness/runs/${run.id}/patch`).then((res) => res.text());
  assert.match(patch, /\+updated 2/);
});

test('HTTP stop aborts streaming request and releases the source for a new run', async (t) => {
  const f = await startFixture(); t.after(f.close);
  const created = await f.request('/api/harness/runs', { ...f.input, task: 'HOLD_FOR_STOP' });
  await until(() => f.calls.length === 1);
  await f.request(`/api/harness/runs/${created.id}/stop`, {});
  const run = await until(async () => { const value = await f.request(`/api/harness/runs/${created.id}`); return value.finishedAt ? value : null; });
  assert.equal(run.status, 'stopped'); assert.equal(f.calls.length, 1);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
  const next = await f.request('/api/harness/runs', f.input);
  const result = await until(async () => { const value = await f.request(`/api/harness/runs/${next.id}`); return value.finishedAt ? value : null; });
  assert.equal(result.status, 'completed', result.summary);
});

test('HTTP automatic setup creates a project and the judge reads files before each verification', async (t) => {
  const f = await startFixture(); t.after(f.close);
  const created = await f.request('/api/harness/runs', { ...f.input, workspace: undefined, verifyCommand: undefined });
  const run = await until(async () => { const value = await f.request(`/api/harness/runs/${created.id}`); return value.finishedAt ? value : null; });
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(run.round, 2); assert.equal(run.automaticVerification, true);
  assert.equal(await readFile(join(run.source, 'file.txt'), 'utf8'), 'updated 2\n');
  assert.equal(run.events.filter((event) => event.title.startsWith('검증 자동 구성')).length, 2);
  assert.ok(f.calls.filter((call) => call.messages.some((message) => message.content.startsWith('검증 방법을'))).every((call) => call.model === 'jev-qa'));
});

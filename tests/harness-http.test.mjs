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
  assert.deepEqual(run.stageModels.planner, { provider: 'api', source: 'Harness QA · 시뮬레이션', id: 'qa-worker', label: 'QA Worker', reasoningEffort: 'high' });
  assert.ok(run.events.some((event) => event.model?.role === 'planner' && event.model.label === 'QA Worker'));
  assert.ok(run.events.some((event) => event.model?.role === 'worker' && event.model.effort === 'medium'));
  assert.ok(run.events.some((event) => event.model?.role === 'judge' && event.model.source === 'Harness QA · 시뮬레이션'));
  const plannerEvent = run.events.find((event) => event.model?.role === 'planner');
  const promptDetails = await f.request(`/api/harness/runs/${run.id}/events/${plannerEvent.id}/prompt`);
  assert.equal(promptDetails.kind, 'harness');
  assert.match(promptDetails.input, /목표: file\.txt를 updated 2로 수정하세요\./);
  const savedRun = JSON.parse(await readFile(join(f.data, 'harness', `${run.id}.json`), 'utf8'));
  const savedPlannerEvent = savedRun.events.find((event) => event.id === plannerEvent.id);
  assert.equal(Object.hasOwn(savedPlannerEvent, 'prompt'), false);
  assert.equal(Object.hasOwn(savedPlannerEvent, 'promptDetails'), false);
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

test('Harness removes temporary Codex threads after transient delete failures', async (t) => {
  const f = await startFixture({ codexMock: true, codexDeleteFailures: 3 }); t.after(f.close);
  const selection = { provider: 'openai', model: 'qa-codex', reasoningEffort: 'medium' };
  const created = await f.request('/api/harness/runs', {
    task: '임시 Codex 대화 정리 동작을 확인합니다.',
    workspace: f.source,
    rounds: 1,
    verifyCommand: 'true',
    roles: { planner: selection, worker: selection, judge: selection },
  });
  const run = await until(async () => { const value = await f.request(`/api/harness/runs/${created.id}`); return value.finishedAt ? value : null; });
  assert.equal(run.status, 'completed', run.summary);

  const calls = (await readFile(f.codexLog, 'utf8')).trim().split('\n').map(JSON.parse);
  const starts = calls.filter((call) => call.method === 'thread/start');
  const unsubscribes = calls.filter((call) => call.method === 'thread/unsubscribe');
  const deletes = calls.filter((call) => call.method === 'thread/delete');
  assert.ok(starts.length >= 3, 'planner, worker, and judge each create a temporary Codex thread');
  assert.ok(starts.every((call) => !Object.hasOwn(call.params, 'ephemeral')));
  assert.equal(unsubscribes.length, starts.length);
  assert.equal(deletes.length, starts.length + 3, 'transient thread writer failures are retried until deletion succeeds');
  assert.ok(deletes.every((call) => /^qa-thread-\d+$/.test(call.params.threadId)));
  for (const deletion of deletes) {
    const deletionIndex = calls.indexOf(deletion);
    assert.ok(calls.findIndex((call) => call.method === 'thread/unsubscribe' && call.params.threadId === deletion.params.threadId) < deletionIndex);
  }
});

test('Harness removes its temporary Codex thread after stopping a model call', async (t) => {
  const f = await startFixture({ codexMock: true }); t.after(f.close);
  const selection = { provider: 'openai', model: 'qa-codex', reasoningEffort: 'medium' };
  const created = await f.request('/api/harness/runs', {
    task: 'codex-delay-qa',
    workspace: f.source,
    rounds: 1,
    verifyCommand: 'true',
    roles: { planner: f.input.roles.planner, worker: selection, judge: f.input.roles.judge },
  });
  await until(async () => {
    try { return (await readFile(f.codexLog, 'utf8')).includes('"method":"turn/start"') ? true : null; }
    catch { return null; }
  });
  await f.request(`/api/harness/runs/${created.id}/stop`, {});
  const run = await until(async () => { const value = await f.request(`/api/harness/runs/${created.id}`); return value.finishedAt ? value : null; });
  assert.equal(run.status, 'stopped');

  const calls = (await readFile(f.codexLog, 'utf8')).trim().split('\n').map(JSON.parse);
  const starts = calls.filter((call) => call.method === 'thread/start');
  const unsubscribes = calls.filter((call) => call.method === 'thread/unsubscribe');
  const deletes = calls.filter((call) => call.method === 'thread/delete');
  assert.equal(starts.length, 1);
  assert.equal(unsubscribes.length, 1);
  assert.equal(deletes.length, 2, 'the interrupted thread is removed after retrying one temporary delete failure');
  assert.ok(deletes.every((call) => call.params.threadId === 'qa-thread-1'));
});

test('Codex conversation deletion unsubscribes before deleting the thread', async (t) => {
  const f = await startFixture({ codexMock: true }); t.after(f.close);
  const result = await f.request('/api/thread/delete', { threadId: 'existing-thread', codexAccountId: 'default' });
  assert.equal(result.deleted, true);

  const calls = (await readFile(f.codexLog, 'utf8')).trim().split('\n').map(JSON.parse);
  const unsubscribeIndex = calls.findIndex((call) => call.method === 'thread/unsubscribe');
  const deleteIndex = calls.findIndex((call) => call.method === 'thread/delete');
  assert.ok(unsubscribeIndex >= 0);
  assert.ok(deleteIndex > unsubscribeIndex);
});

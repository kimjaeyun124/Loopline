import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarnessEvidence, taskType } from '../harness-evidence.mjs';

const model = { provider: 'openai', model: 'test-model', reasoningEffort: 'max' };
const run = (overrides = {}) => ({ id: randomUUID(), task: 'A website dashboard', status: 'completed', applied: true, createdAt: 100, finishedAt: 1000, round: 1, verificationPassed: true, qaRequired: true, browserQaPassed: true, events: [], modelCalls: [{ role: 'worker', ...model, effort: 'max', tokens: 100, durationMs: 300, status: 'success' }], ...overrides });
async function fixture(t) { const directory = await mkdtemp(join(tmpdir(), 'loopline-evidence-')); t.after(() => rm(directory, { recursive: true, force: true })); return new HarnessEvidence(directory); }

test('measurements require three distinct runs and replacement never double counts a resumed run', async (t) => {
  const store = await fixture(t), first = run();
  await store.record(first);
  assert.equal((await store.candidate(model, 'worker', 'website')).sufficientEvidence, false);
  await store.record({ ...first, status: 'limit', applied: false, browserQaPassed: false });
  await store.record(run()); await store.record(run());
  const result = await store.candidate(model, 'worker', 'website');
  assert.equal(result.runs, 3); assert.equal(result.completedRuns, 2); assert.equal(result.completionRate, 2 / 3);
  assert.equal(result.sufficientEvidence, true); assert.equal(result.browserQaPassedRuns, 2);
});

test('model effort, task type and role stay separate and missing token usage is never treated as zero', async (t) => {
  const store = await fixture(t);
  await store.record(run({ modelCalls: [{ role: 'worker', ...model, effort: 'max', tokens: null, durationMs: 10, status: 'success' }] }));
  await store.record(run({ task: 'Task CLI', modelCalls: [{ role: 'worker', ...model, effort: 'medium', tokens: 200, durationMs: 20, status: 'success' }] }));
  const web = await store.candidate(model, 'worker', 'website');
  assert.equal(web.runs, 1); assert.equal(web.missingUsageCalls, 1); assert.equal(web.meanReportedTokens, null);
  assert.equal((await store.candidate({ ...model, reasoningEffort: 'medium' }, 'worker', 'Task CLI')).meanReportedTokens, 200);
  assert.equal((await store.candidate(model, 'planner', 'website')).runs, 0);
  assert.equal(taskType('a command line CLI'), 'cli');
});

test('stored evidence contains no task text, file paths or model prompt and does not invent human labor', async (t) => {
  const store = await fixture(t), value = run({ task: 'website with private-project-secret', source: '/private/work', modelCalls: [{ role: 'worker', ...model, prompt: 'private-key-secret', effort: 'max', tokens: 50, durationMs: 10, status: 'success' }] });
  await store.record(value);
  const saved = await readFile(join(store.directory, `${value.id}.json`), 'utf8');
  assert.ok(!saved.includes('private-project-secret')); assert.ok(!saved.includes('/private/work')); assert.ok(!saved.includes('private-key-secret'));
  assert.equal(JSON.parse(saved).humanIntervention, 'not-measured');
});

test('user stop and shutdown interruption do not enter final completion performance statistics', async (t) => {
  const store = await fixture(t); await store.record(run({ status: 'stopped' })); await store.record(run({ status: 'interrupted' }));
  assert.equal((await store.summary()).recordedRuns, 0);
});

test('browser QA and milestone failures count as recovery work without double counting the same saved run', async (t) => {
  const store = await fixture(t), value = run({ events: [{ title: '응답 형식 재요청 / Retry format' }, { title: '부분 작업 수정 / Milestone failed' }], qaHistory: [{ round: 2, passed: false }, { round: 3, passed: true }] });
  await store.record(value); await store.record(value);
  const saved = JSON.parse(await readFile(join(store.directory, `${value.id}.json`), 'utf8'));
  assert.deepEqual(saved.recoveryBreakdown, { modelRetries: 1, browserQaFailures: 1, milestoneFailures: 1 });
  assert.equal(saved.recoveries, 3);
  const summary = await store.candidate(model, 'worker', 'website');
  assert.equal(summary.runs, 1); assert.equal(summary.meanRunRecoveries, 3);
});

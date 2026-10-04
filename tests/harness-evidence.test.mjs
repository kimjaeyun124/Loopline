import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarnessEvidence, taskType } from '../harness-evidence.mjs';

const model = { provider: 'openai', model: 'test-model', reasoningEffort: 'max' };
const run = (overrides = {}) => ({ id: randomUUID(), task: 'A website dashboard', status: 'completed', applied: true, createdAt: 100, finishedAt: 1000, round: 1, verificationPassed: true, qaRequired: true, browserQaPassed: true, events: [], humanActions: { manualResumes: 0, stopRequests: 0, completeCoverage: true }, modelCalls: [{ role: 'worker', ...model, effort: 'max', tokens: 100, durationMs: 300, status: 'success' }], ...overrides });
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
  assert.equal(result.observedActionRate, 0);
  assert.equal(result.humanInterventionSufficientEvidence, true);
});

test('completion evidence exposes a 95% Wilson lower bound that reflects sample size', async (t) => {
  const store = await fixture(t);
  for (const [candidate, outcomes] of [['small-sample', [true, true, true]], ['larger-sample', [...Array(9).fill(true), false]]]) {
    for (const completed of outcomes) {
      await store.record(run({
        status: completed ? 'completed' : 'failed', applied: completed, verificationPassed: completed,
        modelCalls: [{ role: 'worker', provider: 'openai', model: candidate, effort: 'max', tokens: 100, durationMs: 300, status: 'success' }],
      }));
    }
  }

  const small = await store.candidate({ provider: 'openai', model: 'small-sample', reasoningEffort: 'max' }, 'worker', 'website');
  const larger = await store.candidate({ provider: 'openai', model: 'larger-sample', reasoningEffort: 'max' }, 'worker', 'website');
  assert.equal(small.completionRate, 1);
  assert.equal(larger.completionRate, 0.9);
  assert.ok(small.completionConfidenceLowerBound > 0.43 && small.completionConfidenceLowerBound < 0.45);
  assert.ok(larger.completionConfidenceLowerBound > small.completionConfidenceLowerBound);
});

test('role-level outcomes exclude fallback runs while retaining direct per-model call measurements', async (t) => {
  const store = await fixture(t);
  await store.record(run({
    modelCalls: [
      { role: 'worker', ...model, effort: 'max', tokens: 40, durationMs: 100, status: 'failed', failureKind: 'transport' },
      { role: 'worker', provider: 'openai', model: 'fallback-model', effort: 'max', tokens: 60, durationMs: 200, status: 'success' },
    ],
    humanActions: { manualResumes: 1, stopRequests: 0, completeCoverage: true },
  }));
  for (const completed of [true, true, false]) {
    await store.record(run({
      status: completed ? 'completed' : 'failed', applied: completed,
      verificationPassed: completed, browserQaPassed: completed,
      modelCalls: [{ role: 'worker', provider: 'openai', model: 'fallback-model', effort: 'max', tokens: 60, durationMs: 200, status: 'success' }],
    }));
  }

  const primary = await store.candidate(model, 'worker', 'website');
  assert.equal(primary.runs, 1);
  assert.equal(primary.completionMeasuredRuns, 0);
  assert.equal(primary.completionRate, null);
  assert.equal(primary.sufficientEvidence, false);
  assert.equal(primary.meanModelTimeMs, 100);
  assert.equal(primary.meanReportedTokens, 40);
  assert.equal(primary.humanInterventionMeasuredRuns, 0);

  const fallback = await store.candidate({ provider: 'openai', model: 'fallback-model', reasoningEffort: 'max' }, 'worker', 'website');
  assert.equal(fallback.runs, 4);
  assert.equal(fallback.completionMeasuredRuns, 3);
  assert.equal(fallback.completedRuns, 2);
  assert.equal(fallback.completionRate, 2 / 3);
  assert.equal(fallback.verificationMeasuredRuns, 3);
  assert.equal(fallback.browserQaRuns, 3);
  assert.equal(fallback.browserQaPassedRuns, 2);
  assert.equal(fallback.humanInterventionMeasuredRuns, 3);
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

test('stored evidence contains no task text, file paths or model prompt and does not invent person time', async (t) => {
  const store = await fixture(t), value = run({ task: 'website with private-project-secret', source: '/private/work', modelCalls: [{ role: 'worker', ...model, prompt: 'private-key-secret', effort: 'max', tokens: 50, durationMs: 10, status: 'success' }] });
  await store.record(value);
  const saved = await readFile(join(store.directory, `${value.id}.json`), 'utf8');
  assert.ok(!saved.includes('private-project-secret')); assert.ok(!saved.includes('/private/work')); assert.ok(!saved.includes('private-key-secret'));
  assert.deepEqual(JSON.parse(saved).humanIntervention, { measurement: 'observed-actions', coverage: 'full-run', manualResumes: 0, stopRequests: 0 });
  assert.equal((await store.summary()).humanIntervention.personTimeMinutes, null);
});

test('user stop and shutdown interruption do not enter final completion performance statistics', async (t) => {
  const store = await fixture(t);
  await store.record(run({ status: 'stopped', humanActions: { manualResumes: 1, stopRequests: 1, completeCoverage: true } }));
  await store.record(run({ status: 'interrupted' }));
  const summary = await store.summary();
  assert.equal(summary.recordedRuns, 0);
  assert.equal(summary.humanIntervention.measuredRuns, 1);
  assert.equal(summary.humanIntervention.manualResumes, 1);
  assert.equal(summary.humanIntervention.stopRequests, 1);
  const modelResult = await store.candidate(model, 'worker', 'website');
  assert.equal(modelResult.runs, 0);
  assert.equal(modelResult.completionRate, null);
  assert.equal(modelResult.manualResumes, 1);
  assert.equal(modelResult.stopRequests, 1);
});

test('legacy evidence remains readable and is excluded from intervention coverage', async (t) => {
  const store = await fixture(t), id = randomUUID();
  await mkdir(store.directory, { recursive: true });
  await writeFile(join(store.directory, `${id}.json`), JSON.stringify({ version: 1, id, type: 'web', status: 'completed', completed: true,
    verificationPassed: true, browserQaRequired: false, browserQaPassed: false, recoveries: 0, calls: [{ role: 'worker', provider: model.provider, model: model.model, effort: 'max',
      tokens: 100, durationMs: 300, status: 'success', failureKind: '' }], humanIntervention: 'not-measured' }));
  const summary = await store.summary();
  assert.equal(summary.recordedRuns, 1);
  assert.equal(summary.humanIntervention.measuredRuns, 0);
  assert.equal(summary.models[0].runs, 1);
});

test('observed interaction rate is available only after three fully measured runs', async (t) => {
  const store = await fixture(t);
  await store.record(run());
  await store.record(run({ humanActions: { manualResumes: 1, stopRequests: 0, completeCoverage: true } }));
  const third = run({ humanActions: { manualResumes: 0, stopRequests: 1, completeCoverage: false } });
  await store.record(third);
  let result = await store.candidate(model, 'worker', 'website');
  assert.equal(result.fullyMeasuredInterventionRuns, 2);
  assert.equal(result.partiallyMeasuredInterventionRuns, 1);
  assert.equal(result.observedActionRate, null);
  assert.equal(result.humanInterventionSufficientEvidence, false);

  await store.record(run());
  result = await store.candidate(model, 'worker', 'website');
  assert.equal(result.fullyMeasuredInterventionRuns, 3);
  assert.equal(result.observedActionRate, 1 / 3);
  assert.equal(result.humanInterventionSufficientEvidence, true);
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

test('evidence over the retention limit selects the most recently written records and sorts by completion time', async (t) => {
  const store = await fixture(t);
  await mkdir(store.directory, { recursive: true });
  for (let index = 0; index < 2001; index++) {
    const id = randomUUID();
    await writeFile(join(store.directory, `${id}.json`), JSON.stringify({ version: 2, id, finishedAt: index, calls: [] }));
  }

  // The old implementation sliced the directory listing, so its first entry was always discarded.
  const firstListedName = (await readdir(store.directory)).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))[0];
  const previouslyDiscardedId = firstListedName.slice(0, -5);
  await writeFile(join(store.directory, firstListedName), JSON.stringify({ version: 2, id: previouslyDiscardedId, finishedAt: 3000, calls: [] }));
  await utimes(join(store.directory, firstListedName), new Date('2099-01-01T00:00:00Z'), new Date('2099-01-01T00:00:00Z'));

  const records = await store.records();
  assert.equal(records.length, 2000);
  assert.ok(records.some((record) => record.id === previouslyDiscardedId));
  assert.equal(records.at(-1).id, previouslyDiscardedId);
  assert.ok(records.every((record, index) => index === 0 || records[index - 1].finishedAt <= record.finishedAt));
});

test('task-type summaries retain matching evidence beyond newer records of other types while global summaries stay bounded', async (t) => {
  const store = await fixture(t);
  await mkdir(store.directory, { recursive: true });
  const cliId = randomUUID(), cliPath = join(store.directory, `${cliId}.json`), old = new Date('2020-01-01T00:00:00Z');
  await writeFile(cliPath, JSON.stringify({ version: 2, id: cliId, type: 'cli', status: 'completed', completed: true,
    verificationPassed: true, browserQaRequired: false, browserQaPassed: false, recoveries: 0, finishedAt: 100,
    calls: [{ role: 'worker', provider: model.provider, model: model.model, effort: 'max', tokens: 100, durationMs: 300, status: 'success', failureKind: '' }] }));
  await utimes(cliPath, old, old);

  const recent = new Date('2025-01-01T00:00:00Z');
  for (let index = 0; index < 2000; index++) {
    const id = randomUUID(), path = join(store.directory, `${id}.json`);
    await writeFile(path, JSON.stringify({ version: 2, id, type: 'web', status: 'completed', completed: true, finishedAt: index + 200, calls: [] }));
    await utimes(path, recent, recent);
  }

  const cliSummary = await store.summary('cli');
  assert.equal(cliSummary.recordedRuns, 1);
  assert.equal(cliSummary.models[0].runs, 1);
  const allSummary = await store.summary();
  assert.equal(allSummary.recordedRuns, 2000);
  assert.ok(allSummary.models.every((candidate) => candidate.type === 'web'));
});

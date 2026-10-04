import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarnessEngine, runCommand } from '../harness-engine.mjs';
import { HarnessEvidence } from '../harness-evidence.mjs';

const implementationPlan = '보관 파일의 형식을 유지하면서 입력 검증과 저장 후 재조회 동작을 구현하고 검사한다.';
const pass = async () => ({ code: 0, output: 'PASS: actual fixture check', error: '' });
const answers = (prompt, choice = 'pass') => ({ answers: Object.fromEntries(Object.keys(prompt.questions).map((id) => [id, { choice, reason: 'Supplied evidence matches the acceptance criteria.' }])) });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'loopline-plan-routing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), data = join(root, 'data'); await mkdir(source);
  const git = async (...args) => {
    const result = await runCommand('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=QA', '-c', 'user.email=qa@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd: source });
    assert.equal(result.code, 0, result.error);
  };
  await git('init'); await writeFile(join(source, 'file.txt'), 'original'); await git('add', '.'); await git('commit', '-m', 'fixture');
  const model = { provider: 'api', connectionId: 'fixture', model: 'primary', reasoningEffort: 'high', description: 'Provider description', supportedReasoningEfforts: ['low', 'high'], nativePlugins: false, loopMcp: false };
  const input = { task: 'Update stored data in file.txt', workspace: source, verifyCommand: 'test -f file.txt', rounds: 3, roles: {
    planner: model, worker: { ...model, automatic: true, fallbacks: [{ ...model, model: 'alternative' }] }, judge: { ...model, model: 'jev-fixture', decisionOnly: true },
  } };
  return { root, source, data, model, input };
}

function script({ route = (prompt) => answers(prompt, 'keep'), judge = (prompt) => answers(prompt), worker = () => ({ operations: [{ type: 'write', path: 'file.txt', content: 'updated' }], done: true, summary: 'Updated stored data' }), plan = null } = {}) {
  return async (selection, prompt, _instructions, _signal, report) => {
    report?.({ type: 'usage', usage: { total_tokens: 10 } });
    if (prompt?.questions?.worker || prompt?.questions?.planner) return route(prompt, selection);
    if (typeof prompt === 'object') return judge(prompt, selection);
    if (prompt.includes('구현 계획과 검증 기준')) return implementationPlan;
    if (prompt.includes('큰 프로젝트를 검증 가능한 작은 부분 작업')) return JSON.stringify(typeof plan === 'function' ? await plan(selection, prompt) : plan);
    return JSON.stringify(await worker(selection, prompt));
  };
}
async function finish(engine, input) {
  const created = await engine.create(input); await engine.runs.get(created.id).execution;
  const run = await engine.get(created.id); assert.equal(run.status, 'completed', run.summary); assert.equal(run.applied, true);
  return run;
}

test('implementation routing receives the actual plan before work and records model choice and usage', async (t) => {
  const f = await fixture(t), routes = [], workers = [];
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: script({
    route(prompt) {
      routes.push(prompt);
      if (!prompt.state.planContext) return answers(prompt, 'keep');
      assert.deepEqual(Object.keys(prompt.questions), ['worker']);
      assert.equal(prompt.state.planContext.plan, implementationPlan);
      assert.equal(prompt.state.planContext.milestone, null);
      assert.equal(prompt.state.candidates.worker[0].capabilities.description, 'Provider description');
      assert.deepEqual(prompt.state.candidates.worker[0].capabilities.supportedReasoningEfforts, ['low', 'high']);
      assert.match(prompt.state.candidates.worker[0].capabilities.evidenceType, /not measured/);
      return { answers: { worker: { choice: 'candidate_1', order: ['candidate_1', 'candidate_0'], reason: 'Storage validation requires the supplied candidate capability.' } } };
    },
    worker(selection) { workers.push(selection.model); return { operations: [{ type: 'write', path: 'file.txt', content: 'updated' }], done: true, summary: 'Updated' }; },
  }) });
  const run = await finish(engine, f.input);
  assert.equal(routes.length, 2); assert.deepEqual(workers, ['alternative']);
  const decision = run.events.find((event) => event.title.startsWith('계획별 모델 배정 결과'));
  assert.equal(decision.model.id, 'alternative'); assert.match(decision.detail, /Storage validation/);
  const call = run.events.find((event) => event.title.startsWith('계획별 모델 배정 /'));
  assert.match((await engine.getPromptDetails(run.id, call.id)).input, /보관 파일의 형식/);
  assert.equal(run.modelCalls.filter((entry) => [call.id, run.events.find((event) => event.title === '모델 배정 / Model selection').id].includes(entry.eventId)).reduce((total, entry) => total + entry.tokens, 0), 20);
});

test('automatic routing consumes measured completion and interaction evidence while preserving completion priority', async (t) => {
  const f = await fixture(t), evidence = new HarnessEvidence(join(f.data, 'harness'));
  for (const [model, outcomes] of [['primary', [true, true, false]], ['alternative', [true, true, true]]]) {
    for (const [index, completed] of outcomes.entries()) {
      await evidence.record({
        id: randomUUID(), task: f.input.task, status: completed ? 'completed' : 'failed', applied: completed,
        createdAt: 100, finishedAt: 1000, round: 1, verificationPassed: completed, qaRequired: false, browserQaPassed: false, events: [],
        humanActions: { manualResumes: model === 'primary' && index === 2 ? 1 : 0, stopRequests: 0, completeCoverage: true },
        modelCalls: [{ role: 'worker', provider: 'api', model, effort: 'high', tokens: 100, durationMs: 300, status: 'success' }],
      });
    }
  }
  const routes = [];
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: script({
    route(prompt) {
      if (prompt.questions.worker) {
        routes.push(prompt);
        const primary = prompt.state.candidates.worker.find((candidate) => candidate.model === 'primary');
        const alternative = prompt.state.candidates.worker.find((candidate) => candidate.model === 'alternative');
        assert.equal(primary.measuredEvidence.measuredRuns, 3);
        assert.equal(primary.measuredEvidence.completionRate, 2 / 3);
        assert.equal(primary.measuredEvidence.humanIntervention.observedActionRate, 1 / 3);
        assert.equal(alternative.measuredEvidence.completionRate, 1);
        assert.equal(alternative.measuredEvidence.humanIntervention.observedActionRate, 0);
        assert.match(prompt.state.measurementPolicy, /완료 안정성이 고정된 첫 기준/);
        assert.match(prompt.state.measurementPolicy, /인과적 성능이 아니며/);
      }
      return answers(prompt, 'keep');
    },
  }) });
  const run = await finish(engine, f.input);
  assert.ok(routes.length >= 1);
  assert.equal(run.roles.worker.model, 'alternative', run.events.filter((event) => /모델 배정/.test(event.title)).map((event) => `${event.title}: ${event.detail}`).join('\n'));
  const assignment = run.events.find((event) => event.title === '모델 배정 결과 / Model assigned' && event.model?.role === 'worker');
  assert.match(assignment.detail, /관찰 완료율 우선 배정/);
  assert.match(assignment.detail, /3\/3가 2\/3보다 높아 완료 안정성 우선 규칙/);
});

test('routing hides token and browser QA metrics until each has enough complete samples', async (t) => {
  const f = await fixture(t), evidence = new HarnessEvidence(join(f.data, 'harness'));
  for (let index = 0; index < 3; index++) {
    await evidence.record({
      id: randomUUID(), task: f.input.task, status: 'completed', applied: true,
      createdAt: 100, finishedAt: 1000, round: 1, verificationPassed: true,
      qaRequired: index === 0, browserQaPassed: index === 0, events: [],
      humanActions: { manualResumes: 0, stopRequests: 0, completeCoverage: true },
      modelCalls: [{ role: 'worker', provider: 'api', model: 'primary', effort: 'high', tokens: index === 0 ? 100 : null, durationMs: 300, status: 'success' }],
    });
  }
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: script({ route(prompt) {
    const primary = prompt.state.candidates.worker.find((candidate) => candidate.model === 'primary');
    assert.equal(primary.measuredEvidence.sufficientEvidence, true);
    assert.equal(primary.measuredEvidence.meanModelTimeMs, 300);
    assert.equal(primary.measuredEvidence.meanReportedTokens, null);
    assert.equal(primary.measuredEvidence.fullyReportedRuns, 1);
    assert.equal(primary.measuredEvidence.tokenUsageSufficientEvidence, false);
    assert.equal(primary.tokenEfficiencyBenchmark, 'insufficient usage samples');
    assert.equal(primary.measuredEvidence.browserQaRuns, 1);
    assert.equal(primary.measuredEvidence.browserQaPassRate, null);
    assert.equal(primary.measuredEvidence.browserQaSufficientEvidence, false);
    assert.match(prompt.state.measurementPolicy, /사용량이 모두 보고된 실행 3회 이상/);
    assert.match(prompt.state.measurementPolicy, /실제 QA 실행 3회 이상/);
    return answers(prompt, 'keep');
  } }) });
  const run = await finish(engine, f.input);
  assert.equal(run.roles.worker.model, 'primary');
});

test('completion evidence does not replace the default when samples are tied or the default is unmeasured', async (t) => {
  const cases = [
    { name: 'equal measured rates', primary: [true, true, true], alternative: [true, true, true] },
    { name: 'unmeasured default', primary: [], alternative: [true, true, true] },
    { name: 'insufficient samples', primary: [true, false], alternative: [true, true] },
  ];
  for (const scenario of cases) await t.test(scenario.name, async (t) => {
    const f = await fixture(t), evidence = new HarnessEvidence(join(f.data, 'harness'));
    for (const [model, outcomes] of [['primary', scenario.primary], ['alternative', scenario.alternative]]) {
      for (const completed of outcomes) {
        await evidence.record({
          id: randomUUID(), task: f.input.task, status: completed ? 'completed' : 'failed', applied: completed,
          createdAt: 100, finishedAt: 1000, round: 1, verificationPassed: completed, qaRequired: false, browserQaPassed: false, events: [],
          humanActions: { manualResumes: 0, stopRequests: 0, completeCoverage: true },
          modelCalls: [{ role: 'worker', provider: 'api', model, effort: 'high', tokens: 100, durationMs: 300, status: 'success' }],
        });
      }
    }
    const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: script({ route: (prompt) => answers(prompt, 'keep') }) });
    const run = await finish(engine, f.input);
    assert.equal(run.roles.worker.model, 'primary');
  });
});

test('fixed manual worker choices never perform plan-based reassignment', async (t) => {
  const f = await fixture(t); let routes = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: script({ route(prompt) { routes++; return answers(prompt, 'keep'); } }) });
  const run = await finish(engine, { ...f.input, roles: { ...f.input.roles, worker: { ...f.input.roles.worker, automatic: false } } });
  assert.equal(routes, 0); assert.equal(run.roles.worker.model, 'primary');
});

test('unchanged plan decisions survive reload without another call, while new failure evidence is considered', async (t) => {
  const f = await fixture(t); let routes = 0;
  const invoke = script({ route(prompt) { routes++; return answers(prompt, 'keep'); } });
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke });
  const run = await finish(engine, f.input); assert.equal(routes, 2);
  const restored = new HarnessEngine({ directory: f.data, verify: pass, invoke });
  const record = await restored.record(run.id);
  await restored.selectModels(record, { plan: implementationPlan, feedback: '' });
  assert.equal(routes, 2); assert.equal((await restored.get(run.id)).modelRoutingContexts, undefined);
  await restored.selectModels(record, { plan: implementationPlan, feedback: 'Actual validation failed: invalid input was saved.' });
  assert.equal(routes, 3);
  await restored.selectModels(record, { plan: implementationPlan, feedback: 'Actual validation failed: invalid input was saved.' });
  assert.equal(routes, 3);
});

test('each milestone is routed against its immutable ownership, criteria and dependencies', async (t) => {
  const f = await fixture(t), routes = [], workers = [];
  const plan = { tasks: [
    { id: 'first', title: 'Storage', dependsOn: [], paths: ['first.txt'], criteria: ['Persist the first result safely'], verifyCommand: 'test -f first.txt' },
    { id: 'second', title: 'Integration', dependsOn: ['first'], paths: ['second.txt'], criteria: ['Connect the persisted results'], verifyCommand: 'test -f second.txt' },
  ] };
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: script({ plan,
    route(prompt) {
      if (!prompt.state.planContext) return answers(prompt, 'keep');
      const current = prompt.state.planContext.milestone; routes.push(current);
      assert.equal(Object.hasOwn(current, 'status'), false); assert.equal(Object.hasOwn(current, 'attempts'), false);
      return { answers: { worker: { choice: 'candidate_1', order: ['candidate_1', 'candidate_0'], reason: `Fit for ${current.title}` } } };
    },
    worker(selection, prompt) {
      const part = prompt.includes('"id":"first"') ? 'first' : 'second'; workers.push([part, selection.model]);
      return { operations: [{ type: 'write', path: `${part}.txt`, content: part }], done: true, summary: `${part} complete` };
    },
  }) });
  const run = await finish(engine, { ...f.input, task: 'large project CLI with two parts', verifyCommand: 'test -f first.txt && test -f second.txt' });
  assert.deepEqual(routes.map((item) => item.id), ['first', 'second']);
  assert.deepEqual(routes[1].dependsOn, ['first']); assert.deepEqual(routes[0].criteria, plan.tasks[0].criteria);
  assert.deepEqual(workers, [['first', 'alternative'], ['second', 'primary']]);
  assert.ok(run.milestones.every((part) => part.status === 'completed' && part.evidence.reviewed));
});

test('actual failed verification reaches the next routing decision before repair', async (t) => {
  const f = await fixture(t), routes = [], workers = []; let checks = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: async () => ++checks === 1 ? { code: 1, output: 'QA_SAVE: invalid input was stored', error: '' } : pass(), invoke: script({
    route(prompt) {
      if (!prompt.state.planContext) return answers(prompt, 'keep');
      routes.push(prompt.state.planContext.failureFeedback);
      return routes.length === 1 ? answers(prompt, 'keep') : { answers: { worker: { choice: 'candidate_1', reason: 'Use the other listed candidate to repair the observed save failure.' } } };
    },
    worker(selection) { workers.push(selection.model); return { operations: [{ type: 'write', path: 'file.txt', content: `updated ${workers.length}` }], done: true, summary: 'Stored update' }; },
  }) });
  const run = await finish(engine, f.input);
  assert.equal(run.round, 2); assert.equal(routes.length, 2); assert.match(routes[1], /QA_SAVE/);
  assert.deepEqual(workers, ['primary', 'alternative']);
});

test('invalid plan routing retains the saved assignment and is not repeated for the same context', async (t) => {
  const f = await fixture(t); let plannedRoutes = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: script({ route(prompt) {
    if (!prompt.state.planContext) return answers(prompt, 'keep');
    plannedRoutes++; return { answers: { worker: { choice: 'candidate_1', order: ['candidate_1', 'candidate_1'] } } };
  } }) });
  const run = await finish(engine, f.input); const record = engine.runs.get(run.id);
  assert.equal(run.roles.worker.model, 'primary'); assert.equal(plannedRoutes, 1);
  await engine.selectModels(record, { plan: implementationPlan, feedback: '' });
  assert.equal(plannedRoutes, 1); assert.ok(run.events.some((event) => event.title.startsWith('기본 배정 유지')));
});

test('routing reads current reported quota and passes immutable browser checks unchanged', async (t) => {
  const f = await fixture(t), routes = [];
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: script({ route(prompt) { routes.push(prompt); return answers(prompt, 'keep'); } }) });
  const run = await finish(engine, f.input), record = engine.runs.get(run.id);
  record.run.roles.worker.remainingPercent = 99;
  record.run.modelBudgets[JSON.stringify(['api', 'fixture', 'primary', 'default'])] = { remainingPercent: 22, remainingTokens: 1234 };
  record.run.qaPlan = { entry: 'index.html', checks: [{ id: 'save', steps: [{ action: 'reload' }, { action: 'count', selector: '.item', value: 1 }] }] };
  await engine.selectModels(record, { plan: implementationPlan, feedback: 'Check current QA contract' });
  const state = routes.at(-1).state;
  assert.equal(state.candidates.worker[0].remainingPercent, 22); assert.equal(state.candidates.worker[0].remainingTokens, 1234);
  assert.deepEqual(state.planContext.browserQa, record.run.qaPlan);
});

test('quota fallback retains automatic mode and is not duplicated in later plan routing', async (t) => {
  const f = await fixture(t), routes = [];
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: script({ route(prompt) { routes.push(prompt); return answers(prompt, 'keep'); },
    worker(selection) {
      if (selection.model === 'primary') throw Object.assign(new Error('HTTP 429 quota exhausted'), { status: 429 });
      return { operations: [{ type: 'write', path: 'file.txt', content: 'recovered' }], done: true, summary: 'Recovered' };
    },
  }) });
  const run = await finish(engine, f.input); assert.equal(run.roles.worker.automatic, true); assert.equal(run.roles.worker.model, 'alternative');
  await engine.selectModels(engine.runs.get(run.id), { plan: `${implementationPlan} New part`, feedback: '' });
  assert.equal(routes.length, 2, 'A single available model needs no extra judgement');
});

const twoPartPlan = { tasks: [
  { id: 'first', title: 'Storage', dependsOn: [], paths: ['first.txt'], criteria: ['Persist the first result safely'], verifyCommand: 'test -f first.txt' },
  { id: 'second', title: 'Integration', dependsOn: ['first'], paths: ['second.txt'], criteria: ['Connect the persisted results'], verifyCommand: 'test -f second.txt' },
] };
const partWorker = (_selection, prompt) => {
  const part = prompt.includes('"id":"first"') ? 'first' : 'second';
  return { operations: [{ type: 'write', path: `${part}.txt`, content: part }], done: true, summary: `${part} complete` };
};

test('repeated plan rejection changes only automatic planners and preserves the final review gate', async (t) => {
  for (const automatic of [true, false]) await t.test(automatic ? 'automatic planner skips exhausted alternatives' : 'fixed planner stays selected', async (t) => {
    const f = await fixture(t), planners = []; let reviews = 0;
    const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: script({ worker: partWorker,
      plan(selection, prompt) { planners.push(selection.model); assert.match(prompt, /담당 파일과 기능을 실제로 검사/); return twoPartPlan; },
      judge(prompt) { return answers(prompt, prompt.questions.workPlan && ++reviews < 3 ? 'revise' : 'pass'); },
    }) });
    const run = await finish(engine, { ...f.input, task: 'large project CLI with two parts', verifyCommand: 'test -f first.txt && test -f second.txt', roles: {
      ...f.input.roles, worker: { ...f.model, automatic: false }, planner: { ...f.model, automatic, fallbacks: [
        { ...f.model, model: 'exhausted-planner', remainingPercent: 0 }, { ...f.model, model: 'alternative' },
      ] },
    } });
    assert.equal(reviews, 3);
    assert.deepEqual(planners, automatic ? ['primary', 'primary', 'alternative'] : ['primary', 'primary', 'primary']);
    assert.equal(run.events.filter(e => e.title.startsWith('계획 판정 복구')).length, automatic ? 1 : 0);
    assert.equal(run.roles.worker.model, 'primary'); assert.ok(run.milestones.every(part => part.status === 'completed'));
  });
});

test('planning recovery remains bounded and cannot bypass three rejected reviews', async (t) => {
  const f = await fixture(t), planners = []; let workerCalls = 0, reviews = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: script({
    plan(selection) { planners.push(selection.model); return twoPartPlan; },
    judge(prompt) { if (prompt.questions.workPlan) { reviews++; return answers(prompt, 'revise'); } return answers(prompt); },
    worker() { workerCalls++; throw new Error('Implementation must not start'); },
  }) });
  const created = await engine.create({ ...f.input, task: 'large project CLI', roles: { ...f.input.roles,
    planner: { ...f.model, automatic: true, fallbacks: [{ ...f.model, model: 'alternative' }] }, worker: { ...f.model, automatic: false },
  } });
  await engine.runs.get(created.id).execution; const run = await engine.get(created.id);
  assert.equal(run.status, 'failed'); assert.equal(run.applied, undefined); assert.equal(reviews, 3); assert.equal(workerCalls, 0);
  assert.deepEqual(planners, ['primary', 'primary', 'alternative']);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original');
});

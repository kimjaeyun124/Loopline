import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessEngine, runCommand } from '../harness-engine.mjs';
import { validateMilestones, milestoneContract, milestoneFiles, refreshMilestones, matchesMilestone, nextMilestone, milestoneCoverage } from '../harness-milestones.mjs';
import { validateBrowserPlan, BROWSER_QA_EXECUTOR } from '../browser-qa.mjs';

const plan = { tasks: [
  { id: 'first', title: '첫 기능', dependsOn: [], paths: ['first.txt'], criteria: ['첫 기능 결과가 저장됩니다'], verifyCommand: 'test -f first.txt' },
  { id: 'second', title: '둘째 기능', dependsOn: ['first'], paths: ['second.txt'], criteria: ['첫 기능과 둘째 기능이 연결됩니다'], verifyCommand: 'test -f second.txt' },
] };
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'loopline-milestones-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }

const planningRecord = (qaPlan) => ({ run: {
  task: qaPlan ? '오프라인 작업 관리 웹사이트' : 'large project CLI',
  roles: { planner: { provider: 'api', model: 'qa', automatic: false } },
  modelPriority: { planner: [] }, modelBudgets: {}, milestones: [],
  ...(qaPlan ? { qaPlan } : {}),
} });

test('milestone judgement receives the fixed browser contract and future planning phase without granting execution success', async (t) => {
  const root = await directory(t), engine = new HarnessEngine({ directory: root, invoke: async () => assert.fail('Use the captured planning fixture') });
  const qaPlan = validateBrowserPlan({ entry: 'index.html', checks: [{ id: 'task-flow', categories: ['input', 'save', 'empty', 'keyboard'], steps: [
    { action: 'reset' }, { action: 'visible', selector: '#empty' }, { action: 'fill', selector: '#new-task', value: '검사' },
    { action: 'press', key: 'Enter' }, { action: 'reload' }, { action: 'text', selector: '#tasks', value: '검사' },
  ] }] });
  const before = structuredClone(qaPlan), record = planningRecord(qaPlan);
  engine.callValidated = async () => plan;
  engine.decide = async (_record, state, questions) => {
    assert.equal(state.phase, 'pre-implementation planning'); assert.equal(state.task, record.run.task);
    assert.deepEqual(state.qaPlan, before); assert.deepEqual(state.executor, BROWSER_QA_EXECUTOR);
    assert.deepEqual(state.tasks, validateMilestones(plan));
    assert.match(questions.workPlan.question, /not whether unbuilt files exist or tests already pass/);
    assert.match(questions.workPlan.question, /first task must be testable without later-task files/);
    assert.match(questions.workPlan.question, /browser QA cannot replace meaningful per-task Node tests/);
    assert.match(questions.workPlan.pass, /execution evidence is still required/);
    return { decision: 'complete' };
  };
  engine.event = async () => {};
  await engine.prepareMilestones(record, 'future implementation plan', '');
  assert.deepEqual(qaPlan, before); assert.equal(record.run.milestoneContract, milestoneContract(record.run.milestones));
  assert.ok(record.run.milestones.every(task => task.status === 'pending' && task.evidence === null));
  for (const field of ['applied', 'verificationPassed', 'browserQaPassed']) assert.notEqual(record.run[field], true);
});

test('non-web milestone planning does not fabricate a browser executor or execution evidence', async (t) => {
  const engine = new HarnessEngine({ directory: await directory(t), invoke: async () => assert.fail('Use the captured planning fixture') }), record = planningRecord();
  engine.callValidated = async () => plan;
  engine.decide = async (_record, state) => {
    assert.equal(state.phase, 'pre-implementation planning');
    assert.equal(Object.hasOwn(state, 'qaPlan'), false); assert.equal(Object.hasOwn(state, 'executor'), false);
    return { decision: 'complete' };
  };
  engine.event = async () => {};
  await engine.prepareMilestones(record, 'future CLI plan', '');
  assert.equal(record.run.milestones.length, 2); assert.ok(record.run.milestones.every(task => task.evidence === null));
});

test('explicit milestone rejection retains the three-attempt bound and never grants a milestone contract', async (t) => {
  const engine = new HarnessEngine({ directory: await directory(t), invoke: async () => assert.fail('Use the captured planning fixture') }), record = planningRecord();
  let calls = 0, reviews = 0;
  engine.callValidated = async () => { calls++; return plan; };
  engine.decide = async () => { reviews++; return { decision: 'revise', feedback: 'Missing meaningful integration checks.' }; };
  engine.event = async () => {};
  await assert.rejects(engine.prepareMilestones(record, 'future plan', ''), /부분 작업 계획.*Missing meaningful integration checks/);
  assert.equal(calls, 3); assert.equal(reviews, 3); assert.deepEqual(record.run.milestones, []);
  assert.equal(record.run.milestoneContract, undefined); assert.notEqual(record.run.applied, true);
});

test('unexplained planning rejection uses the first available saved explanatory judge without granting approval', async (t) => {
  const engine = new HarnessEngine({ directory: await directory(t), invoke: async () => assert.fail('No model invocation in candidate selection') });
  const current = { provider: 'api', model: 'jev', decisionOnly: true }, next = { provider: 'api', model: 'reviewer' };
  const record = { run: { roles: { judge: current, planner: { model: 'planner' }, worker: { model: 'worker' } }, modelBudgets: {}, stageModels: {},
    modelPriority: { judge: [current, { provider: 'api', model: 'empty', remainingPercent: 0 }, next, { provider: 'api', model: 'later' }] } } };
  const events = []; engine.event = async (...args) => events.push(args);
  const verdict = { decision: 'revise', failedChecks: ['workPlan'], unexplainedChecks: ['workPlan'] };
  assert.equal(await engine.usePlanningReviewFallback(record, verdict, '부분 작업 계획'), true);
  assert.deepEqual(record.run.roles.judge, next); assert.equal(record.run.stageModels.judge.id, 'reviewer');
  assert.deepEqual(record.run.modelPriority.judge.map(model => model.model), ['jev', 'empty', 'later']);
  assert.equal(record.run.roles.planner.model, 'planner'); assert.equal(record.run.roles.worker.model, 'worker');
  assert.equal(verdict.decision, 'revise'); assert.notEqual(record.run.applied, true); assert.equal(events.length, 1);
  assert.match(events[0][2], /같은 계획과 같은 질문/);
  assert.equal(await engine.usePlanningReviewFallback(record, verdict, '부분 작업 계획'), false);
});

test('planning review keeps fixed explanatory judges, concrete critiques and unavailable fallback configurations', async (t) => {
  const engine = new HarnessEngine({ directory: await directory(t), invoke: async () => assert.fail('No invocation') });
  engine.event = async () => assert.fail('No candidate should be selected');
  const make = () => ({ run: { roles: { judge: { provider: 'api', model: 'jev', decisionOnly: true } }, modelBudgets: {}, stageModels: {}, modelPriority: { judge: [{ provider: 'api', model: 'reviewer' }] } } });
  const rejected = { decision: 'revise', failedChecks: ['workPlan'], unexplainedChecks: ['workPlan'] };
  for (const verdict of [{ decision: 'complete', failedChecks: [], unexplainedChecks: [] }, { ...rejected, unexplainedChecks: [] },
    { ...rejected, failedChecks: ['workPlan', 'another'] }]) assert.equal(await engine.usePlanningReviewFallback(make(), verdict, '계획'), false);
  const fixed = make(); delete fixed.run.roles.judge.decisionOnly;
  assert.equal(await engine.usePlanningReviewFallback(fixed, rejected, '계획'), false);
  const absent = make(); absent.run.modelPriority.judge = [];
  assert.equal(await engine.usePlanningReviewFallback(absent, rejected, '계획'), false);
  const exhausted = make(); exhausted.run.modelPriority.judge[0].remainingTokens = 0;
  assert.equal(await engine.usePlanningReviewFallback(exhausted, rejected, '계획'), false);
});

test('milestone review changes judge after two unexplained rejections and rechecks the identical pending plan', async (t) => {
  const engine = new HarnessEngine({ directory: await directory(t), invoke: async () => assert.fail('Captured planning fixture') }), record = planningRecord();
  record.run.roles.judge = { provider: 'api', model: 'jev', decisionOnly: true };
  record.run.modelPriority.judge = [{ provider: 'api', model: 'reviewer' }]; record.run.stageModels = {};
  let plans = 0; const reviews = [];
  engine.callValidated = async () => { plans++; return plan; };
  engine.decide = async (record, state, checks) => {
    reviews.push({ model: record.run.roles.judge.model, state: structuredClone(state), checks: structuredClone(checks) });
    assert.notEqual(record.run.applied, true); assert.deepEqual(record.run.milestones, []);
    return record.run.roles.judge.model === 'jev' ? { decision: 'revise', failedChecks: ['workPlan'], unexplainedChecks: ['workPlan'], feedback: 'Repair verification.' } : { decision: 'complete' };
  };
  engine.event = async () => {};
  await engine.prepareMilestones(record, 'future plan', '');
  assert.equal(plans, 2); assert.deepEqual(reviews.map(review => review.model), ['jev', 'jev', 'reviewer']);
  assert.deepEqual(reviews[2].state, reviews[1].state); assert.deepEqual(reviews[2].checks, reviews[1].checks);
  assert.ok(record.run.milestones.every(task => task.status === 'pending' && task.evidence === null));
});

test('milestone plans reject cycles, unbounded ownership, empty criteria and fake checks', () => {
  assert.equal(validateMilestones(plan).length, 2);
  const forward = structuredClone(plan); forward.tasks[0].dependsOn = ['second']; assert.throws(() => validateMilestones(forward), /의존 작업/);
  for (const path of ['**', '../outside', '.git/config', '/private/key', 'src/*']) {
    const invalid = structuredClone(plan); invalid.tasks[0].paths = [path]; assert.throws(() => validateMilestones(invalid), /담당 파일/);
  }
  const fake = structuredClone(plan); fake.tasks[0].verifyCommand = 'echo PASS'; assert.throws(() => validateMilestones(fake), /실제 부분/);
  assert.equal(matchesMilestone('src/module/file.js', { paths: ['src/**'] }), true);
  assert.equal(matchesMilestone('src-other/file.js', { paths: ['src/**'] }), false);
});

test('completion criteria hash excludes execution state and completed evidence is invalidated by changed dependencies', async (t) => {
  const root = await directory(t), tasks = validateMilestones(plan), initial = milestoneContract(tasks);
  await writeFile(join(root, 'first.txt'), 'first'); await writeFile(join(root, 'second.txt'), 'second');
  for (const task of tasks) { task.status = 'completed'; task.evidence = { reviewed: true, files: await milestoneFiles(root, ['first.txt', 'second.txt'], task) }; }
  assert.equal(milestoneContract(tasks), initial);
  assert.equal(milestoneCoverage(tasks, ['first.txt', 'second.txt']), true);
  assert.equal(milestoneCoverage(tasks, ['unknown.txt']), false);
  await writeFile(join(root, 'first.txt'), 'changed');
  assert.deepEqual(await refreshMilestones(tasks, root, ['first.txt', 'second.txt']), ['first', 'second']);
  assert.equal(nextMilestone(tasks).id, 'first'); assert.equal(milestoneCoverage(tasks, ['first.txt']), false);
  assert.ok(tasks[0].evidence.files['first.txt']);
  tasks[0].criteria[0] = 'altered'; assert.notEqual(milestoneContract(tasks), initial);
});

test('multi-task execution preserves verified parts and applies only after integration verification', async (t) => {
  const root = await directory(t), source = join(root, 'source'); await mkdir(source);
  const git = async (...args) => {
    const result = await runCommand('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=QA', '-c', 'user.email=qa@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd: source }); assert.equal(result.code, 0, result.error);
  };
  await git('init'); await writeFile(join(source, 'base.txt'), 'base'); await git('add', '.'); await git('commit', '-m', 'base');
  const commands = [], workerTasks = [];
  const engine = new HarnessEngine({ directory: root, verify: async (_workspace, command) => {
    commands.push(command); await assert.rejects(readFile(join(source, 'first.txt')));
    return { code: 0, output: 'meaningful fixture check', error: '' };
  }, invoke: async (_selection, prompt) => {
    if (typeof prompt === 'object') return JSON.stringify({ answers: Object.fromEntries(Object.keys(prompt.questions).map((id) => [id, { choice: 'pass', reason: 'Verified actual files' }])) });
    if (prompt.includes('구현 계획과 검증 기준')) return 'Implement two independent parts and integrate them.';
    if (prompt.includes('큰 프로젝트를 검증 가능한 작은 부분 작업')) return JSON.stringify(plan);
    const task = prompt.includes('"id":"first"') ? 'first' : 'second'; workerTasks.push(task);
    return JSON.stringify({ done: true, summary: `${task} implemented`, operations: [{ type: 'write', path: `${task}.txt`, content: task }] });
  } });
  const model = { provider: 'api', model: 'qa' };
  const created = await engine.create({ task: 'large project CLI', workspace: source, rounds: 3, verifyCommand: 'test -f first.txt && test -f second.txt', roles: { planner: model, worker: model, judge: model } });
  await engine.runs.get(created.id).execution; const run = await engine.get(created.id);
  assert.equal(run.status, 'completed', run.summary); assert.equal(run.applied, true);
  assert.deepEqual(workerTasks, ['first', 'second']); assert.equal(run.round, 2);
  assert.ok(run.milestones.every((task) => task.status === 'completed' && task.evidence.reviewed));
  assert.deepEqual(commands, ['test -f first.txt', 'test -f second.txt', 'test -f first.txt && test -f second.txt']);
  assert.equal(await readFile(join(source, 'first.txt'), 'utf8'), 'first');
});

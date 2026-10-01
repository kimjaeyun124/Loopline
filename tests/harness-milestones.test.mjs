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

async function sharedReviewFixture(t, { failed = false, manyFiles = false } = {}) {
  const root = await directory(t), workspace = join(root, 'workspace'); await mkdir(workspace);
  const git = async (...args) => {
    const result = await runCommand('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=QA', '-c', 'user.email=qa@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd: workspace });
    assert.equal(result.code, 0, result.error); return result.output.trim();
  };
  await git('init'); await mkdir(join(workspace, 'test'));
  const originalPackage = JSON.stringify({ type: 'module', scripts: { test: 'node --test test/core.test.mjs' } });
  const coreTest = "import test from 'node:test'; import assert from 'node:assert/strict'; test('actual core behavior', () => assert.equal(2 + 2, 4));\n";
  await writeFile(join(workspace, 'package.json'), originalPackage);
  await writeFile(join(workspace, 'core.js'), 'export const value = 4;\n');
  await writeFile(join(workspace, 'test/core.test.mjs'), coreTest);
  await git('add', '.'); await git('commit', '-m', 'core snapshot'); const baseline = await git('rev-parse', 'HEAD');
  const tasks = validateMilestones({ tasks: [
    { id: 'core', title: '핵심 모듈', dependsOn: [], paths: ['core.js', 'test/core.test.mjs', 'package.json'], criteria: ['핵심 테스트를 실제 실행하고 공유 테스트 설정을 보존한다'], verifyCommand: 'node --test test/core.test.mjs' },
    { id: 'ui', title: '화면 연결', dependsOn: ['core'], paths: ['index.html', 'test/ui.test.mjs', 'package.json'], criteria: ['화면 테스트와 실제 독립 브라우저 QA를 통과한다'], verifyCommand: 'node --test test/ui.test.mjs' },
  ] });
  tasks[0].status = 'completed'; tasks[0].evidence = { reviewed: true, round: 1, verifyCommand: tasks[0].verifyCommand, verificationOutput: 'previous core PASS',
    files: await milestoneFiles(workspace, ['core.js', 'test/core.test.mjs', 'package.json'], tasks[0]) };
  await writeFile(join(workspace, 'index.html'), '<html>UI exists</html>');
  await writeFile(join(workspace, 'test/ui.test.mjs'), coreTest.replace('actual core behavior', 'actual UI contract'));
  const integratedPackage = JSON.stringify({ type: 'module', scripts: { test: 'node --test test/core.test.mjs test/ui.test.mjs' } });
  await writeFile(join(workspace, 'package.json'), integratedPackage);
  if (failed) await writeFile(join(workspace, 'test/core.test.mjs'), coreTest.replace('2 + 2, 4', '2 + 2, 5'));
  if (manyFiles) {
    const extraOwned = Array.from({ length: 6 }, (_, index) => `owned-${index}.txt`);
    tasks[0].paths.push(...extraOwned);
    for (const path of extraOwned) await writeFile(join(workspace, path), path);
    await writeFile(join(workspace, 'core.js'), 'x'.repeat(2501));
    for (let index = 0; index < 100; index++) await writeFile(join(workspace, `other-${index}-${'a'.repeat(90)}.txt`), 'outside review scope');
  }
  const record = { controller: new AbortController(), run: { workspace, baseline, task: 'large project website', round: 2, runtime: {}, qaRequired: true, milestones: tasks } };
  const engine = new HarnessEngine({ directory: root, invoke: async () => assert.fail('Captured judgement only'),
    verify: async (_workspace, command) => {
      assert.equal(command, tasks[0].verifyCommand);
      // Run the fixture as a standalone test command, not a nested runner child.
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
      return runCommand(process.execPath, ['--test', 'test/core.test.mjs'], { cwd: workspace, env });
    } });
  engine.event = async () => ({});
  const judgements = [];
  engine.decide = async (_record, state, questions) => {
    judgements.push({ state: structuredClone(state), questions: structuredClone(questions) });
    return { decision: 'complete', summary: 'optimistic fixture judge', feedback: '' };
  };
  const before = milestoneContract(tasks), review = await engine.reviewMilestone(record, tasks[0], 'UI files already written');
  assert.equal(milestoneContract(tasks), before);
  return { workspace, record, review, judgements, integratedPackage };
}

test('shared configuration revalidation includes other milestone file presence without treating it as completed evidence', async (t) => {
  const f = await sharedReviewFixture(t), { state, questions } = f.judgements[0];
  assert.equal(f.review.passed, true); assert.equal(state.verification.code, 0); assert.match(state.verification.output, /actual core behavior/);
  assert.ok(state.workspaceInventory.split('\n').includes('test/ui.test.mjs'));
  assert.equal(state.workspaceInventoryTruncated, false);
  assert.equal(state.ownedFiles.includes('test/ui.test.mjs'), false);
  assert.equal(state.actualFiles.some(file => file.path === 'test/ui.test.mjs'), false);
  assert.ok(state.actualFiles.every(file => file.contentTruncated === false));
  assert.equal(state.actualFilesTruncated, false);
  const ui = state.relatedMilestones.find(task => task.id === 'ui'), core = state.relatedMilestones.find(task => task.id === 'core');
  assert.equal(ui.status, 'pending'); assert.equal(Object.hasOwn(ui, 'evidence'), false);
  assert.equal(core.status, 'needs-review'); assert.equal(Object.hasOwn(core, 'evidence'), false);
  assert.match(questions.milestone.question, /absence from them is not evidence/);
  assert.match(questions.milestone.question, /do not replace the current verification/);
  assert.equal(Object.hasOwn(state, 'integrationVerification'), false);
  assert.equal(f.record.run.milestones[0].status, 'completed'); assert.equal(f.record.run.milestones[1].status, 'pending');
  assert.equal(await readFile(join(f.workspace, 'package.json'), 'utf8'), f.integratedPackage);
  assert.notEqual(f.record.run.applied, true); assert.notEqual(f.record.run.browserQaPassed, true);
});

test('complete shared-file inventory and an optimistic judge cannot override a failed actual partial test', async (t) => {
  const f = await sharedReviewFixture(t, { failed: true });
  assert.equal(f.review.verification.code, 1); assert.equal(f.review.passed, false);
  assert.ok(f.judgements[0].state.workspaceInventory.includes('test/ui.test.mjs'));
  assert.equal(f.record.run.milestones[0].status, 'needs-review'); assert.notEqual(f.record.run.applied, true);
  assert.equal(await readFile(join(f.workspace, 'package.json'), 'utf8'), f.integratedPackage);
});

test('milestone review explicitly marks bounded inventory and scoped file previews as incomplete', async (t) => {
  const f = await sharedReviewFixture(t, { manyFiles: true }), { state, questions } = f.judgements[0];
  assert.equal(state.workspaceInventoryTruncated, true); assert.ok(state.workspaceInventory.endsWith('[파일 목록 일부 생략 / File list trimmed]'));
  assert.equal(state.actualFilesTruncated, true); assert.equal(state.actualFiles.length, 8); assert.equal(state.ownedFiles.length, 9);
  const preview = state.actualFiles.find(file => file.path === 'core.js');
  assert.equal(preview.content.length, 2500); assert.equal(preview.contentTruncated, true);
  assert.match(questions.milestone.question, /truncated inventory cannot establish file absence/);
  assert.equal(Object.hasOwn(state, 'integrationVerification'), false); assert.notEqual(f.record.run.applied, true);
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

async function webMilestoneFixture(t, { browserFailure = false, fullFailure = false, finalBrowserFailure = false, automaticVerification = false } = {}) {
  const root = await directory(t), source = join(root, 'source'); await mkdir(source);
  const git = async (...args) => {
    const result = await runCommand('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=QA', '-c', 'user.email=qa@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd: source });
    assert.equal(result.code, 0, result.error);
  };
  await git('init'); await writeFile(join(source, 'base.txt'), 'base'); await git('add', '.'); await git('commit', '-m', 'base');
  const qaPlan = validateBrowserPlan({ entry: 'index.html', checks: [{ id: 'task-flow', categories: ['input', 'save', 'empty', 'keyboard'], steps: [
    { action: 'reset' }, { action: 'visible', selector: '#empty' }, { action: 'fill', selector: '#new-task', value: 'First' },
    { action: 'press', key: 'Enter' }, { action: 'reload' }, { action: 'text', selector: '#tasks', value: 'First' },
  ] }] });
  const milestones = { tasks: [
    { id: 'store', title: '저장 모듈', dependsOn: [], paths: ['store.txt'], criteria: ['저장 모듈 동작을 독립 검증한다'], verifyCommand: 'node --test tests/store.test.mjs' },
    { id: 'ui', title: '화면 통합', dependsOn: ['store'], paths: ['index.html'], criteria: ['화면 통합 테스트, 전체 테스트와 실제 독립 브라우저 QA가 통과한다'], verifyCommand: 'node --test tests/ui.test.mjs' },
  ] };
  const actions = [], workerPrompts = [], reviewEvidence = []; let browserCalls = 0, fullCalls = 0, configured = 0;
  const engine = new HarnessEngine({ directory: root, verify: async (workspace, command) => {
    actions.push(command); await assert.rejects(readFile(join(source, 'index.html')));
    assert.equal(await readFile(join(workspace, 'store.txt'), 'utf8'), 'store');
    if (command !== milestones.tasks[0].verifyCommand) assert.match(await readFile(join(workspace, 'index.html'), 'utf8'), /<html>/);
    if (command === 'node --test' && fullCalls++ === 0 && fullFailure) return { code: 1, output: 'full integration failed', error: '' };
    return { code: 0, output: 'Meaningful fixture verification evidence', error: '' };
  }, verifyBrowser: async (input) => {
    browserCalls++; actions.push('browser'); await assert.rejects(readFile(join(source, 'index.html')));
    const live = engine.runs.get(input.runId).run;
    assert.deepEqual(input.plan, qaPlan); assert.equal(live.milestones[0].status, 'completed');
    assert.ok(fullCalls > 0, 'Full verification must run before browser QA');
    const failed = browserFailure && browserCalls === 1 || finalBrowserFailure && browserCalls === 2;
    return { passed: !failed, checks: [{ id: 'task-flow', passed: !failed }], failures: failed ? ['mobile/task-flow: actual keyboard failure'] : [] };
  }, invoke: async (_selection, prompt) => {
    if (typeof prompt === 'object') {
      if (prompt.state.milestone) {
        const current = prompt.state.milestone;
        if (current.id === 'store') {
          assert.equal(actions.includes('browser'), false); assert.equal(Object.hasOwn(prompt.state, 'integrationVerification'), false);
        } else {
          reviewEvidence.push(structuredClone(prompt.state));
          assert.deepEqual(current.criteria, milestones.tasks[1].criteria);
          assert.ok(prompt.state.integrationVerification, 'Final milestone judge must receive real integration verification');
        }
        actions.push('review-' + current.id);
      }
      // Deliberately optimistic model: real failed execution must still veto it.
      return { answers: Object.fromEntries(Object.keys(prompt.questions).map(id => [id, { choice: 'pass', reason: 'Optimistic fixture model' }])) };
    }
    if (prompt.includes('구현 계획과 검증 기준')) return 'Implement the store, then the UI; actual QA precedes final milestone approval.';
    if (prompt.includes('구현 전에 독립 브라우저 QA 계획')) return qaPlan;
    if (prompt.includes('큰 프로젝트를 검증 가능한 작은 부분 작업')) return milestones;
    workerPrompts.push(prompt);
    const core = prompt.includes('"id":"store"');
    return JSON.stringify({ done: true, summary: core ? 'store implemented' : 'UI implemented', operations: [{ type: 'write', path: core ? 'store.txt' : 'index.html', content: core ? 'store' : '<html>fixture UI</html>' }] });
  } });
  if (automaticVerification) engine.configureVerification = async (record, implementationPlan) => {
    configured++; assert.match(implementationPlan, /actual QA/); record.run.verifyCommand = 'node --test';
  };
  const model = { provider: 'api', model: 'fixture' };
  const created = await engine.create({ task: 'large project website with immutable browser QA', workspace: source, rounds: finalBrowserFailure ? 2 : 3,
    ...(automaticVerification ? {} : { verifyCommand: 'node --test' }), roles: { planner: model, worker: model, judge: model } });
  await engine.runs.get(created.id).execution;
  return { source, engine, run: await engine.get(created.id), actions, workerPrompts, reviewEvidence, browserCalls, configured, qaPlan };
}

test('last web milestone receives full test and browser evidence before approval without an extra worker round', async (t) => {
  const f = await webMilestoneFixture(t);
  assert.equal(f.run.status, 'completed', f.run.summary); assert.equal(f.run.applied, true); assert.equal(f.run.round, 2);
  assert.equal(f.workerPrompts.length, 2); assert.equal(f.browserCalls, 2);
  assert.deepEqual(f.actions, ['node --test tests/store.test.mjs', 'review-store', 'node --test tests/ui.test.mjs', 'node --test', 'browser', 'review-ui', 'node --test', 'browser']);
  assert.equal(f.reviewEvidence[0].integrationVerification.code, 0); assert.equal(f.reviewEvidence[0].independentBrowserQa.passed, true);
  assert.ok(f.run.milestones.every(task => task.status === 'completed' && task.evidence.reviewed));
  assert.deepEqual(f.run.qaPlan, f.qaPlan); assert.equal(await readFile(join(f.source, 'index.html'), 'utf8'), '<html>fixture UI</html>');
});

test('final web milestone chooses the full verification command before browser QA when configuration is automatic', async (t) => {
  const f = await webMilestoneFixture(t, { automaticVerification: true });
  assert.equal(f.run.status, 'completed', f.run.summary); assert.equal(f.configured, 1);
  assert.equal(f.run.verifyCommand, 'node --test'); assert.equal(f.browserCalls, 2); assert.equal(f.run.applied, true);
});

test('failed full tests or partial browser QA preserve the verified core and feed the next UI round', async (t) => {
  for (const failure of ['fullFailure', 'browserFailure']) await t.test(failure, async (t) => {
    const f = await webMilestoneFixture(t, { [failure]: true });
    assert.equal(f.run.status, 'completed', f.run.summary); assert.equal(f.run.round, 3); assert.equal(f.run.applied, true);
    assert.equal(f.workerPrompts.length, 3); assert.ok(f.workerPrompts[0].includes('"id":"store"'));
    assert.ok(f.workerPrompts.slice(1).every(prompt => prompt.includes('"id":"ui"')));
    assert.match(f.workerPrompts[2], failure === 'fullFailure' ? /full integration failed/ : /actual keyboard failure/);
    assert.equal(f.reviewEvidence[0].integrationVerification.code, failure === 'fullFailure' ? 1 : 0);
    assert.equal(f.reviewEvidence[0].independentBrowserQa?.passed, failure === 'fullFailure' ? undefined : false);
    assert.equal(f.browserCalls, failure === 'fullFailure' ? 2 : 3);
    assert.equal(f.run.milestones[0].attempts, 1); assert.equal(f.run.milestones[1].attempts, 2);
  });
});

test('browser QA is executed again after milestone approval and a new failure blocks automatic apply', async (t) => {
  const f = await webMilestoneFixture(t, { finalBrowserFailure: true });
  assert.equal(f.run.status, 'limit', f.run.summary); assert.notEqual(f.run.applied, true);
  assert.equal(f.run.milestones[0].status, 'completed'); assert.equal(f.run.milestones[1].status, 'pending'); assert.equal(f.run.browserQaPassed, false);
  assert.ok(f.run.events.some(event => event.title === '통합 수정 작업 선택 보완 / Integration owner fallback'));
  assert.deepEqual(f.run.qaHistory.map(qa => qa.passed), [true, false]);
  await assert.rejects(readFile(join(f.source, 'index.html')));
});

async function dependencyOwnerFixture(t, { invalidOwner = false, reviewOnlyFailure = false } = {}) {
  const root = await directory(t), source = join(root, 'source'); await mkdir(source);
  const git = async (...args) => {
    const result = await runCommand('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=QA', '-c', 'user.email=qa@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd: source });
    assert.equal(result.code, 0, result.error); return result.output.trim();
  };
  await git('init');
  await writeFile(join(source, 'verify-all.mjs'), `import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs'; import {spawnSync} from 'node:child_process';
const command=JSON.parse(readFileSync('package.json','utf8')).scripts.test;
assert.equal(command,'node --test','package.json must run both owned test files');
const child=spawnSync(process.execPath,['--test'],{encoding:'utf8',env:process.env});
process.stdout.write(child.stdout);process.stderr.write(child.stderr);
assert.equal(child.status,0);assert.match(child.stdout,/core behavior/);assert.match(child.stdout,/UI contract/);\n`);
  await git('add', '.'); await git('commit', '-m', 'independent full verification');
  const tasks = { tasks: [
    { id: 'core', title: 'Core and shared test settings', dependsOn: [], paths: ['core.js', 'package.json', 'test/core.test.mjs'], criteria: ['Core behavior is actually tested; shared settings retain all available tests'], verifyCommand: 'node --test test/core.test.mjs' },
    { id: 'ui', title: 'UI integration', dependsOn: ['core'], paths: ['index.html', 'test/ui.test.mjs'], criteria: ['UI contract and whole verification plus independent browser QA pass'], verifyCommand: 'node --test test/ui.test.mjs' },
  ] };
  const qa = validateBrowserPlan({ entry: 'index.html', checks: [{ id: 'flow', categories: ['input', 'save', 'empty', 'keyboard'], steps: [
    { action: 'reset' }, { action: 'visible', selector: '#empty' }, { action: 'fill', selector: '#input', value: 'QA' },
    { action: 'press', key: 'Enter' }, { action: 'reload' }, { action: 'text', selector: '#list', value: 'QA' },
  ] }] });
  const workerTasks = [], ownerInputs = [], reviewInputs = [], verifyResults = [];
  let coreWrites = 0, browserCalls = 0;
  const engine = new HarnessEngine({ directory: join(root, 'runs'), verify: async (workspace, command) => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const args = command === 'node verify-all.mjs' ? ['verify-all.mjs'] : ['--test', command.endsWith('core.test.mjs') ? 'test/core.test.mjs' : 'test/ui.test.mjs'];
    const result = await runCommand(process.execPath, args, { cwd: workspace, env });
    verifyResults.push({ command, ...result }); return result;
  }, verifyBrowser: async (input) => {
    browserCalls++; assert.deepEqual(input.plan, qa);
    assert.ok(verifyResults.some(v => v.command === 'node verify-all.mjs' && v.code === 0));
    await assert.rejects(readFile(join(source, 'index.html')));
    return { passed: true, checks: [{ id: 'flow', passed: true }], failures: [] };
  }, invoke: async (_model, prompt) => {
    if (typeof prompt === 'object') {
      if (prompt.questions.repairTask) {
        ownerInputs.push(structuredClone(prompt));
        assert.equal(prompt.state.failedTask, 'ui');
        assert.equal(prompt.state.integrationVerification.code, 1);
        assert.match(prompt.state.integrationVerification.error, /package.json must run both owned test files/);
        assert.equal(prompt.state.tasks.find(task => task.id === 'core').status, 'completed');
        assert.deepEqual(prompt.state.tasks.find(task => task.id === 'core').paths, tasks.tasks[0].paths);
        return { answers: { repairTask: { choice: invalidOwner ? 'task_unknown' : 'task_core', reason: 'Actual full check requires package.json, owned by core' } } };
      }
      if (prompt.state.milestone) reviewInputs.push(structuredClone(prompt.state));
      return { answers: Object.fromEntries(Object.keys(prompt.questions).map(id => [id, {
        choice: reviewOnlyFailure && prompt.state.milestone?.id === 'ui' ? 'revise' : 'pass', reason: 'Fixture decision, actual execution remains mandatory',
      }])) };
    }
    if (prompt.includes('구현 계획과 검증 기준')) return 'Create core, integrate UI, verify all; repair shared settings in their owner.';
    if (prompt.includes('구현 전에 독립 브라우저 QA 계획')) return qa;
    if (prompt.includes('큰 프로젝트를 검증 가능한 작은 부분 작업')) return tasks;
    const isCore = prompt.includes('"id":"core"'); workerTasks.push(isCore ? 'core' : 'ui');
    if (isCore) {
      coreWrites++;
      const script = reviewOnlyFailure || coreWrites > 1 ? 'node --test' : 'node --test test/core.test.mjs';
      return JSON.stringify({ done: true, summary: 'Core behavior and owned shared test settings', operations: [
        { type: 'write', path: 'package.json', content: JSON.stringify({ type: 'module', scripts: { test: script } }) },
        { type: 'write', path: 'core.js', content: 'export const value = 4;\n' },
        { type: 'write', path: 'test/core.test.mjs', content: "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../core.js'; test('core behavior',()=>assert.equal(value,4));\n" },
      ] });
    }
    return JSON.stringify({ done: true, summary: 'UI-owned files only; shared settings need their owning task', operations: [
      { type: 'write', path: 'index.html', content: '<html><h1>QA</h1></html>' },
      { type: 'write', path: 'test/ui.test.mjs', content: "import test from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; test('UI contract',()=>assert.match(readFileSync('index.html','utf8'),/<h1>QA/));\n" },
    ] });
  } });
  const model = { provider: 'api', model: 'fixture' }, created = await engine.create({ task: 'large project offline website', workspace: source,
    rounds: invalidOwner || reviewOnlyFailure ? 3 : 4, verifyCommand: 'node verify-all.mjs', roles: { planner: model, worker: model, judge: model } });
  await engine.runs.get(created.id).execution;
  return { source, run: await engine.get(created.id), workerTasks, ownerInputs, reviewInputs, verifyResults, browserCalls, tasks, qa };
}

test('actual partial integration failure reopens the shared-file owner and rechecks dependents before automatic application', async (t) => {
  const f = await dependencyOwnerFixture(t);
  assert.equal(f.run.status, 'completed', f.run.summary); assert.equal(f.run.applied, true);
  assert.equal(f.run.verificationPassed, true); assert.equal(f.run.browserQaPassed, true);
  assert.deepEqual(f.workerTasks, ['core', 'ui', 'core']); assert.equal(f.run.round, 4);
  assert.equal(f.ownerInputs.length, 1); assert.equal(f.browserCalls, 2);
  assert.equal(f.run.milestoneContract, milestoneContract(validateMilestones(f.tasks)));
  assert.deepEqual(f.run.qaPlan, f.qa); assert.ok(f.run.milestones.every(task => task.status === 'completed'));
  assert.equal(f.run.milestones[0].evidenceHistory.length, 1);
  assert.equal(f.reviewInputs.filter(input => input.milestone.id === 'ui').length, 2);
  assert.ok(f.run.events.some(e => e.title === '선행 담당 작업 보완 / Repair owning milestone'));
  assert.equal(JSON.parse(await readFile(join(f.source, 'package.json'), 'utf8')).scripts.test, 'node --test');
  assert.ok(f.verifyResults.some(v => v.command === 'node verify-all.mjs' && v.code === 1));
  assert.ok(f.verifyResults.some(v => v.command === 'node verify-all.mjs' && v.code === 0 && /tests 2/.test(v.output)));
});

test('invalid dependency repair ownership preserves the failing gate and original scope without reopening another task', async (t) => {
  const f = await dependencyOwnerFixture(t, { invalidOwner: true });
  assert.equal(f.run.status, 'limit', f.run.summary); assert.notEqual(f.run.applied, true);
  assert.deepEqual(f.workerTasks, ['core', 'ui', 'ui']); assert.equal(f.browserCalls, 0);
  assert.equal(f.run.milestones[0].status, 'completed'); assert.equal(f.run.milestones[0].evidenceHistory.length, 0);
  assert.equal(f.run.milestones[1].status, 'pending');
  assert.equal(f.run.milestoneContract, milestoneContract(validateMilestones(f.tasks)));
  assert.ok(f.run.events.some(e => e.title === '부분 통합 담당 유지 / Milestone owner retained'));
  await assert.rejects(readFile(join(f.source, 'index.html')));
});

test('a valid negative review with successful actual execution never reassigns another milestone', async (t) => {
  const f = await dependencyOwnerFixture(t, { reviewOnlyFailure: true });
  assert.equal(f.run.status, 'limit', f.run.summary); assert.notEqual(f.run.applied, true);
  assert.deepEqual(f.ownerInputs, []); assert.deepEqual(f.workerTasks, ['core', 'ui', 'ui']);
  assert.equal(f.run.milestones[0].status, 'completed'); assert.equal(f.run.milestones[0].evidenceHistory.length, 0);
  assert.equal(f.run.browserQaPassed, true); assert.equal(f.browserCalls, 2);
  assert.equal(f.run.milestoneContract, milestoneContract(validateMilestones(f.tasks))); assert.deepEqual(f.run.qaPlan, f.qa);
  await assert.rejects(readFile(join(f.source, 'index.html')));
});

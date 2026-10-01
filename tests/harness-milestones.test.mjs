import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessEngine, runCommand } from '../harness-engine.mjs';
import { validateMilestones, milestoneContract, milestoneFiles, refreshMilestones, matchesMilestone, nextMilestone, milestoneCoverage } from '../harness-milestones.mjs';

const plan = { tasks: [
  { id: 'first', title: '첫 기능', dependsOn: [], paths: ['first.txt'], criteria: ['첫 기능 결과가 저장됩니다'], verifyCommand: 'test -f first.txt' },
  { id: 'second', title: '둘째 기능', dependsOn: ['first'], paths: ['second.txt'], criteria: ['첫 기능과 둘째 기능이 연결됩니다'], verifyCommand: 'test -f second.txt' },
] };
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'loopline-milestones-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }

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

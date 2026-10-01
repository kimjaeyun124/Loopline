import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserQaBridge, needsBrowserQa, validateBrowserPlan } from '../browser-qa.mjs';
import { HarnessEngine, runCommand } from '../harness-engine.mjs';

export const qaPlan = { entry: 'index.html', checks: [
  { id: 'empty', categories: ['empty'], steps: [{ action: 'reset' }, { action: 'visible', selector: '#empty' }] },
  { id: 'input-save', categories: ['input', 'save', 'keyboard'], steps: [{ action: 'fill', selector: '#name', value: 'QA task' }, { action: 'press', key: 'Enter' }, { action: 'text', selector: '#list', value: 'QA task' }, { action: 'reload' }, { action: 'text', selector: '#list', value: 'QA task' }] },
] };

test('browser QA detects web work while keeping command line JavaScript outside browser scope', () => {
  assert.equal(needsBrowserQa('Task ledger CLI', 'cli.mjs\ncli.js'), false);
  assert.equal(needsBrowserQa('웹사이트 제작', ''), true);
  assert.equal(needsBrowserQa('버그 수정', 'index.html'), true);
});

test('QA contract requires actual input, reload, key events and assertions, and rejects scripts', () => {
  assert.deepEqual(validateBrowserPlan(qaPlan), qaPlan);
  for (const action of ['fill', 'reload', 'press', 'text']) {
    const plan = structuredClone(qaPlan);
    plan.checks[1].steps = plan.checks[1].steps.filter((s) => s.action !== action);
    assert.throws(() => validateBrowserPlan(plan), /QA 계획 오류/);
  }
  const malicious = structuredClone(qaPlan); malicious.checks[0].steps.push({ action: 'evaluate', script: 'process.exit()' });
  assert.throws(() => validateBrowserPlan(malicious), /허용되지 않은/);
  const traversal = structuredClone(qaPlan); traversal.entry = '../private/index.html';
  assert.throws(() => validateBrowserPlan(traversal), /상대 HTML/);
});

test('browser IPC cancellation removes pending work and standalone mode never claims success', async () => {
  const port = new EventEmitter(); const messages = [];
  port.postMessage = (message) => messages.push(message);
  const bridge = new BrowserQaBridge(port), controller = new AbortController();
  const pending = bridge.verify({ plan: qaPlan }, controller.signal); controller.abort(new Error('USER_STOP'));
  await assert.rejects(pending, /USER_STOP/);
  assert.equal(bridge.pending.size, 0); assert.equal(messages.at(-1).action, 'cancel');
  assert.equal((await new BrowserQaBridge(null).verify({ plan: qaPlan })).passed, false);
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'loopline-browser-gate-'));
  const source = join(directory, 'source'); await mkdir(source);
  const git = async (...args) => {
    const r = await runCommand('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=QA', '-c', 'user.email=qa@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd: source });
    assert.equal(r.code, 0, r.error);
  };
  await git('init'); await writeFile(join(source, 'file.txt'), 'original'); await git('add', '.'); await git('commit', '-m', 'fixture');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const model = { provider: 'api', model: 'qa' };
  return { directory, source, input: { task: '저장과 키보드 입력이 가능한 웹사이트', workspace: source, rounds: 2, verifyCommand: 'true', roles: { planner: model, worker: model, judge: model } } };
}

test('independent QA vetoes optimistic review, preserves evidence and forwards failure before applying', async (t) => {
  const f = await fixture(t); let attempts = 0, workerRounds = 0; const prompts = [];
  const engine = new HarnessEngine({ directory: f.directory, verify: async () => ({ code: 0, output: 'PASS' }),
    verifyBrowser: async () => {
      attempts++;
      await assert.rejects(readFile(join(f.source, 'index.html'))); // No source apply before independent QA.
      return attempts === 1 ? { passed: false, checks: [{ id: 'empty', passed: false }], failures: ['mobile/empty: hidden attribute ignored'] }
        : { passed: true, checks: [{ id: 'empty', passed: true }], failures: [] };
    }, invoke: async (_selection, prompt) => {
      if (typeof prompt === 'object') return { answers: Object.fromEntries(Object.keys(prompt.questions).map((id) => [id, { choice: 'pass', reason: 'Actual evidence' }])) };
      if (prompt.includes('구현 계획과 검증 기준')) return '구현과 QA';
      if (prompt.includes('구현 전에 독립 브라우저 QA 계획')) return qaPlan;
      prompts.push(prompt); workerRounds++;
      return JSON.stringify({ done: true, summary: 'Implemented', operations: [{ type: 'write', path: 'index.html', content: `<html>round ${workerRounds}</html>` }] });
    } });
  const run = await engine.create(f.input); await engine.runs.get(run.id).execution;
  const final = await engine.get(run.id);
  assert.equal(final.status, 'completed', JSON.stringify({summary:final.summary,events:final.events.slice(-6)})); assert.equal(final.applied, true); assert.equal(final.round, 2);
  assert.equal(final.qaHistory.length, 2); assert.equal(final.qaHistory[0].passed, false); assert.equal(final.qaHistory[1].passed, true);
  assert.match(prompts[1], /hidden attribute ignored/);
  assert.deepEqual(final.qaPlan, qaPlan);
});

test('failed independent QA cannot be overridden by model approval at the round limit', async (t) => {
  const f = await fixture(t);
  const engine = new HarnessEngine({ directory: f.directory, verify: async () => ({ code: 0, output: 'PASS' }), verifyBrowser: async () => ({ passed: false, checks: [], failures: ['missing HTML'] }), invoke: async (_selection, prompt) => {
    if (typeof prompt === 'object') return { answers: Object.fromEntries(Object.keys(prompt.questions).map((id) => [id, { choice: 'pass', reason: 'approved' }])) };
    if (prompt.includes('구현 계획과 검증 기준')) return 'Plan';
    if (prompt.includes('구현 전에 독립 브라우저 QA 계획')) return qaPlan;
    return JSON.stringify({ done: true, summary: 'Attempt', operations: [{ type: 'write', path: 'index.html', content: '<html>unverified</html>' }] });
  } });
  const run = await engine.create({ ...f.input, rounds: 1 }); await engine.runs.get(run.id).execution;
  const final = await engine.get(run.id);
  assert.equal(final.status, 'limit', JSON.stringify({summary:final.summary,events:final.events.slice(-6)})); assert.ok(!final.applied); assert.equal(final.browserQaPassed, false);
  await assert.rejects(readFile(join(f.source, 'index.html')));
});

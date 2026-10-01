import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { BrowserQaBridge, needsBrowserQa, validateBrowserPlan } from '../browser-qa.mjs';
import { HarnessEngine, runCommand } from '../harness-engine.mjs';
import { browserPlan, milestonePlan, responseFor } from './fixtures/browser-desktop-qa.mjs';
import { validateMilestones } from '../harness-milestones.mjs';

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

test('QA assertions must follow input, reload and keyboard actions', () => {
  for (const action of ['fill', 'reload', 'press']) {
    const plan = structuredClone(qaPlan);
    const operation = plan.checks[1].steps.find((step) => step.action === action);
    plan.checks[1].steps = [...plan.checks[1].steps.filter((step) => step.action !== action), operation];
    assert.throws(() => validateBrowserPlan(plan), /이후의 assertion/);
  }
});

test('QA category errors identify the check, rejected values and supported contract without weakening assertions', () => {
  const unknown = structuredClone(qaPlan); unknown.checks[0].categories = ['empty', 'responsive'];
  assert.throws(() => validateBrowserPlan(unknown), (error) => {
    assert.equal(error.invalidStructuredOutput, true);
    assert.match(error.message, /empty:.*responsive/); assert.match(error.message, /input, save, empty, keyboard/);
    return true;
  });
  const notArray = structuredClone(qaPlan); notArray.checks[0].categories = 'empty';
  assert.throws(() => validateBrowserPlan(notArray), /categories는 배열/);
  const extra = structuredClone(qaPlan);
  extra.checks.push({ id: 'filter-result', categories: [], steps: [{ action: 'count', selector: '.task', value: 0 }] });
  assert.deepEqual(validateBrowserPlan(extra), extra);
  extra.checks.at(-1).steps = [{ action: 'click', selector: '#filter' }];
  assert.throws(() => validateBrowserPlan(extra), /실제 assertion/);
});

test('QA step limit errors include the exact check and count while keeping the same bound', () => {
  const plan = structuredClone(qaPlan);
  plan.checks[0].steps = Array.from({ length: 25 }, () => ({ action: 'visible', selector: '#empty' }));
  assert.throws(() => validateBrowserPlan(plan), (error) => {
    assert.equal(error.invalidStructuredOutput, true); assert.match(error.message, /empty:.*1~24.*25/);
    assert.match(error.message, /초기 입력과 assertion/); return true;
  });
  plan.checks[0].steps.pop(); assert.deepEqual(validateBrowserPlan(plan), plan);
});

test('native QA inspects CSS rendering even when the hidden attribute is overridden', async () => {
  const source = await readFile(new URL('../desktop/browser-qa.mjs', import.meta.url), 'utf8');
  const body = source.match(/const inspect = \(step\) => js\(`([^]*?)`, step\);/)[1];
  const element = { hidden: true, getBoundingClientRect: () => ({ width: 100, height: 30 }) };
  let display = 'grid';
  const inspect = runInNewContext(`(${body})`, { document: { querySelectorAll: () => [element] }, getComputedStyle: () => ({ display, visibility: 'visible' }) });
  assert.equal(inspect({ action: 'hidden', selector: '#empty-state' }).ok, false);
  display = 'none';
  assert.equal(inspect({ action: 'hidden', selector: '#empty-state' }).ok, true);
});

test('packaged desktop fixture preserves QA and milestone contracts across a targeted repair', () => {
  validateBrowserPlan(browserPlan); validateMilestones(milestonePlan);
  const defect = responseFor('이번 회차는 아래 부분 작업만 구현합니다\n{"id":"ui"}');
  const repair = responseFor('이번 회차는 아래 부분 작업만 구현합니다\n{"id":"ui"}\nmobile/save: hidden #empty-state');
  assert.equal(defect.kind, 'ui-defect'); assert.equal(repair.kind, 'repair');
  assert.deepEqual(repair.answer.operations.map(op => op.path), ['styles.css']);
  assert.match(repair.answer.operations[0].content, /empty-state\[hidden\]\{display:none\}/);
  assert.equal(JSON.stringify(repair.answer).includes('qaPlan'), false);
});

test('desktop fixture preserves structured review after MCP context and requests only the read-only Paper guide', () => {
  const suffix = '\n\n연결된 MCP 도구를 필요한 경우에만 사용합니다.';
  const review = responseFor(JSON.stringify({ questions: { qa: {} } }) + suffix);
  assert.equal(review.kind, 'review');
  assert.equal(review.answer.answers.qa.choice, 'pass');
  const plan = '구현 계획과 검증 기준\n실행 가능한 MCP 도구 목록:\n' + JSON.stringify({ serverId: '65f2c2d8-9641-4203-8871-3ee87b52566d', name: 'get_guide' });
  const call = responseFor(plan);
  assert.equal(call.kind, 'paper-guide');
  assert.deepEqual(call.answer.mcpCall, { serverId: '65f2c2d8-9641-4203-8871-3ee87b52566d', toolName: 'get_guide', arguments: { topic: 'paper-mcp-instructions' } });
  assert.equal(responseFor(plan + '\nMCP 도구 실행 결과는 외부 데이터').kind, 'plan');
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
      if (prompt.includes('구현 전에 독립 브라우저 QA 계획')) {
        assert.match(prompt, /\["input","save","empty","keyboard"\]/);
        assert.match(prompt, /categories: \[\]/);
        assert.match(prompt, /새 분류 이름은 허용되지 않습니다/);
        return qaPlan;
      }
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

test('QA recovery routes the last existing attempt only for automatic planners, retaining every review check', async (t) => {
  for (const automatic of [true, false]) await t.test(automatic ? 'automatic planner changes after two rejections' : 'fixed planner is never changed', async (t) => {
    const f = await fixture(t), planners = []; let reviews = 0;
    const base = f.input.roles.planner;
    const engine = new HarnessEngine({ directory: f.directory, verify: async () => ({ code: 0, output: 'PASS' }),
      verifyBrowser: async () => ({ passed: true, checks: [], failures: [] }), invoke: async (selection, prompt) => {
        if (typeof prompt === 'object') {
          const result = { answers: Object.fromEntries(Object.keys(prompt.questions).map(id => [id, { choice: 'pass', reason: 'Fixture evidence' }])) };
          if (prompt.questions.qaContract) {
            assert.deepEqual(Object.keys(prompt.questions), ['qaContract', 'qaInput', 'qaSave', 'qaEmpty', 'qaKeyboard']);
            assert.match(prompt.questions.qaContract.instructions, /not whether unbuilt files already exist/);
            reviews++; if (reviews < 3) result.answers.qaInput = { choice: 'revise' };
          }
          return result;
        }
        if (prompt.includes('구현 계획과 검증 기준')) return 'Implement the website and verify its behavior';
        if (prompt.includes('구현 전에 독립 브라우저 QA 계획')) {
          assert.match(prompt, /가능하면 12단계/); assert.match(prompt, /원래 기능 검사를 생략하지/);
          if (planners.length) assert.match(prompt, /Add the required input actions/);
          planners.push(selection.model); return qaPlan;
        }
        return JSON.stringify({ done: true, summary: 'Implemented', operations: [{ type: 'write', path: 'index.html', content: '<html>verified fixture</html>' }] });
      } });
    const created = await engine.create({ ...f.input, roles: { ...f.input.roles, planner: { ...base, automatic, fallbacks: [
      { ...base, model: 'unavailable', remainingPercent: 0 }, { ...base, model: 'alternative' },
    ] } } });
    await engine.runs.get(created.id).execution; const run = await engine.get(created.id);
    assert.equal(run.status, 'completed', run.summary); assert.equal(reviews, 3);
    assert.deepEqual(planners, automatic ? ['qa', 'qa', 'alternative'] : ['qa', 'qa', 'qa']);
    assert.equal(run.events.filter(e => e.title.startsWith('QA 계획 판정 복구')).length, automatic ? 1 : 0);
    assert.equal(run.roles.worker.model, 'qa'); assert.equal(run.roles.judge.model, 'qa');
    assert.deepEqual(run.qaPlan, qaPlan);
  });
});

test('QA recovery cannot bypass a failed individual category or start implementation after three rejected plans', async (t) => {
  const f = await fixture(t); let reviews = 0, workerCalls = 0;
  const engine = new HarnessEngine({ directory: f.directory, verify: async () => ({ code: 0, output: 'PASS' }),
    verifyBrowser: async () => { throw new Error('No runtime QA before plan acceptance'); }, invoke: async (_selection, prompt) => {
      if (typeof prompt === 'object') {
        const result = { answers: Object.fromEntries(Object.keys(prompt.questions).map(id => [id, { choice: 'pass' }])) };
        if (prompt.questions.qaContract) { reviews++; result.answers.qaSave = { choice: 'uncertain' }; }
        return result;
      }
      if (prompt.includes('구현 계획과 검증 기준')) return 'Plan';
      if (prompt.includes('구현 전에 독립 브라우저 QA 계획')) return qaPlan;
      workerCalls++; throw new Error('No implementation before plan acceptance');
    } });
  const created = await engine.create({ ...f.input, roles: { ...f.input.roles, planner: {
    ...f.input.roles.planner, automatic: true, fallbacks: [{ provider: 'api', model: 'alternative' }],
  } } });
  await engine.runs.get(created.id).execution; const run = await engine.get(created.id);
  assert.equal(run.status, 'failed'); assert.match(run.summary, /restored state/); assert.equal(reviews, 3);
  assert.equal(workerCalls, 0); assert.equal(run.applied, undefined); assert.equal(run.qaPlan, null);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original');
});

test('fixed QA format repair receives the precise oversized check and succeeds without changing the contract', async (t) => {
  const f = await fixture(t); let plans = 0;
  const engine = new HarnessEngine({ directory: f.directory, verify: async () => ({ code: 0, output: 'PASS' }),
    verifyBrowser: async () => ({ passed: true, checks: [], failures: [] }), invoke: async (_selection, prompt) => {
      if (typeof prompt === 'object') return { answers: Object.fromEntries(Object.keys(prompt.questions).map(id => [id, { choice: 'pass' }])) };
      if (prompt.includes('구현 계획과 검증 기준')) return 'Plan';
      if (prompt.includes('구현 전에 독립 브라우저 QA 계획')) {
        plans++;
        if (plans === 1) { const invalid = structuredClone(qaPlan); invalid.checks[0].steps = Array.from({ length: 25 }, () => ({ action: 'visible', selector: '#empty' })); return invalid; }
        assert.match(prompt, /empty:.*1~24.*25/); return qaPlan;
      }
      return JSON.stringify({ done: true, summary: 'Implemented', operations: [{ type: 'write', path: 'index.html', content: '<html>verified fixture</html>' }] });
    } });
  const created = await engine.create(f.input); await engine.runs.get(created.id).execution;
  const run = await engine.get(created.id); assert.equal(run.status, 'completed', run.summary);
  assert.equal(plans, 2); assert.deepEqual(run.qaPlan, qaPlan); assert.equal(run.roles.planner.model, 'qa');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import { BrowserQaBridge, needsBrowserQa, validateBrowserPlan, applyBrowserPlanPatch, BROWSER_QA_EXECUTOR } from '../browser-qa.mjs';
import { HarnessEngine, runCommand, parseHarnessJson } from '../harness-engine.mjs';
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

const focusCheck = (id = 'keyboard-focus') => ({ id, categories: ['keyboard'], steps: [
  { action: 'reset' }, { action: 'press', key: 'Tab' }, { action: 'focus-visible', selector: '#name' },
] });

test('QA patches retain every accepted check, order and selector without mutating either input', () => {
  const base = structuredClone(qaPlan), patch = { addChecks: [focusCheck()], replaceChecks: [], notApplicable: {} };
  const before = structuredClone({ base, patch });
  const result = applyBrowserPlanPatch(base, patch);
  assert.deepEqual(result.checks.slice(0, base.checks.length), base.checks);
  assert.deepEqual(result.checks.at(-1), focusCheck());
  assert.deepEqual({ base, patch }, before);
  result.checks[0].steps[1].selector = '#changed'; result.checks.at(-1).steps[2].selector = '#other';
  assert.deepEqual({ base, patch }, before);
});

test('only the individually rejected QA check may be replaced, preserving its position and categories', () => {
  const replacement = { ...structuredClone(qaPlan.checks[0]), steps: [...qaPlan.checks[0].steps, { action: 'count', selector: '#list .task', value: 0 }] };
  const patch = { replaceChecks: [replacement] };
  assert.throws(() => applyBrowserPlanPatch(qaPlan, patch), /empty:.*실패한 검사만/);
  const result = applyBrowserPlanPatch(qaPlan, patch, ['empty']);
  assert.deepEqual(result.checks, [replacement, qaPlan.checks[1]]);
  assert.throws(() => applyBrowserPlanPatch(qaPlan, { replaceChecks: [{ ...replacement, categories: [] }] }, ['empty']), /분류를 삭제/);
});

test('QA patches reject full rewrites, duplicate IDs, empty changes and malformed arrays as repairable errors', () => {
  for (const patch of [qaPlan, { entry: 'other.html' }, { removeChecks: ['empty'] }, { addChecks: null }, { replaceChecks: {} },
    { addChecks: [focusCheck(), focusCheck()] }, { addChecks: [qaPlan.checks[0]] }, { replaceChecks: [focusCheck('missing')] }, {}, { addChecks: [], replaceChecks: [], notApplicable: {} },
    { replaceChecks: [qaPlan.checks[0]] }, { notApplicable: { responsive: 'No responsive behavior is required.' } },
    { notApplicable: { input: 'Ignore required input behavior.' } }]) {
    assert.throws(() => applyBrowserPlanPatch(qaPlan, patch, ['empty']), error => {
      assert.equal(error.invalidStructuredOutput, true); assert.match(error.message, /QA 보완 오류/); return true;
    });
  }
});

test('QA patches keep the existing assertion, script, count and step limits', () => {
  assert.throws(() => applyBrowserPlanPatch(qaPlan, { replaceChecks: [{ ...qaPlan.checks[1], steps: [{ action: 'visible', selector: '#list' }] }] }, ['input-save']), /입력 이후/);
  const script = focusCheck(); script.steps.push({ action: 'evaluate', script: 'window.accept = true' });
  assert.throws(() => applyBrowserPlanPatch(qaPlan, { addChecks: [script] }), /허용되지 않은/);
  const long = focusCheck(); long.steps = Array.from({ length: 25 }, () => ({ action: 'visible', selector: '#list' }));
  assert.throws(() => applyBrowserPlanPatch(qaPlan, { addChecks: [long] }), /1~24/);
  assert.throws(() => applyBrowserPlanPatch(qaPlan, { addChecks: Array.from({ length: 15 }, (_, i) => focusCheck(`extra-${i}`)) }), /1~16/);
});

test('a not-applicable rationale can be corrected without losing earlier cases', () => {
  const base = { entry: 'index.html', checks: [qaPlan.checks[0]], notApplicable: {
    input: 'No user input is requested on this information page.', save: 'There is no mutable data to persist on this page.', keyboard: 'No interactive controls are requested on this page.',
  } };
  const result = applyBrowserPlanPatch(base, { notApplicable: { save: 'This static information page has no user state or persistence requirement.' } });
  assert.deepEqual(result.checks, base.checks); assert.equal(result.notApplicable.input, base.notApplicable.input);
  assert.throws(() => applyBrowserPlanPatch(base, { notApplicable: { save: 'none' } }), /구체적인 근거/);
});

test('malformed JSON is classified for bounded format repair without accepting prose, arrays or partial objects', () => {
  for (const answer of ['No JSON here', '{"entry":', '[]', 'null']) {
    assert.throws(() => parseHarnessJson(answer), error => {
      assert.equal(error.invalidStructuredOutput, true); assert.match(error.message, /JSON 형식/); return true;
    });
  }
  assert.deepEqual(parseHarnessJson('```json\n{"entry":"index.html"}\n```'), { entry: 'index.html' });
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
  const body = runInNewContext('`' + source.match(/const inspect = \(step\) => js\(`([^]*?)`, step\);/)[1] + '`');
  const element = { hidden: true, getBoundingClientRect: () => ({ width: 100, height: 30 }) };
  let display = 'grid';
  const inspect = runInNewContext(`(${body})`, { document: { querySelectorAll: () => [element] }, getComputedStyle: () => ({ display, visibility: 'visible' }) });
  assert.equal(inspect({ action: 'hidden', selector: '#empty-state' }).ok, false);
  display = 'none';
  assert.equal(inspect({ action: 'hidden', selector: '#empty-state' }).ok, true);
});

test('visible focus is a selector assertion following an actual key press, not an arbitrary script', () => {
  const plan = structuredClone(qaPlan);
  plan.checks.push({ id: 'focus-cue', categories: ['keyboard'], steps: [{ action: 'press', key: 'Tab' }, { action: 'focus-visible', selector: '#add' }] });
  assert.deepEqual(validateBrowserPlan(plan), plan);
  delete plan.checks.at(-1).steps.at(-1).selector;
  assert.throws(() => validateBrowserPlan(plan), /selector/);
  plan.checks.at(-1).steps = [{ action: 'focus-visible', selector: '#add' }, { action: 'press', key: 'Tab' }];
  assert.throws(() => validateBrowserPlan(plan), /키 입력 이후/);
});

test('native visible focus rejects invisible outlines and permanent shadows while accepting keyboard cues', async () => {
  const source = await readFile(new URL('../desktop/browser-qa.mjs', import.meta.url), 'utf8');
  const body = runInNewContext('`' + source.match(/const inspect = \(step\) => js\(`([^]*?)`, step\);/)[1] + '`');
  let keyboard = true, style = { display: 'block', visibility: 'visible', opacity: '1', outlineWidth: '2px', outlineStyle: 'solid', outlineColor: 'rgb(20, 50, 200)', outline: 'rgb(20, 50, 200) solid 2px', boxShadow: 'none' };
  const element = { getBoundingClientRect: () => ({ width: 120, height: 40 }), matches: () => keyboard };
  const document = { querySelectorAll: () => [element], activeElement: element };
  const inspect = runInNewContext(`(${body})`, { document, getComputedStyle: () => style });
  const step = { action: 'focus-visible', selector: '#add', unfocusedBoxShadow: 'none' };
  assert.equal(inspect(step).ok, true);
  keyboard = false; assert.equal(inspect(step).ok, false); keyboard = true;
  document.activeElement = null; assert.equal(inspect(step).ok, false); document.activeElement = element;
  style.outlineColor = 'rgba(20, 50, 200, 0)'; assert.equal(inspect(step).ok, false);
  style.outlineWidth = '0px'; style.boxShadow = 'rgb(20, 50, 200) 0px 0px 0px 3px';
  assert.equal(inspect(step).ok, true);
  assert.equal(inspect({ ...step, unfocusedBoxShadow: style.boxShadow }).ok, false);
  assert.equal(inspect({ ...step, unfocusedBoxShadow: undefined }).ok, false);
  style.boxShadow = 'rgba(20, 50, 200, 0) 0px 0px 0px 3px'; assert.equal(inspect(step).ok, false);
  style.outlineWidth = '2px'; style.outlineColor = 'rgb(20, 50, 200)'; style.opacity = '0'; assert.equal(inspect(step).ok, false);
});

test('native QA catches overflow immediately after a long input even if a later reset removes it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'loopline-native-layout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runId = randomUUID(), workspace = join(directory, 'harness', runId, 'workspace');
  await mkdir(workspace, { recursive: true }); await writeFile(join(workspace, 'index.html'), '<html>fixture</html>');
  const source = await readFile(new URL('../desktop/browser-qa.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export async function verifyBrowser'))
    .replace('export async function verifyBrowser', 'async function verifyBrowser')
    .replace(/const \{ validateBrowserPlan, BROWSER_QA_EXECUTOR \} = await import\([^]*?\);/, 'const { validateBrowserPlan, BROWSER_QA_EXECUTOR } = shared;');
  const windows = [];
  class MockWindow {
    constructor({ width }) {
      windows.push(this); this.width = width; this.destroyed = false;
      const input = { value: '', focus() {}, select() {}, getBoundingClientRect: () => ({ width: 150, height: 40 }) };
      const document = this.document = { documentElement: { scrollWidth: width }, body: { scrollWidth: width, innerText: 'Fixture' }, querySelectorAll: () => [input], querySelector: () => input };
      this.webContents = { session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} }, async clearStorageData() {}, async closeAllConnections() {} },
        setWindowOpenHandler() {}, on() {}, executeJavaScript: async code => runInNewContext(code, { document, innerWidth: width, localStorage: { clear() {} }, sessionStorage: { clear() {} }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) }),
        debugger: { attach() {}, on() {}, async sendCommand(name) { if (name === 'Input.insertText') document.documentElement.scrollWidth = width + 200; } },
        capturePage: async () => ({ toPNG: () => Buffer.from('fixture') }) };
    }
    async loadURL() { this.document.documentElement.scrollWidth = this.width; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const load = new AsyncFunction('shared', 'BrowserWindow', 'createServer', 'once', 'mkdir', 'readFile', 'realpath', 'stat', 'writeFile', 'dirname', 'extname', 'join', 'relative', 'sep', 'randomUUID', source.slice(source.indexOf('const mime'), source.indexOf('export async function')) + body + '\nreturn verifyBrowser;');
  const verify = await load({ validateBrowserPlan, BROWSER_QA_EXECUTOR }, MockWindow, createServer, once, mkdir, readFile, realpath, stat, writeFile, dirname, extname, join, relative, sep, randomUUID);
  const plan = { entry: 'index.html', checks: [
    { id: 'long', categories: ['input'], steps: [{ action: 'reset' }, { action: 'fill', selector: '#input', value: 'Long title' }, { action: 'visible', selector: '#input' }] },
    { id: 'empty', categories: ['empty'], steps: [{ action: 'reset' }, { action: 'visible', selector: '#input' }] },
  ], notApplicable: { save: 'This fixture has no persistence requirement.', keyboard: 'This fixture has no keyboard behavior requirement.' } };
  const result = await verify({ workspace, runId, round: 1, plan }, directory);
  assert.equal(result.passed, false); assert.equal(windows.length, 2);
  for (const viewport of ['desktop', 'mobile']) {
    assert.equal(result.checks.find(c => c.id === 'long-layout' && c.viewport === viewport).passed, false);
    assert.equal(result.checks.find(c => c.id === 'empty-layout' && c.viewport === viewport).passed, true);
    assert.equal(result.checks.find(c => c.id === 'layout' && c.viewport === viewport).passed, true);
  }
  assert.equal(result.screenshots.length, 4); assert.ok(windows.every(w => w.destroyed));
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
      verifyBrowser: async () => ({ passed: true, checks: [{ id: 'empty', passed: true }], failures: [] }), invoke: async (selection, prompt) => {
        if (typeof prompt === 'object') {
          const result = { answers: Object.fromEntries(Object.keys(prompt.questions).map(id => [id, { choice: 'pass', reason: 'Fixture evidence' }])) };
          if (prompt.questions.qaContract) {
            assert.deepEqual(Object.keys(prompt.questions), ['qaContract', 'qaInput', 'qaSave', 'qaEmpty', 'qaKeyboard', ...prompt.state.qaPlan.checks.map(check => `qaCheck_${check.id}`)]);
            assert.match(prompt.questions.qaContract.instructions, /not whether unbuilt files already exist/);
            assert.deepEqual(prompt.state.executor, BROWSER_QA_EXECUTOR);
            assert.match(prompt.questions.qaContract.instructions, /executor.fixedChecks and viewports/);
            assert.match(prompt.questions.qaKeyboard.instructions, /focused alone cannot establish/);
            reviews++; if (reviews < 3) result.answers.qaInput = { choice: 'revise' };
          }
          return result;
        }
        if (prompt.includes('구현 계획과 검증 기준')) return 'Implement the website and verify its behavior';
        if (prompt.includes('구현 전에 독립 브라우저 QA 계획')) {
          assert.match(prompt, /가능하면 12단계/); assert.match(prompt, /원래 기능 검사를 생략하지/);
          if (!planners.length) { assert.match(prompt, /focus-visible assertion/); assert.match(prompt, /각 검사 직후와 최종 상태/); }
          else { assert.match(prompt, /Add the required input actions/); assert.match(prompt, /보존할 기존 QA 계획/); assert.match(prompt, /교체 허용 검사 ID: \[\]/); }
          planners.push(selection.model);
          return planners.length === 1 ? qaPlan : { addChecks: [focusCheck(`extra-${planners.length}`)] };
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
    assert.deepEqual(run.qaPlan.checks.slice(0, 2), qaPlan.checks);
    assert.deepEqual(run.qaPlan.checks.slice(2), [focusCheck('extra-2'), focusCheck('extra-3')]);
  });
});

test('QA recovery cannot bypass a failed individual category or start implementation after three rejected plans', async (t) => {
  const f = await fixture(t); let reviews = 0, workerCalls = 0, plans = 0;
  const engine = new HarnessEngine({ directory: f.directory, verify: async () => ({ code: 0, output: 'PASS' }),
    verifyBrowser: async () => { throw new Error('No runtime QA before plan acceptance'); }, invoke: async (_selection, prompt) => {
      if (typeof prompt === 'object') {
        const result = { answers: Object.fromEntries(Object.keys(prompt.questions).map(id => [id, { choice: 'pass' }])) };
        if (prompt.questions.qaContract) { reviews++; result.answers.qaSave = { choice: 'uncertain' }; }
        return result;
      }
      if (prompt.includes('구현 계획과 검증 기준')) return 'Plan';
      if (prompt.includes('구현 전에 독립 브라우저 QA 계획')) return ++plans === 1 ? qaPlan : { addChecks: [focusCheck(`extra-${plans}`)] };
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

test('QA delta repair blocks changes to accepted cases and recovers with only the missing check', async (t) => {
  const f = await fixture(t); let plans = 0, reviews = 0;
  const engine = new HarnessEngine({ directory: f.directory, verify: async () => ({ code: 0, output: 'PASS' }),
    verifyBrowser: async (input) => {
      assert.deepEqual(input.plan.checks.slice(0, 2), qaPlan.checks);
      assert.deepEqual(input.plan.checks.at(-1), focusCheck());
      return { passed: true, checks: input.plan.checks.map(({ id }) => ({ id, passed: true })), failures: [] };
    }, invoke: async (_selection, prompt) => {
      if (typeof prompt === 'object') {
        const result = { answers: Object.fromEntries(Object.keys(prompt.questions).map(id => [id, { choice: 'pass', reason: 'Fixture evidence' }])) };
        if (prompt.questions.qaContract && ++reviews === 1) result.answers.qaKeyboard = { choice: 'revise', reason: 'Add visible keyboard focus.' };
        return result;
      }
      if (prompt.includes('구현 계획과 검증 기준')) return 'Plan';
      if (prompt.includes('구현 전에 독립 브라우저 QA 계획')) {
        plans++;
        if (plans === 1) return qaPlan;
        assert.match(prompt, /교체 허용 검사 ID: \[\]/);
        assert.ok(prompt.includes(JSON.stringify(qaPlan)));
        if (plans === 2) return { replaceChecks: [{ ...qaPlan.checks[0], steps: [{ action: 'count', selector: '#list', value: 0 }] }] };
        assert.match(prompt, /직전 응답의 형식 오류:.*empty:.*실패한 검사만/);
        return { addChecks: [focusCheck()], replaceChecks: [] };
      }
      return JSON.stringify({ done: true, summary: 'Implemented', operations: [{ type: 'write', path: 'index.html', content: '<html>fixture</html>' }] });
    } });
  const created = await engine.create(f.input); await engine.runs.get(created.id).execution;
  const run = await engine.get(created.id);
  assert.equal(run.status, 'completed', run.summary); assert.equal(run.applied, true);
  assert.equal(plans, 3); assert.equal(reviews, 2);
  assert.equal(run.events.filter(e => e.title.startsWith('독립 QA 부분 보완')).length, 1);
  assert.deepEqual(run.qaPlan.checks, [...qaPlan.checks, focusCheck()]);
});

test('a rejected individual QA case can be repaired without touching accepted cases', async (t) => {
  const f = await fixture(t); let plans = 0, reviews = 0;
  const corrected = { ...qaPlan.checks[0], steps: [...qaPlan.checks[0].steps, { action: 'count', selector: '#list .task', value: 0 }] };
  const engine = new HarnessEngine({ directory: f.directory, verify: async () => ({ code: 0, output: 'PASS' }),
    verifyBrowser: async (input) => ({ passed: true, checks: input.plan.checks.map(({ id }) => ({ id, passed: true })), failures: [] }), invoke: async (_selection, prompt) => {
      if (typeof prompt === 'object') {
        const result = { answers: Object.fromEntries(Object.keys(prompt.questions).map(id => [id, { choice: 'pass', reason: 'Fixture evidence' }])) };
        if (prompt.questions.qaContract && ++reviews === 1) result.answers.qaCheck_empty = { choice: 'revise', reason: 'Also assert there are zero task rows.' };
        return result;
      }
      if (prompt.includes('구현 계획과 검증 기준')) return 'Plan';
      if (prompt.includes('구현 전에 독립 브라우저 QA 계획')) {
        if (++plans === 1) return qaPlan;
        assert.match(prompt, /교체 허용 검사 ID: \["empty"\]/);
        return { replaceChecks: [corrected] };
      }
      return JSON.stringify({ done: true, summary: 'Implemented', operations: [{ type: 'write', path: 'index.html', content: '<html>fixture</html>' }] });
    } });
  const created = await engine.create(f.input); await engine.runs.get(created.id).execution;
  const run = await engine.get(created.id);
  assert.equal(run.status, 'completed', run.summary); assert.equal(plans, 2); assert.equal(reviews, 2);
  assert.deepEqual(run.qaPlan.checks, [corrected, qaPlan.checks[1]]);
});

test('unchanged QA patches exhaust format repair without repeating review or starting implementation', async (t) => {
  const f = await fixture(t); let plans = 0, reviews = 0, workers = 0;
  const engine = new HarnessEngine({ directory: f.directory, verify: async () => assert.fail('No verification for a rejected plan'),
    verifyBrowser: async () => assert.fail('No browser QA for a rejected plan'), invoke: async (_selection, prompt) => {
      if (typeof prompt === 'object') {
        const result = { answers: Object.fromEntries(Object.keys(prompt.questions).map(id => [id, { choice: 'pass' }])) };
        if (prompt.questions.qaContract) { reviews++; result.answers.qaKeyboard = { choice: 'revise' }; }
        return result;
      }
      if (prompt.includes('구현 계획과 검증 기준')) return 'Plan';
      if (prompt.includes('구현 전에 독립 브라우저 QA 계획')) return ++plans === 1 ? qaPlan : { addChecks: [], replaceChecks: [] };
      workers++; assert.fail('No implementation for unchanged rejected QA');
    } });
  const created = await engine.create(f.input); await engine.runs.get(created.id).execution;
  const run = await engine.get(created.id);
  assert.equal(run.status, 'failed'); assert.match(run.summary, /보완 내용이 없습니다/);
  assert.equal(plans, 3); assert.equal(reviews, 1); assert.equal(workers, 0);
  assert.equal(run.qaPlan, null); assert.notEqual(run.applied, true);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original');
});

test('fixed QA format repair receives the precise oversized check and succeeds without changing the contract', async (t) => {
  const f = await fixture(t); let plans = 0;
  const engine = new HarnessEngine({ directory: f.directory, verify: async () => ({ code: 0, output: 'PASS' }),
    verifyBrowser: async () => ({ passed: true, checks: [{ id: 'empty', passed: true }], failures: [] }), invoke: async (_selection, prompt) => {
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

test('malformed QA JSON enters format repair for fixed models or the saved fallback for automatic models', async (t) => {
  for (const automatic of [false, true]) await t.test(automatic ? 'saved fallback' : 'fixed model repair', async (t) => {
    const f = await fixture(t), plans = [];
    const engine = new HarnessEngine({ directory: f.directory, verify: async () => ({ code: 0, output: 'PASS' }),
      verifyBrowser: async () => ({ passed: true, checks: [{ id: 'empty', passed: true }], failures: [] }), invoke: async (selection, prompt) => {
        if (typeof prompt === 'object') return { answers: Object.fromEntries(Object.keys(prompt.questions).map(id => [id, { choice: 'pass' }])) };
        if (prompt.includes('구현 계획과 검증 기준')) return 'Implement the website';
        if (prompt.includes('구현 전에 독립 브라우저 QA 계획')) {
          plans.push(selection.model);
          if (plans.length === 1) return '{"entry":"index.html","checks":';
          if (!automatic) assert.match(prompt, /직전 응답의 형식 오류:.*JSON 형식/);
          return JSON.stringify(qaPlan);
        }
        return JSON.stringify({ done: true, summary: 'Implemented', operations: [{ type: 'write', path: 'index.html', content: '<html>verified fixture</html>' }] });
      } });
    const created = await engine.create({ ...f.input, roles: { ...f.input.roles, planner: { ...f.input.roles.planner, automatic,
      ...(automatic ? { fallbacks: [{ provider: 'api', model: 'alternative' }] } : {}) } } });
    await engine.runs.get(created.id).execution; const run = await engine.get(created.id);
    assert.equal(run.status, 'completed', run.summary); assert.deepEqual(run.qaPlan, qaPlan);
    assert.deepEqual(plans, automatic ? ['qa', 'alternative'] : ['qa', 'qa']);
    assert.equal(run.events.filter(e => e.title.startsWith('응답 형식 보완')).length, automatic ? 0 : 1);
    assert.equal(run.events.filter(e => e.title.startsWith('응답 형식 오류 · 대체 모델 시도')).length, automatic ? 1 : 0);
  });
});

test('repeated malformed QA JSON exhausts the existing repair bound and never starts implementation', async (t) => {
  const f = await fixture(t); let plans = 0, workerCalls = 0;
  const engine = new HarnessEngine({ directory: f.directory, verify: async () => assert.fail('No verification before a valid contract'),
    verifyBrowser: async () => assert.fail('No browser QA before implementation'), invoke: async (_selection, prompt) => {
      if (typeof prompt === 'object') return { answers: Object.fromEntries(Object.keys(prompt.questions).map(id => [id, { choice: 'pass' }])) };
      if (prompt.includes('구현 계획과 검증 기준')) return 'Plan';
      if (prompt.includes('구현 전에 독립 브라우저 QA 계획')) { plans++; return 'Still not JSON'; }
      workerCalls++; assert.fail('Invalid QA must not reach implementation');
    } });
  const created = await engine.create(f.input); await engine.runs.get(created.id).execution;
  const run = await engine.get(created.id);
  assert.equal(run.status, 'failed'); assert.equal(plans, 2); assert.equal(workerCalls, 0);
  assert.equal(run.qaPlan, null); assert.notEqual(run.applied, true);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original');
});

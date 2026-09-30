import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { HarnessEngine, applyWorkspaceOperations, parseHarnessJson, runCommand, verifyWorkspace } from '../harness-engine.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'loopline-harness-test-'));
  const source = join(directory, 'source'), data = join(directory, 'data');
  await mkdir(source); await mkdir(data);
  const git = async (...args) => {
    const result = await runCommand('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], { cwd: source });
    assert.equal(result.code, 0, result.error); return result.output;
  };
  await git('init'); await writeFile(join(source, 'file.txt'), 'original\n');
  await git('add', '.'); await git('commit', '-m', 'fixture');
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const selection = { provider: 'api', model: 'fixture-model', connectionId: 'fixture' };
  return { source, data, directory, git, input: { task: 'Update file.txt', workspace: source, verifyCommand: 'test -f file.txt', rounds: 2,
    roles: { planner: selection, worker: selection, judge: { ...selection, model: 'jev-fixture' } } } };
}
async function settled(engine, id) {
  await engine.runs.get(id).execution;
  return engine.get(id);
}
const promptText = (prompt) => typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
const hasText = (prompt, value) => promptText(prompt).includes(value);
const startsWithText = (prompt, value) => typeof prompt === 'string' && prompt.startsWith(value);
const isJudgementPrompt = (prompt) => Boolean(prompt && typeof prompt === 'object' && prompt.questions && prompt.state);
function judgementResponse(prompt, decision = 'complete', reason = '') {
  const choice = decision === 'complete' ? 'pass' : 'revise';
  return JSON.stringify({ answers: Object.fromEntries(Object.keys(prompt.questions).map((id) => [id, {
    choice, reason: reason || (choice === 'pass' ? '검증 근거가 기준을 충족합니다.' : '기준을 충족하지 못한 부분을 수정해야 합니다.'),
  }])) });
}
function modelScript(judge) {
  let steps = 0;
  return async (_selection, prompt) => {
    if (isJudgementPrompt(prompt)) {
      const verdict = await judge();
      return verdict?.answers ? verdict : judgementResponse(prompt, verdict?.decision, verdict?.feedback);
    }
    if (startsWithText(prompt, '새 프로젝트의 작업 폴더')) return JSON.stringify({ folderName: 'generated-project', reason: 'Goal-specific folder' });
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Read, update, verify.';
    steps++;
    if (steps % 3 === 1) return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
    if (steps % 3 === 2) return JSON.stringify({ operations: [{ type: 'write', path: 'file.txt', content: `updated ${Math.ceil(steps / 3)}\n` }] });
    return JSON.stringify({ done: true, summary: 'Updated file.txt' });
  };
}
const pass = async () => ({ code: 0, output: 'PASS', error: '' });
const complete = () => ({ decision: 'complete', summary: 'Verified', feedback: '' });

test('a reported zero-token budget skips to the next saved planner and judge priorities', async (t) => {
  const f = await fixture(t), plannerCalls = [];
  const primary = { ...f.input.roles.planner, fallbacks: [
    { ...f.input.roles.planner, model: 'planner-priority-1', label: 'Planner priority 1' },
    { ...f.input.roles.planner, model: 'planner-priority-2', label: 'Planner priority 2' },
  ] };
  const script = modelScript(complete);
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt, instructions, signal, onSignal) => {
    if (startsWithText(prompt, '검증 방법을')) {
      plannerCalls.push(selection.model);
      if (plannerCalls.length === 1) {
        onSignal({ type: 'budget', remainingTokens: 0, source: 'QA response header' });
        return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
      }
      return JSON.stringify({ verifyCommand: 'test -f file.txt', reason: 'Check the implemented file.' });
    }
    return script(selection, prompt, instructions, signal, onSignal);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, roles: { ...f.input.roles, planner: primary }, verifyCommand: undefined })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.deepEqual(plannerCalls, ['fixture-model', 'planner-priority-1']);
  assert.equal(run.stageModels.planner.id, 'planner-priority-1');
  assert.ok(run.events.some((event) => event.title.includes('모델 한도 확인') && event.detail.includes('남은 토큰 0')));
  assert.ok(run.events.some((event) => event.title.includes('우선순위 모델 전환') && event.model?.id === 'planner-priority-1'));
});

test('a temporary provider failure switches to the next configured model and completes the task', async (t) => {
  const f = await fixture(t); let primaryFailed = false;
  const planner = { ...f.input.roles.planner, fallbacks: [{ ...f.input.roles.planner, model: 'planner-backup' }] };
  const script = modelScript(complete);
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt, ...rest) => {
    if (!primaryFailed && selection.model === 'fixture-model' && hasText(prompt, '구현 계획과 검증 기준')) {
      primaryFailed = true;
      throw Object.assign(new Error('API unavailable (HTTP 503)'), { remoteStatus: 503 });
    }
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, roles: { ...f.input.roles, planner } })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(run.stageModels.planner.id, 'planner-backup');
  assert.ok(run.events.some((event) => event.title.includes('모델 일시 오류') && event.model?.id === 'fixture-model'));
});

test('a Korean Codex request timeout switches to the next saved worker model', async (t) => {
  const f = await fixture(t), script = modelScript(complete), workerModels = [];
  let timedOut = false;
  const worker = { ...f.input.roles.worker, model: 'worker-primary', label: 'Primary worker', fallbacks: [
    { ...f.input.roles.worker, model: 'worker-fallback', label: 'Fallback worker' },
  ] };
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt, ...rest) => {
    if (hasText(prompt, '최근 도구 결과:')) {
      workerModels.push(selection.model);
      if (selection.model === 'worker-primary' && !timedOut) {
        timedOut = true;
        throw new Error('요청 시간이 초과되었습니다.');
      }
    }
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, roles: { ...f.input.roles, worker } })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(run.stageModels.worker.id, 'worker-fallback');
  assert.deepEqual(workerModels.slice(0, 2), ['worker-primary', 'worker-fallback']);
  assert.ok(run.events.some((event) => event.title.includes('모델 일시 오류') && event.model?.id === 'worker-primary'));
  assert.ok(run.events.some((event) => event.title.includes('우선순위 모델 전환') && event.model?.id === 'worker-fallback'));
});

test('HTTP 429 fails over in the saved order but authentication errors do not', async (t) => {
  const f = await fixture(t), plannerCalls = [];
  const primary = { ...f.input.roles.planner, fallbacks: [
    { ...f.input.roles.planner, model: 'planner-priority-1', label: 'Planner priority 1' },
    { ...f.input.roles.planner, model: 'planner-priority-2', label: 'Planner priority 2' },
  ] };
  const script = modelScript(complete);
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt, ...rest) => {
    if (hasText(prompt, '구현 계획과 검증 기준')) {
      plannerCalls.push(selection.model);
      if (selection.model !== 'planner-priority-2') throw Object.assign(new Error('API rate limit reached'), { remoteStatus: 429 });
    }
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, roles: {
    ...f.input.roles, planner: primary,
    worker: { ...f.input.roles.worker, fallbacks: primary.fallbacks },
  } })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.deepEqual(plannerCalls, ['fixture-model', 'planner-priority-1', 'planner-priority-2']);
  assert.equal(run.stageModels.planner.id, 'planner-priority-2');
  assert.equal(run.events.filter((event) => event.title.includes('한도 초과')).length, 2);

  const g = await fixture(t), attempted = [];
  const fatalEngine = new HarnessEngine({ directory: g.data, invoke: async (selection, prompt) => {
    if (hasText(prompt, '구현 계획과 검증 기준')) {
      attempted.push(selection.model);
      throw Object.assign(new Error('API key invalid'), { remoteStatus: 401 });
    }
    return script(selection, prompt);
  } });
  const failed = await settled(fatalEngine, (await fatalEngine.create({ ...g.input, roles: { ...g.input.roles, planner: primary } })).id);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(attempted, ['fixture-model']);
});

test('Jev quota exhaustion routes every subsequent judgement to the saved general model', async (t) => {
  const f = await fixture(t), calls = [];
  const script = modelScript(complete);
  const judge = { provider: 'api', model: 'jev-primary', label: 'Jev', connectionId: 'jev', decisionOnly: true,
    fallbacks: [{ provider: 'api', model: 'judge-priority-1', label: 'General judge', connectionId: 'general' }] };
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt, ...rest) => {
    if (isJudgementPrompt(prompt)) {
      calls.push(selection.model);
      if (selection.model === 'jev-primary') throw Object.assign(new Error('Jev rate limit reached'), { remoteStatus: 429 });
      return judgementResponse(prompt);
    }
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, roles: { ...f.input.roles, judge } })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(calls[0], 'jev-primary');
  assert.ok(calls.slice(1).length > 0 && calls.slice(1).every((model) => model === 'judge-priority-1'));
  assert.equal(run.stageModels.judge.id, 'judge-priority-1');
  assert.ok(run.events.some((event) => event.title.includes('우선순위 모델 전환') && event.model?.id === 'judge-priority-1'));
});

test('round feedback reaches worker, dirty user files survive and accepted patch applies automatically', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'user-note.txt'), 'untracked user data');
  await writeFile(join(f.source, 'file.txt'), 'user edit\n');
  let judgments = 0;
  const invoke = modelScript(() => ++judgments === 1 ? { decision: 'revise', summary: 'Needs another pass', feedback: 'second-pass-feedback' } : complete());
  let receivedFeedback = false;
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (...args) => { if (hasText(args[1], 'second-pass-feedback')) receivedFeedback = true; return invoke(...args); } });
  const created = await engine.create(f.input);
  const run = await settled(engine, created.id);
  assert.equal(run.status, 'completed', run.summary); assert.equal(run.round, 2); assert.equal(run.applied, true);
  assert.equal(receivedFeedback, true);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'updated 2\n');
  assert.equal(await readFile(join(f.source, 'user-note.txt'), 'utf8'), 'untracked user data');
  assert.match(await engine.patch(run.id), /user edit/);
  assert.ok(!run.events.some((event) => event.status === 'running'));
});

test('worker combines the final file operation and completion to reduce model calls', async (t) => {
  async function runWorker(combineCompletion) {
    const f = await fixture(t); let workerCalls = 0;
    const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (_selection, prompt) => {
      if (hasText(prompt, '구현 계획과 검증 기준')) return 'Read and update file.txt.';
      if (isJudgementPrompt(prompt)) return judgementResponse(prompt);
      workerCalls++;
      if (workerCalls === 1) return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
      const operation = { type: 'edit', path: 'file.txt', oldText: 'original\n', newText: 'updated\n' };
      if (workerCalls === 2 && combineCompletion) return JSON.stringify({ operations: [operation], done: true, summary: 'Updated file.txt.' });
      if (workerCalls === 2) return JSON.stringify({ operations: [operation] });
      return JSON.stringify({ done: true, summary: 'Updated file.txt.' });
    } });
    const run = await settled(engine, (await engine.create({ ...f.input, rounds: 1 })).id);
    return { run, workerCalls, source: f.source };
  }

  const separate = await runWorker(false);
  const combined = await runWorker(true);
  assert.equal(separate.run.status, 'completed', separate.run.summary);
  assert.equal(combined.run.status, 'completed', combined.run.summary);
  assert.equal(separate.workerCalls, 3);
  assert.equal(combined.workerCalls, 2);
  assert.equal(await readFile(join(separate.source, 'file.txt'), 'utf8'), 'updated\n');
  assert.equal(await readFile(join(combined.source, 'file.txt'), 'utf8'), 'updated\n');
});

test('visual interface tasks receive design guidance while CLI tasks keep their existing prompts', async (t) => {
  async function runTask(task) {
    const f = await fixture(t), script = modelScript(complete);
    const captured = { plan: '', worker: '', judge: null };
    const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt, ...rest) => {
      if (startsWithText(prompt, '목표:')) captured.plan = prompt;
      if (hasText(prompt, '최근 도구 결과:')) captured.worker = prompt;
      if (isJudgementPrompt(prompt)) captured.judge = prompt;
      return script(selection, prompt, ...rest);
    } });
    const run = await settled(engine, (await engine.create({ ...f.input, task, rounds: 1 })).id);
    assert.equal(run.status, 'completed', run.summary);
    return captured;
  }

  const website = await runTask('한국어 웹사이트 작업 관리 대시보드를 제작합니다.');
  assert.match(website.plan, /디자인 브리프/);
  assert.match(website.plan, /반응형 변화/);
  assert.match(website.worker, /웹 UI 작업 기준/);
  assert.match(website.worker, /시각 위계/);
  assert.ok(Object.hasOwn(website.judge.questions, 'visualDesign'));

  const cli = await runTask('file.txt를 읽고 검증하는 독립형 CLI 유틸리티를 제작합니다.');
  assert.doesNotMatch(cli.plan, /디자인 브리프/);
  assert.doesNotMatch(cli.worker, /웹 UI 작업 기준/);
  assert.ok(!Object.hasOwn(cli.judge.questions, 'visualDesign'));
});

test('worker context replaces an edited file with its latest contents', async (t) => {
  const f = await fixture(t);
  const previous = 'ORIGINAL_CONTEXT_SENTINEL\n', current = 'CURRENT_CONTEXT_SENTINEL\n';
  await writeFile(join(f.source, 'file.txt'), previous);
  let workerCalls = 0, latestPrompt = '';
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (_selection, prompt) => {
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Read and update file.txt.';
    if (isJudgementPrompt(prompt)) return judgementResponse(prompt);
    workerCalls++;
    if (workerCalls === 1) return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
    if (workerCalls === 2) return JSON.stringify({ operations: [{ type: 'edit', path: 'file.txt', oldText: previous, newText: current }] });
    latestPrompt = prompt;
    return JSON.stringify({ done: true, summary: 'Updated file.txt.' });
  } });

  const run = await settled(engine, (await engine.create({ ...f.input, rounds: 1 })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.match(latestPrompt, new RegExp(current.trim()));
  assert.doesNotMatch(latestPrompt, new RegExp(previous.trim()));
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), current);
});

test('worker context sends one current copy when a file is read repeatedly', async (t) => {
  const f = await fixture(t);
  const content = `REPEATED_READ_SENTINEL\n${'x'.repeat(12_000)}`;
  await writeFile(join(f.source, 'file.txt'), content);
  let workerCalls = 0, promptAfterRepeatedRead = '';
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (_selection, prompt) => {
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Read file.txt.';
    if (isJudgementPrompt(prompt)) return judgementResponse(prompt);
    workerCalls++;
    if (workerCalls < 3) return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
    promptAfterRepeatedRead = prompt;
    return JSON.stringify({ done: true, summary: 'Read file.txt once per current state.' });
  } });

  const run = await settled(engine, (await engine.create({ ...f.input, rounds: 1 })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(promptAfterRepeatedRead.split('REPEATED_READ_SENTINEL').length - 1, 1);
  assert.ok(promptAfterRepeatedRead.length < content.length * 1.6, `prompt was ${promptAfterRepeatedRead.length} chars for ${content.length} chars of file content`);
});

test('a failed batched final operation does not count as worker completion', async (t) => {
  const f = await fixture(t); let workerCalls = 0, receivedCurrentFile = false;
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (_selection, prompt) => {
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Read and update file.txt.';
    if (isJudgementPrompt(prompt)) return judgementResponse(prompt);
    workerCalls++;
    if (workerCalls === 1) return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
    if (workerCalls === 2) return JSON.stringify({
      operations: [{ type: 'edit', path: 'file.txt', oldText: 'stale text', newText: 'updated\n' }],
      done: true,
      summary: 'Updated file.txt.',
    });
    receivedCurrentFile = hasText(prompt, '최신 파일 내용입니다') && hasText(prompt, 'original\n');
    return JSON.stringify({ operations: [{ type: 'edit', path: 'file.txt', oldText: 'original\n', newText: 'updated\n' }], done: true, summary: 'Updated file.txt.' });
  } });

  const run = await settled(engine, (await engine.create({ ...f.input, rounds: 1 })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(workerCalls, 3);
  assert.equal(receivedCurrentFile, true);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'updated\n');
});

test('failed verification cannot be overridden by a complete verdict', async (t) => {
  const f = await fixture(t);
  const engine = new HarnessEngine({ directory: f.data, invoke: modelScript(complete), verify: async () => ({ code: 1, output: '', error: 'FAIL' }) });
  const run = await settled(engine, (await engine.create({ ...f.input, rounds: 1 })).id);
  assert.equal(run.status, 'limit'); assert.equal(run.applied, undefined);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
});

test('malformed judge reply fails closed and retains patch', async (t) => {
  const f = await fixture(t), invoke = modelScript(complete);
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: (...args) => isJudgementPrompt(args[1]) ? 'Looks good!' : invoke(...args) });
  const run = await settled(engine, (await engine.create(f.input)).id);
  assert.equal(run.status, 'failed'); assert.equal(run.patchAvailable, true);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
});

test('source changes during the run are preserved without automatic overwrite', async (t) => {
  const f = await fixture(t);
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: modelScript(async () => {
    await writeFile(join(f.source, 'file.txt'), 'concurrent user edit\n'); return complete();
  }) });
  const run = await settled(engine, (await engine.create(f.input)).id);
  assert.equal(run.status, 'failed'); assert.match(run.summary, /원본 프로젝트가 변경/);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'concurrent user edit\n');
  assert.ok(await engine.patch(run.id));
});

test('stop cancels current model call and never starts worker or verification', async (t) => {
  const f = await fixture(t); let started; const ready = new Promise((resolve) => { started = resolve; }); let calls = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: () => assert.fail('Unexpected verification'), invoke: (_model, _prompt, _instructions, signal) => {
    calls++; started(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const run = await engine.create(f.input); await ready; await engine.stop(run.id);
  const result = await settled(engine, run.id);
  assert.equal(result.status, 'stopped'); assert.equal(calls, 1);
  assert.ok(result.events.every((event) => event.status !== 'running'));
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
});

test('workspace tools reject traversal, git metadata and symlinks', async (t) => {
  const f = await fixture(t);
  await symlink(f.data, join(f.source, 'outside'));
  for (const path of ['../escape', '/tmp/escape', '.GIT/config', 'outside/escape']) {
    await assert.rejects(applyWorkspaceOperations(f.source, [{ type: 'write', path, content: 'bad' }]));
  }
  await assert.rejects(applyWorkspaceOperations(f.source, [{ type: 'edit', path: 'file.txt', oldText: 'missing', newText: 'bad' }]));
  await applyWorkspaceOperations(f.source, [{ type: 'edit', path: 'file.txt', oldText: 'original', newText: 'updated' }]);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'updated\n');
  assert.throws(() => parseHarnessJson('prefix {"decision":"complete"}'));
});

test('only one run per source can run at a time', async (t) => {
  const f = await fixture(t); let started; const ready = new Promise((resolve) => { started = resolve; });
  const engine = new HarnessEngine({ directory: f.data, invoke: (_model, _prompt, _instructions, signal) => {
    started(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const run = await engine.create(f.input); await ready;
  await assert.rejects(engine.create(f.input), /이미 Harness/); await engine.stop(run.id); await settled(engine, run.id);
});

test('macOS verification allows workspace writes and blocks writes outside the workspace', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = await fixture(t); const runtime = join(f.directory, 'runtime'); await mkdir(runtime);
  const good = await verifyWorkspace(f.source, 'printf success > verified.txt && cat verified.txt', runtime, new AbortController().signal);
  assert.equal(good.code, 0, good.error); assert.equal(good.output, 'success');
  const bad = await verifyWorkspace(f.source, `printf bad > '${join(f.directory, 'outside.txt')}'`, runtime, new AbortController().signal);
  assert.notEqual(bad.code, 0);
});

test('review-only mode preserves original and passes root instructions to every role', async (t) => {
  const f = await fixture(t); await writeFile(join(f.source, 'AGENTS.md'), 'Use the project convention.');
  const invoke = modelScript(complete); const received = [];
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: (...args) => { received.push(args[2]); return invoke(...args); } });
  const run = await settled(engine, (await engine.create({ ...f.input, autoApply: false })).id);
  assert.equal(run.status, 'reviewed'); assert.ok(run.patchAvailable);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
  assert.ok(received.every((value) => value.includes('Use the project convention.')));
  const restored = await new HarnessEngine({ directory: f.data, invoke: () => assert.fail('Must not restart') }).get(run.id);
  assert.equal(restored.status, 'reviewed'); assert.equal(restored.events.length, run.events.length);
});

test('identical AGENTS.md and CLAUDE.md instructions are delivered once per model call', async (t) => {
  const f = await fixture(t); const shared = 'Follow the same project rules in every stage.';
  await writeFile(join(f.source, 'AGENTS.md'), `${shared}\n`);
  await writeFile(join(f.source, 'CLAUDE.md'), `${shared}\n`);
  const script = modelScript(complete), delivered = [];
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: (...args) => {
    delivered.push(args[2]); return script(...args);
  } });
  const run = await settled(engine, (await engine.create(f.input)).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.ok(delivered.length > 0);
  for (const instructions of delivered) {
    assert.equal(instructions.split(shared).length - 1, 1);
    assert.match(instructions, /AGENTS\.md \/ CLAUDE\.md \(내용 동일 \/ identical content\)/);
  }
});

test('automatic verification command is reused after a passing check requests another implementation round', async (t) => {
  const f = await fixture(t); const script = modelScript(complete);
  let verificationPlans = 0, reviews = 0, verifications = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: async () => { verifications++; return pass(); }, invoke: async (selection, prompt, ...rest) => {
    if (startsWithText(prompt, '검증 방법을')) {
      verificationPlans++;
      return JSON.stringify({ verifyCommand: 'test -f file.txt', reason: 'Check the requested output exists.' });
    }
    if (isJudgementPrompt(prompt)) {
      if (prompt.questions.command) return judgementResponse(prompt);
      reviews++;
      return judgementResponse(prompt, reviews === 1 ? 'revise' : 'complete', reviews === 1 ? 'Continue the requested work.' : '');
    }
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, verifyCommand: undefined })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(run.round, 2);
  assert.equal(verificationPlans, 1);
  assert.equal(verifications, 2);
  assert.equal(run.events.filter((event) => event.title.startsWith('검증 자동 구성')).length, 1);
});

test('automatic verification keeps the same command after a test assertion fails', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  let verificationPlans = 0, reviews = 0, verifications = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: async (_workspace, command) => {
    assert.equal(command, 'node --test'); verifications++;
    return verifications === 1 ? { code: 1, output: 'AssertionError: expected updated output', error: '' } : pass();
  }, invoke: async (selection, prompt, ...rest) => {
    if (startsWithText(prompt, '검증 방법을')) {
      verificationPlans++;
      return JSON.stringify({ verifyCommand: 'node --test', reason: 'Run the project tests.' });
    }
    if (isJudgementPrompt(prompt)) {
      if (prompt.questions.command) return judgementResponse(prompt);
      reviews++;
      return judgementResponse(prompt, reviews === 1 ? 'revise' : 'complete', reviews === 1 ? 'Fix the failing behavior.' : '');
    }
    return script(selection, prompt, ...rest);
  } });

  const run = await settled(engine, (await engine.create({ ...f.input, verifyCommand: undefined })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(run.round, 2);
  assert.equal(verificationPlans, 1);
  assert.equal(verifications, 2);
  assert.equal(run.events.filter((event) => event.title.startsWith('검증 자동 구성')).length, 1);
});

test('automatic verification can choose another command when the selected command is unavailable', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  let verificationPlans = 0, reviews = 0, verifications = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: async (_workspace, command) => {
    verifications++;
    if (verifications === 1) {
      assert.equal(command, 'missing-check');
      return { code: 127, output: 'sh: missing-check: command not found', error: '' };
    }
    assert.equal(command, 'test -f file.txt');
    return pass();
  }, invoke: async (selection, prompt, ...rest) => {
    if (startsWithText(prompt, '검증 방법을')) {
      verificationPlans++;
      return JSON.stringify({
        verifyCommand: verificationPlans === 1 ? 'missing-check' : 'test -f file.txt',
        reason: 'Use the available project check.',
      });
    }
    if (isJudgementPrompt(prompt)) {
      if (prompt.questions.command) return judgementResponse(prompt);
      reviews++;
      return judgementResponse(prompt, reviews === 1 ? 'revise' : 'complete', reviews === 1 ? 'Continue after selecting a runnable check.' : '');
    }
    return script(selection, prompt, ...rest);
  } });

  const run = await settled(engine, (await engine.create({ ...f.input, verifyCommand: undefined })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(run.round, 2);
  assert.equal(verificationPlans, 2);
  assert.equal(verifications, 2);
});

test('restored unfinished runs are marked interrupted without restarting model calls', async (t) => {
  const f = await fixture(t); const id = '12345678-1234-1234-1234-123456789abc';
  await mkdir(join(f.data, 'harness'));
  await writeFile(join(f.data, 'harness', `${id}.json`), JSON.stringify({ id, status: 'running', events: [] }));
  const engine = new HarnessEngine({ directory: f.data, invoke: () => assert.fail('Must not restart') });
  assert.equal((await engine.get(id)).status, 'interrupted');
});

test('LangGraph saves the active stage and resumes an interrupted run after engine reload', async (t) => {
  const f = await fixture(t);
  let markWorkerStarted;
  const workerStarted = new Promise((resolve) => { markWorkerStarted = resolve; });
  let holdWorker = true;
  const script = modelScript(complete);
  const invoke = async (selection, prompt, instructions, signal, ...rest) => {
    if (holdWorker && typeof prompt === 'string' && prompt.startsWith('기본 CLI 도구')) {
      markWorkerStarted();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return script(selection, prompt, instructions, signal, ...rest);
  };
  const firstEngine = new HarnessEngine({ directory: f.data, verify: pass, invoke });
  const created = await firstEngine.create(f.input);
  await workerStarted;
  await firstEngine.stop(created.id);
  await firstEngine.runs.get(created.id).execution;
  assert.equal((await firstEngine.get(created.id)).canResume, true);

  const recordPath = join(f.data, 'harness', `${created.id}.json`);
  const saved = JSON.parse(await readFile(recordPath, 'utf8'));
  assert.equal(saved.graphCheckpoint.activeNode, 'round');
  assert.equal(saved.graphCheckpoint.threadId, created.id);
  saved.status = 'running';
  await writeFile(recordPath, JSON.stringify(saved));

  holdWorker = false;
  const restoredEngine = new HarnessEngine({ directory: f.data, verify: pass, invoke });
  const interrupted = await restoredEngine.get(created.id);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.canResume, true);
  assert.equal(Object.hasOwn(interrupted, 'graphCheckpoint'), false);
  await restoredEngine.resume(created.id);
  await restoredEngine.runs.get(created.id).execution;

  const completed = await restoredEngine.get(created.id);
  assert.equal(completed.status, 'completed', completed.summary);
  assert.equal(completed.workflowEngine, 'langgraph');
  assert.ok(completed.events.some((event) => event.title.includes('Loop 이어하기')));
  assert.ok(completed.events.some((event) => event.title.includes('LangGraph 단계 저장')));
});

test('snapshot and auto-apply do not invoke repository-configured external filters', async (t) => {
  const f = await fixture(t);
  await f.git('config', 'filter.qa.clean', 'touch filter-was-run; cat');
  await f.git('config', 'filter.qa.smudge', 'touch filter-was-run; cat');
  await writeFile(join(f.source, '.gitattributes'), 'file.txt filter=qa\n');
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: modelScript(complete) });
  const run = await settled(engine, (await engine.create(f.input)).id);
  assert.equal(run.status, 'completed', run.summary);
  await assert.rejects(readFile(join(f.source, 'filter-was-run')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(run.workspace, 'filter-was-run')), { code: 'ENOENT' });
});

test('macOS verification blocks outside reads and local networking', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = await fixture(t); const runtime = join(f.directory, 'runtime'); await mkdir(runtime);
  await writeFile(join(f.directory, 'private.txt'), 'fixture secret');
  const outside = await verifyWorkspace(f.source, `cat '${join(f.directory, 'private.txt')}'`, runtime, new AbortController().signal);
  assert.notEqual(outside.code, 0); assert.ok(!outside.output.includes('fixture secret'));
  const server = createServer((_req, res) => res.end('reachable'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await fetch(url).then((res) => res.text()), 'reachable');
  const network = await verifyWorkspace(f.source, `/usr/bin/curl --max-time 2 ${url}`, runtime, new AbortController().signal);
  assert.notEqual(network.code, 0);
  assert.match(network.error, /Operation not permitted|Couldn't connect|Failed to connect/i);
});

test('cancellation terminates a running verification command', async () => {
  const controller = new AbortController();
  const process = runCommand('/bin/sh', ['-c', 'sleep 30'], { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(new Error('stop verification')), 100);
  try { await assert.rejects(process, /stop verification/); } finally { clearTimeout(timer); }
});

test('repeated identical reads stop early instead of consuming every tool step', async (t) => {
  const f = await fixture(t); let calls = 0;
  const engine = new HarnessEngine({ directory: f.data, invoke: async (_model, prompt) => {
    calls++;
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Read then update.';
    return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
  } });
  const run = await settled(engine, (await engine.create(f.input)).id);
  assert.equal(run.status, 'failed'); assert.match(run.summary, /같은 읽기 작업/); assert.equal(calls, 4);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
});

test('judge creates a managed project and configures verification from implemented files', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  let inspected = false;
  const engine = new HarnessEngine({ directory: f.data, verify: async (_workspace, command) => {
    assert.equal(command, 'test -f file.txt'); assert.equal(inspected, true); return pass();
  }, invoke: async (selection, prompt, ...rest) => {
    if (startsWithText(prompt, '새 프로젝트의 작업 폴더')) return JSON.stringify({ folderName: 'generated-project', reason: 'Goal-specific folder' });
    if (startsWithText(prompt, '검증 방법을')) {
      assert.equal(selection.model, 'fixture-model');
      if (!hasText(prompt, '"content":')) return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
      inspected = true; return JSON.stringify({ verifyCommand: 'test -f file.txt', reason: 'Check output exists' });
    }
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, workspace: undefined, verifyCommand: undefined })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.ok(run.source.startsWith(join(await realpath(f.data), 'harness', 'projects')));
  assert.ok(run.source.endsWith('/generated-project'));
  assert.equal(await readFile(join(run.source, 'file.txt'), 'utf8'), 'updated 1\n');
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
  assert.ok(run.events.some((event) => event.title.startsWith('검증 자동 구성')));
  // Subsequent turns explicitly reuse the returned source rather than creating another project.
  const next = await settled(engine, (await engine.create({ ...f.input, workspace: run.source, verifyCommand: undefined })).id);
  assert.equal(next.status, 'completed', next.summary);
  assert.equal(next.source, run.source); assert.equal(next.managedProject, false);
});

test('automatic verification retries malformed and incomplete judge responses', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  let verificationResponses = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: async (_workspace, command) => {
    assert.equal(command, 'test -f file.txt'); return pass();
  }, invoke: async (selection, prompt, ...rest) => {
    if (startsWithText(prompt, '새 프로젝트')) return JSON.stringify({ folderName: 'retry-review', reason: 'QA' });
    if (startsWithText(prompt, '검증 방법을')) {
      verificationResponses++;
      if (verificationResponses === 1) return 'The response is not JSON';
      if (verificationResponses === 2) return JSON.stringify({ reason: 'command omitted' });
      return JSON.stringify({ verifyCommand: 'test -f file.txt', reason: 'Check the created file exists.' });
    }
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, workspace: undefined, verifyCommand: undefined })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(verificationResponses, 3);
  assert.equal(run.events.filter((event) => event.title.startsWith('검증 응답 재요청')).length, 2);
});

test('automatic verification retries an invalid judge review without losing the proposed command', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  let verificationPlans = 0, commandReviews = 0, verifications = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: async (_workspace, command) => {
    assert.equal(command, 'node --test'); verifications++; return pass();
  }, invoke: async (selection, prompt, ...rest) => {
    if (startsWithText(prompt, '검증 방법을')) {
      verificationPlans++;
      return JSON.stringify({ verifyCommand: 'node --test', reason: 'Run the project tests with real assertions.' });
    }
    if (isJudgementPrompt(prompt) && prompt.questions.command) {
      commandReviews++;
      if (commandReviews === 1) return JSON.stringify({ answers: {} });
    }
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, verifyCommand: undefined })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(verificationPlans, 2);
  assert.equal(commandReviews, 2);
  assert.equal(verifications, 1);
  assert.equal(run.events.filter((event) => event.title.startsWith('검증 판정 재요청')).length, 1);
  assert.equal(run.events.filter((event) => event.title.startsWith('검증 자동 구성')).length, 1);
});

test('automatic verification does not retry judge transport failures as malformed decisions', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  let verificationPlans = 0, commandReviews = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: () => assert.fail('Transport failures must not run verification'), invoke: async (selection, prompt, ...rest) => {
    if (startsWithText(prompt, '검증 방법을')) {
      verificationPlans++;
      return JSON.stringify({ verifyCommand: 'node --test', reason: 'Run the project tests.' });
    }
    if (isJudgementPrompt(prompt) && prompt.questions.command) {
      commandReviews++;
      throw new Error('judge connection failed');
    }
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, verifyCommand: undefined })).id);
  assert.equal(run.status, 'failed');
  assert.match(run.summary, /judge connection failed/);
  assert.equal(verificationPlans, 1);
  assert.equal(commandReviews, 1);
  assert.equal(run.events.some((event) => event.title.startsWith('검증 판정 재요청')), false);
});

test('automatic verification stops safely after eight invalid judge responses', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  let verificationResponses = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: () => assert.fail('Invalid verification must not run'), invoke: async (selection, prompt, ...rest) => {
    if (startsWithText(prompt, '새 프로젝트')) return JSON.stringify({ folderName: 'invalid-review', reason: 'QA' });
    if (startsWithText(prompt, '검증 방법을')) { verificationResponses++; return JSON.stringify({ reason: 'command omitted' }); }
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, workspace: undefined, verifyCommand: undefined })).id);
  assert.equal(run.status, 'failed'); assert.match(run.summary, /검증 준비 한도\(8회\)/);
  assert.equal(verificationResponses, 8);
  assert.equal(run.events.filter((event) => event.title.startsWith('검증 응답 재요청')).length, 8);
  assert.equal(run.applied, undefined);
});

test('failed edit feedback includes current file contents so the worker can rebase its edit', async (t) => {
  const f = await fixture(t); let step = 0, receivedCurrentFile = false;
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (_selection, prompt) => {
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Read file.txt and update it.';
    if (isJudgementPrompt(prompt)) return judgementResponse(prompt);
    step++;
    if (step === 1) return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
    if (step === 2) return JSON.stringify({ operations: [{ type: 'edit', path: 'file.txt', oldText: 'stale source', newText: 'updated\n' }] });
    if (step === 3) {
      receivedCurrentFile = hasText(prompt, '최신 파일 내용입니다') && hasText(prompt, 'original\n');
      return JSON.stringify({ operations: [{ type: 'edit', path: 'file.txt', oldText: 'original\n', newText: 'updated\n' }] });
    }
    return JSON.stringify({ done: true, summary: 'Updated file.txt using the current file contents.' });
  } });
  const run = await settled(engine, (await engine.create(f.input)).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(receivedCurrentFile, true);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'updated\n');
  assert.ok(run.events.some((event) => event.title.startsWith('작업 수정 요청') && event.detail.includes('original\n')));
});

test('failed edit in a batch returns the latest contents after earlier edits were applied', async (t) => {
  const f = await fixture(t); let step = 0, receivedLatestFile = false;
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (_selection, prompt) => {
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Read and update file.txt.';
    if (isJudgementPrompt(prompt)) return judgementResponse(prompt);
    step++;
    if (step === 1) return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
    if (step === 2) return JSON.stringify({ operations: [
      { type: 'edit', path: 'file.txt', oldText: 'original\n', newText: 'partially updated\n' },
      { type: 'edit', path: 'file.txt', oldText: 'original\n', newText: 'stale replacement\n' },
    ] });
    if (step === 3) {
      receivedLatestFile = hasText(prompt, '최신 파일 내용입니다') && hasText(prompt, 'partially updated\n');
      return JSON.stringify({ operations: [{ type: 'edit', path: 'file.txt', oldText: 'partially updated\n', newText: 'updated\n' }] });
    }
    return JSON.stringify({ done: true, summary: 'Rebased the failed edit on the latest file contents.' });
  } });
  const run = await settled(engine, (await engine.create(f.input)).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(receivedLatestFile, true);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'updated\n');
  assert.ok(run.events.some((event) => event.title.startsWith('작업 수정 요청') && event.detail.includes('partially updated\n')));
});

test('malformed operations response returns tool feedback instead of throwing in the error handler', async (t) => {
  const f = await fixture(t); let step = 0, receivedError = false;
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (_selection, prompt) => {
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Inspect and update file.txt.';
    if (isJudgementPrompt(prompt)) return judgementResponse(prompt);
    step++;
    if (step === 1) return JSON.stringify({ operations: 'invalid' });
    if (step === 2) {
      receivedError = hasText(prompt, '작업 요청은 한 번에 12개까지 가능합니다.');
      return JSON.stringify({ operations: [{ type: 'edit', path: 'file.txt', oldText: 'original\n', newText: 'updated\n' }] });
    }
    return JSON.stringify({ done: true, summary: 'Updated file.txt after correcting the malformed tool request.' });
  } });
  const run = await settled(engine, (await engine.create(f.input)).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(receivedError, true);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'updated\n');
});

test('judge folder names cannot escape the managed project directory', async (t) => {
  const f = await fixture(t);
  const engine = new HarnessEngine({ directory: f.data, invoke: async () => JSON.stringify({ folderName: '../../outside' }) });
  const run = await settled(engine, (await engine.create({ ...f.input, workspace: undefined, verifyCommand: undefined })).id);
  assert.equal(run.status, 'failed'); assert.equal(run.source, null);
  assert.match(run.summary, /폴더 이름/); assert.equal(engine.sources.size, 0);
});

test('verification setup cannot mutate files and never applies on configuration failure', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  const engine = new HarnessEngine({ directory: f.data, verify: () => assert.fail('must not verify'), invoke: (selection, prompt, ...rest) => startsWithText(prompt, '검증 방법을')
    ? JSON.stringify({ operations: [{ type: 'write', path: 'file.txt', content: 'override' }] }) : script(selection, prompt, ...rest) });
  const run = await settled(engine, (await engine.create({ ...f.input, verifyCommand: undefined })).id);
  assert.equal(run.status, 'failed'); assert.match(run.summary, /읽기만 허용/);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
});

test('stop during automatic project setup cancels the judge before creating a source', async (t) => {
  const f = await fixture(t); let ready; const started = new Promise((resolve) => { ready = resolve; });
  const engine = new HarnessEngine({ directory: f.data, invoke: (_model, _prompt, _instructions, signal) => {
    ready(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const run = await engine.create({ ...f.input, workspace: undefined, verifyCommand: undefined });
  await started; await engine.stop(run.id);
  const stopped = await settled(engine, run.id);
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.source, null); assert.equal(engine.sources.size, 0);
});

test('native Jev judges Luna proposals and uncertain verdicts continue to a second round', async (t) => {
  const f = await fixture(t); const script = modelScript(complete); let judgments = 0, typedCalls = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt, ...rest) => {
    if (typeof prompt === 'object') {
      assert.equal(selection.decisionOnly, true); typedCalls++;
      if (prompt.questions.command) assert.match(prompt.state.inspectedFiles, /diff --git.*file.txt/s);
      const choice = prompt.questions.goal && ++judgments === 1 ? 'uncertain' : 'pass';
      return { model: 'jev-version', answers: Object.fromEntries(Object.keys(prompt.questions).map((key) => [key, { type: 'choice', choice, confidence: 0.9, probabilities: { pass: choice === 'pass' ? 0.9 : 0.05, revise: choice === 'revise' ? 0.9 : 0.05, uncertain: choice === 'uncertain' ? 0.9 : 0.05 } }])) };
    }
    assert.notEqual(selection.decisionOnly, true);
    if (startsWithText(prompt, '새 프로젝트')) return JSON.stringify({ folderName: 'jev-test', reason: 'QA' });
    if (startsWithText(prompt, '검증 방법')) return JSON.stringify({ verifyCommand: 'test -f file.txt', reason: 'fixture check' });
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, workspace: undefined, verifyCommand: undefined,
    roles: { ...f.input.roles, judge: { ...f.input.roles.judge, decisionOnly: true } } })).id);
  assert.equal(run.status, 'completed', run.summary); assert.equal(run.round, 2); assert.equal(typedCalls, 4);
  assert.ok(run.events.some((e) => e.title.includes('Live Jev decision') && e.detail.includes('uncertain')));
  assert.equal(await readFile(join(run.source, 'file.txt'), 'utf8'), 'updated 2\n');
});

test('native Jev cannot generate plans and missing decisions fail closed', async (t) => {
  const f = await fixture(t); const script = modelScript(complete);
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: (selection, prompt, ...rest) => typeof prompt === 'object' ? { answers: {} } : script(selection, prompt, ...rest) });
  await assert.rejects(engine.create({ ...f.input, roles: { ...f.input.roles, planner: { ...f.input.roles.planner, decisionOnly: true } } }), /판정 역할/);
  const run = await settled(engine, (await engine.create({ ...f.input, roles: { ...f.input.roles, judge: { ...f.input.roles.judge, decisionOnly: true } } })).id);
  assert.equal(run.status, 'failed'); assert.equal(run.applied, undefined);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
});

test('Jev selects automatic roles once, applies ranking, accounts routing tokens, and preserves priority fallbacks', async (t) => {
  const f = await fixture(t), routes = [], plannerCalls = [];
  const planner = { ...f.input.roles.planner, automatic: true, fallbacks: [
    { ...f.input.roles.planner, model: 'planner-b' },
    { ...f.input.roles.planner, model: 'planner-c' },
  ] };
  const script = modelScript(complete);
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt, ...rest) => {
    if (prompt?.questions?.planner) {
      routes.push(prompt);
      rest[2]({ type: 'usage', usage: { total_tokens: 42 } });
      assert.deepEqual(prompt.state.priorities.map((item) => item.id), ['completion', 'quality', 'reasoning', 'tokenEfficiency', 'speed']);
      return { answers: { planner: { choice: 'candidate_1', reason: 'Suitable candidate from saved choices.' } } };
    }
    if (hasText(prompt, '구현 계획과 검증 기준')) plannerCalls.push(selection.model);
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, roles: {
    ...f.input.roles, planner, judge: { ...f.input.roles.judge, decisionOnly: true },
  } })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].questions.worker, undefined);
  assert.deepEqual(plannerCalls, ['planner-b']);
  assert.equal(run.stageModels.planner.id, 'planner-b');
  assert.deepEqual(run.modelPriority.planner.map((item) => item.model), ['fixture-model', 'planner-c']);
  assert.equal(Object.values(run.modelUsage)[0].totalTokens, 42);
  const event = run.events.find((event) => event.title === '모델 배정 / Model selection');
  assert.ok(event);
  assert.match((await engine.getPromptDetails(run.id, event.id)).input, /candidate_1/);
});

test('a regular judge ranks the primary and all automatic-role fallbacks by the saved priorities', async (t) => {
  const f = await fixture(t), plannerCalls = [];
  const planner = { ...f.input.roles.planner, automatic: true, fallbacks: [
    { ...f.input.roles.planner, model: 'planner-b' }, { ...f.input.roles.planner, model: 'planner-c' },
  ] };
  const judge = { ...f.input.roles.judge, model: 'general-review-model', label: 'General reviewer' };
  const script = modelScript(complete);
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt, ...rest) => {
    if (prompt?.questions?.planner) {
      assert.deepEqual(prompt.state.priorities.map((item) => item.id), ['completion', 'speed', 'tokenEfficiency', 'quality', 'reasoning']);
      return { answers: { planner: {
        choice: 'candidate_2', order: ['candidate_2', 'candidate_1', 'candidate_0'], reason: 'Reported quota is available; this order matches the requested priorities.' } } };
    }
    if (hasText(prompt, '구현 계획과 검증 기준')) plannerCalls.push(selection.model);
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, priorities: ['speed', 'tokenEfficiency', 'quality'], roles: {
    ...f.input.roles, planner, judge,
  } })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.deepEqual(plannerCalls, ['planner-c']);
  assert.equal(run.stageModels.planner.id, 'planner-c');
  assert.deepEqual(run.modelPriority.planner.map((item) => item.model), ['planner-b', 'fixture-model']);
  assert.deepEqual(run.priorities, ['speed', 'tokenEfficiency', 'quality', 'reasoning']);
});

test('invalid Jev routing keeps all default roles and excludes exhausted candidates', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt, ...rest) => {
    if (prompt?.questions?.planner) {
      assert.equal(prompt.state.candidates.planner.length, 2);
      return { answers: { planner: { choice: 'candidate_1' }, worker: { choice: 'unlisted-model' } } };
    }
    return script(selection, prompt, ...rest);
  } });
  const roles = { ...f.input.roles, judge: { ...f.input.roles.judge, decisionOnly: true } };
  for (const role of ['planner', 'worker']) roles[role] = { ...roles[role], automatic: true, fallbacks: [
    { ...roles[role], model: 'exhausted', remainingPercent: 0 },
    { ...roles[role], model: 'alternative' },
  ] };
  const run = await settled(engine, (await engine.create({ ...f.input, roles })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(run.roles.planner.model, f.input.roles.planner.model);
  assert.equal(run.roles.worker.model, f.input.roles.worker.model);
  assert.ok(run.events.some((event) => event.title.includes('기본 배정 유지')));
});

test('stop during Jev routing prevents planning and implementation', async (t) => {
  const f = await fixture(t);
  let routingStarted;
  const started = new Promise((resolve) => { routingStarted = resolve; });
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (_selection, prompt, _instructions, signal) => {
    assert.ok(prompt.questions.planner);
    routingStarted();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const run = await engine.create({ ...f.input, roles: { ...f.input.roles,
    planner: { ...f.input.roles.planner, automatic: true, fallbacks: [{ ...f.input.roles.planner, model: 'alternative' }] },
    judge: { ...f.input.roles.judge, decisionOnly: true },
  } });
  await started; await engine.stop(run.id);
  const done = await settled(engine, run.id);
  assert.equal(done.status, 'stopped');
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
});

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
function modelScript(judge) {
  let steps = 0;
  return async (_selection, prompt) => {
    if (prompt.includes('구현 계획과 검증 기준')) return 'Read, update, verify.';
    if (prompt.startsWith('변경 결과를')) return JSON.stringify(await judge());
    steps++;
    if (steps % 3 === 1) return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
    if (steps % 3 === 2) return JSON.stringify({ operations: [{ type: 'write', path: 'file.txt', content: `updated ${Math.ceil(steps / 3)}\n` }] });
    return JSON.stringify({ done: true, summary: 'Updated file.txt' });
  };
}
const pass = async () => ({ code: 0, output: 'PASS', error: '' });
const complete = () => ({ decision: 'complete', summary: 'Verified', feedback: '' });

test('round feedback reaches worker, dirty user files survive and accepted patch applies automatically', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'user-note.txt'), 'untracked user data');
  await writeFile(join(f.source, 'file.txt'), 'user edit\n');
  let judgments = 0;
  const invoke = modelScript(() => ++judgments === 1 ? { decision: 'revise', summary: 'Needs another pass', feedback: 'second-pass-feedback' } : complete());
  let receivedFeedback = false;
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (...args) => { if (args[1].includes('second-pass-feedback')) receivedFeedback = true; return invoke(...args); } });
  const created = await engine.create(f.input);
  const run = await settled(engine, created.id);
  assert.equal(run.status, 'completed', run.summary); assert.equal(run.round, 2); assert.equal(run.applied, true);
  assert.equal(receivedFeedback, true);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'updated 2\n');
  assert.equal(await readFile(join(f.source, 'user-note.txt'), 'utf8'), 'untracked user data');
  assert.match(await engine.patch(run.id), /user edit/);
  assert.ok(!run.events.some((event) => event.status === 'running'));
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
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: (...args) => args[1].startsWith('변경 결과를') ? 'Looks good!' : invoke(...args) });
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
    if (prompt.startsWith('검증 방법을')) {
      verificationPlans++;
      return JSON.stringify({ verifyCommand: 'test -f file.txt', reason: 'Check the requested output exists.' });
    }
    if (prompt.startsWith('변경 결과를')) {
      reviews++;
      return JSON.stringify(reviews === 1
        ? { decision: 'revise', summary: 'One focused change remains.', feedback: 'Continue the requested work.' }
        : complete());
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

test('restored unfinished runs are marked interrupted without restarting model calls', async (t) => {
  const f = await fixture(t); const id = '12345678-1234-1234-1234-123456789abc';
  await mkdir(join(f.data, 'harness'));
  await writeFile(join(f.data, 'harness', `${id}.json`), JSON.stringify({ id, status: 'running', events: [] }));
  const engine = new HarnessEngine({ directory: f.data, invoke: () => assert.fail('Must not restart') });
  assert.equal((await engine.get(id)).status, 'interrupted');
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
    if (prompt.includes('구현 계획과 검증 기준')) return 'Read then update.';
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
    if (prompt.startsWith('새 프로젝트의 작업 폴더')) return JSON.stringify({ folderName: 'generated-project', reason: 'Goal-specific folder' });
    if (prompt.startsWith('검증 방법을')) {
      assert.equal(selection.model, 'jev-fixture');
      if (!prompt.includes('"content":')) return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
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
    if (prompt.startsWith('새 프로젝트')) return JSON.stringify({ folderName: 'retry-review', reason: 'QA' });
    if (prompt.startsWith('검증 방법을')) {
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

test('automatic verification stops safely after eight invalid judge responses', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  let verificationResponses = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: () => assert.fail('Invalid verification must not run'), invoke: async (selection, prompt, ...rest) => {
    if (prompt.startsWith('새 프로젝트')) return JSON.stringify({ folderName: 'invalid-review', reason: 'QA' });
    if (prompt.startsWith('검증 방법을')) { verificationResponses++; return JSON.stringify({ reason: 'command omitted' }); }
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
    if (prompt.includes('구현 계획과 검증 기준')) return 'Read file.txt and update it.';
    if (prompt.startsWith('변경 결과를')) return JSON.stringify(complete());
    step++;
    if (step === 1) return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
    if (step === 2) return JSON.stringify({ operations: [{ type: 'edit', path: 'file.txt', oldText: 'stale source', newText: 'updated\n' }] });
    if (step === 3) {
      receivedCurrentFile = prompt.includes('최신 파일 내용입니다') && prompt.includes('original\n');
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

test('judge folder names cannot escape the managed project directory', async (t) => {
  const f = await fixture(t);
  const engine = new HarnessEngine({ directory: f.data, invoke: async () => JSON.stringify({ folderName: '../../outside' }) });
  const run = await settled(engine, (await engine.create({ ...f.input, workspace: undefined, verifyCommand: undefined })).id);
  assert.equal(run.status, 'failed'); assert.equal(run.source, null);
  assert.match(run.summary, /폴더 이름/); assert.equal(engine.sources.size, 0);
});

test('verification setup cannot mutate files and never applies on configuration failure', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  const engine = new HarnessEngine({ directory: f.data, verify: () => assert.fail('must not verify'), invoke: (selection, prompt, ...rest) => prompt.startsWith('검증 방법을')
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
      return { model: 'jev-version', answers: Object.fromEntries(Object.keys(prompt.questions).map((key) => [key, { type: 'choice', choice, confidence: 0.9, probabilities: { [choice]: 0.9 } }])) };
    }
    assert.notEqual(selection.decisionOnly, true);
    if (prompt.startsWith('새 프로젝트')) return JSON.stringify({ folderName: 'jev-test', reason: 'QA' });
    if (prompt.startsWith('검증 방법')) return JSON.stringify({ verifyCommand: 'test -f file.txt', reason: 'fixture check' });
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

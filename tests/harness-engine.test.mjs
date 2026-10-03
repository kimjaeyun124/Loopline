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

test('managed project setup repairs one malformed folder proposal and review without restarting', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  let proposals = 0, folderReviews = 0, originalReview;
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt, ...rest) => {
    if (startsWithText(prompt, '새 프로젝트의 작업 폴더')) {
      proposals++;
      if (proposals === 1) return 'Use a suitable project name.';
      assert.ok(hasText(prompt, '직전 응답의 형식 오류'));
      return JSON.stringify({ folderName: 'completion-recovery', reason: 'Identify this QA task.' });
    }
    if (isJudgementPrompt(prompt) && prompt.questions.folder) {
      folderReviews++;
      if (folderReviews === 1) { originalReview = prompt; return JSON.stringify({ answers: {} }); }
      assert.match(prompt.instruction, /형식 오류/);
      assert.deepEqual(prompt.questions, originalReview.questions);
      assert.deepEqual(prompt.state, originalReview.state);
      return judgementResponse(prompt);
    }
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, workspace: undefined })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(run.applied, true);
  assert.equal(proposals, 2); assert.equal(folderReviews, 2);
  assert.equal(run.events.filter((event) => event.title.startsWith('응답 형식 보완')).length, 2);
  assert.equal(await readFile(join(run.source, 'file.txt'), 'utf8'), 'updated 1\n');
});

test('final review repairs one invalid JSON response while reusing the verified patch', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  let reviews = 0, verifications = 0, workerCalls = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: async (...args) => {
    verifications++; return pass(...args);
  }, invoke: async (selection, prompt, ...rest) => {
    if (isJudgementPrompt(prompt)) {
      reviews++;
      assert.equal(prompt.state.verification.code, 0);
      assert.match(prompt.state.diff, /updated 1/);
      if (reviews === 1) return 'The changes look complete.';
      assert.match(prompt.instruction, /형식 오류/);
      return judgementResponse(prompt);
    }
    if (hasText(prompt, '최근 도구 결과:')) workerCalls++;
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create(f.input)).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(run.applied, true);
  assert.equal(reviews, 2); assert.equal(verifications, 1); assert.equal(workerCalls, 3);
});

test('persistent invalid initial and final reviews are bounded and never apply changes', async (t) => {
  for (const managed of [true, false]) await t.test(managed ? 'initial review' : 'final review', async (t) => {
    const f = await fixture(t), script = modelScript(complete); let reviews = 0;
    const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: (selection, prompt, ...rest) => {
      if (isJudgementPrompt(prompt)) { reviews++; return 'Still not JSON.'; }
      return script(selection, prompt, ...rest);
    } });
    const run = await settled(engine, (await engine.create({ ...f.input, ...(managed ? { workspace: undefined } : {}) })).id);
    assert.equal(run.status, 'failed'); assert.equal(reviews, 2);
    assert.equal(run.applied, undefined);
    assert.equal(run.source === null, managed);
    assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
  });
});

test('single worker retries one temporary provider failure, preserves progress and records reported usage', async (t) => {
  const f = await fixture(t); let workerCalls = 0, calls = 0, verifications = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: async (workspace) => {
    verifications++;
    assert.equal(await readFile(join(workspace, 'file.txt'), 'utf8'), 'updated\n');
    assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
    return pass();
  }, invoke: async (_selection, prompt, _instructions, _signal, onSignal) => {
    calls++; onSignal({ type: 'usage', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Update and verify.';
    if (isJudgementPrompt(prompt)) return judgementResponse(prompt);
    workerCalls++;
    assert.ok(hasText(prompt, '12,000자') && hasText(prompt, '파일 변경 2~3개'));
    if (workerCalls === 1) return JSON.stringify({ operations: [{ type: 'write', path: 'file.txt', content: 'partial\n' }] });
    if (workerCalls === 2) throw Object.assign(new Error('Provider temporarily unavailable'), { remoteStatus: 503 });
    assert.ok(hasText(prompt, '필요한 파일 한 개') && hasText(prompt, 'partial\\n'));
    return JSON.stringify({ operations: [{ type: 'write', path: 'file.txt', content: 'updated\n' }], done: true, summary: 'Completed the saved work.' });
  } });
  const run = await settled(engine, (await engine.create(f.input)).id);
  assert.equal(run.status, 'completed', run.summary); assert.equal(run.applied, true);
  assert.equal(workerCalls, 3); assert.equal(verifications, 1);
  assert.equal(run.events.filter((event) => event.title.startsWith('구현 호출 복구')).length, 1);
  assert.equal(Object.values(run.modelUsage).reduce((total, usage) => total + usage.totalTokens, 0), calls * 15);
  assert.equal(Object.values(run.modelUsage).reduce((total, usage) => total + usage.calls, 0), calls);
});

test('repeated temporary worker failures continue in the next round before verification and application', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = await fixture(t); let firstRoundCalls = 0, secondRoundCalls = 0, verifications = 0, reviews = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: async (workspace, command, runtime, signal) => {
    verifications++; assert.equal(await readFile(join(workspace, 'file.txt'), 'utf8'), 'completed\n');
    return verifyWorkspace(workspace, command, runtime, signal);
  }, invoke: async (_selection, prompt) => {
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Save work in small steps and finish.';
    if (isJudgementPrompt(prompt)) { reviews++; return judgementResponse(prompt); }
    const round = Number(prompt.match(/회차 (\d+)\//)?.[1]);
    if (round === 1) {
      firstRoundCalls++;
      if (firstRoundCalls === 1) return JSON.stringify({ operations: [{ type: 'write', path: 'saved.txt', content: 'preserved\n' }] });
      throw Object.assign(new Error('Temporary transport failure'), { code: 'ETIMEDOUT' });
    }
    secondRoundCalls++;
    assert.equal(verifications, 0); assert.equal(reviews, 0);
    assert.match(prompt, /파일 목록:\n[\s\S]*saved\.txt/);
    assert.ok(hasText(prompt, '성공한 작업을 처음부터 반복'));
    return JSON.stringify({ operations: [{ type: 'write', path: 'file.txt', content: 'completed\n' }], done: true, summary: 'Finished without repeating saved.txt.' });
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, verifyCommand: 'test "$(cat file.txt)" = "completed" && test "$(cat saved.txt)" = "preserved"' })).id);
  assert.equal(run.status, 'completed', run.summary); assert.equal(run.round, 2); assert.equal(run.applied, true);
  assert.equal(firstRoundCalls, 3); assert.equal(secondRoundCalls, 1);
  assert.equal(verifications, 1); assert.equal(reviews, 1);
  assert.equal(await readFile(join(f.source, 'saved.txt'), 'utf8'), 'preserved\n');
  assert.ok(run.events.some((event) => event.title.startsWith('구현 이어가기')));
});

test('worker step exhaustion preserves files and completes automatically in the next round', async (t) => {
  const f = await fixture(t); let workerCalls = 0, verifications = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: async (workspace) => {
    verifications++;
    assert.equal(await readFile(join(workspace, 'part-16.txt'), 'utf8'), 'part 16\n');
    assert.equal(await readFile(join(workspace, 'file.txt'), 'utf8'), 'completed\n'); return pass();
  }, invoke: async (_selection, prompt) => {
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Create parts, then finish.';
    if (isJudgementPrompt(prompt)) return judgementResponse(prompt);
    workerCalls++;
    const round = Number(prompt.match(/회차 (\d+)\//)?.[1]);
    const step = Number(prompt.match(/단계 (\d+)\/16/)?.[1]);
    if (round === 1) return JSON.stringify({ operations: [{ type: 'write', path: `part-${step}.txt`, content: `part ${step}\n` }] });
    assert.equal(verifications, 0);
    assert.ok(hasText(prompt, 'part-1.txt') && hasText(prompt, 'part-16.txt') && hasText(prompt, '한도(16회)'));
    return JSON.stringify({ operations: [{ type: 'write', path: 'file.txt', content: 'completed\n' }], done: true, summary: 'Finished the existing parts.' });
  } });
  const run = await settled(engine, (await engine.create(f.input)).id);
  assert.equal(run.status, 'completed', run.summary); assert.equal(run.round, 2); assert.equal(run.applied, true);
  assert.equal(workerCalls, 17); assert.equal(verifications, 1);
  assert.equal(await readFile(join(f.source, 'part-16.txt'), 'utf8'), 'part 16\n');
});

test('unfinished implementation extends automatic rounds and finishes after the initial limit', async (t) => {
  const f = await fixture(t); let verifications = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: async () => { verifications++; return pass(); }, invoke: async (_selection, prompt) => {
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Continue until the final part is ready.';
    if (isJudgementPrompt(prompt)) return judgementResponse(prompt);
    const round = Number(prompt.match(/회차 (\d+)\//)?.[1]);
    const step = Number(prompt.match(/단계 (\d+)\/16/)?.[1]);
    assert.equal(verifications, 0);
    return JSON.stringify({ operations: [{ type: 'write', path: 'file.txt', content: `round ${round} step ${step}\n` }],
      ...(round === 5 ? { done: true, summary: 'Completed the remaining part.' } : {}) });
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, rounds: 0 })).id);
  assert.equal(run.status, 'completed', run.summary); assert.equal(run.round, 5); assert.equal(run.rounds, 6);
  assert.equal(run.applied, true); assert.equal(verifications, 1);
  assert.ok(run.events.some((event) => event.title.startsWith('자동 회차 연장') && event.detail.includes('4회에서 6회')));
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'round 5 step 1\n');
});

test('unfinished implementation respects the configured round limit without verification or application', async (t) => {
  const f = await fixture(t); let workerCalls = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: () => assert.fail('Incomplete work must not verify'), invoke: async (_selection, prompt) => {
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Update in steps.';
    assert.equal(isJudgementPrompt(prompt), false);
    workerCalls++; return JSON.stringify({ operations: [{ type: 'write', path: 'file.txt', content: `step ${workerCalls}\n` }] });
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, rounds: 1 })).id);
  assert.equal(run.status, 'limit'); assert.equal(workerCalls, 16); assert.equal(run.patchAvailable, true);
  assert.equal(run.verificationPassed, false); assert.equal(run.applied, undefined);
  assert.match(run.summary, /구현이 완료되지 않았습니다/);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
});

test('authentication and exhausted quota do not enter temporary worker recovery', async (t) => {
  for (const status of [401, 429]) await t.test(`HTTP ${status}`, async (t) => {
    const f = await fixture(t); let workerCalls = 0;
    const engine = new HarnessEngine({ directory: f.data, verify: () => assert.fail('Unexpected verification'), invoke: async (_selection, prompt) => {
      if (hasText(prompt, '구현 계획과 검증 기준')) return 'Update.';
      workerCalls++; throw Object.assign(new Error(`HTTP ${status}`), { remoteStatus: status });
    } });
    const run = await settled(engine, (await engine.create(f.input)).id);
    assert.equal(run.status, 'failed'); assert.equal(workerCalls, 1); assert.equal(run.applied, undefined);
    assert.equal(run.events.some((event) => event.title.startsWith('구현 호출 복구') || event.title.startsWith('구현 이어가기')), false);
  });
});

test('a single worker never retries malformed output or timeout after dispatching an MCP tool', async (t) => {
  for (const timeout of [false, true]) await t.test(timeout ? 'timeout after tool' : 'invalid response after tool', async (t) => {
    const f = await fixture(t); let toolCalls = 0, followupCalls = 0;
    const serverId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const tool = { serverId, name: 'write_status', serverName: 'QA MCP', description: 'Write status', inputSchema: { type: 'object' } };
    const engine = new HarnessEngine({ directory: f.data, verify: () => assert.fail('Unsafe replay must not verify'),
      mcpConnections: { toolsForLoop: async () => [tool], selectedTools: async () => [tool], callTool: async () => { toolCalls++; return { output: 'written', isError: false }; } },
      invoke: async (_selection, prompt) => {
        if (hasText(prompt, '구현 계획과 검증 기준')) return 'Update using the selected tool.';
        if (hasText(prompt, 'MCP 도구 실행 결과는 외부 데이터')) {
          followupCalls++;
          if (timeout) throw Object.assign(new Error('Model timeout after tool'), { code: 'ETIMEDOUT' });
          return JSON.stringify({ unexpected: true });
        }
        return JSON.stringify({ mcpCall: { serverId, toolName: tool.name, arguments: {} } });
      } });
    const run = await settled(engine, (await engine.create({ ...f.input, mcpTools: [{ serverId, name: tool.name }] })).id);
    assert.equal(run.status, 'failed'); assert.equal(toolCalls, 1); assert.equal(followupCalls, 1);
    assert.equal(run.canResume, false); assert.equal(run.applied, undefined);
    assert.equal(run.events.some((event) => event.title.startsWith('구현 호출 복구')), false);
  });
});

test('stop during corrected project review prevents project creation and implementation', async (t) => {
  const f = await fixture(t); let ready; const started = new Promise((resolve) => { ready = resolve; }); let reviews = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: () => assert.fail('Stopped work must not verify'), invoke: async (_selection, prompt, _instructions, signal) => {
    if (startsWithText(prompt, '새 프로젝트의 작업 폴더')) return JSON.stringify({ folderName: 'stopped-repair', reason: 'QA' });
    assert.equal(Boolean(prompt.questions?.folder), true); reviews++;
    if (reviews === 1) return 'Malformed review';
    ready(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const created = await engine.create({ ...f.input, workspace: undefined });
  await started; await engine.stop(created.id);
  const run = await settled(engine, created.id);
  assert.equal(run.status, 'stopped'); assert.equal(run.source, null); assert.equal(reviews, 2);
  assert.equal(run.events.some((event) => event.title.startsWith('파일 작업')), false);
});

test('stop during a recovered worker call prevents later verification and application', async (t) => {
  const f = await fixture(t); let ready; const started = new Promise((resolve) => { ready = resolve; }); let workerCalls = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: () => assert.fail('Stopped recovery must not verify'), invoke: async (_selection, prompt, _instructions, signal) => {
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Update and verify.';
    workerCalls++;
    if (workerCalls === 1) throw Object.assign(new Error('Temporary timeout'), { code: 'ETIMEDOUT' });
    ready(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const created = await engine.create(f.input);
  await started; await engine.stop(created.id);
  const run = await settled(engine, created.id);
  assert.equal(run.status, 'stopped'); assert.equal(workerCalls, 2); assert.equal(run.applied, undefined);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
});

test('implementation recovery never replays an earlier completed MCP side effect', async (t) => {
  for (const timeout of [true, false]) await t.test(timeout ? 'later timeout' : 'step exhaustion', async (t) => {
    const f = await fixture(t); let toolCalls = 0, workerCalls = 0;
    const serverId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const tool = { serverId, name: 'write_status', serverName: 'QA MCP', inputSchema: { type: 'object' } };
    const engine = new HarnessEngine({ directory: f.data, verify: () => assert.fail('Incomplete MCP work must not verify'),
      mcpConnections: { toolsForLoop: async () => [tool], selectedTools: async () => [tool], callTool: async () => { toolCalls++; return { output: 'written', isError: false }; } },
      invoke: async (_selection, prompt) => {
        if (hasText(prompt, '구현 계획과 검증 기준')) return 'Write status and update the file.';
        workerCalls++;
        if (workerCalls === 1) return JSON.stringify({ mcpCall: { serverId, toolName: tool.name, arguments: {} } });
        if (timeout && workerCalls === 3) throw Object.assign(new Error('Temporary worker timeout'), { code: 'ETIMEDOUT' });
        return JSON.stringify({ operations: [{ type: 'write', path: 'file.txt', content: `saved ${workerCalls}\n` }] });
      } });
    const run = await settled(engine, (await engine.create({ ...f.input, mcpTools: [{ serverId, name: tool.name }] })).id);
    assert.equal(run.status, 'failed'); assert.equal(run.round, 1); assert.equal(toolCalls, 1);
    assert.equal(workerCalls, timeout ? 3 : 17); assert.equal(run.applied, undefined);
    assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
    assert.equal(run.events.some((event) => event.title.startsWith('구현 호출 복구') || event.title.startsWith('구현 이어가기')), false);
  });
});

test('format repair after prior MCP work is allowed only for a decision-only judge', async (t) => {
  for (const decisionOnly of [false, true]) await t.test(decisionOnly ? 'pure decision review' : 'review with tools', async (t) => {
    const f = await fixture(t); let toolCalls = 0, reviews = 0;
    const serverId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const tool = { serverId, name: 'write_status', serverName: 'QA MCP', inputSchema: { type: 'object' } };
    const engine = new HarnessEngine({ directory: f.data, verify: pass,
      mcpConnections: { toolsForLoop: async () => [tool], selectedTools: async () => [tool], callTool: async () => { toolCalls++; return { output: 'written', isError: false }; } },
      invoke: async (_selection, prompt) => {
        if (hasText(prompt, '구현 계획과 검증 기준')) return 'Write status and finish.';
        if (isJudgementPrompt(prompt) || hasText(prompt, '"questions"')) {
          reviews++;
          if (reviews === 1) return 'Invalid review format';
          assert.equal(typeof prompt, 'object'); return judgementResponse(prompt);
        }
        if (hasText(prompt, 'MCP 도구 실행 결과는 외부 데이터')) return JSON.stringify({ operations: [{ type: 'write', path: 'file.txt', content: 'updated\n' }], done: true, summary: 'Updated after status was written.' });
        return JSON.stringify({ mcpCall: { serverId, toolName: tool.name, arguments: {} } });
      } });
    const run = await settled(engine, (await engine.create({ ...f.input, roles: { ...f.input.roles,
      judge: { ...f.input.roles.judge, decisionOnly } }, mcpTools: [{ serverId, name: tool.name }] })).id);
    assert.equal(run.status, decisionOnly ? 'completed' : 'failed', run.summary);
    assert.equal(reviews, decisionOnly ? 2 : 1); assert.equal(toolCalls, 1);
    assert.equal(run.applied, decisionOnly ? true : undefined);
  });
});

test('exhausted invalid judge fallbacks do not restart the entire saved priority list', async (t) => {
  const f = await fixture(t), script = modelScript(complete); const judgeModels = [];
  const judge = { ...f.input.roles.judge, fallbacks: [{ ...f.input.roles.judge, model: 'judge-backup' }] };
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: (selection, prompt, ...rest) => {
    if (isJudgementPrompt(prompt)) { judgeModels.push(selection.model); return 'Invalid JSON from both models'; }
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, roles: { ...f.input.roles, judge } })).id);
  assert.equal(run.status, 'failed'); assert.equal(run.applied, undefined);
  assert.deepEqual(judgeModels, ['jev-fixture', 'judge-backup']);
  assert.equal(run.events.some((event) => event.title.startsWith('응답 형식 보완')), false);
});

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

test('a localized API connection failure continues through the saved worker models', async (t) => {
  const f = await fixture(t), script = modelScript(complete), workerModels = [];
  const worker = { ...f.input.roles.worker, model: 'worker-connection-primary', fallbacks: [
    { ...f.input.roles.worker, model: 'worker-connection-backup', label: 'Connection backup' },
  ] };
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt, ...rest) => {
    if (hasText(prompt, '최근 도구 결과:')) {
      workerModels.push(selection.model);
      if (selection.model === 'worker-connection-primary') {
        throw new Error('API 서버에 연결하지 못했습니다. 주소와 네트워크 연결을 확인해 주세요.');
      }
    }
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, roles: { ...f.input.roles, worker } })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(run.stageModels.worker.id, 'worker-connection-backup');
  assert.deepEqual(workerModels.slice(0, 2), ['worker-connection-primary', 'worker-connection-backup']);
  assert.ok(run.events.some((event) => event.title.includes('모델 일시 오류') && event.model?.id === 'worker-connection-primary'));
});

test('an API authentication failure wrapped by the local relay does not switch models', async (t) => {
  const f = await fixture(t), plannerCalls = [], script = modelScript(complete);
  const planner = { ...f.input.roles.planner, model: 'auth-primary', fallbacks: [
    { ...f.input.roles.planner, model: 'auth-backup', label: 'Authentication backup' },
  ] };
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt, ...rest) => {
    if (hasText(prompt, '구현 계획과 검증 기준')) {
      plannerCalls.push(selection.model);
      if (selection.model === 'auth-primary') throw Object.assign(new Error('API key invalid'), { status: 502, remoteStatus: 401 });
    }
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, roles: { ...f.input.roles, planner } })).id);
  assert.equal(run.status, 'failed');
  assert.deepEqual(plannerCalls, ['auth-primary']);
  assert.equal(run.recoverableFailure, false);
  assert.equal(run.canResume, false);
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

test('an invalid verification plan falls back to the next saved planner and completes', async (t) => {
  const f = await fixture(t), plannerCalls = [], script = modelScript(complete);
  const planner = { ...f.input.roles.planner, fallbacks: [
    { ...f.input.roles.planner, model: 'planner-format-backup', label: 'Format backup' },
  ] };
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt, ...rest) => {
    if (startsWithText(prompt, '검증 방법을')) {
      plannerCalls.push(selection.model);
      if (selection.model === 'fixture-model') return JSON.stringify({ reason: '명령이 빠졌습니다.' });
      return JSON.stringify({ verifyCommand: 'test -f file.txt', reason: '구현 파일이 존재하는지 확인합니다.' });
    }
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({
    ...f.input, verifyCommand: undefined, roles: { ...f.input.roles, planner },
  })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.deepEqual(plannerCalls, ['fixture-model', 'planner-format-backup']);
  assert.equal(run.stageModels.planner.id, 'planner-format-backup');
  assert.ok(run.events.some((event) => event.title.includes('Invalid output · Trying fallback')));
});

test('an invalid judge decision falls back without requiring a task restart', async (t) => {
  const f = await fixture(t), judgeCalls = [], script = modelScript(complete); let original;
  const judge = { ...f.input.roles.judge, model: 'judge-primary', fallbacks: [
    { ...f.input.roles.judge, model: 'judge-format-backup', label: 'Judge backup' },
  ] };
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt, ...rest) => {
    if (isJudgementPrompt(prompt)) {
      judgeCalls.push(selection.model);
      if (selection.model === 'judge-primary') { original = structuredClone(prompt); return JSON.stringify({ answers: {} }); }
      assert.deepEqual(prompt.questions, original.questions);
      assert.deepEqual({ ...prompt.state, responseFormatCorrection: undefined }, { ...original.state, responseFormatCorrection: undefined });
      assert.match(prompt.instruction, /판정이 누락/);
      assert.match(prompt.state.responseFormatCorrection, /원래 목표·필드·판정 질문·검사 조건을 유지/);
      return judgementResponse(prompt);
    }
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, roles: { ...f.input.roles, judge } })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.deepEqual(judgeCalls, ['judge-primary', 'judge-format-backup']);
  assert.equal(run.stageModels.judge.id, 'judge-format-backup');
});

test('a valid negative judge verdict never invokes a fallback to chase approval', async (t) => {
  for (const choice of ['revise', 'uncertain']) await t.test(choice, async (t) => {
    const f = await fixture(t), calls = [], script = modelScript(complete);
    const judge = { ...f.input.roles.judge, fallbacks: [{ ...f.input.roles.judge, model: 'optimistic-backup' }] };
    const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt, ...rest) => {
      if (isJudgementPrompt(prompt)) {
        calls.push(selection.model);
        assert.equal(prompt.state.responseFormatCorrection, undefined);
        return { answers: Object.fromEntries(Object.keys(prompt.questions).map(id => [id, { choice, reason: 'Actual required behavior is not proven.' }])) };
      }
      return script(selection, prompt, ...rest);
    } });
    const run = await settled(engine, (await engine.create({ ...f.input, rounds: 1, roles: { ...f.input.roles, judge } })).id);
    assert.deepEqual(calls, ['jev-fixture']); assert.equal(run.status, 'limit', run.summary);
    assert.notEqual(run.applied, true); assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
    assert.equal(run.events.some(event => event.title.startsWith('응답 형식 오류')), false);
  });
});

test('a malformed worker action uses the next saved implementation model', async (t) => {
  const f = await fixture(t), workerCalls = [], script = modelScript(complete);
  const worker = { ...f.input.roles.worker, model: 'worker-primary', fallbacks: [
    { ...f.input.roles.worker, model: 'worker-format-backup', label: 'Worker backup' },
  ] };
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt, ...rest) => {
    if (hasText(prompt, '최근 도구 결과:')) {
      workerCalls.push(selection.model);
      if (selection.model === 'worker-primary') return 'not JSON';
      if (selection.model === 'worker-format-backup' && workerCalls.length === 2) {
        assert.match(prompt, /모델 응답이 요청한 JSON 형식이 아닙니다/);
        assert.match(prompt, /원래 목표·필드·판정 질문·검사 조건을 유지/);
      }
    }
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, roles: { ...f.input.roles, worker } })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.deepEqual(workerCalls.slice(0, 2), ['worker-primary', 'worker-format-backup']);
  assert.equal(run.stageModels.worker.id, 'worker-format-backup');
});

test('an invalid automatic model ranking falls back to the saved review model', async (t) => {
  const f = await fixture(t), routingCalls = [], script = modelScript(complete);
  const planner = { ...f.input.roles.planner, automatic: true, fallbacks: [
    { ...f.input.roles.planner, model: 'planner-routing-backup' },
  ] };
  const worker = { ...f.input.roles.worker, automatic: true, fallbacks: [
    { ...f.input.roles.worker, model: 'worker-routing-backup' },
  ] };
  const judge = { ...f.input.roles.judge, model: 'judge-routing-primary', fallbacks: [
    { ...f.input.roles.judge, model: 'judge-routing-backup' },
  ] };
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt, ...rest) => {
    if (isJudgementPrompt(prompt) && Object.hasOwn(prompt.questions, 'planner')) {
      routingCalls.push(selection.model);
      if (selection.model === 'judge-routing-primary') return JSON.stringify({ answers: { planner: { choice: 'candidate_99' } } });
      return JSON.stringify({ answers: Object.fromEntries(Object.keys(prompt.questions).map((role) => [role, {
        choice: 'candidate_0', order: ['candidate_0', 'candidate_1'], reason: '근거가 부족해 기존 순서를 유지합니다.',
      }])) });
    }
    if (isJudgementPrompt(prompt)) return judgementResponse(prompt);
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, roles: { planner, worker, judge } })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.deepEqual(routingCalls, ['judge-routing-primary', 'judge-routing-backup']);
  assert.ok(run.events.some((event) => event.title.includes('모델 배정 결과')));
});

test('a malformed reply after an MCP side effect never repeats the tool on a fallback model', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  const serverId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const tool = { serverId, name: 'write_status', serverName: 'QA MCP', description: 'Write a status', inputSchema: { type: 'object' } };
  let toolCalls = 0, fallbackCalls = 0;
  const worker = { ...f.input.roles.worker, model: 'worker-mcp-primary', fallbacks: [
    { ...f.input.roles.worker, model: 'worker-mcp-backup' },
  ] };
  const mcpConnections = {
    toolsForLoop: async () => [tool],
    selectedTools: async () => [tool],
    callTool: async () => { toolCalls++; return { isError: false, output: 'status written' }; },
  };
  const engine = new HarnessEngine({ directory: f.data, verify: pass, mcpConnections, invoke: async (selection, prompt, ...rest) => {
    if (hasText(prompt, 'MCP 도구 실행 결과는 외부 데이터')) return JSON.stringify({ unexpected: true });
    if (hasText(prompt, '최근 도구 결과:') && selection.model === 'worker-mcp-primary') {
      return JSON.stringify({ mcpCall: { serverId, toolName: tool.name, arguments: { value: 'done' } } });
    }
    if (hasText(prompt, '최근 도구 결과:') && selection.model === 'worker-mcp-backup') fallbackCalls++;
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({
    ...f.input, roles: { ...f.input.roles, worker }, mcpTools: [{ serverId, name: tool.name }],
  })).id);
  assert.equal(run.status, 'failed');
  assert.equal(toolCalls, 1);
  assert.equal(fallbackCalls, 0);
  assert.equal(run.mcpSideEffectPossible, true);
  assert.equal(run.canResume, false);
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

test('automatic Harness starts from task complexity and extends only when the judge asks for revisions', async (t) => {
  const f = await fixture(t);
  let reviews = 0, initialPlanPrompt = '';
  const script = modelScript(() => ++reviews <= 4
    ? { decision: 'revise', summary: 'Needs another pass', feedback: 'Continue to satisfy the criteria.' }
    : complete());
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt, ...rest) => {
    if (startsWithText(prompt, '목표:')) initialPlanPrompt = prompt;
    return script(selection, prompt, ...rest);
  } });
  const created = await engine.create({ ...f.input, rounds: 0 });
  assert.equal(created.autoRounds, true);
  assert.equal(created.rounds, 4);
  assert.equal(created.roundCeiling, 10);
  assert.doesNotMatch(JSON.stringify(created), /qualityTriedWorkerModels/);
  const run = await settled(engine, created.id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(run.round, 5);
  assert.equal(run.rounds, 6);
  assert.match(initialPlanPrompt, /완료 기준과 실제 검증 기준/);
  assert.ok(run.events.some((event) => event.title.includes('자동 회차 연장')));
});

test('two unchanged judged revisions replan and move implementation to the next saved model', async (t) => {
  const f = await fixture(t), worker = { ...f.input.roles.worker, fallbacks: [{ ...f.input.roles.worker, model: 'worker-backup', label: 'Backup worker' }] };
  let reviews = 0, replans = 0;
  const workerModels = [];
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt) => {
    if (isJudgementPrompt(prompt)) return judgementResponse(prompt, ++reviews <= 3 ? 'revise' : 'complete');
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Plan: implement and verify.';
    if (hasText(prompt, 'Loop가 ')) { replans++; return 'Replanned: use an alternate implementation and verify its behavior.'; }
    if (hasText(prompt, '최근 도구 결과:')) {
      workerModels.push(selection.model);
      const step = Number(prompt.match(/단계 (\d+)\/16/)?.[1] || 1);
      if (step === 1) return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
      if (step === 2) return JSON.stringify({ operations: [{ type: 'write', path: 'file.txt', content: selection.model === 'worker-backup' ? 'improved\n' : 'same\n' }] });
      return JSON.stringify({ done: true, summary: 'Updated file.txt.' });
    }
    return 'Plan: implement and verify.';
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, rounds: 5, roles: { ...f.input.roles, worker } })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(replans, 1);
  assert.ok(workerModels.includes('worker-backup'));
  assert.equal(run.stageModels.worker.id, 'worker-backup');
  assert.ok(run.events.some((event) => event.title.includes('품질 정체 후 모델 교체')));
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'improved\n');
});

test('automatic Harness stops repeated unchanged work after replan instead of spending all ten rounds', async (t) => {
  const f = await fixture(t);
  let reviews = 0, replans = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (_selection, prompt) => {
    if (isJudgementPrompt(prompt)) { reviews++; return judgementResponse(prompt, 'revise'); }
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Plan: implement and verify.';
    if (hasText(prompt, 'Loop가 ')) { replans++; return `Replanned attempt ${replans}: try a simpler change.`; }
    if (hasText(prompt, '최근 도구 결과:')) {
      const step = Number(prompt.match(/단계 (\d+)\/16/)?.[1] || 1);
      if (step === 1) return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
      if (step === 2) return JSON.stringify({ operations: [{ type: 'write', path: 'file.txt', content: 'same\n' }] });
      return JSON.stringify({ done: true, summary: 'Updated file.txt.' });
    }
    return 'Plan: implement and verify.';
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, rounds: 0 })).id);
  assert.equal(run.status, 'limit');
  assert.equal(run.round, 5);
  assert.equal(run.rounds, 6);
  assert.equal(reviews, 5);
  assert.equal(replans, 2);
  assert.match(run.summary, /진행이 감지되지 않았습니다/);
  assert.equal(run.applied, undefined);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
  assert.ok(await engine.patch(run.id));
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
  assert.match(run.summary, /설정한 최대 회차/);
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
      const answers = Object.fromEntries(Object.keys(prompt.questions).map((id) => [id, {
        choice: id === 'goal' && reviews === 1 ? 'revise' : 'pass',
        reason: id === 'goal' && reviews === 1 ? 'Continue the requested work.' : 'The verification evidence is sufficient.',
      }]));
      return JSON.stringify({ answers });
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

test('an insufficient judge verification verdict replans the command for the next round', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  let verificationPlans = 0, reviews = 0;
  const verifiedCommands = [];
  const engine = new HarnessEngine({ directory: f.data, verify: async (_workspace, command) => {
    verifiedCommands.push(command);
    return pass();
  }, invoke: async (selection, prompt, ...rest) => {
    if (startsWithText(prompt, '검증 방법을')) {
      const verifyCommand = verificationPlans++ === 0 ? 'test -f file.txt' : 'test -s file.txt';
      return JSON.stringify({ verifyCommand, reason: 'Check the latest implementation evidence.' });
    }
    if (isJudgementPrompt(prompt)) {
      if (prompt.questions.command) return judgementResponse(prompt);
      const answers = Object.fromEntries(Object.keys(prompt.questions).map((id) => [id, {
        choice: id === 'verification' && reviews === 0 ? 'revise' : 'pass',
        reason: id === 'verification' && reviews === 0 ? 'The first check does not cover the behavior tests.' : 'The available evidence is sufficient.',
      }]));
      reviews++;
      return JSON.stringify({ answers });
    }
    return script(selection, prompt, ...rest);
  } });

  const run = await settled(engine, (await engine.create({ ...f.input, verifyCommand: undefined, rounds: 2 })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(run.round, 2);
  assert.equal(reviews, 2);
  assert.equal(verificationPlans, 2);
  assert.deepEqual(verifiedCommands, ['test -f file.txt', 'test -s file.txt']);
  assert.equal(run.events.filter((event) => event.title.startsWith('검증 자동 구성')).length, 2);
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

test('verification-plan rejection uses the next saved planner and then applies only after approval', async (t) => {
  const f = await fixture(t), script = modelScript(complete), plannerCalls = [];
  let commandReviews = 0, verifiedCommand = '';
  const planner = { ...f.input.roles.planner, fallbacks: [
    { ...f.input.roles.planner, model: 'verification-backup', label: 'Verification backup' },
  ] };
  const engine = new HarnessEngine({ directory: f.data, verify: async (_workspace, command) => {
    verifiedCommand = command;
    return pass();
  }, invoke: async (selection, prompt, ...rest) => {
    if (startsWithText(prompt, '검증 방법을')) {
      plannerCalls.push(selection.model);
      return selection.model === 'fixture-model'
        ? JSON.stringify({ verifyCommand: 'true', reason: 'Run a command.' })
        : JSON.stringify({ verifyCommand: 'test "$(cat file.txt)" = "updated 1"', reason: 'Assert the generated file contents.' });
    }
    if (isJudgementPrompt(prompt) && prompt.questions.command) {
      commandReviews++;
      return commandReviews === 1
        ? judgementResponse(prompt, 'revise', 'true에는 실제 assertion이 없습니다.')
        : judgementResponse(prompt);
    }
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({
    ...f.input, verifyCommand: undefined, roles: { ...f.input.roles, planner },
  })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.deepEqual(plannerCalls, ['fixture-model', 'verification-backup']);
  assert.equal(commandReviews, 2);
  assert.equal(verifiedCommand, 'test "$(cat file.txt)" = "updated 1"');
  assert.equal(run.stageModels.planner.id, 'verification-backup');
  assert.ok(run.events.some((event) => event.title.startsWith('검증 계획 대체 모델')));
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'updated 1\n');
});

test('restored unfinished runs are marked interrupted without restarting model calls', async (t) => {
  const f = await fixture(t); const id = '12345678-1234-1234-1234-123456789abc';
  await mkdir(join(f.data, 'harness'));
  await writeFile(join(f.data, 'harness', `${id}.json`), JSON.stringify({ id, status: 'running', events: [] }));
  const engine = new HarnessEngine({ directory: f.data, invoke: () => assert.fail('Must not restart') });
  assert.equal((await engine.get(id)).status, 'interrupted');
});

test('LangGraph automatically resumes the saved stage after engine restart', async (t) => {
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
  await firstEngine.shutdown();
  assert.equal((await firstEngine.get(created.id)).status, 'interrupted');
  assert.equal((await firstEngine.get(created.id)).canResume, true);

  const recordPath = join(f.data, 'harness', `${created.id}.json`);
  const saved = JSON.parse(await readFile(recordPath, 'utf8'));
  assert.equal(saved.graphCheckpoint.activeNode, 'round');
  assert.equal(saved.graphCheckpoint.threadId, created.id);
  // A hard process exit leaves the last durable state as running.
  saved.status = 'running';
  delete saved.shutdownRequested;
  await writeFile(recordPath, JSON.stringify(saved));

  holdWorker = false;
  const restoredEngine = new HarnessEngine({ directory: f.data, verify: pass, invoke });
  assert.deepEqual(await restoredEngine.recoverInterruptedRuns(), [created.id]);
  await restoredEngine.runs.get(created.id).execution;

  const completed = await restoredEngine.get(created.id);
  assert.equal(completed.status, 'completed', completed.summary);
  assert.equal(completed.autoResumeAttempts, 1);
  assert.equal(completed.workflowEngine, 'langgraph');
  assert.ok(completed.events.some((event) => event.title.includes('Loop 이어하기')));
  assert.ok(completed.events.some((event) => event.title.includes('LangGraph 단계 저장')));
});

test('startup recovery preserves an explicit user stop', async (t) => {
  const f = await fixture(t); let markWorkerStarted; let calls = 0;
  const workerStarted = new Promise((resolve) => { markWorkerStarted = resolve; });
  const invoke = (_selection, prompt, _instructions, signal) => {
    calls++;
    if (typeof prompt === 'string' && prompt.startsWith('기본 CLI 도구')) {
      markWorkerStarted();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return modelScript(complete)(_selection, prompt, _instructions, signal);
  };
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke });
  const created = await engine.create(f.input);
  await workerStarted;
  await engine.stop(created.id);
  await engine.runs.get(created.id).execution;

  const restarted = new HarnessEngine({ directory: f.data, invoke: () => assert.fail('Explicitly stopped run must not restart') });
  assert.deepEqual(await restarted.recoverInterruptedRuns(), []);
  const stopped = await restarted.get(created.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.canResume, true);
  assert.equal(calls, 2);
});

test('a failed transient model call can resume from its safe checkpoint with a bounded retry count', async (t) => {
  const f = await fixture(t); let signalWorkerStarted; let holdWorker = true;
  const workerStarted = new Promise((resolve) => { signalWorkerStarted = resolve; });
  const script = modelScript(complete);
  const invoke = (selection, prompt, instructions, signal, ...rest) => {
    if (holdWorker && startsWithText(prompt, '기본 CLI 도구')) {
      signalWorkerStarted();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return script(selection, prompt, instructions, ...rest);
  };
  const firstEngine = new HarnessEngine({ directory: f.data, verify: pass, invoke });
  const created = await firstEngine.create(f.input);
  await workerStarted;
  await firstEngine.stop(created.id);
  await firstEngine.runs.get(created.id).execution;

  const recordPath = join(f.data, 'harness', `${created.id}.json`);
  const saved = JSON.parse(await readFile(recordPath, 'utf8'));
  saved.status = 'failed';
  saved.summary = 'API 서버에 연결하지 못했습니다. 주소와 네트워크 연결을 확인해 주세요.';
  saved.recoverableFailure = true;
  saved.autoResumeAttempts = 0;
  await writeFile(recordPath, JSON.stringify(saved));

  holdWorker = false;
  const resumedEngine = new HarnessEngine({ directory: f.data, verify: pass, invoke });
  const resumable = await resumedEngine.get(created.id);
  assert.equal(resumable.canResume, true);
  await resumedEngine.resume(created.id);
  await resumedEngine.runs.get(created.id).execution;
  const completed = await resumedEngine.get(created.id);
  assert.equal(completed.status, 'completed', completed.summary);
  assert.equal(completed.applied, true);
  assert.equal(completed.autoResumeAttempts, 1);
  assert.ok(completed.events.some((event) => event.title.includes('Loop 이어하기')));
});

test('startup recovery reconnects saved MCP tools and respects safety and restart limits', async (t) => {
  const f = await fixture(t); let markWorkerStarted; let holdWorker = true; let connected = true; let connectCalls = 0;
  const workerStarted = new Promise((resolve) => { markWorkerStarted = resolve; });
  const serverId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const tool = { serverId, name: 'read_status', serverName: 'QA MCP', description: 'Read status', inputSchema: { type: 'object' } };
  const mcpConnections = {
    toolsForLoop: async (selection) => selection.map(() => tool),
    selectedTools: async (selection) => {
      if (!connected) throw new Error('MCP disconnected');
      return selection.map(() => tool);
    },
    connect: async () => { connectCalls++; connected = true; },
  };
  const script = modelScript(complete);
  const invoke = async (selection, prompt, instructions, signal, ...rest) => {
    if (holdWorker && typeof prompt === 'string' && prompt.startsWith('기본 CLI 도구')) {
      markWorkerStarted();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return script(selection, prompt, instructions, signal, ...rest);
  };
  const firstEngine = new HarnessEngine({ directory: f.data, verify: pass, invoke, mcpConnections });
  const created = await firstEngine.create({ ...f.input, roles: { ...f.input.roles, judge: { ...f.input.roles.judge, decisionOnly: true } }, mcpTools: [{ serverId, name: tool.name }] });
  await workerStarted;
  await firstEngine.stop(created.id);
  await firstEngine.runs.get(created.id).execution;

  const recordPath = join(f.data, 'harness', `${created.id}.json`);
  const saved = JSON.parse(await readFile(recordPath, 'utf8'));
  saved.status = 'running'; delete saved.userStopRequested;
  await writeFile(recordPath, JSON.stringify(saved));
  connected = false; holdWorker = false;

  const restoredEngine = new HarnessEngine({ directory: f.data, verify: pass, invoke, mcpConnections });
  assert.deepEqual(await restoredEngine.recoverInterruptedRuns(), [created.id]);
  await restoredEngine.runs.get(created.id).execution;
  const recovered = await restoredEngine.get(created.id);
  assert.equal(recovered.status, 'completed', recovered.summary);
  assert.equal(connectCalls, 1);

  const blockedId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const cappedId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const interruptedRun = (id, overrides = {}) => ({
    id, status: 'running', events: [], mcpSideEffectPossible: false, mcpTools: [],
    graphCheckpoint: { version: 1, threadId: id, nextNode: 'round', activeNode: null, state: { completedRounds: 0 } },
    ...overrides,
  });
  await writeFile(join(f.data, 'harness', `${blockedId}.json`), JSON.stringify(interruptedRun(blockedId, { mcpSideEffectPossible: true })));
  await writeFile(join(f.data, 'harness', `${cappedId}.json`), JSON.stringify(interruptedRun(cappedId, { autoResumeAttempts: 3 })));
  const safetyEngine = new HarnessEngine({ directory: f.data, invoke: () => assert.fail('Unsafe or capped run must not call a model') });
  assert.deepEqual(await safetyEngine.recoverInterruptedRuns(), []);
  const unsafe = await safetyEngine.get(blockedId);
  const capped = await safetyEngine.get(cappedId);
  assert.equal(unsafe.status, 'interrupted'); assert.equal(unsafe.canResume, false);
  assert.ok(unsafe.events.some((event) => event.title.includes('자동 이어하기 보류')));
  assert.equal(capped.status, 'interrupted'); assert.equal(capped.canResume, true);
  assert.ok(capped.events.some((event) => event.title.includes('한도 도달')));
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

test('repeated identical reads give one recovery hint before stopping a stubborn model', async (t) => {
  const f = await fixture(t); let calls = 0;
  const engine = new HarnessEngine({ directory: f.data, invoke: async (_model, prompt) => {
    calls++;
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Read then update.';
    return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
  } });
  const run = await settled(engine, (await engine.create(f.input)).id);
  assert.equal(run.status, 'failed'); assert.match(run.summary, /안내를 따르지 않아/); assert.equal(calls, 5);
  assert.equal(run.events.filter((event) => event.title.startsWith('중복 읽기 안내')).length, 1);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
});

test('the worker continues with an edit after repeated-read feedback includes current file contents', async (t) => {
  const f = await fixture(t); let workerCalls = 0, sawCurrentContent = false;
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (_model, prompt) => {
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Read file.txt, update it, then verify.';
    if (isJudgementPrompt(prompt)) return judgementResponse(prompt);
    workerCalls++;
    if (workerCalls <= 3) return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
    if (hasText(prompt, '같은 파일 또는 목록의 읽기 요청이 반복')) {
      sawCurrentContent = hasText(prompt, 'original\n');
      return JSON.stringify({ operations: [{ type: 'edit', path: 'file.txt', oldText: 'original\n', newText: 'updated\n' }] });
    }
    return JSON.stringify({ done: true, summary: 'Updated file.txt after using the existing read result.' });
  } });
  const run = await settled(engine, (await engine.create(f.input)).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(workerCalls, 5);
  assert.equal(sawCurrentContent, true);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'updated\n');
  assert.ok(run.events.some((event) => event.title.startsWith('중복 읽기 안내')));
});

test('reordered and subset reads recover through the saved worker while retaining the verification veto', async (t) => {
  for (const verificationPassed of [true, false]) await t.test(verificationPassed ? 'verified recovery applies' : 'failed verification never applies', async t => {
    const f = await fixture(t), models = []; let steps = 0;
    const worker = { ...f.input.roles.worker, model: 'read-primary', fallbacks: [{ ...f.input.roles.worker, model: 'read-backup' }] };
    const engine = new HarnessEngine({ directory: f.data, verify: async () => ({ code: verificationPassed ? 0 : 1, output: 'actual fixture verification' }), invoke: async (selection, prompt) => {
      if (hasText(prompt, '구현 계획과 검증 기준')) return 'Update file.txt.';
      if (isJudgementPrompt(prompt)) return judgementResponse(prompt);
      models.push(selection.model); steps++;
      assert.ok(hasText(prompt, 'done은 담당 파일·테스트·문서 작성을 마쳤다는 뜻'));
      if (steps === 1) return JSON.stringify({ operations: [{ type: 'list', path: '.' }, { type: 'read', path: 'file.txt' }] });
      if (steps === 2) return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }, { type: 'list', path: '.' }] });
      if (steps === 3) return JSON.stringify({ operations: [{ type: 'list', path: '.' }] });
      if (steps === 4) return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
      assert.equal(selection.model, 'read-backup'); assert.match(promptText(prompt), /original(?:\\n|\n)/);
      return JSON.stringify({ operations: [{ type: 'write', path: 'file.txt', content: 'updated\n' }], done: true, summary: 'Files ready for independent verification.' });
    } });
    const r = await settled(engine, (await engine.create({ ...f.input, rounds: 1, roles: { ...f.input.roles, worker } })).id);
    assert.deepEqual(models, ['read-primary', 'read-primary', 'read-primary', 'read-primary', 'read-backup']);
    assert.equal(r.events.filter(e => e.title.startsWith('중복 읽기 안내')).length, 1);
    assert.equal(r.events.filter(e => e.title.startsWith('읽기 정체 · 대체 모델 전환')).length, 1);
    assert.equal(r.status, verificationPassed ? 'completed' : 'limit', r.summary);
    assert.equal(r.applied === true, verificationPassed);
    assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), verificationPassed ? 'updated\n' : 'original\n');
  });
});

test('failed reads of an uncreated file give creation guidance and do not evade progress recovery', async t => {
  const f = await fixture(t); let steps = 0; const models = [];
  const worker = { ...f.input.roles.worker, model: 'missing-primary', fallbacks: [{ ...f.input.roles.worker, model: 'missing-backup' }] };
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt) => {
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Update file.txt and write documentation.';
    if (isJudgementPrompt(prompt)) return judgementResponse(prompt);
    models.push(selection.model); steps++;
    if (steps <= 4) {
      if (steps === 2) assert.ok(hasText(prompt, '요청한 파일이 아직 없습니다') && hasText(prompt, 'write로 생성'));
      return JSON.stringify({ operations: [{ type: 'read', path: 'README.md' }] });
    }
    assert.equal(selection.model, 'missing-backup');
    return JSON.stringify({ operations: [{ type: 'write', path: 'README.md', content: 'Offline instructions.\n' }, { type: 'write', path: 'file.txt', content: 'updated\n' }], done: true, summary: 'Created missing documentation and updated file.' });
  } });
  const r = await settled(engine, (await engine.create({ ...f.input, rounds: 1, roles: { ...f.input.roles, worker } })).id);
  assert.equal(r.status, 'completed', r.summary); assert.equal(models.length, 5);
  assert.equal(await readFile(join(f.source, 'README.md'), 'utf8'), 'Offline instructions.\n');
});

test('fresh file inspections and inspections following mutations are legitimate progress', async t => {
  const f = await fixture(t); let steps = 0;
  for (let i = 0; i < 5; i++) await writeFile(join(f.source, `section-${i}.txt`), `section ${i}\n`);
  await f.git('add', '.'); await f.git('commit', '-m', 'context fixture');
  const worker = { ...f.input.roles.worker, model: 'progress-primary', fallbacks: [{ ...f.input.roles.worker, model: 'unused-backup' }] };
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt) => {
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Inspect and update.';
    if (isJudgementPrompt(prompt)) return judgementResponse(prompt);
    assert.equal(selection.model, 'progress-primary'); steps++;
    if (steps <= 5) return JSON.stringify({ operations: [{ type: 'read', path: `section-${steps - 1}.txt` }] });
    if (steps === 6) return JSON.stringify({ operations: [{ type: 'write', path: 'file.txt', content: 'intermediate\n' }] });
    if (steps <= 8) return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
    if (steps === 9) return JSON.stringify({ operations: [{ type: 'write', path: 'file.txt', content: 'updated\n' }] });
    if (steps <= 11) return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
    return JSON.stringify({ done: true, summary: 'All inspections and changes completed.' });
  } });
  const r = await settled(engine, (await engine.create({ ...f.input, rounds: 1, roles: { ...f.input.roles, worker } })).id);
  assert.equal(r.status, 'completed', r.summary); assert.equal(steps, 12);
  assert.ok(!r.events.some(e => /중복 읽기 안내|읽기 정체/.test(e.title)));
});

test('large current files cannot hide inventory and the latest operation metadata', async t => {
  const f = await fixture(t); let steps = 0;
  await writeFile(join(f.source, 'file.txt'), 'large source '.repeat(3000));
  await f.git('add', '.'); await f.git('commit', '-m', 'large context fixture');
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (_selection, prompt) => {
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Update large source.';
    if (isJudgementPrompt(prompt)) return judgementResponse(prompt);
    steps++;
    if (steps === 1) return JSON.stringify({ operations: [{ type: 'list', path: '.' }] });
    if (steps === 2) return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
    const context = promptText(prompt).split('최근 도구 결과:').at(-1);
    assert.ok(context.indexOf('현재 디렉터리 목록:') >= 0 && context.indexOf('현재 디렉터리 목록:') < context.indexOf('현재 파일 상태:'));
    assert.ok(context.indexOf('최근 작업 기록:') >= 0 && context.indexOf('최근 작업 기록:') < context.indexOf('현재 파일 상태:'));
    return JSON.stringify({ operations: [{ type: 'write', path: 'file.txt', content: 'updated\n' }], done: true, summary: 'Updated using visible inventory.' });
  } });
  const r = await settled(engine, (await engine.create({ ...f.input, rounds: 1 })).id);
  assert.equal(r.status, 'completed', r.summary);
});

test('the latest read retains its complete middle when older file context exceeds the budget', async t => {
  const f = await fixture(t); let steps = 0;
  const latest = 'L'.repeat(9000) + 'LATEST_MIDDLE_MARKER' + 'Z'.repeat(11000);
  const older = 'O'.repeat(20000);
  await writeFile(join(f.source, 'file.txt'), latest);
  await writeFile(join(f.source, 'older.txt'), older);
  await f.git('add', '.'); await f.git('commit', '-m', 'bounded context fixture');
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (_selection, prompt) => {
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Read both files and update file.txt.';
    if (isJudgementPrompt(prompt)) return judgementResponse(prompt);
    if (++steps === 1) return JSON.stringify({ operations: [{ type: 'read', path: 'older.txt' }, { type: 'read', path: 'file.txt' }] });
    assert.ok(hasText(prompt, latest), 'the requested latest file must not lose its middle to older file content');
    assert.ok(!hasText(prompt, older), 'the existing total context bound must still truncate older content');
    return JSON.stringify({ operations: [{ type: 'write', path: 'file.txt', content: 'updated\n' }], done: true, summary: 'Changed using the complete latest file.' });
  } });
  const r = await settled(engine, (await engine.create({ ...f.input, rounds: 1 })).id);
  assert.equal(r.status, 'completed', r.summary); assert.equal(steps, 2);
  assert.equal(await readFile(join(f.source, 'older.txt'), 'utf8'), older);
});

test('read stagnation after an external MCP side effect never changes or replays the worker', async t => {
  const f = await fixture(t); let steps = 0;
  const worker = { ...f.input.roles.worker, model: 'side-effect-worker', fallbacks: [{ ...f.input.roles.worker, model: 'never-dispatched-backup' }] };
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt) => {
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Inspect then update.';
    if (isJudgementPrompt(prompt)) return judgementResponse(prompt);
    assert.equal(selection.model, 'side-effect-worker'); steps++;
    engine.runs.values().next().value.run.mcpSideEffectPossible = true;
    return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
  } });
  const r = await settled(engine, (await engine.create({ ...f.input, rounds: 1, roles: { ...f.input.roles, worker } })).id);
  assert.equal(r.status, 'failed'); assert.equal(steps, 4);
  assert.ok(!r.events.some(e => e.title.startsWith('읽기 정체 · 대체 모델 전환')));
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

test('automatic verification planning and judgement receive the actual test source', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  const testSource = `// MORROW_TEST_ASSERTION_SOURCE\nimport test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('task output is persisted', () => assert.equal('saved', 'saved'));\n`;
  await writeFile(join(f.source, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  await mkdir(join(f.source, 'tests'));
  await writeFile(join(f.source, 'tests', 'behavior.test.js'), testSource);
  await f.git('add', 'package.json', 'tests/behavior.test.js');
  await f.git('commit', '-m', 'Add verification evidence fixture');

  let verificationPlans = 0, commandReviewEvidence = '';
  const engine = new HarnessEngine({ directory: f.data, verify: async (_workspace, command) => {
    assert.equal(command, 'node --test'); return pass();
  }, invoke: async (selection, prompt, ...rest) => {
    if (startsWithText(prompt, '검증 방법을')) {
      verificationPlans++;
      assert.ok(hasText(prompt, 'MORROW_TEST_ASSERTION_SOURCE'));
      return JSON.stringify({ verifyCommand: 'node --test', reason: 'Run the test that asserts saved task behavior.' });
    }
    if (isJudgementPrompt(prompt) && prompt.questions.command) {
      commandReviewEvidence = JSON.stringify(prompt.state.inspectedFiles);
      assert.ok(commandReviewEvidence.includes('MORROW_TEST_ASSERTION_SOURCE'));
      return judgementResponse(prompt);
    }
    return script(selection, prompt, ...rest);
  } });

  const run = await settled(engine, (await engine.create({ ...f.input, verifyCommand: undefined })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(verificationPlans, 1);
  assert.ok(commandReviewEvidence.includes('task output is persisted'));
  assert.equal(run.verifyCommand, 'node --test');
});

test('automatic verification limits repeated file inspection and still selects a judged command', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  let verificationResponses = 0, commandReviews = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: async (_workspace, command) => {
    assert.equal(command, 'test -f file.txt'); return pass();
  }, invoke: async (selection, prompt, ...rest) => {
    if (startsWithText(prompt, '검증 방법을')) {
      verificationResponses++;
      if (verificationResponses <= 2) return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
      return JSON.stringify({ verifyCommand: 'test -f file.txt', reason: 'Confirm the requested output exists.' });
    }
    if (isJudgementPrompt(prompt) && prompt.questions.command) {
      commandReviews++;
      return judgementResponse(prompt);
    }
    return script(selection, prompt, ...rest);
  } });

  const run = await settled(engine, (await engine.create({ ...f.input, verifyCommand: undefined })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(verificationResponses, 3);
  assert.equal(commandReviews, 1);
  assert.equal(run.events.filter((event) => event.title.startsWith('검증 파일 확인 / Inspect verification files')).length, 1);
  assert.equal(run.events.filter((event) => event.title.startsWith('추가 검증 파일 확인 제한')).length, 1);
  assert.equal(run.verifyCommand, 'test -f file.txt');
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

test('automatic verification retries one invalid judge review without replanning the command', async (t) => {
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
  assert.equal(verificationPlans, 1);
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

test('automatic verification bounds repeated malformed plans without wasting eight requests', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  let verificationResponses = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: () => assert.fail('Invalid verification must not run'), invoke: async (selection, prompt, ...rest) => {
    if (startsWithText(prompt, '새 프로젝트')) return JSON.stringify({ folderName: 'invalid-review', reason: 'QA' });
    if (startsWithText(prompt, '검증 방법을')) { verificationResponses++; return JSON.stringify({ reason: 'command omitted' }); }
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, workspace: undefined, verifyCommand: undefined, rounds: 1 })).id);
  assert.equal(run.status, 'limit'); assert.match(run.summary, /검증 명령 또는 선택 근거/);
  assert.equal(verificationResponses, 3);
  assert.equal(run.events.filter((event) => event.title.startsWith('검증 응답 재요청')).length, 3);
  assert.equal(run.applied, undefined);
});

test('rejected verification plans return their evidence gaps to the worker and run real assertions before applying', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = await fixture(t);
  let workerCalls = 0, plannerCalls = 0, commandReviews = 0, finalReviews = 0, verifications = 0;
  const testSource = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\ntest('recovered output', () => assert.equal(readFileSync(new URL('../file.txt', import.meta.url), 'utf8'), 'updated\\n'));\n`;
  const engine = new HarnessEngine({ directory: f.data, verify: async (...args) => {
    assert.equal(commandReviews, 4); assert.equal(workerCalls, 2);
    assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
    verifications++; return verifyWorkspace(...args);
  }, invoke: async (_selection, prompt) => {
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Update file.txt and verify its exact contents offline.';
    if (startsWithText(prompt, '검증 방법을')) {
      plannerCalls++;
      return JSON.stringify({ verifyCommand: 'node --test tests/output.test.mjs', reason: 'Run an exact output assertion.' });
    }
    if (isJudgementPrompt(prompt)) {
      if (prompt.questions.command) {
        commandReviews++;
        return judgementResponse(prompt, String(prompt.state.inspectedFiles).includes("test('recovered output'") ? 'complete' : 'revise',
          'Add tests/output.test.mjs to assert the exact contents of file.txt; a test file is missing.');
      }
      finalReviews++; assert.equal(prompt.state.verification.code, 0);
      return judgementResponse(prompt);
    }
    workerCalls++;
    if (workerCalls === 2) {
      assert.match(prompt, /판정 피드백: 자동 검증 준비/);
      assert.match(prompt, /Add tests\/output.test.mjs/);
      assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
    }
    return JSON.stringify({ operations: workerCalls === 1
      ? [{ type: 'write', path: 'file.txt', content: 'updated\n' }]
      : [{ type: 'write', path: 'tests/output.test.mjs', content: testSource }], done: true, summary: 'Updated output and its verification evidence.' });
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, verifyCommand: undefined })).id);
  assert.equal(run.status, 'completed', run.summary); assert.equal(run.round, 2);
  assert.equal(plannerCalls, 4); assert.equal(verifications, 1); assert.equal(finalReviews, 1);
  assert.equal(run.verificationPassed, true); assert.equal(run.applied, true);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'updated\n');
  assert.equal(await readFile(join(f.source, 'tests/output.test.mjs'), 'utf8'), testSource);
  const titles = run.events.map((event) => event.title);
  assert.equal(titles.filter((title) => title.startsWith('검증 준비 복구')).length, 1);
  assert.ok(titles.findIndex((title) => title.startsWith('검증 준비 복구')) < titles.findIndex((title) => title === '검증 / Verification'));
});

test('missing verification commands recover in the next implementation round within the configured limit', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  let verificationPlans = 0, verifications = 0, sawFeedback = false;
  const engine = new HarnessEngine({ directory: f.data, verify: async () => { verifications++; return pass(); }, invoke: async (selection, prompt, ...rest) => {
    if (startsWithText(prompt, '검증 방법을')) {
      verificationPlans++;
      return JSON.stringify(verificationPlans <= 3 ? { reason: 'command omitted' }
        : { verifyCommand: 'test -f file.txt', reason: 'Check the updated file.' });
    }
    if (hasText(prompt, '회차 2/2') && hasText(prompt, '최근 도구 결과:')) sawFeedback ||= hasText(prompt, '검증 명령 또는 선택 근거');
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, verifyCommand: undefined })).id);
  assert.equal(run.status, 'completed', run.summary); assert.equal(run.round, 2);
  assert.equal(verificationPlans, 4); assert.equal(verifications, 1); assert.equal(sawFeedback, true);
  assert.equal(run.applied, true); assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'updated 2\n');
});

test('verification preparation recovery exhausts the round limit without executing or applying unchecked changes', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  let verificationPlans = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: () => assert.fail('Unapproved commands must not execute'), invoke: async (selection, prompt, ...rest) => {
    if (startsWithText(prompt, '검증 방법을')) { verificationPlans++; return JSON.stringify({ reason: 'command omitted' }); }
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, verifyCommand: undefined })).id);
  assert.equal(run.status, 'limit'); assert.equal(run.round, 2); assert.equal(verificationPlans, 6);
  assert.equal(run.verificationPassed, false); assert.equal(run.verifyCommand, '');
  assert.equal(run.applied, undefined); assert.equal(run.patchAvailable, true);
  assert.match(run.summary, /검증은 실행되지 않았습니다/);
  assert.equal(run.events.some((event) => event.title === '검증 / Verification' || event.title.startsWith('판정 결과')), false);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
});

test('automatic rounds extend after verification preparation failures and complete when evidence becomes available', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  let verificationPlans = 0, verifications = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: async () => { verifications++; return pass(); }, invoke: async (selection, prompt, ...rest) => {
    if (startsWithText(prompt, '검증 방법을')) {
      verificationPlans++;
      return JSON.stringify(verificationPlans <= 12 ? { reason: 'command omitted' }
        : { verifyCommand: 'test -f file.txt', reason: 'Check the updated file.' });
    }
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, verifyCommand: undefined, rounds: 0 })).id);
  assert.equal(run.status, 'completed', run.summary); assert.equal(run.round, 5); assert.equal(run.rounds, 6);
  assert.equal(verificationPlans, 13); assert.equal(verifications, 1); assert.equal(run.applied, true);
  assert.equal(run.events.filter((event) => event.title.startsWith('자동 회차 연장')).length, 1);
});

test('stop during verification preparation recovery prevents the next round from verifying or applying', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  let reachedRecovery;
  const recovering = new Promise((resolve) => { reachedRecovery = resolve; });
  const engine = new HarnessEngine({ directory: f.data, verify: () => assert.fail('Stopped recovery must not verify'), invoke: async (selection, prompt, instructions, signal, ...rest) => {
    if (startsWithText(prompt, '검증 방법을')) return JSON.stringify({ reason: 'command omitted' });
    if (hasText(prompt, '회차 2/2') && hasText(prompt, '최근 도구 결과:')) {
      reachedRecovery();
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return script(selection, prompt, instructions, signal, ...rest);
  } });
  const created = await engine.create({ ...f.input, verifyCommand: undefined });
  await recovering; await engine.stop(created.id);
  const run = await settled(engine, created.id);
  assert.equal(run.status, 'stopped'); assert.equal(run.applied, undefined); assert.equal(run.verificationPassed, false);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
});

test('authentication errors during verification planning do not enter implementation recovery', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  let verificationPlans = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: () => assert.fail('Authentication errors must not verify'), invoke: async (selection, prompt, ...rest) => {
    if (startsWithText(prompt, '검증 방법을')) { verificationPlans++; throw Object.assign(new Error('planner authentication failed'), { remoteStatus: 401 }); }
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, verifyCommand: undefined })).id);
  assert.equal(run.status, 'failed'); assert.equal(run.round, 1); assert.equal(verificationPlans, 1);
  assert.match(run.summary, /planner authentication failed/);
  assert.equal(run.events.some((event) => event.title.startsWith('검증 준비 복구')), false);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
});

test('verification preparation recovery clears a previously passing command and result before reaching the round limit', async (t) => {
  const f = await fixture(t), script = modelScript(complete);
  let verificationPlans = 0, verifications = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: async () => { verifications++; return pass(); }, invoke: async (selection, prompt, ...rest) => {
    if (startsWithText(prompt, '검증 방법을')) {
      verificationPlans++;
      return JSON.stringify(verificationPlans === 1 ? { verifyCommand: 'test -f file.txt', reason: 'Check the updated file.' } : { reason: 'command omitted' });
    }
    if (isJudgementPrompt(prompt) && prompt.questions.verification) return judgementResponse(prompt, 'revise', 'The passing command lacks the required behavior assertions.');
    return script(selection, prompt, ...rest);
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, verifyCommand: undefined })).id);
  assert.equal(run.status, 'limit'); assert.equal(run.round, 2); assert.equal(verifications, 1); assert.equal(verificationPlans, 4);
  assert.equal(run.verifyCommand, ''); assert.equal(run.verificationPassed, false); assert.equal(run.applied, undefined);
  assert.match(run.summary, /검증은 실행되지 않았습니다/);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
});

test('stagnation replanning handles unexecuted verification while recovering missing plans', async (t) => {
  const f = await fixture(t);
  let workerRounds = 0, replans = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (_selection, prompt) => {
    if (isJudgementPrompt(prompt)) return judgementResponse(prompt);
    if (startsWithText(prompt, 'Loop가')) { replans++; assert.match(prompt, /검증 준비 실패로 실행되지 않음/); return 'Add the missing verification evidence.'; }
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Update and test the file.';
    if (startsWithText(prompt, '검증 방법을')) return JSON.stringify(workerRounds < 4 ? { reason: 'command omitted' }
      : { verifyCommand: 'test -f file.txt', reason: 'Check the updated file.' });
    workerRounds++;
    return JSON.stringify({ operations: [{ type: 'write', path: 'file.txt', content: 'updated\n' }], done: true, summary: 'Updated the same file.' });
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, verifyCommand: undefined, rounds: 4 })).id);
  assert.equal(run.status, 'completed', run.summary); assert.equal(run.round, 4); assert.equal(replans, 1);
  assert.equal(run.applied, true);
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

test('failed edit in a batch leaves earlier edits unapplied and provides the original content', async (t) => {
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
      receivedLatestFile = hasText(prompt, '최신 파일 내용입니다') && hasText(prompt, 'original\n');
      return JSON.stringify({ operations: [{ type: 'edit', path: 'file.txt', oldText: 'original\n', newText: 'updated\n' }] });
    }
    return JSON.stringify({ done: true, summary: 'Rebased the failed edit on the latest file contents.' });
  } });
  const run = await settled(engine, (await engine.create(f.input)).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(receivedLatestFile, true);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'updated\n');
  assert.ok(run.events.some((event) => event.title.startsWith('작업 수정 요청') && event.detail.includes('original\n')));
});

test('repeated identical malformed worker output stops safely after one correction attempt', async (t) => {
  const f = await fixture(t); let workerCalls = 0;
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (_selection, prompt) => {
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Read and update file.txt.';
    if (isJudgementPrompt(prompt)) return judgementResponse(prompt);
    workerCalls++;
    return 'The same non-JSON response';
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, rounds: 1 })).id);
  assert.equal(run.status, 'failed');
  assert.equal(workerCalls, 2);
  assert.match(run.summary, /응답 형식이 연속으로 반복/);
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'original\n');
  assert.ok(run.events.some((event) => event.title.startsWith('응답 형식 재요청')));
});

test('repeated edit failures switch to the next saved worker before further attempts', async (t) => {
  const f = await fixture(t); let workerCalls = 0; const workerModels = [];
  const worker = { ...f.input.roles.worker, model: 'worker-edit-primary', fallbacks: [
    { ...f.input.roles.worker, model: 'worker-edit-backup', label: 'Edit recovery worker' },
  ] };
  const engine = new HarnessEngine({ directory: f.data, verify: pass, invoke: async (selection, prompt) => {
    if (hasText(prompt, '구현 계획과 검증 기준')) return 'Read and update file.txt.';
    if (isJudgementPrompt(prompt)) return judgementResponse(prompt);
    workerCalls++; workerModels.push(selection.model);
    if (workerCalls === 1) return JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
    if (workerCalls <= 3) return JSON.stringify({ operations: [{ type: 'edit', path: 'file.txt', oldText: 'stale text', newText: 'updated\n' }] });
    assert.equal(selection.model, 'worker-edit-backup');
    assert.ok(hasText(prompt, '최신 파일 내용입니다') && hasText(prompt, 'original\n'));
    return JSON.stringify({ operations: [{ type: 'edit', path: 'file.txt', oldText: 'original\n', newText: 'updated\n' }], done: true, summary: 'Rebased using the next worker model.' });
  } });
  const run = await settled(engine, (await engine.create({ ...f.input, roles: { ...f.input.roles, worker }, rounds: 1 })).id);
  assert.equal(run.status, 'completed', run.summary);
  assert.deepEqual(workerModels, ['worker-edit-primary', 'worker-edit-primary', 'worker-edit-primary', 'worker-edit-backup']);
  assert.equal(run.stageModels.worker.id, 'worker-edit-backup');
  assert.ok(run.events.some((event) => event.title.startsWith('편집 오류 반복 · 대체 모델 전환')));
  assert.equal(await readFile(join(f.source, 'file.txt'), 'utf8'), 'updated\n');
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
  assert.equal(run.status, 'completed', run.summary); assert.equal(run.round, 2); assert.equal(typedCalls, 5);
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

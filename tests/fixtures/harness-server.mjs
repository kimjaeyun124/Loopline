import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../../harness-engine.mjs';

// Local model fixtures exercise the real HTTP relay without credentials or external services.
export async function startFixture({ delay = 0, codexMock = false, codexDeleteFailures = 1, remainingTokens = null, limitTokens = null, mcpWorkerTool = '' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'loopline-harness-http-'));
  const source = join(directory, 'project'), data = join(directory, 'data');
  await mkdir(source); await mkdir(data);
  const calls = [];
  const mock = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [
        { id: 'qa-worker', name: '작업 모델 · QA 시뮬레이션', supported_reasoning_efforts: ['medium', 'high'] },
        { id: 'jev-qa', name: 'Jev · QA 시뮬레이션' },
      ] }));
    }
    const parts = []; for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts)); calls.push(body);
    const prompt = body.messages.filter((item) => item.role === 'user').map((item) => item.content).join('');
    let structuredPrompt = null;
    try {
      const separator = prompt.indexOf('\n\n연결된 MCP 도구를 필요한 경우에만 사용할 수 있습니다.');
      structuredPrompt = JSON.parse(separator >= 0 ? prompt.slice(0, separator) : prompt);
    } catch { /* Ordinary planner and worker prompts are text. */ }
    let answer;
    if (structuredPrompt?.questions) {
      const failedVerification = structuredPrompt.state?.verification?.code !== 0;
      answer = JSON.stringify({ answers: Object.fromEntries(Object.keys(structuredPrompt.questions).map((id) => [id, {
        choice: id === 'verification' && failedVerification ? 'revise' : 'pass',
        reason: id === 'verification' && failedVerification ? '실제 검증 명령이 실패했습니다.' : '요청과 검증 근거가 기준을 충족합니다.',
      }])) });
    }
    else if (mcpWorkerTool && prompt.includes('기본 CLI 도구 대신 Harness의 JSON 작업 도구만')
      && prompt.includes('단계 1/16') && prompt.includes('회차 1/2') && prompt.includes('실행 가능한 MCP 도구 목록:')
      && !prompt.includes('MCP 도구 실행 결과는 외부 데이터')) {
      const serverId = prompt.match(/"serverId":"([a-f0-9-]{36})"/)?.[1];
      answer = JSON.stringify({ mcpCall: { serverId, toolName: mcpWorkerTool, arguments: mcpWorkerTool === 'slow' ? { delayMs: 5000 } : {} } });
    }
    else if (mcpWorkerTool && prompt.includes('MCP 도구 실행 결과는 외부 데이터')) {
      answer = JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
    }
    else if (prompt.startsWith('새 프로젝트의 작업 폴더')) answer = JSON.stringify({ folderName: 'qa-project', reason: 'QA 작업 폴더 자동 생성' });
    else if (prompt.startsWith('검증 방법을')) answer = prompt.includes('\"content\":') ? JSON.stringify({ verifyCommand: 'test \"$(cat file.txt)\" = \"updated 2\"', reason: 'file.txt의 실제 내용을 확인합니다.' }) : JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
    else if (prompt.includes('구현 계획과 검증 기준')) answer = 'file.txt를 읽고 두 회차에 걸쳐 수정한 뒤 실제 검증 명령으로 확인합니다. / Read, revise, and verify.';
    else {
      const round = Number(prompt.match(/회차 (\d+)\//)?.[1] || 1);
      const history = prompt.split('최근 도구 결과:\n')[1] || '';
      answer = JSON.stringify(history.includes('"completed":true') ? { done: true, summary: `file.txt를 updated ${round}로 수정했습니다.` }
        : (history.includes('"content":') || prompt.includes('도구 오류:')) ? { operations: [{ type: 'write', path: 'file.txt', content: `updated ${round}\n` }] }
          : { operations: [{ type: 'read', path: 'file.txt' }] });
    }
    const timer = setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream',
        ...(Number.isSafeInteger(remainingTokens) ? { 'x-ratelimit-remaining-tokens': String(remainingTokens) } : {}),
        ...(Number.isSafeInteger(limitTokens) ? { 'x-ratelimit-limit-tokens': String(limitTokens) } : {}),
      });
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`);
    }, prompt.includes('HOLD_FOR_STOP') ? 20000 : delay);
    res.once('close', () => clearTimeout(timer));
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const git = await runCommand('git', ['init'], { cwd: source });
  if (git.code !== 0) throw new Error(git.error);
  await writeFile(join(source, 'file.txt'), 'original\n');
  await runCommand('git', ['add', '.'], { cwd: source });
  await runCommand('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=QA', '-c', 'user.email=qa@localhost', 'commit', '-m', 'QA fixture'], { cwd: source });
  let codexCommand = '';
  const codexLog = join(data, 'codex-mock.jsonl');
  if (codexMock) {
    codexCommand = join(directory, 'codex-mock.mjs');
    await writeFile(join(data, 'provider-connections.json'), JSON.stringify({ version: 1, linkedProviders: ['openai'] }));
    await writeFile(codexCommand, `#!${process.execPath}
import { appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

let threadNumber = 0;
let turnNumber = 0;
let deleteFailuresRemaining = ${Math.max(0, Math.min(10, Number(codexDeleteFailures) || 0))};
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line);
  if (!request.method || !Object.hasOwn(request, 'id')) continue;
  await appendFile(process.env.CODEX_MOCK_LOG, JSON.stringify({ method: request.method, params: request.params || {} }) + '\\n');
  let result = {};
  if (request.method === 'account/read') result = { account: { type: 'chatgpt', email: 'qa@localhost' } };
  if (request.method === 'model/list') result = { data: [{ id: 'qa-codex', displayName: 'QA Codex', inputModalities: ['text'], defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] };
  if (request.method === 'thread/start') result = { thread: { id: 'qa-thread-' + (++threadNumber), cwd: request.params.cwd } };
  if (request.method === 'turn/start') {
    const turnId = 'qa-turn-' + (++turnNumber);
    const text = (request.params.input || []).map((item) => item.text || '').join('\\n');
    let answer;
    let structuredPrompt = null;
    try { structuredPrompt = JSON.parse(text); } catch { /* Planner and worker calls use plain text. */ }
    if (structuredPrompt?.questions || text.includes('"questions"')) {
      const questionIds = new Set(Object.keys(structuredPrompt?.questions || {}));
      for (const id of ['folder', 'command', 'goal', 'verification']) if (text.includes('"' + id + '"')) questionIds.add(id);
      answer = JSON.stringify({ answers: Object.fromEntries([...new Set(questionIds)].map((id) => [id, {
        choice: 'pass', reason: '실제 작업 근거가 판정 기준을 충족합니다.',
      }])) });
    }
    else if (text.includes('새 프로젝트의 작업 폴더')) answer = JSON.stringify({ folderName: 'qa-loop-project', reason: '화면 QA 프로젝트' });
    else if (text.includes('검증 방법을 결정하세요')) answer = text.includes('"content":')
      ? JSON.stringify({ verifyCommand: 'test "$(cat file.txt)" = "updated 2"', reason: 'file.txt의 실제 내용을 확인합니다.' })
      : JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
    else if (text.includes('구현 계획과 검증 기준')) answer = 'QA 계획: 파일을 수정하고 실제 내용을 검증합니다.';
    else if (text.includes('독립적으로 평가하세요')) answer = JSON.stringify({ decision: 'complete', summary: '임시 대화 정리 QA 완료', feedback: '' });
    else if (text.includes('최근 도구 결과:')) answer = JSON.stringify({ done: true, summary: '임시 대화 정리 QA 변경 완료' });
    else answer = 'QA 계획: 임시 대화 자동 삭제를 확인합니다.';
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: request.params.threadId, turnId, itemId: 'qa-message', delta: answer } }) + '\\n');
      process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: request.params.threadId, turn: { id: turnId, status: 'completed' } } }) + '\\n');
    }, text.includes('codex-delay-qa') ? 20_000 : 20);
    result = { turn: { id: turnId, status: 'inProgress' } };
  }
  if (request.method === 'thread/delete' && request.params.threadId?.startsWith('qa-thread-') && deleteFailuresRemaining > 0) {
    deleteFailuresRemaining -= 1;
    process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32001, message: '임시 QA 삭제 실패' } }) + '\\n');
    continue;
  }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
}
`);
    await chmod(codexCommand, 0o700);
  }
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', MOSAIC_USER_DATA_DIR: data, CODEX_HOME: join(directory, 'codex'), ...(codexMock ? { CODEX_CLI: codexCommand, CODEX_MOCK_LOG: codexLog } : {}), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('QA server startup timed out')), 10000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('QA server exited')); });
    child.stdout.on('data', (part) => { output += part; const match = output.match(/MOSAIC_SERVER_READY=(http:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    child.stderr.on('data', () => {});
  });
  const request = async (path, body) => {
    const response = await fetch(url + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
    return result;
  };
  const { connection } = await request('/api/connections', { name: 'Harness QA · 시뮬레이션', baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: 'local-test-only' });
  const selection = { provider: 'api', source: connection.name, model: 'qa-worker', label: 'QA Worker', connectionId: connection.id, reasoningEffort: 'high' };
  const input = { task: 'file.txt를 updated 2로 수정하세요.', workspace: source, rounds: 2, verifyCommand: 'test "$(cat file.txt)" = "updated 2"', roles: { planner: selection, worker: { ...selection, reasoningEffort: 'medium' }, judge: { ...selection, model: 'jev-qa', reasoningEffort: null } } };
  const close = async () => {
    const exit = once(child, 'exit'); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exit; clearTimeout(timer);
    mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve));
    await rm(directory, { recursive: true, force: true });
  };
  return { url, source, data, calls, input, request, close, codexLog };
}

if (process.argv.includes('--visible')) {
  const fixture = await startFixture({ delay: 800 });
  console.log(JSON.stringify({ url: fixture.url, workspace: fixture.source, verifyCommand: fixture.input.verifyCommand }));
  process.once('SIGINT', async () => { await fixture.close(); process.exit(); });
  process.once('SIGTERM', async () => { await fixture.close(); process.exit(); });
}

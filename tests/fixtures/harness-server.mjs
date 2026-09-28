import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../../harness-engine.mjs';

// Local model fixtures exercise the real HTTP relay without credentials or external services.
export async function startFixture({ delay = 0 } = {}) {
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
    let answer;
    if (prompt.startsWith('새 프로젝트의 작업 폴더')) answer = JSON.stringify({ folderName: 'qa-project', reason: 'QA 작업 폴더 자동 생성' });
    else if (prompt.startsWith('검증 방법을')) answer = prompt.includes('\"content\":') ? JSON.stringify({ verifyCommand: 'test \"$(cat file.txt)\" = \"updated 2\"', reason: 'file.txt의 실제 내용을 확인합니다.' }) : JSON.stringify({ operations: [{ type: 'read', path: 'file.txt' }] });
    else if (prompt.includes('구현 계획과 검증 기준')) answer = 'file.txt를 읽고 두 회차에 걸쳐 수정한 뒤 실제 검증 명령으로 확인합니다. / Read, revise, and verify.';
    else if (prompt.startsWith('변경 결과를')) {
      const passed = prompt.includes('"code":0');
      answer = JSON.stringify({ decision: passed ? 'complete' : 'revise', summary: passed ? '검증 통과 · 두 번째 회차 완료 / Verified and completed' : '다음 회차에서 updated 2로 수정 / Revision needed', feedback: passed ? '' : 'file.txt를 updated 2로 수정하세요.' });
    } else {
      const round = Number(prompt.match(/회차 (\d+)\//)?.[1] || 1);
      const history = prompt.split('최근 도구 결과:\n')[1] || '';
      answer = JSON.stringify(history.includes('"completed":true') ? { done: true, summary: `file.txt를 updated ${round}로 수정했습니다.` }
        : (history.includes('"content":') || prompt.includes('도구 오류:')) ? { operations: [{ type: 'write', path: 'file.txt', content: `updated ${round}\n` }] }
          : { operations: [{ type: 'read', path: 'file.txt' }] });
    }
    const timer = setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
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
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', MOSAIC_USER_DATA_DIR: data, CODEX_HOME: join(directory, 'codex'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
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
  const selection = { provider: 'api', model: 'qa-worker', connectionId: connection.id, reasoningEffort: 'high' };
  const input = { task: 'file.txt를 updated 2로 수정하세요.', workspace: source, rounds: 2, verifyCommand: 'test "$(cat file.txt)" = "updated 2"', roles: { planner: selection, worker: { ...selection, reasoningEffort: 'medium' }, judge: { ...selection, model: 'jev-qa', reasoningEffort: null } } };
  const close = async () => {
    const exit = once(child, 'exit'); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exit; clearTimeout(timer);
    mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve));
    await rm(directory, { recursive: true, force: true });
  };
  return { url, source, data, calls, input, request, close };
}

if (process.argv.includes('--visible')) {
  const fixture = await startFixture({ delay: 800 });
  console.log(JSON.stringify({ url: fixture.url, workspace: fixture.source, verifyCommand: fixture.input.verifyCommand }));
  process.once('SIGINT', async () => { await fixture.close(); process.exit(); });
  process.once('SIGTERM', async () => { await fixture.close(); process.exit(); });
}

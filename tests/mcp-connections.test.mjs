import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpConnections } from '../mcp-connections.mjs';
import { startFixture } from './fixtures/harness-server.mjs';

const mcpServerFile = fileURLToPath(new URL('./fixtures/mcp-stdio-server.mjs', import.meta.url));

async function until(check, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('MCP QA did not reach the expected state');
}

async function connectMcp(fixture) {
  const log = join(fixture.data, 'mcp-calls.log');
  const saved = await fixture.request('/api/mcp/servers', {
    name: 'Local MCP QA',
    transport: 'stdio',
    command: process.execPath,
    args: [mcpServerFile],
    env: { QA_MCP_LOG: log, QA_SECRET_VALUE: 'must-not-be-saved-in-plain-text' },
  });
  const connected = await fixture.request(`/api/mcp/servers/${saved.id}/connect`, {});
  return { ...connected, log };
}

test('remote Streamable HTTP MCP uses the saved Bearer token without exposing it in connection metadata', async (t) => {
  const token = 'qa-mcp-bearer-token';
  const calls = [];
  const server = createServer(async (req, res) => {
    calls.push({ method: req.method, authorization: req.headers.authorization || '' });
    if (req.method === 'GET') {
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': connected\n\n');
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push({ method: message.method, authorization: req.headers.authorization || '' });
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
      return;
    }
    if (message.method.startsWith('notifications/')) {
      res.writeHead(202).end();
      return;
    }
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'remote-qa', version: '1.0.0' } }
      : message.method === 'tools/list'
        ? { tools: [{ name: 'remote_status', description: 'Remote QA status.', inputSchema: { type: 'object', properties: {} } }] }
        : message.method === 'tools/call'
          ? { content: [{ type: 'text', text: 'REMOTE_MCP_OK' }] }
          : {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const directory = await mkdtemp(join(tmpdir(), 'loopline-mcp-http-'));
  const manager = new McpConnections(directory);
  t.after(async () => {
    await manager.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const address = server.address();
  const saved = await manager.save({
    name: 'Remote MCP QA',
    transport: 'http',
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
  });
  const connected = await manager.connect(saved.id);
  assert.equal(connected.connected, true);
  assert.deepEqual(connected.tools.map((tool) => tool.name), ['remote_status']);
  const result = await manager.callTool(saved.id, 'remote_status', {});
  assert.match(result.output, /REMOTE_MCP_OK/);
  assert.ok(calls.length >= 3);
  assert.ok(calls.every((item) => item.authorization === `Bearer ${token}`));
  const metadata = await readFile(join(directory, 'mcp-connections.json'), 'utf8');
  assert.equal(metadata.includes(token), false);
});

test('local stdio MCP connects, lists tools, runs an allowlisted tool, and keeps environment secrets out of metadata', async (t) => {
  const fixture = await startFixture({ mcpWorkerTool: 'get_status' }); t.after(fixture.close);
  const server = await connectMcp(fixture);
  assert.equal(server.connected, true);
  assert.deepEqual(server.tools.map((tool) => tool.name), ['get_status', 'slow']);
  const metadata = await readFile(join(fixture.data, 'mcp-connections.json'), 'utf8');
  assert.equal(metadata.includes('must-not-be-saved-in-plain-text'), false);
  assert.equal(metadata.includes('QA_SECRET_VALUE'), false);

  const created = await fixture.request('/api/harness/runs', {
    ...fixture.input,
    mcpTools: [{ serverId: server.id, name: 'get_status' }],
  });
  const run = await until(async () => {
    const current = await fixture.request(`/api/harness/runs/${created.id}`);
    return current.finishedAt ? current : null;
  });
  assert.equal(run.status, 'completed', run.summary);
  assert.equal(run.mcpCalls, 1);
  assert.equal(await readFile(server.log, 'utf8'), 'get_status\n');
  const event = run.events.find((item) => item.title.includes('MCP tool · get_status'));
  assert.ok(event);
  assert.equal(event.status, 'completed');
  assert.match(event.detail, /MCP_FIXTURE_OK/);
  const workerEvent = run.events.find((item) => item.model?.role === 'worker' && item.title.startsWith('구현'));
  const prompt = await fixture.request(`/api/harness/runs/${run.id}/events/${workerEvent.id}/prompt`);
  assert.match(prompt.input, /get_status/);
  assert.match(prompt.input, /MCP/);
});

test('an MCP tool omitted from the run selection is rejected before any server call', async (t) => {
  const fixture = await startFixture({ mcpWorkerTool: 'slow' }); t.after(fixture.close);
  const server = await connectMcp(fixture);
  const created = await fixture.request('/api/harness/runs', {
    ...fixture.input,
    mcpTools: [{ serverId: server.id, name: 'get_status' }],
  });
  const run = await until(async () => {
    const current = await fixture.request(`/api/harness/runs/${created.id}`);
    return current.finishedAt ? current : null;
  });
  assert.equal(run.status, 'failed');
  assert.equal(run.mcpCalls || 0, 0);
  await assert.rejects(readFile(server.log, 'utf8'), { code: 'ENOENT' });
});

test('stopping an in-flight MCP call marks the run as unsafe to resume', async (t) => {
  const fixture = await startFixture({ mcpWorkerTool: 'slow' }); t.after(fixture.close);
  const server = await connectMcp(fixture);
  const created = await fixture.request('/api/harness/runs', {
    ...fixture.input,
    mcpTools: [{ serverId: server.id, name: 'slow' }],
  });
  await until(async () => {
    try { return (await readFile(server.log, 'utf8')).includes('slow\n') ? true : null; }
    catch { return null; }
  });
  await fixture.request(`/api/harness/runs/${created.id}/stop`, {});
  const run = await until(async () => {
    const current = await fixture.request(`/api/harness/runs/${created.id}`);
    return current.finishedAt ? current : null;
  });
  assert.equal(run.status, 'stopped');
  assert.equal(run.canResume, false);
  assert.equal(run.mcpSideEffectPossible, true);
  assert.ok(run.events.some((item) => item.title.includes('MCP tool · slow') && item.status === 'stopped'));
});

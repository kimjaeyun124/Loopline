import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

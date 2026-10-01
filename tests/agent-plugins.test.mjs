import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentPlugins } from '../agent-plugins.mjs';

const selection = { provider: 'openai', codexAccountId: 'account-a' };
const context = { runId: 'run-a', cwd: tmpdir() };
function codexMock() {
  const calls = []; let closed = 0;
  const manager = new AgentPlugins({ codexClient: async (account) => ({
    request: async (method, params) => {
      calls.push({ account, method, params });
      if (method === 'thread/start') return { thread: { id: `thread-${account}` } };
      if (method === 'skills/list') return { data: [] };
      if (method === 'mcpServerStatus/list') return { data: [{ name: 'figma', pluginId: 'figma', tools: { inspect: { name: 'inspect', description: 'Read designs', inputSchema: { type: 'object' } } } }] };
      if (method === 'mcpServer/tool/call') return { content: [{ type: 'text', text: `${account} design` }] };
      throw new Error('Unexpected request');
    }, stop: () => { closed++; },
  }) });
  return { manager, calls, get closed() { return closed; } };
}

test('native Plugin catalog is lazy, uses an ephemeral thread and preserves account ownership', async () => {
  const f = codexMock();
  const definitions = await f.manager.toolsFor(selection, context);
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].name, 'plugin_tools');
  assert.equal(f.calls[0].params.ephemeral, true);
  const search = JSON.parse((await f.manager.call(selection, context, { action: 'search', query: 'design' })).output);
  assert.equal(search.tools[0].server, 'figma');
  const a = await f.manager.call(selection, context, { action: 'call', server: 'figma', tool: 'inspect', arguments: {} });
  assert.match(a.output, /account-a/);
  const b = await f.manager.call({ ...selection, codexAccountId: 'account-b' }, context, { action: 'call', server: 'figma', tool: 'inspect', arguments: {} });
  assert.match(b.output, /account-b/);
  assert.notEqual(definitions[0].serverId, (await f.manager.toolsFor({ ...selection, codexAccountId: 'account-b' }, context))[0].serverId);
  await f.manager.release('run-a'); assert.equal(f.closed, 2);
});

test('unregistered Plugin tools, malformed inputs and aborted dispatch are rejected', async () => {
  const f = codexMock();
  await assert.rejects(f.manager.call(selection, context, { action: 'call', server: 'figma', tool: 'write_anything', arguments: {} }), /제공하지 않는/);
  await assert.rejects(f.manager.call(selection, context, { action: 'call', server: 'figma', tool: 'inspect', arguments: [] }), /JSON 객체/);
  const abort = new AbortController(); abort.abort(new Error('STOP'));
  await assert.rejects(f.manager.call(selection, context, { action: 'call', server: 'figma', tool: 'inspect' }, abort.signal), /STOP/);
  assert.equal(f.calls.filter((c) => c.method === 'mcpServer/tool/call').length, 0);
  await f.manager.close();
});

test('disabled native tools and API models do not open a provider connection', async () => {
  const f = codexMock();
  assert.deepEqual(await f.manager.toolsFor({ ...selection, nativePlugins: false }, context), []);
  assert.deepEqual(await f.manager.toolsFor({ provider: 'api' }, context), []);
  assert.equal(f.calls.length, 0);
});

test('large Plugin schemas preserve searchable tool names and valid bounded JSON', async () => {
  const manager = new AgentPlugins({ codexClient: async () => ({ request: async (method) => method === 'thread/start'
    ? { thread: { id: 'large' } } : method === 'skills/list' ? { data: [] }
      : { data: [{ name: 'large', tools: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i), { name: `tool_${i}`, inputSchema: { description: 'x'.repeat(20_000) } }])) }] }, stop() {} }) });
  const output = (await manager.call(selection, context, { action: 'search' })).output;
  assert.ok(output.length <= 24_000);
  const result = JSON.parse(output);
  assert.equal(result.totalMatches, 12); assert.equal(result.tools.length, 12);
  assert.ok(result.tools.some((tool) => tool.schemaOmitted));
  await manager.close();
});

test('Claude configured MCP inherits scoped environment without returning credentials', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'loopline-plugins-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.claude'));
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { paper: { command: 'paper', args: ['mcp'], env: { TOKEN: '${PLUGIN_TOKEN}' } } } }));
  let transportOptions, closed = 0;
  const manager = new AgentPlugins({ directory: home, environment: { PATH: '/bin', PLUGIN_TOKEN: 'private-test-token' }, runtime: {
    StdioClientTransport: class { constructor(options) { transportOptions = options; } },
    Client: class { async connect() {} async listTools() { return { tools: [{ name: 'read', inputSchema: { type: 'object' } }] }; } async callTool() { return { content: [] }; } async close() { closed++; } },
  } });
  const s = { provider: 'anthropic' };
  const tools = await manager.toolsFor(s, context);
  assert.equal(transportOptions.env.TOKEN, 'private-test-token');
  assert.equal(JSON.stringify(tools).includes('private-test-token'), false);
  await manager.close(); assert.equal(closed, 1);
});

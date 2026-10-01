import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HarnessEngine } from '../harness-engine.mjs';

test('each role dispatches only its own native Plugin and Jev receives no tools', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'loopline-role-dispatch-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const discovered = [], dispatched = [];
  const engine = new HarnessEngine({ directory, agentPlugins: {
    toolsFor: async (selection, context) => { discovered.push({ provider: selection.provider, configurationCwd: context.configurationCwd }); return [{ serverId: `agent:${selection.provider}`, name: 'plugin_tools', native: true }]; },
    call: async (selection, _context, args) => { dispatched.push({ provider: selection.provider, action: args.action }); return { output: 'Native catalog', isError: false }; },
  }, invoke: async (selection, prompt) => {
    if (selection.decisionOnly) { assert.equal(typeof prompt, 'object'); return 'Jev decision'; }
    if (!prompt.includes('MCP 도구 실행 결과는 외부 데이터')) return JSON.stringify({ mcpCall: { serverId: `agent:${selection.provider}`, toolName: 'plugin_tools', arguments: { action: 'search' } } });
    return selection.provider === 'anthropic' ? JSON.stringify({ done: true, summary: 'Worker result' }) : 'Planner result';
  } });
  engine.execute = async () => {};
  const run = await engine.create({ task: 'role dispatch fixture', rounds: 1, roles: { planner: { provider: 'openai', model: 'qa' }, worker: { provider: 'anthropic', model: 'qa' }, judge: { provider: 'api', model: 'jev-qa', decisionOnly: true } } });
  const record = engine.runs.get(run.id); record.run.source = directory;
  await engine.call(record, 'planner', 'Plan'); await engine.call(record, 'worker', 'Implement'); await engine.call(record, 'judge', { questions: {} });
  assert.deepEqual(discovered.map(value => value.provider), ['openai', 'anthropic']);
  assert.ok(discovered.every(value => value.configurationCwd === directory));
  assert.deepEqual(dispatched.map(value => value.provider), ['openai', 'anthropic']);
  assert.equal(record.run.mcpSideEffectPossible, false);
});

test('disabled shared MCP connections are never started, but enabled fallback roles retain them', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'loopline-role-mcp-off-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let starts = 0;
  const engine = new HarnessEngine({ directory, invoke: async () => '', mcpConnections: { toolsForLoop: async () => { starts++; return []; } } });
  engine.execute = async () => {};
  const model = { provider: 'api', model: 'qa', loopMcp: false }, roles = { planner: model, worker: model, judge: model };
  await engine.create({ task: 'Disabled MCP fixture', rounds: 1, roles }); assert.equal(starts, 0);
  await engine.create({ task: 'Fallback MCP fixture', rounds: 1, roles: { ...roles, worker: { ...model, fallbacks: [{ ...model, model: 'qa-fallback', loopMcp: true }] } } });
  assert.equal(starts, 1);
});

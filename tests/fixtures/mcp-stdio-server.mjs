import { appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
const delayed = new Map();

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }

for await (const line of input) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (!Object.hasOwn(request, 'id')) {
    if (request.method === 'notifications/cancelled') {
      const timer = delayed.get(request.params?.requestId);
      if (timer) clearTimeout(timer);
      delayed.delete(request.params?.requestId);
    }
    continue;
  }
  let result;
  if (request.method === 'initialize') {
    result = {
      protocolVersion: request.params?.protocolVersion || '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'loopline-qa-mcp', version: '1.0.0' },
    };
  } else if (request.method === 'tools/list') {
    const extraCount = Math.max(0, Math.min(120, Number(process.env.QA_MCP_EXTRA_TOOL_COUNT) || 0));
    result = { tools: [
      { name: 'get_status', description: 'Return a fixed local QA status.', inputSchema: { type: 'object', properties: {} } },
      { name: 'slow', description: 'Wait until cancelled for stop-flow QA.', inputSchema: { type: 'object', properties: { delayMs: { type: 'number' } } } },
      ...Array.from({ length: extraCount }, (_, index) => ({
        name: `extra_${index + 1}`,
        description: 'Additional MCP QA tool description. '.repeat(24),
        inputSchema: { type: 'object', properties: { input: { type: 'string' } } },
      })),
    ] };
  } else if (request.method === 'tools/call') {
    const name = request.params?.name;
    if (process.env.QA_MCP_LOG) await appendFile(process.env.QA_MCP_LOG, `${name}\n`);
    if (name === 'slow') {
      const delay = Math.max(1, Math.min(10_000, Number(request.params?.arguments?.delayMs) || 5000));
      const timer = setTimeout(() => {
        delayed.delete(request.id);
        send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'MCP_SLOW_COMPLETED' }] } });
      }, delay);
      delayed.set(request.id, timer);
      continue;
    }
    result = { content: [{ type: 'text', text: 'MCP_FIXTURE_OK' }] };
  } else if (request.method === 'ping') result = {};
  else {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
    continue;
  }
  send({ jsonrpc: '2.0', id: request.id, result });
}

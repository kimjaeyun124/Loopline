import test from 'node:test';
import assert from 'node:assert/strict';
import { HarnessEngine } from '../harness-engine.mjs';
import { RESPONSE_SCHEMAS } from '../harness-response-schemas.mjs';

test('verification response schema permits only bounded read/list requests or a reasoned command', () => {
  const schema = RESPONSE_SCHEMAS.verificationProposal;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['operations', 'verifyCommand', 'reason']);
  assert.deepEqual(schema.anyOf, [
    { properties: { operations: { minItems: 1 } } },
    { properties: { verifyCommand: { minLength: 1 }, reason: { minLength: 1 } } },
  ]);

  const operations = schema.properties.operations;
  assert.equal(operations.minItems ?? 0, 0);
  assert.equal(operations.maxItems, 12);
  const operationSchemas = operations.items.anyOf;
  assert.deepEqual(operationSchemas.map((schema) => schema.properties.type.enum), [['list'], ['read']]);
  assert.equal(operationSchemas[1].properties.path.type, 'string');
  assert.equal(operationSchemas.every((schema) => schema.additionalProperties === false), true);

  assert.equal(schema.properties.verifyCommand.maxLength, 1000);
  assert.equal(schema.properties.reason.type, 'string');
});

test('verification planner calls pass the structured response schema to the selected model', async () => {
  const engine = new HarnessEngine({ directory: '/tmp', invoke: async () => assert.fail('invokeMeasured is captured') });
  let receivedSchema;
  engine.event = async () => ({ id: 'verification-event', status: 'running', detail: '' });
  engine.persist = async () => {};
  engine.invokeMeasured = async (_record, _role, _selection, _prompt, _eventId, options) => {
    receivedSchema = options.responseSchema;
    return { operations: [{ type: 'read', path: 'README.md' }] };
  };

  const record = {
    controller: new AbortController(),
    run: {
      roles: { planner: { provider: 'anthropic', model: 'claude-sonnet-5', label: 'Claude Sonnet 5', nativePlugins: false } },
      modelPriority: { planner: [] }, modelBudgets: {}, modelUsage: {}, modelCalls: [], stageModels: {}, mcpTools: [],
      instructions: '', task: '오프라인 웹 앱 QA', round: 1, rounds: 1, priorities: { speed: 'low' },
    },
  };

  const result = await engine.call(record, 'planner', '검증 방법을 제안하세요. 실제 변경 내용을 검토하세요.');

  assert.deepEqual(result, { operations: [{ type: 'read', path: 'README.md' }] });
  assert.deepEqual(receivedSchema, RESPONSE_SCHEMAS.verificationProposal);
});

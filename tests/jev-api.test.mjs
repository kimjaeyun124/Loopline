import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiConnections } from '../api-connections.mjs';
import { HarnessEngine } from '../harness-engine.mjs';
import { RESPONSE_SCHEMAS, decisionResponseSchema } from '../harness-response-schemas.mjs';
import { applyBrowserPlanPatch, validateBrowserPlan, QA_CATEGORIES } from '../browser-qa.mjs';

test('structured response schemas require every property and keep action-specific values', () => {
  const inspect = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') {
      assert.deepEqual(node.required, Object.keys(node.properties));
      assert.equal(node.additionalProperties, false);
    }
    Object.values(node).forEach((value) => Array.isArray(value) ? value.forEach(inspect) : inspect(value));
  };
  Object.values(RESPONSE_SCHEMAS).forEach(inspect);
  const decision = decisionResponseSchema({ final: {}, qaSave: {} }); inspect(decision);
  assert.deepEqual(decision.properties.answers.required, ['final', 'qaSave']);
  assert.equal(RESPONSE_SCHEMAS.browserPlan.properties.notApplicable.anyOf.length, 16);
  assert.deepEqual(RESPONSE_SCHEMAS.browserPlan.properties.notApplicable.anyOf[0].properties, {});
});

const displayCheck = (id, steps = 1) => ({ id, categories: [], steps: Array.from({ length: steps }, () => ({ action: 'visible', selector: '#status' })) });
const displayPlan = (count = 1, steps = 1) => ({ entry: 'index.html', checks: Array.from({ length: count }, (_, i) => displayCheck(`case-${i}`, steps)),
  notApplicable: Object.fromEntries(QA_CATEGORIES.map(category => [category, '이 과제는 사용자 입력과 저장 상태가 없는 정적 안내 화면입니다.'])) });

test('browser generation bounds match accepted and rejected executor boundaries', () => {
  const checks = RESPONSE_SCHEMAS.browserPlan.properties.checks;
  const steps = checks.items.properties.steps;
  assert.deepEqual([checks.minItems, checks.maxItems], [1, 16]);
  assert.deepEqual([steps.minItems, steps.maxItems], [1, 24]);
  for (const count of [checks.minItems, checks.maxItems]) {
    const plan = displayPlan(count); assert.deepEqual(validateBrowserPlan(plan), plan);
  }
  for (const count of [checks.minItems - 1, checks.maxItems + 1]) assert.throws(() => validateBrowserPlan(displayPlan(count)), /검사는 1~16개/);
  for (const count of [steps.minItems, steps.maxItems]) {
    const plan = displayPlan(1, count); assert.deepEqual(validateBrowserPlan(plan), plan);
  }
  for (const count of [steps.minItems - 1, steps.maxItems + 1]) assert.throws(() => validateBrowserPlan(displayPlan(1, count)), /단계는 1~24개/);
});

test('bounded browser patch arrays preserve empty alternatives and combined runtime guards', () => {
  const schema = RESPONSE_SCHEMAS.browserPatch.properties;
  for (const name of ['addChecks', 'replaceChecks', 'extendChecks']) {
    assert.equal(schema[name].maxItems, 16); assert.equal(schema[name].minItems ?? 0, 0);
    assert.deepEqual([schema[name].items.properties.steps.minItems, schema[name].items.properties.steps.maxItems], [1, 24]);
  }
  const base = displayPlan(), original = structuredClone(base);
  const patch = { addChecks: [], replaceChecks: [], extendChecks: [{ id: 'case-0', steps: displayCheck('unused', 23).steps }], notApplicable: {} };
  assert.equal(applyBrowserPlanPatch(base, patch).checks[0].steps.length, 24);
  patch.extendChecks[0].steps.push({ action: 'visible', selector: '#status' });
  assert.throws(() => applyBrowserPlanPatch(base, patch), /단계는 1~24개/, 'individual schema bounds cannot replace the merged step limit');
  assert.throws(() => applyBrowserPlanPatch(displayPlan(16), { addChecks: [displayCheck('extra')] }), /검사는 1~16개/);
  assert.throws(() => applyBrowserPlanPatch(base, { addChecks: displayPlan(8).checks, replaceChecks: displayPlan(9).checks }), /보완할 검사는 최대 16개/);
  assert.throws(() => applyBrowserPlanPatch(base, { replaceChecks: [displayCheck('case-0')] }), /실패한 검사만 교체/);
  assert.deepEqual(base, original, 'rejected patches must not mutate the accepted plan');
});

const question = { type: 'choice', instructions: 'Does evidence pass?', criteria: { pass: 'yes', revise: 'no', uncertain: 'unknown' } };
const valid = () => ({ model: 'jev-test-version', answers: { goal: { type: 'choice', choice: 'pass', confidence: 0.95, probabilities: { pass: 0.98, revise: 0.01, uncertain: 0.01 } } }, usage: { input_tokens: 20, output_tokens: 3 } });
async function setup(t, reply = () => Response.json(valid())) {
  const dir = await mkdtemp(join(tmpdir(), 'loopline-jev-test-')); const calls = [];
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/models')) return Response.json({ models: [{ name: 'jev-latest' }] });
    return reply(options);
  });
  const api = new ApiConnections(dir);
  const connection = await api.connect({ name: 'Jev', baseUrl: 'https://api.typesafe.ai/v1', apiKey: 'test-only-secret' });
  return { dir, api, connection, calls, evaluate: (signal = new AbortController().signal, onUsage, timeoutMs) => api.evaluate(connection.id, 'jev-latest', { state: { diff: 'QA' }, questions: { goal: question } }, { signal, onUsage, timeoutMs }) };
}

async function setupChatConnection(t, reply) {
  const dir = await mkdtemp(join(tmpdir(), 'loopline-api-timeout-test-'));
  const calls = [];
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'qa-model', name: 'QA model' }] });
    return reply(options);
  });
  const api = new ApiConnections(dir);
  const connection = await api.connect({ name: 'QA API', baseUrl: 'https://api.example.test/v1', apiKey: 'test-only-secret' });
  return { api, connection, calls };
}

test('API sends browser generation bounds without removing strict response validation', async (t) => {
  let calls = 0, usageCalls = 0;
  const f = await setupChatConnection(t, options => {
    const body = JSON.parse(options.body), schema = body.response_format.json_schema;
    assert.equal(schema.strict, true);
    const expected = calls++ === 0 ? RESPONSE_SCHEMAS.browserPlan : RESPONSE_SCHEMAS.browserPatch;
    assert.deepEqual(schema.schema, expected);
    const bounded = schema.schema.properties.checks || schema.schema.properties.addChecks;
    assert.equal(bounded.maxItems, 16); assert.equal(bounded.items.properties.steps.maxItems, 24);
    return Response.json({ choices: [{ message: { content: JSON.stringify(displayPlan()) } }], usage: { total_tokens: 20 } });
  });
  for (const responseSchema of [RESPONSE_SCHEMAS.browserPlan, RESPONSE_SCHEMAS.browserPatch]) {
    await f.api.chat(f.connection.id, 'qa-model', [], { signal: new AbortController().signal, responseSchema,
      onDelta() {}, onUsage: () => usageCalls++, onSchemaFallback: () => assert.fail('No unsupported-format response was returned') });
  }
  assert.equal(calls, 2); assert.equal(usageCalls, 2);
});

test('API forwards strict schemas and falls back once only for explicit unsupported format', async (t) => {
  let requests = 0, fallback = 0, usageCalls = 0;
  const f = await setupChatConnection(t, (options) => {
    const body = JSON.parse(options.body);
    if (++requests === 1) {
      assert.deepEqual(body.response_format.json_schema.schema, RESPONSE_SCHEMAS.project);
      assert.equal(body.response_format.json_schema.strict, true);
      return Response.json({ error: { param: 'response_format', message: 'response_format is not supported' } }, { status: 400 });
    }
    assert.equal(body.response_format, undefined);
    return Response.json({ choices: [{ message: { content: '{"folderName":"qa","reason":"Test project"}' } }], usage: { total_tokens: 30 } });
  });
  await f.api.chat(f.connection.id, 'qa-model', [], { signal: new AbortController().signal,
    responseSchema: RESPONSE_SCHEMAS.project, onSchemaFallback: () => fallback++, onDelta() {}, onUsage: () => usageCalls++ });
  assert.equal(requests, 2); assert.equal(fallback, 1); assert.equal(usageCalls, 1);
});

test('invalid schemas and authentication never downgrade structured output', async (t) => {
  let status = 400, requests = 0;
  const f = await setupChatConnection(t, () => { requests++; return Response.json({ error: { param: 'response_format', message: 'Invalid JSON schema: private detail' } }, { status }); });
  for (status of [400, 401]) await assert.rejects(f.api.chat(f.connection.id, 'qa-model', [], {
    signal: new AbortController().signal, responseSchema: RESPONSE_SCHEMAS.project, onDelta() {}, onSchemaFallback: () => assert.fail('No downgrade'),
  }), (error) => error.remoteStatus === status && !error.message.includes('private detail'));
  assert.equal(requests, 2);
});
test('Jev native protocol preserves typed answers, accounts usage and never saves the session key', async (t) => {
  const f = await setup(t); let usage;
  const result = await f.evaluate(undefined, (value) => { usage = value; });
  assert.equal(f.connection.decisionOnly, true); assert.equal(f.connection.models[0].decisionOnly, true);
  assert.deepEqual(result, valid()); assert.deepEqual(usage, valid().usage);
  assert.equal(f.calls[1].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(f.calls[1].options.redirect, 'manual');
  assert.equal(JSON.parse(f.calls[1].options.body).questions.goal.type, 'choice');
  assert.ok(!(await readFile(join(f.dir, 'api-connections.json'), 'utf8')).includes('test-only-secret'));
  await assert.rejects(f.api.chat(f.connection.id, 'jev-latest', [], { signal: new AbortController().signal }), /판정 전용/);
});
test('missing or invalid Jev answers never count as successful decisions', async (t) => {
  const bad = [null, [], 42, 'pass', {}, { ...valid(), answers: {} }, { ...valid(), answers: { goal: { ...valid().answers.goal, choice: 'invented' } } }, { ...valid(), answers: { goal: { ...valid().answers.goal, probabilities: { pass: 0.1, revise: 0.8, uncertain: 0.1 } } } }];
  const responses = bad.length;
  const f = await setup(t, () => Response.json(bad.shift()));
  for (let i = 0; i < responses; i++) await assert.rejects(f.evaluate(), (error) => {
    assert.match(error.message, /불완전/);
    return error.invalidStructuredOutput === true && error.invalidJudgeOutput === true;
  });
});
test('malformed Jev JSON is a format failure while HTTP outages remain transport failures', async (t) => {
  let status = 200;
  const f = await setup(t, () => new Response('Not JSON', { status }));
  await assert.rejects(f.evaluate(), (error) => error.invalidStructuredOutput === true && error.invalidJudgeOutput === true);
  status = 503;
  await assert.rejects(f.evaluate(), (error) => error.remoteStatus === 503 && !error.invalidStructuredOutput);
});

test('Harness repairs native Jev format once with feedback in the actual systemone request', async (t) => {
  let reviews = 0;
  const f = await setup(t, (options) => {
    reviews++;
    const body = JSON.parse(options.body);
    assert.equal(body.questions.goal.criteria.pass, question.criteria.pass);
    assert.equal(body.questions.goal.criteria.revise, question.criteria.revise);
    assert.equal(body.questions.goal.criteria.uncertain, 'Evidence is missing or insufficient to decide.');
    assert.equal(body.state.task, 'QA goal');
    if (reviews === 1) return Response.json({ ...valid(), answers: {} });
    assert.match(body.state.responseFormatCorrection, /형식 오류/);
    return Response.json(valid());
  });
  const judge = { provider: 'api', model: 'jev-latest', connectionId: f.connection.id, decisionOnly: true };
  const record = { controller: new AbortController(), writes: Promise.resolve(), run: {
    id: randomUUID(), roles: { judge }, modelPriority: { judge: [] }, modelBudgets: {}, modelUsage: {},
    stageModels: {}, instructions: '', round: 1, rounds: 2, mcpTools: [], events: [],
  } };
  const engine = new HarnessEngine({ directory: f.dir, invoke: (selection, prompt, _instructions, signal, onSignal) => f.api.evaluate(
    selection.connectionId, selection.model, prompt, { signal, onUsage: (usage) => onSignal({ type: 'usage', usage }) },
  ) });
  const result = await engine.decide(record, { task: 'QA goal' }, { goal: {
    label: '목표', question: question.instructions, pass: question.criteria.pass, revise: question.criteria.revise,
  } });
  assert.equal(result.decision, 'complete'); assert.equal(reviews, 2);
  assert.equal(record.run.events.filter((event) => event.title.startsWith('응답 형식 보완')).length, 1);
  assert.equal(Object.values(record.run.modelUsage).reduce((sum, usage) => sum + usage.totalTokens, 0), 46);
});

test('Jev authentication failures redact upstream bodies and redirects are refused', async (t) => {
  let status = 401; const f = await setup(t, () => new Response('test-only-secret', { status }));
  await assert.rejects(f.evaluate(), (error) => error.remoteStatus === 401 && !error.message.includes('test-only-secret'));
  status = 302; await assert.rejects(f.evaluate(), /다른 주소로 이동/);
});
test('Jev cancellation propagates and releases connection for removal', async (t) => {
  let started; const ready = new Promise((resolve) => { started = resolve; });
  const f = await setup(t, (options) => new Promise((resolve, reject) => { started(); options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); }));
  const controller = new AbortController(); const pending = f.evaluate(controller.signal); await ready;
  controller.abort(new Error('QA stopped')); await assert.rejects(pending, /QA stopped/);
  await f.api.remove(f.connection.id);
});

test('Jev supports a longer Harness timeout while retaining cancellation', async (t) => {
  const f = await setup(t, (options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  await assert.rejects(f.evaluate(new AbortController().signal, undefined, 25), /Jev 판정 시간이 초과되었습니다/);
  await f.api.remove(f.connection.id);
});

test('OpenAI-compatible model calls enforce the supplied Harness timeout', async (t) => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const f = await setupChatConnection(t, (options) => new Promise((resolve, reject) => {
    started(); options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  const controller = new AbortController();
  const pending = f.api.chat(f.connection.id, 'qa-model', [{ role: 'user', content: 'slow request' }], {
    signal: controller.signal, timeoutMs: 25, onDelta() {},
  });
  await ready;
  await assert.rejects(pending, /API 응답 시간이 초과되었습니다/);
  assert.equal(controller.signal.aborted, false, 'the configured timeout must not be mistaken for user cancellation');
  await f.api.remove(f.connection.id);
});

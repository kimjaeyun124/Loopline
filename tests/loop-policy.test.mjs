import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticLoopStartRounds, classifyLoopTask, DEFAULT_LOOP_PRIORITIES, extendAutomaticLoopRounds, MAX_AUTO_LOOP_ROUNDS, MAX_LOOP_ROUNDS, normalizeLoopPriorities, recommendLoopEffort, selectAutomaticLoopModel } from '../public/loop-policy.mjs';

test('loop complexity keeps small requests light and raises effort for broad engineering changes', () => {
  assert.equal(classifyLoopTask('Export a small constant and test its value.'), 'simple');
  assert.equal(classifyLoopTask('데이터베이스 마이그레이션과 동시성 문제를 포함한 구조 변경을 진행해 주세요.'), 'complex');
  assert.equal(classifyLoopTask('- one\n- two\n- three\n- four'), 'complex');
});

test('automatic loop starts with task-sized rounds and extends in bounded quality-first steps', () => {
  assert.equal(MAX_LOOP_ROUNDS, 10);
  assert.equal(MAX_AUTO_LOOP_ROUNDS, 20);
  assert.equal(automaticLoopStartRounds('Export a small constant.'), 4);
  assert.equal(automaticLoopStartRounds('Implement a database migration and concurrency-safe cache.'), 6);
  assert.equal(extendAutomaticLoopRounds(4), 6);
  assert.equal(extendAutomaticLoopRounds(8), 10);
  assert.equal(extendAutomaticLoopRounds(10), 12);
  assert.equal(extendAutomaticLoopRounds(18), 20);
  assert.equal(extendAutomaticLoopRounds(20), 20);
  assert.equal(extendAutomaticLoopRounds(6, 5), 6);
});

test('automatic effort puts quality and compute first by default and follows resource priorities when reordered', () => {
  const supported = ['low', 'medium', 'high', 'max'];
  assert.equal(recommendLoopEffort('planner', supported, 'Fix one label.'), 'max');
  assert.equal(recommendLoopEffort('worker', supported, 'Fix one label.'), 'max');
  assert.equal(recommendLoopEffort('judge', supported, 'Fix one label.'), 'max');
  const complexTask = 'Refactor the architecture and improve concurrency handling.';
  assert.equal(recommendLoopEffort('planner', supported, complexTask), 'max');
  assert.equal(recommendLoopEffort('worker', supported, complexTask), 'max');
  assert.equal(recommendLoopEffort('judge', supported, complexTask), 'max');
  assert.equal(recommendLoopEffort('planner', ['low', 'high'], complexTask), 'high');
  const resourceFirst = ['tokenEfficiency', 'speed', 'quality', 'reasoning'];
  assert.equal(recommendLoopEffort('worker', supported, 'Fix one label.', resourceFirst), 'medium');
  assert.equal(recommendLoopEffort('worker', supported, complexTask, resourceFirst), 'high');
  assert.equal(recommendLoopEffort('worker', supported, 'Fix one label.', ['reasoning', 'quality', 'tokenEfficiency', 'speed']), 'max');
  assert.equal(recommendLoopEffort('worker', [], 'Anything'), null);
});

test('completion stays fixed and invalid saved priority values normalize to the full supported order', () => {
  assert.deepEqual(DEFAULT_LOOP_PRIORITIES, ['quality', 'reasoning', 'tokenEfficiency', 'speed']);
  assert.deepEqual(normalizeLoopPriorities(['speed', 'speed', 'unknown']), ['speed', 'quality', 'reasoning', 'tokenEfficiency']);
  assert.deepEqual(normalizeLoopPriorities(null), DEFAULT_LOOP_PRIORITIES);
});

test('automatic roles share the implementation model, prefer Jev for review, and otherwise use another connection', () => {
  const models = [
    { id: 'codex', provider: 'openai', connected: true },
    { id: 'claude', provider: 'anthropic', connected: true },
    { id: 'grok', provider: 'api', connectionId: 'xai', connected: true },
    { id: 'jev', provider: 'api', connectionId: 'typesafe', connected: true, decisionOnly: true },
    { id: 'offline', provider: 'api', connectionId: 'offline', connected: false },
  ];
  const key = (model) => model.id;
  assert.equal(selectAutomaticLoopModel('worker', models, key, { currentModelKey: 'grok' })?.id, 'grok');
  assert.equal(selectAutomaticLoopModel('worker', models, key, { currentModelKey: 'codex', workerModelKey: 'grok' })?.id, 'grok');
  assert.equal(selectAutomaticLoopModel('planner', models, key, { currentModelKey: 'codex', workerModelKey: 'grok' })?.id, 'grok');
  assert.equal(selectAutomaticLoopModel('judge', models, key, { currentModelKey: 'grok' })?.id, 'jev');
  const withoutJev = models.filter((model) => model.id !== 'jev');
  assert.equal(selectAutomaticLoopModel('judge', withoutJev, key, { currentModelKey: 'grok' })?.id, 'codex');
  assert.equal(selectAutomaticLoopModel('judge', withoutJev.filter((model) => model.id === 'grok'), key, { currentModelKey: 'grok' })?.id, 'grok');
});


test('automatic roles prefer the measured mix and skip known exhausted accounts', () => {
  const models = [
    { id: 'gpt-6-luna', provider: 'openai', connected: true },
    { id: 'gpt-6-sol', provider: 'openai', connected: true, remainingPercent: 20 },
    { id: 'models/gemini-3-flash-preview', provider: 'api', connectionId: 'gemini', connected: true },
    { id: 'jev', provider: 'api', connected: true, decisionOnly: true },
  ];
  const key = (model) => model.id;
  const options = { currentModelKey: 'gpt-6-luna' };
  assert.equal(selectAutomaticLoopModel('worker', models, key, options).id, 'gpt-6-sol');
  assert.equal(selectAutomaticLoopModel('planner', models, key, options).id, 'models/gemini-3-flash-preview');
  assert.equal(selectAutomaticLoopModel('judge', models, key, options).id, 'jev');
  assert.equal(selectAutomaticLoopModel('worker', models, key, { ...options, workerModelKey: 'gpt-6-luna' }).id, 'gpt-6-luna');
  models[1].remainingPercent = 0;
  assert.equal(selectAutomaticLoopModel('worker', models, key, options).id, 'gpt-6-luna');
  assert.equal(selectAutomaticLoopModel('worker', [{ ...models[1] }], key, options), null);
  models[2].connected = false;
  assert.equal(selectAutomaticLoopModel('planner', models, key, options).id, 'gpt-6-luna');
});

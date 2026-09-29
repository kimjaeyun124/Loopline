import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLoopTask, recommendLoopEffort, selectAutomaticLoopModel } from '../public/loop-policy.mjs';

test('loop complexity keeps small requests light and raises effort for broad engineering changes', () => {
  assert.equal(classifyLoopTask('Export a small constant and test its value.'), 'simple');
  assert.equal(classifyLoopTask('데이터베이스 마이그레이션과 동시성 문제를 포함한 구조 변경을 진행해 주세요.'), 'complex');
  assert.equal(classifyLoopTask('- one\n- two\n- three\n- four'), 'complex');
});

test('automatic effort uses the lowest suitable level for simple work and a stronger level for complex work', () => {
  const supported = ['low', 'medium', 'high', 'max'];
  assert.equal(recommendLoopEffort('planner', supported, 'Fix one label.'), 'low');
  assert.equal(recommendLoopEffort('worker', supported, 'Fix one label.'), 'medium');
  assert.equal(recommendLoopEffort('judge', supported, 'Fix one label.'), 'low');
  const complexTask = 'Refactor the architecture and improve concurrency handling.';
  assert.equal(recommendLoopEffort('planner', supported, complexTask), 'medium');
  assert.equal(recommendLoopEffort('worker', supported, complexTask), 'high');
  assert.equal(recommendLoopEffort('judge', supported, complexTask), 'medium');
  assert.equal(recommendLoopEffort('planner', ['low', 'high'], complexTask), 'high');
  assert.equal(recommendLoopEffort('worker', [], 'Anything'), null);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { modelSelectionStrength } from '../public/model-capabilities.mjs';

test('Codex model descriptions become concise Korean selection guidance', () => {
  assert.equal(modelSelectionStrength({ description: 'Frontier intelligence for the most demanding work.' }), '최난도 작업 · 깊은 추론');
  assert.equal(modelSelectionStrength({ description: 'Previous generation workhorse model.' }), '범용 작업 · 폭넓은 처리');
  assert.equal(modelSelectionStrength({ description: 'Fast and affordable model for easier tasks.' }), '가벼운 작업 · 빠르고 효율적');
  assert.equal(modelSelectionStrength({ description: 'Older balanced model for straightforward work.' }), '일반 작업 · 속도와 추론의 균형');
});

test('unknown provider descriptions remain available and effort metadata is the fallback', () => {
  assert.equal(modelSelectionStrength({ description: 'Specialized model for long context.' }), 'Specialized model for long context.');
  assert.equal(modelSelectionStrength({ provider: 'openai', supportedReasoningEfforts: [{ reasoningEffort: 'max' }] }), '높은 추론 강도 지원');
  assert.equal(modelSelectionStrength({ provider: 'openai', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }), '빠른 응답을 위한 낮은 추론 강도 지원');
  assert.equal(modelSelectionStrength({ provider: 'api', reasoningEfforts: [] }), '');
});

export const CLAUDE_MODEL_CAPABILITIES = Object.freeze({
  'claude-sonnet-5': Object.freeze({
    reasoningEfforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
    defaultReasoningEffort: 'high',
  }),
  'claude-opus-5': Object.freeze({
    reasoningEfforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
    defaultReasoningEffort: 'high',
  }),
  'claude-haiku-4-5-20251001': Object.freeze({
    reasoningEfforts: Object.freeze([]),
    defaultReasoningEffort: null,
  }),
});

const MODEL_SELECTION_STRENGTHS = Object.freeze([
  [/frontier intelligence|most demanding work/i, '최난도 작업 · 깊은 추론'],
  [/fast and affordable|fast and efficient/i, '가벼운 작업 · 빠르고 효율적'],
  [/workhorse model/i, '범용 작업 · 폭넓은 처리'],
  [/balanced model|balances speed and reasoning/i, '일반 작업 · 속도와 추론의 균형'],
  [/legacy coding model/i, '코딩 중심 · 이전 세대 모델'],
]);

export function modelSelectionStrength(model) {
  const description = typeof model?.description === 'string' ? model.description.trim() : '';
  if (description) {
    const strength = MODEL_SELECTION_STRENGTHS.find(([pattern]) => pattern.test(description));
    return strength?.[1] || description;
  }
  const efforts = model?.provider === 'openai'
    ? (model.supportedReasoningEfforts || []).map((item) => item.reasoningEffort)
    : model?.reasoningEfforts || [];
  if (efforts.includes('ultra') || efforts.includes('max')) return '높은 추론 강도 지원';
  if (efforts.includes('low')) return '빠른 응답을 위한 낮은 추론 강도 지원';
  return '';
}

export function modelEffortCapability(provider, modelId) {
  if (provider === 'anthropic') return CLAUDE_MODEL_CAPABILITIES[modelId] || null;
  return null;
}

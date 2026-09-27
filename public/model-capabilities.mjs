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

export function modelEffortCapability(provider, modelId) {
  if (provider === 'anthropic') return CLAUDE_MODEL_CAPABILITIES[modelId] || null;
  return null;
}

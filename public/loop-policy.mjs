const DEEP_TASK = /\b(?:architecture|architectural|refactor(?:ing)?|migration|migrate|security|concurrency|database|performance|optimization|integration|distributed|race condition|multi[- ]file)\b|아키텍처|구조 변경|리팩토링|마이그레이션|보안|동시성|경쟁 조건|데이터베이스|성능|최적화|통합|대규모|여러\s*파일/i;
export const MAX_LOOP_ROUNDS = 10;
export const MAX_AUTO_LOOP_ROUNDS = 20;
export const LOOP_PRIORITY_DIMENSIONS = Object.freeze([
  { id: 'quality', label: '결과 품질' },
  { id: 'reasoning', label: '추론 투입량' },
  { id: 'tokenEfficiency', label: '토큰 효율' },
  { id: 'speed', label: '응답 속도' },
]);
export const DEFAULT_LOOP_PRIORITIES = Object.freeze(LOOP_PRIORITY_DIMENSIONS.map(({ id }) => id));
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function classifyEvidenceTaskType(task) {
  if (/(?:\bCLI\b|command.line|명령줄)/i.test(task)) return 'cli';
  if (/(?:website|web\s*(?:app|page|site)|dashboard|front.end|\bUI\b|웹|화면|디자인)/i.test(task)) return 'web';
  if (/(?:API|backend|server|서버|백엔드)/i.test(task)) return 'backend';
  return 'general';
}

export function normalizeLoopPriorities(value) {
  const allowed = new Set(DEFAULT_LOOP_PRIORITIES);
  const requested = Array.isArray(value) ? value.filter((id) => allowed.has(id)) : [];
  return [...new Set(requested), ...DEFAULT_LOOP_PRIORITIES.filter((id) => !requested.includes(id))];
}

export function classifyLoopTask(task) {
  const text = String(task || '').trim();
  const checklistItems = text.split('\n').filter((line) => /^\s*(?:[-*•]|\d+[.)])\s/.test(line)).length;
  return text.length >= 600 || DEEP_TASK.test(text) || checklistItems >= 4 ? 'complex' : 'simple';
}

export function automaticLoopStartRounds(task) {
  return classifyLoopTask(task) === 'complex' ? 6 : 4;
}

export function extendAutomaticLoopRounds(current, ceiling = MAX_AUTO_LOOP_ROUNDS) {
  if (!Number.isInteger(current) || current < 1 || !Number.isInteger(ceiling) || ceiling < current) return current;
  return Math.min(ceiling, current + 2);
}

export function recommendLoopEffort(role, supportedEfforts, task, priorities = DEFAULT_LOOP_PRIORITIES) {
  if (!Array.isArray(supportedEfforts) || !supportedEfforts.length) return null;
  const supported = [...new Set(supportedEfforts)].sort((left, right) => EFFORT_ORDER.indexOf(left) - EFFORT_ORDER.indexOf(right));
  const normalizedPriorities = normalizeLoopPriorities(priorities);
  const qualityPosition = normalizedPriorities.indexOf('quality');
  const reasoningPosition = normalizedPriorities.indexOf('reasoning');
  const efficiencyPosition = Math.min(normalizedPriorities.indexOf('tokenEfficiency'), normalizedPriorities.indexOf('speed'));
  const computePosition = Math.min(qualityPosition, reasoningPosition);
  if (computePosition < efficiencyPosition) {
    const offset = computePosition === 0 ? 0 : 1;
    return supported[Math.max(0, supported.length - 1 - offset)];
  }
  const complex = classifyLoopTask(task) === 'complex';
  const preferences = complex
    ? { planner: ['medium', 'high', 'xhigh', 'max', 'ultra', 'low'], worker: ['high', 'medium', 'xhigh', 'max', 'ultra', 'low'], judge: ['medium', 'low', 'high', 'xhigh', 'max', 'ultra'] }
    : { planner: ['low', 'medium', 'high'], worker: ['medium', 'low', 'high'], judge: ['low', 'medium', 'high'] };
  const order = preferences[role] || preferences.worker;
  return [...order, ...supported].find((effort, index, all) => supported.includes(effort) && all.indexOf(effort) === index) || null;
}

function sameConnection(left, right) {
  return left?.provider === right?.provider && (left?.connectionId || '') === (right?.connectionId || '');
}

export function selectAutomaticLoopModel(role, models, getKey, { currentModelKey = '', workerModelKey = '' } = {}) {
  const available = (Array.isArray(models) ? models : []).filter((model) => model?.connected
    && !(Number.isFinite(model.remainingPercent) && model.remainingPercent <= 0)
    && (role === 'judge' || !model.decisionOnly));
  if (!available.length) return null;
  const find = (key) => key ? available.find((model) => getKey(model) === key) : null;
  // This measured combination is a starting preference, not a price or quality ranking
  // for unknown models. Explicit role choices and saved fallback order remain separate.
  const id = (model) => String(model.id || '').replace(/^models\//, '');
  const worker = find(workerModelKey)
    || available.find((model) => model.provider === 'openai' && id(model) === 'gpt-6-sol')
    || find(currentModelKey) || available.find((model) => !model.decisionOnly) || null;

  if (role === 'worker') return worker || available[0];
  if (role === 'planner') return available.find((model) => id(model) === 'gemini-3-flash-preview') || worker || available[0];
  if (role === 'judge') {
    return available.find((model) => model.decisionOnly)
      || available.find((model) => worker && !sameConnection(model, worker))
      || worker
      || available[0];
  }
  return worker || available[0];
}

function hasSamples(item, countField, valueField, minimumRuns) {
  return Number.isSafeInteger(item?.evidence?.[countField])
    && item.evidence[countField] >= minimumRuns
    && Number.isFinite(item.evidence[valueField]);
}

function comparableMetric(items, minimumRuns, countField, valueField, direction, label) {
  if (!items.every((item) => hasSamples(item, countField, valueField, minimumRuns))) return null;
  return { value: (item) => item.evidence[valueField], direction, label };
}

export function rankLoopModelCandidates(candidates, priorities = DEFAULT_LOOP_PRIORITIES, {
  minimumRuns = 3,
  taskType = 'general',
} = {}) {
  const available = (Array.isArray(candidates) ? candidates : []).filter((item) => item?.model?.connected
    && !(Number.isFinite(item.model.remainingPercent) && item.model.remainingPercent <= 0));
  const measured = available.filter((item) => item.evidence?.sufficientEvidence === true
    && Number.isFinite(item.evidence.completionConfidenceLowerBound));
  const metrics = [];

  if (measured.length > 1) {
    const orderedPriorities = normalizeLoopPriorities(priorities);
    for (const priority of orderedPriorities) {
      if (priority === 'quality') {
        const verification = comparableMetric(measured, minimumRuns, 'verificationMeasuredRuns', 'verificationPassRate', 'desc', '검증 통과율');
        if (verification) metrics.push(verification);
        if (taskType === 'web') {
          const browserQa = comparableMetric(measured, minimumRuns, 'browserQaRuns', 'browserQaPassRate', 'desc', '브라우저 QA');
          if (browserQa) metrics.push(browserQa);
        }
        const recoveries = comparableMetric(measured, minimumRuns, 'completionMeasuredRuns', 'meanRunRecoveries', 'asc', '평균 복구 횟수');
        if (recoveries) metrics.push(recoveries);
      } else if (priority === 'tokenEfficiency') {
        const tokens = comparableMetric(measured, minimumRuns, 'fullyReportedRuns', 'meanReportedTokens', 'asc', '평균 토큰');
        if (tokens) metrics.push(tokens);
      } else if (priority === 'speed') {
        const duration = comparableMetric(measured, minimumRuns, 'durationRuns', 'meanModelTimeMs', 'asc', '평균 모델 시간');
        if (duration) metrics.push(duration);
      }
      // No common, independent reasoning benchmark is collected. Catalog claims
      // and supported Effort options are shown as capabilities, never scores.
    }
  }

  const ranked = [...measured].sort((left, right) => {
    const completion = right.evidence.completionConfidenceLowerBound - left.evidence.completionConfidenceLowerBound;
    if (completion) return completion;
    for (const metric of metrics) {
      const delta = metric.value(left) - metric.value(right);
      if (delta) return metric.direction === 'desc' ? -delta : delta;
    }
    return available.indexOf(left) - available.indexOf(right);
  });
  return {
    available,
    measured: ranked,
    recommended: ranked[0] || null,
    mode: ranked.length > 1 ? 'measured' : ranked.length === 1 ? 'single-measured' : 'provisional',
    comparableMetrics: metrics.map(({ label }) => label),
    minimumRuns,
  };
}

const DEEP_TASK = /\b(?:architecture|architectural|refactor(?:ing)?|migration|migrate|security|concurrency|database|performance|optimization|integration|distributed|race condition|multi[- ]file)\b|아키텍처|구조 변경|리팩토링|마이그레이션|보안|동시성|경쟁 조건|데이터베이스|성능|최적화|통합|대규모|여러\s*파일/i;
const PRODUCT_SCOPE_TASK = /\b(?:build|create|implement|develop|application|website|dashboard|backend|server|endpoint|service|feature|project|program)\b|웹사이트|대시보드|백엔드|서버|엔드포인트|서비스|앱|프로그램|기능|구현|제작|개발|만들기/i;
const HIGH_RISK_TASK = /\b(?:security|authentication|authorization|payment|database|migration|concurrency|race condition|production|architecture)\b|보안|인증|권한|결제|데이터베이스|마이그레이션|동시성|경쟁 조건|운영 환경|아키텍처/i;
export const MAX_LOOP_ROUNDS = 10;
export const MAX_AUTO_LOOP_ROUNDS = 20;
export const LOOP_BUDGET_PROFILES = Object.freeze({
  standard: { totalTokens: 2_000_000, preparationTokens: 500_000, modelTimeMs: 60 * 60_000, preparationTimeMs: 15 * 60_000 },
  extended: { totalTokens: 4_000_000, preparationTokens: 1_000_000, modelTimeMs: 120 * 60_000, preparationTimeMs: 30 * 60_000 },
  compact: { totalTokens: 1_000_000, preparationTokens: 250_000, modelTimeMs: 30 * 60_000, preparationTimeMs: 10 * 60_000 },
});

export function normalizeExecutionBudget(value, profile = 'standard') {
  const budget = { ...LOOP_BUDGET_PROFILES[Object.hasOwn(LOOP_BUDGET_PROFILES, profile) ? profile : 'standard'], ...(value || {}) };
  if (value != null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('실행 예산 형식이 올바르지 않습니다.');
  for (const [key, amount] of Object.entries(budget)) {
    if (!Object.hasOwn(LOOP_BUDGET_PROFILES.standard, key) || !Number.isSafeInteger(amount) || amount < 1 || amount > (key.endsWith('Ms') ? 12 * 60 * 60_000 : 20_000_000)) throw new Error('실행 예산은 허용 범위의 양의 정수여야 합니다.');
  }
  if (budget.preparationTokens > budget.totalTokens || budget.preparationTimeMs > budget.modelTimeMs) throw new Error('준비 예산은 전체 예산을 넘을 수 없습니다.');
  return budget;
}
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

export function classifyLoopModelTier(task) {
  const text = String(task || '').trim();
  const checklistItems = text.split('\n').filter((line) => /^\s*(?:[-*•]|\d+[.)])\s/.test(line)).length;
  if (!text) return 'standard';
  if (text.length >= 600 || DEEP_TASK.test(text) || checklistItems >= 4) return 'complex';
  if (text.length <= 220 && checklistItems < 3 && !PRODUCT_SCOPE_TASK.test(text)) return 'simple';
  return 'standard';
}

const normalizeModelId = (model) => String(model?.id || '').replace(/^models\//, '').toLocaleLowerCase();
const LOOP_MODEL_FAMILIES = Object.freeze({
  efficient: ['gpt-5.6-luna'],
  balanced: ['gpt-6-luna', 'gpt-5.6-terra'],
  coding: ['gpt-6-sol', 'gpt-5.6'],
  frontier: ['gpt-6-astra'],
  planner: ['gemini-3-flash-preview'],
});
const modelFamilyMatch = (model, family) => LOOP_MODEL_FAMILIES[family].includes(normalizeModelId(model))
  && (family === 'planner' || model?.provider === 'openai');

export function loopModelSelectionGuidance(role, task) {
  if (role === 'judge') return '판정은 연결된 Jev를 먼저 사용하고, 없으면 다른 연결의 판정 모델을 고릅니다.';
  const tier = classifyLoopModelTier(task);
  if (tier === 'simple') return '짧고 범위가 좁은 요청은 GPT-5.6 Luna를 먼저 시도합니다. 검사에서 문제가 나오면 저장된 후보로 전환할 수 있습니다.';
  if (tier === 'complex') return HIGH_RISK_TASK.test(String(task || ''))
    ? '보안·데이터·동시성처럼 위험도가 높은 작업은 연결된 GPT-6 Astra를 우선하고, GPT-6 Sol 또는 GPT-5.6 Sol 순으로 이어갑니다.'
    : '범위가 넓거나 여러 단계가 필요한 작업은 연결된 GPT-6 Sol 또는 GPT-5.6 Sol을 우선하고, GPT-6 Astra 순으로 이어갑니다.';
  return role === 'planner'
    ? '일반 기능 작업은 연결된 Gemini Flash를 계획에 우선 사용하고, 없으면 GPT-6 Luna·GPT-5.6 Terra 같은 균형형 후보를 고릅니다.'
    : '일반 기능 작업은 GPT-6 Luna·GPT-5.6 Terra 같은 균형형 후보를 먼저 사용하고, 더 강한 코딩 후보로 이어갑니다.';
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
  const efficiencyPosition = Math.min(normalizedPriorities.indexOf('tokenEfficiency'), normalizedPriorities.indexOf('speed'));
  if (normalizedPriorities[0] === 'reasoning') return supported.at(-1);
  const complex = classifyLoopTask(task) === 'complex';
  if (qualityPosition < efficiencyPosition) {
    const preferred = complex
      ? { planner: ['high', 'xhigh', 'max', 'ultra', 'medium'], worker: ['max', 'xhigh', 'high', 'ultra', 'medium'], judge: ['high', 'xhigh', 'max', 'ultra', 'medium'] }
      : { planner: ['medium', 'high', 'low'], worker: ['high', 'medium', 'low'], judge: ['high', 'medium', 'low'] };
    return [...(preferred[role] || preferred.worker), ...supported].find((effort) => supported.includes(effort));
  }
  const preferences = complex
    ? { planner: ['medium', 'high', 'xhigh', 'max', 'ultra', 'low'], worker: ['high', 'medium', 'xhigh', 'max', 'ultra', 'low'], judge: ['medium', 'low', 'high', 'xhigh', 'max', 'ultra'] }
    : { planner: ['low', 'medium', 'high'], worker: ['medium', 'low', 'high'], judge: ['low', 'medium', 'high'] };
  const order = preferences[role] || preferences.worker;
  return [...order, ...supported].find((effort, index, all) => supported.includes(effort) && all.indexOf(effort) === index) || null;
}

function sameConnection(left, right) {
  return left?.provider === right?.provider && (left?.connectionId || '') === (right?.connectionId || '');
}

export function automaticLoopModelOrder(role, models, getKey, { currentModelKey = '', workerModelKey = '', task = '', priorities = DEFAULT_LOOP_PRIORITIES } = {}) {
  const available = (Array.isArray(models) ? models : []).filter((model) => model?.connected
    && !(Number.isFinite(model.remainingPercent) && model.remainingPercent <= 0)
    && !(Number.isSafeInteger(model.remainingTokens) && model.remainingTokens <= 0)
    && (role === 'judge' || !model.decisionOnly));
  if (!available.length) return [];
  const find = (key) => key ? available.find((model) => getKey(model) === key) : null;
  const worker = find(workerModelKey) || null;
  if (role === 'judge') {
    const reviewModel = available.find((model) => model.decisionOnly)
      || available.find((model) => worker && !sameConnection(model, worker))
      || worker || available[0];
    return [reviewModel, ...available.filter((model) => model !== reviewModel)];
  }
  const tier = classifyLoopModelTier(task);
  const strongestFirst = normalizeLoopPriorities(priorities)[0] === 'reasoning';
  const highRisk = HIGH_RISK_TASK.test(String(task || ''));
  const familyOrder = tier === 'simple'
    ? strongestFirst
      ? ['frontier', 'coding', 'efficient', 'balanced']
      : ['efficient', 'balanced', 'coding', 'frontier']
    : tier === 'complex'
      ? highRisk
        ? ['frontier', 'coding', 'balanced', 'efficient']
        : ['coding', 'frontier', 'balanced', 'efficient']
      : role === 'planner'
        ? ['planner', 'balanced', 'coding', 'efficient', 'frontier']
        : ['balanced', 'coding', 'efficient', 'frontier', 'planner'];
  const ranked = [];
  const add = (model) => { if (model && !ranked.includes(model)) ranked.push(model); };
  add(worker);
  for (const family of familyOrder) add(available.find((model) => modelFamilyMatch(model, family)));
  // The selected chat model stays available as a fallback, after the task-fit
  // default. Unrecognized connected providers keep their catalog order.
  add(find(currentModelKey));
  for (const model of available) add(model);
  return ranked;
}

export function selectAutomaticLoopModel(role, models, getKey, options = {}) {
  return automaticLoopModelOrder(role, models, getKey, options)[0] || null;
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
        const callSuccess = comparableMetric(measured, minimumRuns, 'callSuccessMeasuredRuns', 'callSuccessRate', 'desc', '모델 호출 성공률');
        if (callSuccess) metrics.push(callSuccess);
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

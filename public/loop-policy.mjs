const DEEP_TASK = /\b(?:architecture|architectural|refactor(?:ing)?|migration|migrate|security|concurrency|database|performance|optimization|integration|distributed|race condition|multi[- ]file)\b|아키텍처|구조 변경|리팩토링|마이그레이션|보안|동시성|경쟁 조건|데이터베이스|성능|최적화|통합|대규모|여러\s*파일/i;

export function classifyLoopTask(task) {
  const text = String(task || '').trim();
  const checklistItems = text.split('\n').filter((line) => /^\s*(?:[-*•]|\d+[.)])\s/.test(line)).length;
  return text.length >= 600 || DEEP_TASK.test(text) || checklistItems >= 4 ? 'complex' : 'simple';
}

export function recommendLoopEffort(role, supportedEfforts, task) {
  if (!Array.isArray(supportedEfforts) || !supportedEfforts.length) return null;
  const complex = classifyLoopTask(task) === 'complex';
  const preferences = complex
    ? { planner: ['medium', 'high', 'xhigh', 'max', 'ultra', 'low'], worker: ['high', 'medium', 'xhigh', 'max', 'ultra', 'low'], judge: ['medium', 'low', 'high', 'xhigh', 'max', 'ultra'] }
    : { planner: ['low', 'medium', 'high'], worker: ['medium', 'low', 'high'], judge: ['low', 'medium', 'high'] };
  const order = preferences[role] || preferences.worker;
  return [...order, ...supportedEfforts].find((effort, index, all) => supportedEfforts.includes(effort) && all.indexOf(effort) === index) || null;
}

function sameConnection(left, right) {
  return left?.provider === right?.provider && (left?.connectionId || '') === (right?.connectionId || '');
}

export function selectAutomaticLoopModel(role, models, getKey, { currentModelKey = '', workerModelKey = '' } = {}) {
  const available = (Array.isArray(models) ? models : []).filter((model) => model?.connected && (role === 'judge' || !model.decisionOnly));
  if (!available.length) return null;
  const find = (key) => key ? available.find((model) => getKey(model) === key) : null;
  const worker = find(workerModelKey) || find(currentModelKey) || available.find((model) => !model.decisionOnly) || null;

  if (role === 'worker') return find(workerModelKey) || find(currentModelKey) || worker || available[0];
  if (role === 'planner') return worker || available[0];
  if (role === 'judge') {
    return available.find((model) => model.decisionOnly)
      || available.find((model) => worker && !sameConnection(model, worker))
      || worker
      || available[0];
  }
  return worker || available[0];
}

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const QA_CATEGORIES = ['input', 'save', 'empty', 'keyboard'];
const ACTIONS = new Set(['reset', 'reload', 'fill', 'click', 'press', 'visible', 'hidden', 'text', 'value', 'count', 'focused', 'focus-visible']);
export const BROWSER_QA_EXECUTOR = Object.freeze({
  viewports: [{ id: 'desktop', width: 1440, height: 900 }, { id: 'mobile', width: 390, height: 844 }],
  actions: [...ACTIONS],
  fixedChecks: [{ id: 'layout', after: 'every planned check and the final state', criteria: ['nonblank rendered page', 'no horizontal overflow', 'requested viewport width'] }],
  focusVisibleEvidence: 'focus-visible asserts keyboard focus plus a visible outline or a box shadow that changed from its unfocused style; focused alone asserts only the active element.',
});
const KEYS = new Set(['Tab', 'Enter', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space', 'Backspace']);
export function needsBrowserQa(task, files = '') {
  return /(?:website|web\s*(?:app|page|site)|front[- ]end|dashboard|landing\s*page|\bUI\b|웹\s*(?:사이트|앱|페이지)|프론트엔드|대시보드|랜딩|화면|디자인)/i.test(task)
    || /(?:^|\n).*\.(?:html|jsx|tsx|vue|svelte|astro)(?:\n|$)/i.test(files);
}
export function validateBrowserPlan(plan) {
  const invalid = (reason) => { throw Object.assign(new Error(`독립 QA 계획 오류: ${reason}`), { invalidStructuredOutput: true }); };
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) invalid('JSON 객체가 필요합니다.');
  if (typeof plan.entry !== 'string' || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.html$/.test(plan.entry) || plan.entry.includes('..')) invalid('실행 가능한 상대 HTML 경로가 필요합니다.');
  if (!Array.isArray(plan.checks) || plan.checks.length < 1 || plan.checks.length > 16) invalid('검사는 1~16개여야 합니다.');
  const ids = new Set(), covered = new Set();
  for (const check of plan.checks) {
    if (!check || typeof check.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(check.id) || ids.has(check.id)) invalid('검사 ID가 누락되거나 중복됐습니다.');
    ids.add(check.id);
    if (!Array.isArray(check.categories)) invalid(`${check.id}: categories는 배열이어야 합니다. 허용 분류: ${QA_CATEGORIES.join(', ')}.`);
    const unsupportedCategories = check.categories.filter((category) => !QA_CATEGORIES.includes(category));
    if (unsupportedCategories.length) invalid(`${check.id}: 지원하지 않는 검사 분류 ${JSON.stringify(unsupportedCategories).slice(0, 180)}입니다. 허용 분류: ${QA_CATEGORIES.join(', ')}. 추가 동작 검사는 기존 분류 또는 빈 배열을 사용하고 assertion을 유지하세요.`);
    check.categories.forEach((category) => covered.add(category));
    if (!Array.isArray(check.steps) || check.steps.length < 1 || check.steps.length > 24) invalid(`${check.id}: 검사 단계는 1~24개여야 합니다. 실제 단계 수: ${Array.isArray(check.steps) ? check.steps.length : '배열 아님'}. 긴 시나리오는 필요한 초기 입력과 assertion을 유지해 독립 검사로 나누세요.`);
    const assertions = check.steps.filter((step) => ['visible', 'hidden', 'text', 'value', 'count', 'focused', 'focus-visible'].includes(step?.action));
    if (!assertions.length) invalid('각 검사에 실제 assertion이 필요합니다.');
    const assertsAfter = (action) => {
      const index = check.steps.findLastIndex((step) => step.action === action);
      return index >= 0 && check.steps.slice(index + 1).some((step) => assertions.includes(step));
    };
    if (check.categories.includes('input') && !assertsAfter('fill')) invalid('입력 검사에는 실제 입력 이후의 assertion이 필요합니다.');
    if (check.categories.includes('save') && !assertsAfter('reload')) invalid('저장 검사에는 새로고침 이후의 assertion이 필요합니다.');
    if (check.categories.includes('empty') && !check.steps.some((s) => ['visible', 'hidden', 'count'].includes(s.action))) invalid('빈 상태의 표시 검사가 필요합니다.');
    if (check.categories.includes('keyboard') && !assertsAfter('press')) invalid('키보드 검사에는 실제 키 입력 이후의 assertion이 필요합니다.');
    for (const step of check.steps) {
      if (!step || !ACTIONS.has(step.action)) invalid('허용되지 않은 브라우저 동작입니다.');
      if (!['reset', 'reload', 'press'].includes(step.action) && (typeof step.selector !== 'string' || !step.selector.trim() || step.selector.length > 300)) invalid('검사할 selector가 필요합니다.');
      if (step.action === 'press' && !KEYS.has(step.key)) invalid('허용되지 않은 키 입력입니다.');
      if (['fill', 'text', 'value'].includes(step.action) && (typeof step.value !== 'string' || step.value.length > 2000)) invalid('검사 값이 올바르지 않습니다.');
      if (step.action === 'count' && (!Number.isSafeInteger(step.value) || step.value < 0 || step.value > 1000)) invalid('검사 개수가 올바르지 않습니다.');
    }
  }
  for (const category of QA_CATEGORIES) if (!covered.has(category)) {
    const reason = plan.notApplicable?.[category];
    if (typeof reason !== 'string' || reason.trim().length < 12 || reason.length > 500) invalid(`${category} 검사가 없으며 해당 없음의 구체적인 근거도 없습니다.`);
  }
  return JSON.parse(JSON.stringify(plan));
}

export function applyBrowserPlanPatch(plan, patch, replaceableCheckIds = []) {
  const base = validateBrowserPlan(plan);
  const invalid = (reason) => { throw Object.assign(new Error(`독립 QA 보완 오류: ${reason}`), { invalidStructuredOutput: true }); };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) invalid('JSON 보완 객체가 필요합니다.');
  const fields = new Set(['addChecks', 'replaceChecks', 'notApplicable']);
  if (Object.keys(patch).some((field) => !fields.has(field))) invalid('전체 계획을 다시 작성하지 마세요. addChecks, replaceChecks, notApplicable만 반환하세요. entry와 기존 검사 순서는 유지합니다.');
  const additions = patch.addChecks === undefined ? [] : patch.addChecks;
  const replacements = patch.replaceChecks === undefined ? [] : patch.replaceChecks;
  if (!Array.isArray(additions) || !Array.isArray(replacements)) invalid('addChecks와 replaceChecks는 배열이어야 합니다.');
  if (additions.length + replacements.length > 16) invalid('한 번에 보완할 검사는 최대 16개입니다.');
  const existing = new Map(base.checks.map((check) => [check.id, check]));
  const replaceable = new Set(replaceableCheckIds), changed = new Set(), replacementMap = new Map();
  for (const check of [...replacements, ...additions]) {
    if (!check || typeof check.id !== 'string' || changed.has(check.id)) invalid('추가·교체 검사 ID가 누락되거나 중복됐습니다.');
    changed.add(check.id);
  }
  for (const check of replacements) {
    const previous = existing.get(check.id);
    if (!previous || !replaceable.has(check.id)) invalid(`${String(check.id).slice(0, 64)}: 이번 판정에서 실패한 검사만 교체할 수 있습니다. 통과한 검사와 selector·assertion은 보존하세요.`);
    if (!Array.isArray(check.categories) || previous.categories.some((category) => !check.categories.includes(category))) invalid(`${check.id}: 기존 검사 분류를 삭제할 수 없습니다.`);
    replacementMap.set(check.id, check);
  }
  for (const check of additions) if (existing.has(check.id)) invalid(`${check.id}: 기존 ID를 새 검사로 추가할 수 없습니다.`);
  if (patch.notApplicable !== undefined && (!patch.notApplicable || typeof patch.notApplicable !== 'object' || Array.isArray(patch.notApplicable)
    || Object.keys(patch.notApplicable).some((category) => !QA_CATEGORIES.includes(category)))) invalid('notApplicable은 허용 분류에 대한 근거 객체여야 합니다.');
  for (const [category, reason] of Object.entries(patch.notApplicable || {})) {
    if (base.checks.some((check) => check.categories.includes(category))) invalid(`${category}: 기존 검사가 있는 기능을 해당 없음으로 바꿀 수 없습니다.`);
    if (typeof reason !== 'string' || reason.trim().length < 12 || reason.length > 500) invalid(`${category}: 해당 없음의 구체적인 근거가 필요합니다.`);
  }
  // Keep every earlier case, position and accepted selector. Only an explicit
  // failed-check verdict grants replacement; a missing feature grants addition.
  const merged = validateBrowserPlan({ ...base,
    checks: [...base.checks.map((check) => replacementMap.get(check.id) || check), ...additions],
    ...(patch.notApplicable && Object.keys(patch.notApplicable).length ? { notApplicable: { ...(base.notApplicable || {}), ...patch.notApplicable } } : {}),
  });
  if (isDeepStrictEqual(merged, base)) invalid('실제 보완 내용이 없습니다. 판정에서 누락된 행동 검사를 추가하거나 허용된 실패 검사만 고치세요.');
  return merged;
}

export class BrowserQaBridge {
  constructor(port = process.env.MOSAIC_DESKTOP === '1' ? process.parentPort : null) {
    this.port = port; this.pending = new Map();
    port?.on('message', ({ data }) => {
      if (data?.scope !== 'loopline-browser-qa' || !this.pending.has(data.id)) return;
      this.pending.get(data.id).finish(data.error ? new Error(data.error) : null, data.result);
    });
  }
  verify(input, signal) {
    if (!this.port) return Promise.resolve({ passed: false, checks: [], failures: ['독립 브라우저 QA는 Loopline 데스크톱에서 실행해야 합니다.'], unavailable: true });
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error, result) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(result);
      };
      const cancel = () => { this.port.postMessage({ scope: 'loopline-browser-qa', id, action: 'cancel' }); finish(signal?.reason || new Error('브라우저 QA를 중지했습니다.')); };
      const timer = setTimeout(() => { this.port.postMessage({ scope: 'loopline-browser-qa', id, action: 'cancel' }); finish(new Error('독립 브라우저 QA의 제한 시간에 도달했습니다.')); }, 120_000);
      this.pending.set(id, { finish }); signal?.addEventListener('abort', cancel, { once: true });
      this.port.postMessage({ scope: 'loopline-browser-qa', id, action: 'verify', input });
    });
  }
}

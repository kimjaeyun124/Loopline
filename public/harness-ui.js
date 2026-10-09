import { modelEffortCapability, modelSelectionStrength } from './model-capabilities.mjs';
import {
  automaticLoopModelOrder, classifyEvidenceTaskType, classifyLoopModelTier,
  LOOP_BUDGET_PROFILES, DEFAULT_LOOP_PRIORITIES, LOOP_PRIORITY_DIMENSIONS,
  MAX_AUTO_LOOP_ROUNDS, normalizeLoopPriorities, rankLoopModelCandidates,
  recommendLoopEffort, selectAutomaticLoopModel, loopModelSelectionGuidance,
} from './loop-policy.mjs';

const KEY = 'loopline.harness.v1';
const DONE = new Set(['completed', 'reviewed', 'failed', 'stopped', 'limit', 'blocked', 'interrupted']);
const ROLES = [['planner', '계획 / Planning'], ['worker', '구현 / Implementation'], ['judge', '판정 / Review']];
const MAX_FALLBACKS = 8;
const MAX_LOOP_MCP_TOOLS = 64;
const EVIDENCE_REASON_LABELS = new Map([
  ['invalid-shape', '기록 구조'], ['unsupported-version', '지원 버전'], ['id-mismatch', '파일 ID'],
  ['invalid-metadata', '실행 정보'], ['invalid-recoveries', '복구 횟수'], ['invalid-calls', '호출 목록'],
  ['invalid-call', '호출 데이터'], ['invalid-attribution', '실패 원인'], ['invalid-human-intervention', '개입 정보'],
  ['malformed-json', 'JSON 오류'], ['unreadable', '읽기 오류'],
]);
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function failedQaEvidence(qa, checks) {
  const failedChecks = checks.filter((check) => check?.passed !== true).length;
  if (failedChecks) return `${failedChecks}/${checks.length}개 검사 실패`;
  const failures = Array.isArray(qa.failures) ? qa.failures.length : 0;
  if (failures) return `추가 실패 근거 ${failures}개`;
  return checks.length ? '통과 근거 불충분' : '검사 근거 없음';
}

export function formatReadmeQaSummary(run) {
  const history = Array.isArray(run?.readmeQaHistory) ? run.readmeQaHistory : [];
  const qa = history.at(-1);
  if (!qa) return '';
  const round = Number.isSafeInteger(qa.round) && qa.round > 0 ? ` · ${qa.round}회차` : '';
  if (qa.applicable !== true) {
    return `\n\nREADME 실행 안내 QA: 미적용${round} · 적용할 로컬 실행 안내 없음 · 통과로 집계하지 않음`;
  }
  if (qa.skipped === true) return `\n\nREADME 실행 안내 QA: 검사 미완료${round} · 적용 대상이지만 실행되지 않음`;
  if (qa.passed === true) {
    const checks = Array.isArray(qa.checks) ? qa.checks.length : 0;
    return `\n\nREADME 실행 안내 QA: 통과${round} · ${checks}개 기본 주소·자산 검사`;
  }
  const checks = Array.isArray(qa.checks) ? qa.checks : [];
  const evidence = ` · ${failedQaEvidence(qa, checks)}`;
  return `\n\nREADME 실행 안내 QA: 실패${round}${evidence}`;
}

export function formatBrowserQaSummary(run) {
  const history = Array.isArray(run?.qaHistory) ? run.qaHistory : [];
  const qa = history.at(-1);
  if (!qa) return '';
  const passed = qa.passed === true;
  const round = Number.isSafeInteger(qa.round) && qa.round > 0 ? ` · ${qa.round}회차` : '';
  const checks = Array.isArray(qa.checks) ? qa.checks : [];
  const evidence = passed
    ? ` · ${checks.length}개 검사`
    : ` · ${failedQaEvidence(qa, checks)}`;
  return `\n\n독립 브라우저 QA: ${passed ? '통과' : '실패'}${round}${evidence}`;
}

export function createHarnessUI({ state, catalog, modelKey, currentKey, getProject, saveProjects, saveConversations, render, toast, instructions, onComplete, getMcpTools = () => [], refreshMcpTools = null }) {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }
  const hasSavedRoleModel = ROLES.some(([role]) => typeof saved?.roles?.[role]?.model === 'string' && saved.roles[role].model);
  const storedModelSelectionMode = ['automatic', 'priority'].includes(saved?.modelSelectionMode)
    ? saved.modelSelectionMode : hasSavedRoleModel ? 'priority' : 'automatic';
  const config = {
    enabled: saved?.enabled !== false, autoApply: saved?.autoApply !== false,
    modelSelectionMode: storedModelSelectionMode,
    budgetProfile: Object.hasOwn(LOOP_BUDGET_PROFILES, saved?.budgetProfile) ? saved.budgetProfile : 'standard',
    mcpTools: Array.isArray(saved?.mcpTools) ? saved.mcpTools.filter((tool) => tool && typeof tool.serverId === 'string' && typeof tool.name === 'string').slice(0, MAX_LOOP_MCP_TOOLS) : [],
    priorities: normalizeLoopPriorities(saved?.priorities),
    roles: Object.fromEntries(ROLES.map(([role]) => [role, {
      model: typeof saved?.roles?.[role]?.model === 'string' ? saved.roles[role].model : '',
      nativePlugins: saved?.roles?.[role]?.nativePlugins !== false, loopMcp: saved?.roles?.[role]?.loopMcp !== false,
      effort: typeof saved?.roles?.[role]?.effort === 'string' ? saved.roles[role].effort : '',
      fallbacks: Array.isArray(saved?.roles?.[role]?.fallbacks) ? saved.roles[role].fallbacks.filter((value) => typeof value === 'string').slice(0, MAX_FALLBACKS) : [],
      fallbacksConfigured: Array.isArray(saved?.roles?.[role]?.fallbacks),
    }])),
  };
  const modal = document.querySelector('#harnessModal');
  const fields = document.querySelector('#harnessRoles');
  const mcpFields = document.querySelector('#harnessMcpTools');
  const priorityFields = document.querySelector('#harnessPriorities');
  const saveStatus = document.querySelector('#harnessSaveStatus');
  const evidenceStatus = document.querySelector('#harnessEvidenceStatus');
  const evidenceRefresh = document.querySelector('#harnessEvidenceRefresh');
  const evidenceNotice = document.querySelector('#harnessEvidenceNotice');
  const evidenceDetails = document.querySelector('#harnessEvidenceDetails');
  const evidenceIds = document.querySelector('#harnessEvidenceIds');
  const evidenceTypeSelect = document.querySelector('#harnessEvidenceType');
  const modelSelectionMode = document.querySelector('#harnessModelSelectionMode');
  const modelSelectionHint = document.querySelector('#harnessModelSelectionHint');
  const evidenceScope = document.querySelector('#harnessEvidenceScope');
  const search = document.querySelector('#harnessModelSearch');
  const expandedFallbacks = new Set();
  let measuredModels = [];
  let minimumEvidenceRuns = 3;
  let hasLoadedEvidence = false;
  let lastEvidenceRefreshAt = '';
  let evidenceRefreshInProgress = false;
  let activeRunId = null, watching = false, starting = false, stopRequested = false;
  function renderEvidenceDiagnostics(diagnostics) {
    const invalidReasons = diagnostics?.invalidRecordReasons && typeof diagnostics.invalidRecordReasons === 'object' && !Array.isArray(diagnostics.invalidRecordReasons)
      ? diagnostics.invalidRecordReasons : {};
    const reasonCounts = new Map();
    for (const [reason, count] of Object.entries(invalidReasons)) {
      if (!Number.isSafeInteger(count) || count <= 0) continue;
      const label = EVIDENCE_REASON_LABELS.get(reason) || '기타 형식 오류';
      reasonCounts.set(label, (reasonCounts.get(label) || 0) + count);
    }
    const invalidRecords = [...reasonCounts.values()].reduce((total, count) => total + count, 0);
    const invalidReasonSummary = [...reasonCounts].map(([label, count]) => `${label} ${count}개`).join(', ');
    const malformedJsonRecords = Number.isSafeInteger(diagnostics?.malformedJsonRecords) ? diagnostics.malformedJsonRecords : 0;
    const unreadableRecords = Number.isSafeInteger(diagnostics?.unreadableRecords) ? diagnostics.unreadableRecords : 0;
    const total = invalidRecords + malformedJsonRecords + unreadableRecords;
    evidenceNotice.hidden = total === 0;
    evidenceNotice.textContent = total === 0 ? '' : `실측 기록 ${total}개를 모델 선택 통계에서 제외했습니다 · JSON 오류 ${malformedJsonRecords}개 · 형식 오류 ${invalidRecords}개${invalidReasonSummary ? ` (${invalidReasonSummary})` : ''} · 읽기 오류 ${unreadableRecords}개`;
    const excludedRecordIds = diagnostics?.excludedRecordIds && typeof diagnostics.excludedRecordIds === 'object' && !Array.isArray(diagnostics.excludedRecordIds)
      ? diagnostics.excludedRecordIds : {};
    const exampleGroups = Object.entries(excludedRecordIds).flatMap(([reason, ids]) => {
      if (!Array.isArray(ids)) return [];
      const safeIds = ids.filter((id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)).slice(0, 3);
      return safeIds.length ? [[EVIDENCE_REASON_LABELS.get(reason) || '기타 형식 오류', safeIds]] : [];
    });
    evidenceDetails.hidden = total === 0 || exampleGroups.length === 0;
    evidenceIds.innerHTML = exampleGroups.map(([label, ids]) => `<li><span>${escape(label)} · 예시 ID</span><div class="harness-evidence-id-list">${ids.map((id) => `<span class="harness-evidence-id"><code>${escape(id)}</code><button type="button" class="harness-evidence-copy" data-copy-excluded-id="${escape(id)}" aria-label="${escape(id)} 복사">복사</button></span>`).join('')}</div></li>`).join('');
  }
  const save = () => {
    try {
      const persisted = { ...config, priorities: normalizeLoopPriorities(config.priorities), roles: Object.fromEntries(ROLES.map(([role]) => [role, {
        model: config.roles[role].model, effort: config.roles[role].effort, nativePlugins: config.roles[role].nativePlugins, loopMcp: config.roles[role].loopMcp, fallbacks: config.roles[role].fallbacks.slice(0, MAX_FALLBACKS),
      }])) };
      localStorage.setItem(KEY, JSON.stringify(persisted));
      saveStatus.textContent = '자동 저장됨 · 다음 실행부터 적용';
      return true;
    } catch {
      saveStatus.textContent = '저장하지 못했습니다. 완료를 눌러 다시 시도하세요.';
      toast('Harness 설정을 저장하지 못했습니다. 저장 공간을 확인해 주세요.');
      return false;
    }
  };
  const currentProject = () => getProject(state.conversations.find((c) => c.id === state.activeId)?.projectId || state.activeProjectId);
  const connected = () => catalog().filter((model) => model.connected);
  const efforts = (model) => model?.provider === 'openai'
    ? (model.supportedReasoningEfforts || []).map((item) => item.reasoningEffort)
    : model?.provider === 'anthropic' ? modelEffortCapability('anthropic', model.id)?.reasoningEfforts || [] : model?.reasoningEfforts || [];
  const modelByKey = (key) => connected().find((model) => modelKey(model) === key) || null;
  function currentTaskText() {
    const draft = document.querySelector('#messageInput')?.value.trim();
    if (draft) return draft;
    const conversation = state.conversations.find((item) => item.id === state.activeId);
    const latestUserMessage = [...(conversation?.messages || [])].reverse().find((message) => message?.role === 'user' && typeof message.content === 'string');
    return latestUserMessage?.content || '';
  }
  function comparisonTaskType() {
    return evidenceTypeSelect.value === 'auto' ? classifyEvidenceTaskType(currentTaskText()) : evidenceTypeSelect.value;
  }
  function comparisonEffort(role, model, task) {
    const supported = efforts(model);
    const selected = config.roles[role].effort;
    return selected && supported.includes(selected)
      ? selected
      : recommendLoopEffort(role, supported, task, config.priorities) || 'default';
  }
  function automaticModelOrder(role, task = currentTaskText()) {
    const candidates = connected().filter((model) => role === 'judge' || !model.decisionOnly);
    return automaticLoopModelOrder(role, candidates, modelKey, {
      currentModelKey: currentKey(), task, priorities: config.priorities,
      workerModelKey: config.modelSelectionMode === 'priority' ? config.roles.worker.model : '',
    });
  }
  function ensurePrioritySelections(task = currentTaskText()) {
    let changed = false;
    for (const [role] of ROLES) {
      if (config.roles[role].model) continue;
      const candidates = connected().filter((model) => role === 'judge' || !model.decisionOnly);
      const candidate = automaticLoopModelOrder(role, candidates, modelKey, {
        currentModelKey: currentKey(), task, priorities: config.priorities,
        workerModelKey: config.roles.worker.model,
      })[0];
      if (!candidate) continue;
      config.roles[role].model = modelKey(candidate);
      changed = true;
    }
    return changed;
  }
  function renderModelSelectionHint(task) {
    const tier = classifyLoopModelTier(task);
    const tierLabel = tier === 'simple' ? '간단' : tier === 'complex' ? '복잡·고위험 가능성' : '일반 기능';
    modelSelectionHint.textContent = config.modelSelectionMode === 'automatic'
      ? '자동 선택 · 현재 요청 분류: ' + tierLabel + '. ' + loopModelSelectionGuidance('worker', task) + ' 판정 단계에서 충분한 완료 실측이 있으면 완료 안정성을 우선해 재배정합니다. 후보 순서를 편집하면 후보 순서 모드로 전환됩니다.'
      : '후보 순서 · 역할별 1순위 모델을 그대로 사용하고, 한도 소진이나 호출 실패 때 저장한 순서로 전환합니다.';
  }
  function formatPercent(value) { return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '미측정'; }
  function formatRate(passed, total, minimumRuns) {
    if (!total) return '미측정';
    return `${passed}/${total} (${Math.round((passed / total) * 100)}%)${total < minimumRuns ? ` · 표본 ${total}/${minimumRuns}` : ''}`;
  }
  function formatTime(milliseconds) {
    if (!Number.isFinite(milliseconds)) return '미측정';
    return milliseconds < 1000 ? `${Math.round(milliseconds)}ms` : `${(milliseconds / 1000).toFixed(1)}초`;
  }
  function renderModelComparison(role, task, taskType) {
    renderModelSelectionHint(task);
    const available = connected().filter((model) => role === 'judge' || !model.decisionOnly);
    const candidates = available.map((model) => {
      const effort = comparisonEffort(role, model, task);
      const evidence = measuredModels.find((item) => item.type === taskType && item.role === role
        && item.provider === model.provider && item.model === model.id && item.effort === effort) || null;
      return { model, effort, evidence };
    });
    const ranking = rankLoopModelCandidates(candidates, config.priorities, {
      minimumRuns: minimumEvidenceRuns,
      taskType,
    });
    const baseline = config.modelSelectionMode === 'priority' && config.roles[role].model
      ? available.find((model) => modelKey(model) === config.roles[role].model) || null
      : selectAutomaticLoopModel(role, available, modelKey, {
        currentModelKey: currentKey(), workerModelKey: config.modelSelectionMode === 'priority' ? config.roles.worker.model : '',
        task, priorities: config.priorities,
      });
    const recommendation = ranking.recommended || ranking.available.find((item) => item.model === baseline) || ranking.available[0] || null;
    const measured = ranking.measured;
    const comparisonMetrics = ranking.comparableMetrics.length
      ? `완료 안정성 후 ${ranking.comparableMetrics.join(' → ')}`
      : '완료 안정성 외에는 공통 표본 기준을 갖춘 추가 실측 지표가 없음';
    const explanation = ranking.mode === 'measured'
        ? `동일 ${taskType} 작업·역할·Effort의 완료 실측을 우선 비교했습니다. 완료 신뢰 하한 ${formatPercent(recommendation?.evidence?.completionConfidenceLowerBound)} · ${recommendation?.evidence?.completedRuns || 0}/${recommendation?.evidence?.completionMeasuredRuns || 0}회. 다음 비교 기준: ${comparisonMetrics}. 표본 부족 후보 ${Math.max(0, ranking.available.length - measured.length)}개는 우열을 매기지 않았습니다.`
      : ranking.mode === 'single-measured'
        ? `${recommendation.model.label}만 완료 실측 ${recommendation.evidence.completionMeasuredRuns}회 기준을 채웠습니다. 다른 후보는 비교 표본이 부족해 최고 성능으로 확정할 수 없습니다.`
        : `동일 ${taskType} 작업·역할·Effort에서 완료 실측 ${ranking.minimumRuns}회 기준을 채운 모델이 없습니다. ${recommendation ? `${recommendation.model.label}을 임시 기본 후보로 표시합니다.` : '사용 가능한 모델이 없습니다.'}`;
    evidenceScope.textContent = evidenceTypeSelect.value === 'auto'
      ? `현재 입력 기준: ${taskType} · Effort는 이 작업과 개인 우선순위에 맞춰 비교합니다.`
      : `선택한 유형: ${taskType} · Effort는 이 작업과 개인 우선순위에 맞춰 비교합니다.`;

    const rankedKeys = new Map(measured.map((item, index) => [modelKey(item.model), index]));
    const ordered = [...candidates].sort((left, right) => {
      const leftRank = rankedKeys.get(modelKey(left.model));
      const rightRank = rankedKeys.get(modelKey(right.model));
      if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
      if (leftRank !== undefined) return -1;
      if (rightRank !== undefined) return 1;
      return available.indexOf(left.model) - available.indexOf(right.model);
    });
    const reference = ranking.recommended;
    const comparableTokens = candidates.filter((item) => Number.isFinite(item.evidence?.meanReportedTokens)
      && item.evidence.fullyReportedRuns >= minimumEvidenceRuns);
    const lowestTokenCandidate = comparableTokens.reduce((best, item) => !best || item.evidence.meanReportedTokens < best.evidence.meanReportedTokens ? item : best, null);
    const comparableTimes = candidates.filter((item) => Number.isFinite(item.evidence?.meanModelTimeMs)
      && item.evidence.durationRuns >= minimumEvidenceRuns);
    const fastestCandidate = comparableTimes.reduce((best, item) => !best || item.evidence.meanModelTimeMs < best.evidence.meanModelTimeMs ? item : best, null);
    const rows = ordered.map((item) => {
      const { model: candidate, evidence } = item;
      const selected = config.modelSelectionMode === 'priority' && config.roles[role].model === modelKey(candidate);
      const automaticBase = config.modelSelectionMode === 'automatic' && candidate === baseline;
      const isRecommended = candidate === recommendation?.model;
      const strength = modelSelectionStrength(candidate) || '공급자 강점 설명 없음';
      const supported = efforts(candidate);
      const completion = evidence?.completionMeasuredRuns
        ? `${evidence.completedRuns}/${evidence.completionMeasuredRuns} (${formatPercent(evidence.completionRate)}) · 신뢰 하한 ${formatPercent(evidence.completionConfidenceLowerBound)}${evidence.sufficientEvidence ? '' : ` · 표본 ${evidence.completionMeasuredRuns}/${minimumEvidenceRuns}`}`
        : '완료 실측 없음';
      const verification = formatRate(evidence?.verifiedRuns || 0, evidence?.verificationMeasuredRuns || 0, minimumEvidenceRuns);
      const browserQa = formatRate(evidence?.browserQaPassedRuns || 0, evidence?.browserQaRuns || 0, minimumEvidenceRuns);
      const time = evidence?.meanModelTimeMs == null ? '미측정' : `${formatTime(evidence.meanModelTimeMs)} · 표본 ${evidence.durationRuns}/${minimumEvidenceRuns}${evidence.durationRuns < minimumEvidenceRuns ? ' · 비교 보류' : ''}`;
      const tokens = evidence?.meanReportedTokens == null ? '미측정' : `${Math.round(evidence.meanReportedTokens).toLocaleString()} · 표본 ${evidence.fullyReportedRuns}/${minimumEvidenceRuns}${evidence.fullyReportedRuns < minimumEvidenceRuns ? ' · 비교 보류' : ''}`;
      const recoveries = evidence?.meanRunRecoveries == null ? '미측정' : `${evidence.meanRunRecoveries.toFixed(1)}회 · ${evidence.completionMeasuredRuns}회`;
      const callSuccess = Number.isFinite(evidence?.callSuccessRate)
        ? `${evidence.successfulCalls}/${evidence.calls} (${formatPercent(evidence.callSuccessRate)}) · 실행 ${evidence.callSuccessMeasuredRuns}/${minimumEvidenceRuns}${evidence.callSuccessMeasuredRuns < minimumEvidenceRuns ? ' · 비교 보류' : ''}`
        : '미측정';
      const interventions = evidence?.humanInterventionMeasuredRuns
        ? `재개 ${evidence.manualResumes}회 · 중지 ${evidence.stopRequests}회 · 완전 계측 ${evidence.fullyMeasuredInterventionRuns}회${Number.isFinite(evidence.observedActionRate) ? ` · 개입 발생 ${formatPercent(evidence.observedActionRate)}` : ' · 비교 표본 부족'}`
        : '미측정';
      const caveats = [];
      const referenceEvidence = reference?.evidence;
      if (Number.isFinite(candidate.remainingPercent) && candidate.remainingPercent <= 0) caveats.push('잔여 한도 없음 · 선택 불가');
      if (evidence?.providerFailures) caveats.push(`연결 오류 ${evidence.providerFailures}회`);
      if (evidence?.excludedOutcomeRuns) caveats.push(`귀속 불확실·흐름 원인 완료율 제외 ${evidence.excludedOutcomeRuns}회`);
      if (evidence?.schemaFallbackCalls) caveats.push(`구조화 응답 미지원 ${evidence.schemaFallbackCalls}호출`);
      if (evidence?.formatFailures) caveats.push(`응답 형식 오류 ${evidence.formatFailures}회`);
      if (candidate !== reference?.model && evidence?.sufficientEvidence && referenceEvidence?.sufficientEvidence
        && evidence.completionConfidenceLowerBound < referenceEvidence.completionConfidenceLowerBound) caveats.push('추천 후보보다 완료 신뢰 하한이 낮음');
      if (candidate !== reference?.model && Number.isFinite(evidence?.verificationPassRate) && Number.isFinite(referenceEvidence?.verificationPassRate)
        && evidence.verificationMeasuredRuns >= minimumEvidenceRuns && referenceEvidence.verificationMeasuredRuns >= minimumEvidenceRuns
        && evidence.verificationPassRate < referenceEvidence.verificationPassRate) caveats.push('추천 후보보다 검증 통과율이 낮음');
      if (candidate !== reference?.model && Number.isFinite(evidence?.browserQaPassRate) && Number.isFinite(referenceEvidence?.browserQaPassRate)
        && evidence.browserQaRuns >= minimumEvidenceRuns && referenceEvidence.browserQaRuns >= minimumEvidenceRuns
        && evidence.browserQaPassRate < referenceEvidence.browserQaPassRate) caveats.push('추천 후보보다 브라우저 QA 통과율이 낮음');
      if (candidate !== reference?.model && Number.isFinite(evidence?.callSuccessRate) && Number.isFinite(referenceEvidence?.callSuccessRate)
        && evidence.callSuccessMeasuredRuns >= minimumEvidenceRuns && referenceEvidence.callSuccessMeasuredRuns >= minimumEvidenceRuns
        && evidence.callSuccessRate < referenceEvidence.callSuccessRate) caveats.push('추천 후보보다 모델 호출 성공률이 낮음');
      if (candidate !== reference?.model && Number.isFinite(evidence?.meanRunRecoveries) && Number.isFinite(referenceEvidence?.meanRunRecoveries)
        && evidence.completionMeasuredRuns >= minimumEvidenceRuns && referenceEvidence.completionMeasuredRuns >= minimumEvidenceRuns
        && evidence.meanRunRecoveries > referenceEvidence.meanRunRecoveries) caveats.push('추천 후보보다 평균 복구 횟수가 많음');
      if (evidence?.fullyReportedRuns >= minimumEvidenceRuns && lowestTokenCandidate?.model !== candidate
        && evidence.meanReportedTokens > lowestTokenCandidate?.evidence?.meanReportedTokens) caveats.push(`토큰 최저 후보 ${lowestTokenCandidate.model.label}보다 평균 사용량이 많음`);
      if (evidence?.durationRuns >= minimumEvidenceRuns && fastestCandidate?.model !== candidate
        && evidence.meanModelTimeMs > fastestCandidate?.evidence?.meanModelTimeMs) caveats.push(`가장 빠른 후보 ${fastestCandidate.model.label}보다 평균 응답 시간이 김`);
      if (!evidence?.sufficientEvidence) caveats.push(`완료 표본 ${evidence?.completionMeasuredRuns || 0}/${minimumEvidenceRuns} · 성능상 약점 미확인`);
      const caveatText = caveats.length ? caveats.join(' · ') : evidence?.sufficientEvidence ? '확인된 주요 주의점 없음' : '성능 기록 부족 · 우열을 판단할 수 없음';
      const description = typeof candidate.description === 'string' ? candidate.description.slice(0, 220) : '';
      return `<article class="harness-model-candidate${isRecommended ? ' recommended' : ''}">
        <div class="harness-model-candidate-head"><div><strong>${escape(candidate.label)}</strong><span>${escape(candidate.source || candidate.provider)} · Effort ${escape(item.effort)}</span></div><div class="harness-model-badges">${isRecommended ? '<span class="recommendation-badge">추천</span>' : ''}${selected ? '<span class="recommendation-badge selected">직접 지정</span>' : automaticBase ? '<span class="recommendation-badge muted">자동 기본</span>' : ''}</div></div>
        <p class="harness-model-strength"><strong>강점</strong> ${escape(strength)}${supported.length ? ` · 지원 Effort ${escape(supported.join(', '))}` : ''}${description ? `<span>${escape(description)}</span>` : ''}</p>
        <dl class="harness-model-metrics"><div><dt>완료 안정성</dt><dd>${escape(completion)}</dd></div><div><dt>검증</dt><dd>${escape(verification)}</dd></div><div><dt>브라우저 QA</dt><dd>${escape(browserQa)}</dd></div><div><dt>모델 호출 성공률</dt><dd>${escape(callSuccess)}</dd></div><div><dt>모델 응답 시간</dt><dd>${escape(time)}</dd></div><div><dt>사용 토큰</dt><dd>${escape(tokens)}${evidence?.missingUsageCalls ? ` · 사용량 누락 ${evidence.missingUsageCalls}호출` : ''}</dd></div><div><dt>첫 텍스트 응답</dt><dd>${escape(formatTime(evidence?.meanFirstResponseMs))} · 계측 ${evidence?.firstResponseCalls || 0}호출</dd></div><div><dt>세부 토큰 누적</dt><dd>${evidence?.detailedUsageCalls ? escape(`입력 ${evidence.reportedInputTokens.toLocaleString()} · 출력 ${evidence.reportedOutputTokens.toLocaleString()} · 캐시 ${evidence.cachedUsageCalls ? evidence.reportedCachedInputTokens.toLocaleString() : '미제공'} · ${evidence.detailedUsageCalls}호출`) : '미측정'}</dd></div><div><dt>복구 횟수</dt><dd>${escape(recoveries)}</dd></div><div><dt>앱 내 수동 개입</dt><dd>${escape(interventions)}</dd></div></dl>
        <p class="harness-model-caveat"><strong>주의점</strong> ${escape(caveatText)}</p>
        <button type="button" class="text-button harness-model-select" data-model-compare-select="${role}" data-key="${escape(modelKey(candidate))}"${selected || (Number.isFinite(candidate.remainingPercent) && candidate.remainingPercent <= 0) ? ' disabled' : ''}>${selected ? '현재 직접 지정됨' : Number.isFinite(candidate.remainingPercent) && candidate.remainingPercent <= 0 ? '현재 한도 소진됨' : '이 모델로 직접 지정'}</button>
      </article>`;
    }).join('');
    return `<div class="harness-recommendation"><strong>${recommendation ? `추천 기준 모델 · ${escape(recommendation.model.label || recommendation.model.id)}` : '사용 가능한 모델 없음'}</strong><p>${escape(explanation)}</p><small>호출 성공률은 실행 중 기록된 연결·응답 형식 결과이며 추론 품질 점수와 구분합니다. 추론 성능 자체는 공통 과제 벤치마크가 없어 점수화하지 않습니다. 강점과 지원 Effort는 연결에서 받은 모델 설명입니다. 개입 통계는 앱 안에서 측정한 재개·중지뿐이며 실제 사람 투입 시간은 측정하지 않습니다.</small></div>
      <details class="harness-model-comparison"><summary>모델별 강점과 실측 비교 보기 · ${available.length}개</summary><div class="harness-model-candidate-list">${rows || '<p class="settings-footnote">이 역할에 사용할 수 있는 연결 모델이 없습니다.</p>'}</div></details>`;
  }
  const choose = (role, task = currentTaskText()) => {
    const models = connected().filter((model) => role === 'judge' || !model.decisionOnly);
    if (config.modelSelectionMode === 'priority' && config.roles[role].model) return models.find((model) => modelKey(model) === config.roles[role].model);
    return selectAutomaticLoopModel(role, models, modelKey, {
      currentModelKey: currentKey(), workerModelKey: config.modelSelectionMode === 'priority' ? config.roles.worker.model : '',
      task, priorities: config.priorities,
    });
  };
  const resolveEffort = (role, model, task = '') => {
    const allowed = efforts(model);
    if (config.roles[role].effort && !allowed.includes(config.roles[role].effort)) throw new Error(`${model.label}의 추론 강도를 다시 선택해 주세요.`);
    return config.roles[role].effort || recommendLoopEffort(role, allowed, task, config.priorities);
  };
  const resolveFallbackEffort = (role, model, task) => {
    const allowed = efforts(model);
    return allowed.includes(config.roles[role].effort)
      ? config.roles[role].effort
      : recommendLoopEffort(role, allowed, task, config.priorities);
  };
  function suggestedFallbacks(role) {
    const primary = choose(role);
    if (!primary) return [];
    const models = connected().filter((model) => role === 'judge' || !model.decisionOnly);
    const preferred = [];
    if (role === 'judge') preferred.push(...models.filter((model) => model.decisionOnly));
    for (const [otherRole] of ROLES) {
      if (otherRole === role) continue;
      const other = choose(otherRole);
      if (other) preferred.push(other);
    }
    const current = models.find((model) => modelKey(model) === currentKey());
    if (current) preferred.push(current);
    preferred.push(...models);
    const seen = new Set([modelKey(primary)]);
    return preferred.filter((model) => {
      if (role !== 'judge' && model.decisionOnly) return false;
      const key = modelKey(model);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, MAX_FALLBACKS).map(modelKey);
  }
  function ensureFallbackPriority() {
    let changed = false;
    for (const [role] of ROLES) {
      const settings = config.roles[role];
      if (settings.fallbacksConfigured) continue;
      settings.fallbacks = suggestedFallbacks(role);
      settings.fallbacksConfigured = true;
      changed = true;
    }
    if (changed) save();
  }
  const budgetLabel = (model) => Number.isFinite(model?.remainingPercent)
    ? `계정 한도 ${Math.max(0, Math.min(100, model.remainingPercent))}% 남음` : '잔여 한도 미제공';
  function modelOptions(models, selected = '') {
    if (config.modelSelectionMode !== 'priority') selected = '';
    const query = search.value.trim().toLocaleLowerCase();
    const visible = models.filter((model) => modelKey(model) === selected
      || `${model.label} ${model.id} ${model.source} ${modelSelectionStrength(model)}`.toLocaleLowerCase().includes(query));
    const groups = new Map();
    for (const model of visible) {
      const group = model.source || '연결된 모델';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(model);
    }
    return [...groups].map(([source, items]) => `<optgroup label="${escape(source)}">${items.map((model) => `<option value="${escape(modelKey(model))}"${selected === modelKey(model) ? ' selected' : ''}>${escape(model.label)}${modelSelectionStrength(model) ? ` · ${escape(modelSelectionStrength(model))}` : ''}${Number.isFinite(model.remainingPercent) ? ` · 한도 ${Math.max(0, model.remainingPercent)}%` : ''}</option>`).join('')}</optgroup>`).join('')
      || '<option disabled>검색 결과 없음</option>';
  }
  function renderRoles() {
    const task = currentTaskText();
    const taskType = comparisonTaskType();
    modelSelectionMode.value = config.modelSelectionMode;
    renderModelSelectionHint(task);
    fields.innerHTML = ROLES.map(([role, title]) => {
      const model = choose(role), supported = efforts(model);
      const unavailableEffort = config.roles[role].effort && !supported.includes(config.roles[role].effort);
      const effortLabel = config.roles[role].effort
        ? `${config.roles[role].effort} · 직접 지정`
        : supported.length ? '자동 · 작업 난이도에 따라 조정' : model?.decisionOnly ? 'Jev 판정 전용' : '서비스 기본 추론';
      const primaryKey = model ? modelKey(model) : '';
      const savedFallbacks = config.roles[role].fallbacks.filter((key) => key !== primaryKey);
      const fallbackModels = savedFallbacks.map((key) => ({ key, model: modelByKey(key) }));
      const available = connected().filter((item) => role === 'judge' || !item.decisionOnly);
      const eligible = available.filter((item) => modelKey(item) !== primaryKey && !savedFallbacks.includes(modelKey(item)));
      const fallbackList = fallbackModels.map(({ key, model: fallback }, index) => `<li class="harness-fallback-item">
        <span class="harness-fallback-index">${index + 1}</span>
        <span class="harness-fallback-name">${fallback ? `${escape(fallback.label)} · ${escape(fallback.source)}${role !== 'judge' && fallback.decisionOnly ? ' · 판정 전용, 이 역할에서 건너뜀' : ''}` : '연결을 확인할 수 없는 저장 모델'}</span>
        <span class="harness-fallback-actions">
          <button type="button" data-fallback-move="${role}" data-key="${escape(key)}" data-direction="up" aria-label="${title} ${index + 1}순위 올리기"${index === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" data-fallback-move="${role}" data-key="${escape(key)}" data-direction="down" aria-label="${title} ${index + 1}순위 내리기"${index === fallbackModels.length - 1 ? ' disabled' : ''}>↓</button>
          <button type="button" data-fallback-remove="${role}" data-key="${escape(key)}" aria-label="${title} ${index + 1}순위 제거">×</button>
        </span></li>`).join('');
      return `<div class="harness-role">
        <label class="project-field"><span>${title}</span><select data-harness-role="${role}" aria-label="${title} 모델">
          <option value="">${config.modelSelectionMode === 'automatic' ? '자동 · 작업별 추천' : '후보 1순위 선택'}</option>
          ${config.roles[role].model && !model ? `<option selected value="${escape(config.roles[role].model)}">저장된 모델 · 연결 확인 필요</option>` : ''}
          ${modelOptions(available, config.roles[role].model)}</select></label>
        <label class="project-field"><span>추론 강도</span><select data-harness-effort="${role}" aria-label="${title} 추론 강도"${!supported.length ? ' disabled' : ''}>
          <option value="">${supported.length ? '자동' : '서비스 기본값'}</option>
          ${unavailableEffort ? `<option selected value="${escape(config.roles[role].effort)}">${escape(config.roles[role].effort)} · 지원 확인 필요</option>` : ''}
          ${supported.map((value) => `<option value="${escape(value)}"${config.roles[role].effort === value ? ' selected' : ''}>${escape(value)}</option>`).join('')}</select></label>
        <div class="harness-role-summary"><strong>${config.modelSelectionMode === 'automatic' ? '자동 추천 · ' : !config.roles[role].model ? '기본 후보 · ' : ''}${model ? escape(model.label) : '사용 가능한 모델 없음'}</strong><span>${model ? escape(budgetLabel(model)) : '연결과 잔여 한도를 확인하세요.'}</span></div>
        <div class="harness-measured">${(() => { const item = measuredModels.find((m) => m.type === taskType && m.role === role && m.provider === model?.provider && m.model === model?.id && m.effort === comparisonEffort(role, model, task)); if (!item) return '실측 기록 축적 중 · 같은 작업 유형·역할·Effort로 비교'; const completionRuns = item.completionMeasuredRuns ?? 0; const switchedRoles = item.runs > completionRuns; const confidence = item.sufficientEvidence && Number.isFinite(item.completionConfidenceLowerBound) ? ` · 완료 신뢰 하한 ${Math.round(item.completionConfidenceLowerBound * 100)}% (95%)` : ''; return `${item.type} 실행 참여 ${item.runs}회 · 역할 단독 완료 ${item.completedRuns}/${completionRuns}${switchedRoles ? ' (역할 내 모델 전환 실행 제외)' : ''}${confidence} · QA ${item.browserQaPassedRuns}/${item.browserQaRuns} · 호출 토큰 ${item.reportedTokens.toLocaleString()}${item.missingUsageCalls ? ` (사용량 누락 ${item.missingUsageCalls}호출)` : ''}${item.humanInterventionMeasuredRuns ? ` · 개입 계측 ${item.humanInterventionMeasuredRuns}개 실행${item.partiallyMeasuredInterventionRuns ? ' (일부 기록)' : ''} · 수동 재개 ${item.manualResumes}회 · 중지 요청 ${item.stopRequests}회` : ''} · ${item.sufficientEvidence ? '선택 근거 제공' : '표본 축적 중'}`; })()}</div>
        ${renderModelComparison(role, task, taskType)}
        <small>${model ? `${escape(modelSelectionStrength(model) || effortLabel)} · ${escape(effortLabel)} · ${escape(loopModelSelectionGuidance(role, task))}` : '모델을 연결하거나 직접 선택해 주세요.'}</small>
        <div class="harness-agent-tools"><label><input type="checkbox" data-harness-native="${role}"${config.roles[role].nativePlugins ? ' checked' : ''}> 이 Agent의 Plugin·Skill·MCP 사용</label><label><input type="checkbox" data-harness-shared="${role}"${config.roles[role].loopMcp ? ' checked' : ''}> Loopline MCP 사용</label><small>Codex·Claude의 기존 연결을 사용합니다. API 모델은 Loopline MCP를 사용하며 Jev 판정에는 도구를 전달하지 않습니다.</small></div>
        <details class="harness-fallbacks" data-fallback-details="${role}"${expandedFallbacks.has(role) ? ' open' : ''}>
          <summary class="harness-fallback-heading"><strong>${config.modelSelectionMode === 'automatic' ? '저장 후보 순서 · 수동 모드에서 사용' : '한도 소진 시 대체 순서'}</strong><span>${fallbackModels.length}개 · 펼쳐서 편집</span></summary>
          <section aria-label="${title} 대체 모델 우선순위"><ol>${fallbackList || '<li class="harness-fallback-empty">대체 모델이 없습니다.</li>'}</ol>
          <div class="harness-fallback-add"><select data-fallback-select="${role}" aria-label="${title} 대체 모델 선택"><option value="">대체 모델 추가…</option>${modelOptions(eligible)}</select>
          <button type="button" data-fallback-add="${role}"${config.roles[role].fallbacks.length >= MAX_FALLBACKS || !eligible.length ? ' disabled' : ''}>추가</button></div></section>
          <small>${config.modelSelectionMode === 'automatic' ? '자동 선택에서는 작업 난이도와 연결된 모델로 후보 순서를 계산합니다. 이 저장 순서는 후보 순서 모드에서 사용하며, 여기서 편집하면 해당 모드로 전환됩니다.' : '실행 중에는 잔여 한도와 실패 여부를 확인해 저장된 다음 후보로 전환합니다. 잔여 한도 미제공은 사용 가능량을 알 수 없다는 뜻입니다.'}</small>
        </details></div>`;
    }).join('');
  }
  function renderPriorities() {
    const movable = normalizeLoopPriorities(config.priorities);
    priorityFields.innerHTML = `<ol class="harness-priority-list"><li class="harness-priority-item locked"><span class="harness-priority-index">1</span><strong>완료 안정성</strong><span class="harness-priority-lock">항상 최우선</span></li>${movable.map((id, index) => {
      const item = LOOP_PRIORITY_DIMENSIONS.find((dimension) => dimension.id === id);
      return `<li class="harness-priority-item"><span class="harness-priority-index">${index + 2}</span><strong>${escape(item.label)}</strong><span class="harness-priority-actions"><button type="button" data-priority-move="${id}" data-direction="up" aria-label="${escape(item.label)} 우선순위 올리기"${index === 0 ? ' disabled' : ''}>↑</button><button type="button" data-priority-move="${id}" data-direction="down" aria-label="${escape(item.label)} 우선순위 내리기"${index === movable.length - 1 ? ' disabled' : ''}>↓</button></span></li>`;
    }).join('')}</ol>`;
  }
  function renderMcpTools() {
    const available = typeof getMcpTools === 'function' ? getMcpTools() : [];
    const automaticCount = available.filter((tool) => tool.autoRun).length;
    if (!available.length) {
      mcpFields.innerHTML = `<p class="settings-footnote">사용 가능한 MCP 도구가 없습니다. Paper 또는 Figma를 연결 설정에서 자동 사용으로 켜면 다음 Loop 실행부터 포함됩니다. <button type="button" class="text-button" data-open-mcp-settings>MCP 연결 설정 열기</button></p>${config.mcpTools.length ? '<p class="harness-mcp-warning">저장한 도구 연결이 없습니다. MCP 연결을 다시 열고 Loop 구성을 새로 저장해 주세요.</p>' : ''}`;
      return;
    }
    const keys = new Set(available.map((tool) => JSON.stringify([tool.serverId, tool.name])));
    const missing = config.mcpTools.filter((tool) => !keys.has(JSON.stringify([tool.serverId, tool.name])));
    mcpFields.innerHTML = `<p class="settings-footnote">${automaticCount}개 도구가 연결 설정에 따라 자동 제공됩니다. 호출은 각 Loop 단계에서 확인할 수 있습니다.</p><div class="harness-mcp-list">${available.map((tool) => {
      const key = JSON.stringify([tool.serverId, tool.name]);
      const checked = config.mcpTools.some((savedTool) => savedTool.serverId === tool.serverId && savedTool.name === tool.name);
      const automatic = tool.autoRun === true;
      return `<label class="harness-mcp-tool"><input type="checkbox" data-harness-mcp-tool="${escape(key)}"${automatic || checked ? ' checked' : ''}${automatic ? ' disabled title="연결 설정에서 자동 제공됩니다."' : !checked && config.mcpTools.length + automaticCount >= MAX_LOOP_MCP_TOOLS ? ' disabled' : ''} /><span><strong>${escape(tool.name)}${automatic ? ' · 자동' : ''}</strong><small>${escape(tool.serverName)}${tool.description ? ` · ${escape(tool.description)}` : ''}</small></span></label>`;
    }).join('')}</div>${missing.length ? `<p class="harness-mcp-warning">이전에 고른 도구 ${missing.length}개가 현재 연결에서 보이지 않습니다. 해당 MCP 서버에 다시 연결한 뒤 선택을 갱신하세요.</p>` : ''}`;
  }
  function open() {
    if (state.busy) return toast('실행이 끝난 뒤 구성을 변경해 주세요.');
    document.querySelector('#harnessAutoApply').checked = config.autoApply;
    document.querySelector('#harnessBudgetProfile').value = config.budgetProfile;
    modelSelectionMode.value = config.modelSelectionMode;
    if (config.modelSelectionMode === 'priority' && ensurePrioritySelections()) save();
    search.value = ''; evidenceTypeSelect.value = 'auto'; ensureFallbackPriority(); renderPriorities(); renderRoles(); renderMcpTools(); modal.hidden = false; document.querySelector('#harnessClose').focus();
    void refreshEvidence();
    if (typeof refreshMcpTools === 'function') void Promise.resolve(refreshMcpTools({ quiet: true })).then(renderMcpTools);
  }
  async function refreshEvidence({ notifyFailure = false } = {}) {
    if (evidenceRefreshInProgress) return false;
    evidenceRefreshInProgress = true;
    evidenceRefresh.disabled = true;
    evidenceStatus.textContent = hasLoadedEvidence
      ? `실측 정보 갱신 중 · 마지막 확인 ${lastEvidenceRefreshAt}`
      : '실측 정보를 불러오는 중…';
    try {
      let evidence;
      const maxRetries = 2;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          evidence = await request('/api/harness/evidence');
          break;
        } catch (error) {
          const status = error?.status;
          const retryable = !Number.isInteger(status) || status === 408 || status === 425
            || status === 429 || status >= 500;
          if (!retryable || attempt === maxRetries) throw error;
          const retryNumber = attempt + 1;
          evidenceStatus.textContent = hasLoadedEvidence
            ? `실측 정보 재시도 ${retryNumber}/${maxRetries} 중 · 마지막 확인 ${lastEvidenceRefreshAt}`
            : `실측 정보 일시 오류 · 재시도 ${retryNumber}/${maxRetries} 중…`;
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
      measuredModels = Array.isArray(evidence.models) ? evidence.models : [];
      minimumEvidenceRuns = Number.isSafeInteger(evidence.minimumRuns) && evidence.minimumRuns > 0 ? evidence.minimumRuns : 3;
      renderEvidenceDiagnostics(evidence.evidenceDiagnostics);
      renderRoles();
      hasLoadedEvidence = true;
      lastEvidenceRefreshAt = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
      evidenceStatus.textContent = `실측 정보를 갱신했습니다 · 마지막 확인 ${lastEvidenceRefreshAt}`;
      return true;
    } catch {
      evidenceStatus.textContent = hasLoadedEvidence
        ? `갱신 실패 · ${lastEvidenceRefreshAt} 기준 실측 정보를 표시 중입니다.`
        : '실측 정보를 불러오지 못했습니다.';
      if (notifyFailure) toast('실측 진단 정보를 갱신하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      return false;
    } finally {
      evidenceRefreshInProgress = false;
      evidenceRefresh.disabled = false;
    }
  }
  function close() { modal.hidden = true; document.querySelector('#harnessConfigure').focus(); }
  evidenceRefresh.addEventListener('click', () => refreshEvidence({ notifyFailure: true }));
  search.addEventListener('input', renderRoles);
  evidenceTypeSelect.addEventListener('change', renderRoles);
  fields.addEventListener('toggle', (event) => {
    const role = event.target.dataset.fallbackDetails;
    if (role) event.target.open ? expandedFallbacks.add(role) : expandedFallbacks.delete(role);
  }, true);
  evidenceDetails.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy-excluded-id]');
    if (!button) return;
    const id = button.dataset.copyExcludedId;
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('클립보드를 사용할 수 없습니다.');
      await navigator.clipboard.writeText(id);
      button.textContent = '복사됨';
      toast('제외된 기록 ID를 복사했습니다.');
      setTimeout(() => { if (button.isConnected) button.textContent = '복사'; }, 1400);
    } catch {
      toast('클립보드에 복사하지 못했습니다.');
    }
  });
  priorityFields.addEventListener('click', (event) => {
    const button = event.target.closest('[data-priority-move]');
    if (!button) return;
    const index = config.priorities.indexOf(button.dataset.priorityMove);
    const next = index + (button.dataset.direction === 'up' ? -1 : 1);
    if (index < 0 || next < 0 || next >= config.priorities.length) return;
    [config.priorities[index], config.priorities[next]] = [config.priorities[next], config.priorities[index]];
    save(); renderPriorities();
  });
  mcpFields.addEventListener('change', (event) => {
    const checkbox = event.target.closest('[data-harness-mcp-tool]');
    if (!checkbox) return;
    let serverId, name;
    try { [serverId, name] = JSON.parse(checkbox.dataset.harnessMcpTool); } catch { checkbox.checked = false; return; }
    const index = config.mcpTools.findIndex((tool) => tool.serverId === serverId && tool.name === name);
    if (checkbox.checked && index < 0) {
      const automaticCount = (typeof getMcpTools === 'function' ? getMcpTools() : []).filter((tool) => tool.autoRun).length;
      if (config.mcpTools.length + automaticCount >= MAX_LOOP_MCP_TOOLS) { checkbox.checked = false; toast(`자동 제공 도구를 포함해 Loop에는 최대 ${MAX_LOOP_MCP_TOOLS}개 MCP 도구를 사용할 수 있습니다.`); return; }
      config.mcpTools.push({ serverId, name });
    } else if (!checkbox.checked && index >= 0) config.mcpTools.splice(index, 1);
    save(); renderMcpTools();
  });
  mcpFields.addEventListener('click', (event) => {
    if (event.target.closest('[data-open-mcp-settings]')) {
      close();
      document.querySelector('#settingsButtonTop').click();
      document.querySelector('#mcpTab').click();
    }
  });
  document.querySelector('#harnessUseAutomatic').addEventListener('click', () => {
    for (const [role] of ROLES) {
      config.roles[role].model = ''; config.roles[role].effort = '';
    }
    config.modelSelectionMode = 'automatic';
    modelSelectionMode.value = config.modelSelectionMode;
    search.value = ''; save(); renderRoles();
  });
  modelSelectionMode.addEventListener('change', () => {
    if (!['automatic', 'priority'].includes(modelSelectionMode.value)) {
      modelSelectionMode.value = config.modelSelectionMode;
      return;
    }
    config.modelSelectionMode = modelSelectionMode.value;
    if (config.modelSelectionMode === 'priority') ensurePrioritySelections();
    save(); renderRoles();
  });
  fields.addEventListener('change', (event) => {
    const native = event.target.dataset.harnessNative, shared = event.target.dataset.harnessShared;
    if (native || shared) { config.roles[native || shared][native ? 'nativePlugins' : 'loopMcp'] = event.target.checked; save(); return; }
    // Choosing an add candidate must survive until the Add button is pressed.
    if (!event.target.dataset.harnessRole && !event.target.dataset.harnessEffort) return;
    if (event.target.dataset.harnessRole) {
      const role = event.target.dataset.harnessRole;
      config.roles[role].model = event.target.value;
      config.roles[role].effort = '';
      config.modelSelectionMode = event.target.value ? 'priority' : 'automatic';
      modelSelectionMode.value = config.modelSelectionMode;
      if (config.modelSelectionMode === 'priority') ensurePrioritySelections();
    }
    if (event.target.dataset.harnessEffort) config.roles[event.target.dataset.harnessEffort].effort = event.target.value;
    save(); renderRoles();
  });
  fields.addEventListener('click', (event) => {
    const modelChoice = event.target.closest('[data-model-compare-select]');
    if (modelChoice) {
      const role = modelChoice.dataset.modelCompareSelect;
      const candidate = modelByKey(modelChoice.dataset.key);
      if (!config.roles[role] || !candidate || (role !== 'judge' && candidate.decisionOnly)) return;
      config.roles[role].model = modelKey(candidate);
      config.roles[role].effort = '';
      config.modelSelectionMode = 'priority';
      modelSelectionMode.value = config.modelSelectionMode;
      ensurePrioritySelections();
      save(); renderRoles();
      return;
    }
    const add = event.target.closest('[data-fallback-add]');
    const move = event.target.closest('[data-fallback-move]');
    const remove = event.target.closest('[data-fallback-remove]');
    const role = add?.dataset.fallbackAdd || move?.dataset.fallbackMove || remove?.dataset.fallbackRemove;
    if (!role || !config.roles[role]) return;
    if (config.modelSelectionMode === 'automatic') {
      ensurePrioritySelections();
      config.modelSelectionMode = 'priority';
      modelSelectionMode.value = config.modelSelectionMode;
    }
    const fallbacks = config.roles[role].fallbacks;
    expandedFallbacks.add(role);
    if (add) {
      const select = fields.querySelector(`[data-fallback-select="${role}"]`);
      const key = select?.value;
      const candidate = modelByKey(key);
      if (!candidate || (role !== 'judge' && candidate.decisionOnly) || key === modelKey(choose(role) || {}) || fallbacks.includes(key) || fallbacks.length >= MAX_FALLBACKS) return;
      fallbacks.push(key);
      select.value = '';
    } else if (remove) {
      const index = fallbacks.indexOf(remove.dataset.key);
      if (index < 0) return;
      fallbacks.splice(index, 1);
    } else {
      const visible = fallbacks.filter((key) => key !== modelKey(choose(role) || {}));
      const position = visible.indexOf(move.dataset.key);
      const neighbor = visible[position + (move.dataset.direction === 'up' ? -1 : 1)];
      const index = fallbacks.indexOf(move.dataset.key), next = fallbacks.indexOf(neighbor);
      if (position < 0 || index < 0 || next < 0) return;
      [fallbacks[index], fallbacks[next]] = [fallbacks[next], fallbacks[index]];
    }
    config.roles[role].fallbacksConfigured = true;
    save(); renderRoles();
  });
  document.querySelector('#harnessBudgetProfile').addEventListener('change', (event) => {
    if (Object.hasOwn(LOOP_BUDGET_PROFILES, event.target.value)) { config.budgetProfile = event.target.value; save(); }
  });
  document.querySelector('#harnessAutoApply').addEventListener('change', (event) => {
    config.autoApply = event.target.checked; save();
  });
  document.querySelector('#harnessSave').addEventListener('click', () => { if (save()) close(); });
  document.querySelector('#harnessClose').addEventListener('click', close);
  modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
  modal.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
  document.querySelector('#harnessConfigure').addEventListener('click', open);
  document.querySelector('#loopExecutionMode').value = config.enabled ? 'harness' : 'repeat';
  document.querySelector('#loopExecutionMode').addEventListener('change', (event) => { config.enabled = event.target.value === 'harness'; save(); render(); });
  document.querySelector('#messages').addEventListener('click', async (event) => {
    const link = event.target.closest('a');
    if (!link) return;
    const url = new URL(link.href);
    if (url.origin !== location.origin || !/^\/api\/harness\/runs\/[a-f0-9-]{36}\/patch$/.test(url.pathname)) return;
    event.preventDefault();
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error('패치를 내려받지 못했습니다.');
      const href = URL.createObjectURL(await response.blob());
      const download = document.createElement('a'); download.href = href; download.download = 'harness.patch';
      document.body.append(download); download.click(); download.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (error) { toast(error.message); }
  });

  async function request(path, body) {
    const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Harness 서버에 연결하지 못했습니다.'), { status: response.status });
    return data;
  }
  function update(run, message, conversation) {
    const pending = !DONE.has(run.status);
    message.harnessRunId = run.id; message.harnessStatus = run.status; message.pending = pending;
    message.harnessCanResume = run.canResume === true;
    if (run.stageModels) message.harnessStageModels = run.stageModels;
    message.startedAt = run.createdAt; message.workedForMs = (run.finishedAt || Date.now()) - run.createdAt;
    message.activityMode = 'native';
    message.activities = run.events.slice(-100).map((event) => ({ ...event,
      ...(event.status !== 'running' && event.detail && !event.model && !event.title.startsWith('파일 작업') ? { kind: 'commentary', text: `**${event.title}**\n\n${event.detail}` } : {}),
    }));
    message.error = ['failed', 'blocked', 'interrupted'].includes(run.status);
    message.content = pending ? `Harness · ${run.round}/${run.rounds}회차${run.autoRounds ? ` · 자동 최대 ${MAX_AUTO_LOOP_ROUNDS}회` : ''} · ${run.status === 'stopping' ? '중지 중' : ({ selecting: '판정 모델이 주·대체 모델 순위 선택', prepare: '작업 공간 준비', configuring: '판정 모델이 실행 환경 구성', planning: '계획 작성', working: '파일 작업', verifying: '프로젝트 검증', 'browser-qa': '독립 브라우저 QA', 'milestone-qa': '부분 작업 검증', judging: '판정', applying: '프로젝트 반영' })[run.stage] || run.stage}`
      : `${run.summary || '실행을 마쳤습니다.'}${run.applied ? '\n\n프로젝트에 변경을 자동 반영했습니다.' : ''}${run.source ? `\n\n프로젝트: \`${run.source}\`` : ''}${run.workspace && run.status !== 'completed' ? `\n\n작업 공간: \`${run.workspace}\`` : ''}${run.milestones?.length ? `\n\n부분 작업 ${run.milestones.filter((task) => task.status === 'completed').length}/${run.milestones.length} 완료\n${run.milestones.map((task) => `- ${task.status === 'completed' ? '✓' : task.status === 'needs-review' ? '↻' : '○'} ${task.title} · ${task.evidence?.reviewed ? '검증 근거 보존' : '검증 대기'}`).join('\n')}` : ''}${formatBrowserQaSummary(run)}${run.qaHistory?.length ? `\n${(run.qaHistory.at(-1).screenshots || []).map((image) => `[${image.viewport} · ${image.checkId}](${location.origin}/api/harness/runs/${run.id}/qa/${run.qaHistory.at(-1).round}/${image.name})`).join(' · ')}` : ''}${formatReadmeQaSummary(run)}${run.patchAvailable ? `\n\n[변경 패치 내려받기](${location.origin}/api/harness/runs/${run.id}/patch)` : ''}`;
    if (run.source) {
      conversation.harnessWorkspace = run.source;
      const project = getProject(conversation.projectId);
      if (project && !project.workspace) { project.workspace = run.source; saveProjects(); }
    }
    conversation.updatedAt = Date.now(); saveConversations(); render();
  }
  async function watch(id, message, conversation) {
    if (watching) return;
    watching = true; activeRunId = id;
    state.busy = true; state.loopEngineeringRunning = true;
    let failures = 0;
    const poll = async () => {
      try {
        const run = await request(`/api/harness/runs/${id}`); failures = 0;
        state.busy = !DONE.has(run.status); state.loopEngineeringRunning = state.busy;
        update(run, message, conversation);
        if (DONE.has(run.status)) { watching = false; activeRunId = null; state.loopStopRequested = false; render(); if (run.status === 'completed') onComplete?.(conversation); return; }
      } catch (error) {
        if (error.status === 404) {
          watching = false; activeRunId = null; state.busy = false; state.loopEngineeringRunning = false;
          message.pending = false; message.error = true; message.harnessStatus = 'interrupted';
          message.content = '이 서버에서 실행 기록을 찾을 수 없습니다. 작업 폴더의 변경 상태를 확인한 뒤 새 실행을 시작해 주세요.';
          saveConversations(); render(); return;
        }
        failures++;
        if (failures === 3) { message.content = '진행 상태 연결을 다시 시도하고 있습니다. 서버에서 실행이 계속될 수 있습니다.'; render(); }
        if (failures === 10) toast('서버 연결을 기다립니다. 연결이 복구되면 실행 결과를 다시 표시합니다.');
      }
      setTimeout(poll, failures ? 5000 : 800);
    };
    await poll();
  }
  async function start(task, message, conversation) {
    const project = currentProject();
    const roles = {};
    if (config.modelSelectionMode === 'priority' && ensurePrioritySelections(task)) save();
    ensureFallbackPriority();
    const roleSelection = (role, model, primary) => ({
      provider: model.provider, source: model.source, model: model.id, label: model.label,
      description: typeof model.description === 'string' ? model.description.slice(0, 600) : '',
      supportedReasoningEfforts: efforts(model),
      connectionId: model.connectionId,
      ...(model.provider === 'openai' ? {
        codexAccountId: model.codexAccountId || state.activeCodexAccountId,
        ...(Number.isFinite(model.remainingPercent) ? { remainingPercent: model.remainingPercent } : {}),
      } : {}),
      ...(model.decisionOnly ? { decisionOnly: true } : {}),
      automaticEffort: !config.roles[role].effort,
      reasoningEffort: primary ? resolveEffort(role, model, task) : resolveFallbackEffort(role, model, task),
      instructions: instructions(model.provider), nativePlugins: config.roles[role].nativePlugins, loopMcp: config.roles[role].loopMcp,
    });
    for (const [role] of ROLES) {
      const model = choose(role, task);
      if (!model) { open(); throw new Error(role === 'judge' ? 'Jev를 연결하거나 판정 모델을 선택해 주세요.' : '사용할 모델을 연결해 주세요.'); }
      const candidates = config.modelSelectionMode === 'automatic'
        ? automaticModelOrder(role, task).slice(0, MAX_FALLBACKS + 1)
        : [model, ...config.roles[role].fallbacks.map(modelByKey).filter(Boolean)];
      const fallbacks = candidates.slice(1)
        .filter((candidate) => candidate && (role === 'judge' || !candidate.decisionOnly) && modelKey(candidate) !== modelKey(model));
      roles[role] = { ...roleSelection(role, model, true), automatic: config.modelSelectionMode === 'automatic', fallbacks: fallbacks.map((candidate) => roleSelection(role, candidate, false)) };
    }
    const workspace = project?.workspace || conversation.harnessWorkspace || undefined;
    starting = true; stopRequested = false;
    state.busy = true; state.loopEngineeringRunning = true; render();
    try {
      const run = await request('/api/harness/runs', { task, roles, priorities: config.priorities, budgetProfile: config.budgetProfile, workspace, rounds: state.loopEngineeringRounds, autoApply: config.autoApply, mcpTools: config.mcpTools, instructions: project ? `${project.instructions || ''}\n${project.knowledge || ''}` : '' });
      activeRunId = run.id;
      update(run, message, conversation);
      if (stopRequested) await stop();
      await watch(run.id, message, conversation);
    } catch (error) { state.busy = false; state.loopEngineeringRunning = false; render(); throw error; }
    finally { starting = false; }
  }
  async function stop() {
    stopRequested = true;
    if (!activeRunId) return;
    try { await request(`/api/harness/runs/${activeRunId}/stop`, {}); toast('현재 작업과 다음 회차를 중지합니다.'); }
    catch (error) { toast(error.message); }
  }
  async function resume() {
    for (const conversation of state.conversations) {
      const message = [...conversation.messages].reverse().find((item) => item.harnessRunId && !DONE.has(item.harnessStatus));
      if (message) { await watch(message.harnessRunId, message, conversation); return; }
    }
  }
  async function resumeRun(message, conversation) {
    if (!message?.harnessRunId || starting || watching) return;
    starting = true; state.busy = true; state.loopEngineeringRunning = true; render();
    try {
      const run = await request(`/api/harness/runs/${message.harnessRunId}/resume`, {});
      activeRunId = run.id;
      update(run, message, conversation);
      await watch(run.id, message, conversation);
    } catch (error) {
      state.busy = false; state.loopEngineeringRunning = false; render();
      toast(error.message);
    } finally { starting = false; }
  }
  return { enable: () => { config.enabled = true; document.querySelector('#loopExecutionMode').value = 'harness'; save(); }, enabled: () => config.enabled, active: () => starting || Boolean(activeRunId), open, start, stop, resume, resumeRun };
}

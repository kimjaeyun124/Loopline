import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarnessUI } from '../public/harness-ui.js';

const KEY = 'loopline.harness.v1';
// Minimal event surface: exercise the real settings handlers without a browser dependency.
function setup(t, { storage = new Map(), project = null, models = null, evidence = { models: [] } } = {}) {
  const nodes = new Map();
  const toasts = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, hidden: true, textContent: '', dataset: {},
      listeners: {}, focus() {}, addEventListener(name, handler) { this.listeners[name] = handler; },
      fire(name, target = this) { return this.listeners[name]?.({ target, key: 'Escape', stopPropagation() {} }); } });
    return nodes.get(id);
  };
  let evidenceResponse = evidence, failEvidenceRequest = false, evidenceFailureStatus = null, evidenceRequestCount = 0;
  let failStorage = false;
  for (const key of ['document', 'localStorage', 'window', 'fetch']) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : delete globalThis[key]);
  }
  globalThis.document = { querySelector: node };
  globalThis.fetch = async () => {
    evidenceRequestCount++;
    if (failEvidenceRequest) throw new Error('offline');
    if (evidenceFailureStatus !== null) return { ok: false, status: evidenceFailureStatus, json: async () => ({ error: 'request failed' }) };
    const response = typeof evidenceResponse === 'function' ? await evidenceResponse() : evidenceResponse;
    return { ok: true, json: async () => response };
  };
  node('#harnessRoles').querySelector = (selector) => {
    const role = selector.match(/data-fallback-select="([a-z]+)"/)?.[1];
    return role ? node(`#fallbackSelect-${role}`) : null;
  };
  globalThis.window = { looplineWorkspace: { chooseFolder: async () => '/chosen/project' } };
  globalThis.localStorage = { getItem: (key) => storage.get(key), setItem(key, value) { if (failStorage) throw new Error('quota'); storage.set(key, value); } };
  const model = { provider: 'api', id: 'jev-test', label: 'Jev Test', source: 'QA', connected: true, reasoningEfforts: ['medium', 'high'] };
  const state = { conversations: [], activeProjectId: 'project' };
  const ui = createHarnessUI({ state, catalog: () => models || [model], modelKey: (item) => item.id, currentKey: () => model.id,
    getProject: () => project, saveProjects() {},
    saveConversations() {}, render() {}, toast: (message) => toasts.push(message), instructions() {}, onComplete() {} });
  return { ui, node, fields: node('#harnessRoles'), storage, saved: () => JSON.parse(storage.get(KEY)),
    toasts, failStorage: (value) => { failStorage = value; },
    setEvidence: (value) => { evidenceResponse = value; }, failEvidence: (value) => { failEvidenceRequest = value; },
    setEvidenceStatus: (value) => { evidenceFailureStatus = value; },
    evidenceRequestCount: () => evidenceRequestCount };
}

function setWebsiteTask(s) {
  s.node('#messageInput').value = 'Build a website dashboard architecture with responsive layouts.';
}

test('role, effort and options save without the completion button', (t) => {
  const s = setup(t); s.ui.open();
  s.node('#harnessRoles').fire('change', { dataset: { harnessRole: 'worker' }, value: 'jev-test' });
  s.node('#harnessRoles').fire('change', { dataset: { harnessEffort: 'worker' }, value: 'high' });
  s.node('#harnessAutoApply').checked = false; s.node('#harnessAutoApply').fire('change');
  s.node('#harnessClose').fire('click');
  assert.deepEqual(s.saved().roles.worker, { model: 'jev-test', effort: 'high', nativePlugins: true, loopMcp: true, fallbacks: [] });
  assert.equal(s.saved().autoApply, false);
  assert.match(s.node('#harnessSaveStatus').textContent, /자동 저장됨/);
});

test('model settings survive a fresh UI instance without workspace inputs', (t) => {
  const s = setup(t); s.ui.open();
  s.node('#harnessRoles').fire('change', { dataset: { harnessRole: 'worker' }, value: 'jev-test' });
  s.node('#harnessRoles').fire('change', { dataset: { harnessEffort: 'worker' }, value: 'high' });
  s.node('#harnessModal').fire('keydown');
  const reloaded = setup(t, { storage: s.storage }); reloaded.ui.open();
  assert.match(reloaded.node('#harnessRoles').innerHTML, /value="high" selected/);
  assert.deepEqual(reloaded.saved().roles.worker, { model: 'jev-test', effort: 'high', nativePlugins: true, loopMcp: true, fallbacks: [] });
});

test('Loop role model choices show and search by model strengths', (t) => {
  const model = {
    provider: 'openai', id: 'gpt-6-luna', label: 'GPT-6-Luna', source: 'Codex', connected: true,
    description: 'Fast and affordable model for easier tasks.',
    supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
  };
  const s = setup(t, { models: [model] }); s.ui.open();
  assert.match(s.fields.innerHTML, /GPT-6-Luna · 가벼운 작업 · 빠르고 효율적/);
  assert.match(s.fields.innerHTML, /가벼운 작업 · 빠르고 효율적/);
  s.node('#harnessModelSearch').value = '빠르고 효율적';
  s.node('#harnessModelSearch').fire('input');
  assert.match(s.fields.innerHTML, /value="gpt-6-luna"/);
});

test('model settings show observed manual resumes and stop requests beside measured performance', async (t) => {
  const model = { provider: 'api', id: 'writer', label: 'Writer', source: 'QA', connected: true, reasoningEfforts: ['max'] };
  const storage = new Map([[KEY, JSON.stringify({ roles: { worker: { model: 'writer', effort: 'max' } } })]]);
  const evidence = { models: [{ role: 'worker', provider: 'api', model: 'writer', effort: 'max', type: 'web', runs: 1, completionMeasuredRuns: 1, completedRuns: 1,
    browserQaPassedRuns: 0, browserQaRuns: 0, reportedTokens: 1234, missingUsageCalls: 0, sufficientEvidence: false,
    humanInterventionMeasuredRuns: 2, partiallyMeasuredInterventionRuns: 1, manualResumes: 1, stopRequests: 2 }] };
  const s = setup(t, { storage, models: [model], evidence });
  setWebsiteTask(s);
  s.ui.open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(s.fields.innerHTML, /실행 참여 1회 · 역할 단독 완료 1\/1/);
  assert.match(s.fields.innerHTML, /개입 계측 2개 실행 \(일부 기록\)/);
  assert.match(s.fields.innerHTML, /수동 재개 1회/);
  assert.match(s.fields.innerHTML, /중지 요청 2회/);
});

test('malformed evidence exclusions are visible only when records are skipped', async (t) => {
  const s = setup(t, { evidence: { models: [], evidenceDiagnostics: {
    malformedJsonRecords: 1, unreadableRecords: 1,
    invalidRecordReasons: { 'invalid-call': 2, 'invalid-human-intervention': 1, 'future-reason': 1 },
    excludedRecordIds: {
      'invalid-call': ['11111111-1111-4111-8111-111111111111'],
      'malformed-json': ['22222222-2222-4222-8222-222222222222'],
      unreadable: ['33333333-3333-4333-8333-333333333333'],
      'future-reason': ['44444444-4444-4444-8444-444444444444'],
    },
  } } });
  s.ui.open();
  await new Promise((resolve) => setImmediate(resolve));
  const notice = s.node('#harnessEvidenceNotice');
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /실측 기록 6개를 모델 선택 통계에서 제외/);
  assert.match(notice.textContent, /JSON 오류 1개 · 형식 오류 4개 \(호출 데이터 2개, 개입 정보 1개, 기타 형식 오류 1개\) · 읽기 오류 1개/);
  const details = s.node('#harnessEvidenceDetails');
  const ids = s.node('#harnessEvidenceIds');
  assert.equal(details.hidden, false);
  assert.match(ids.innerHTML, /호출 데이터 · 예시 ID/);
  assert.match(ids.innerHTML, /JSON 오류 · 예시 ID/);
  assert.match(ids.innerHTML, /읽기 오류 · 예시 ID/);
  assert.match(ids.innerHTML, /11111111-1111-4111-8111-111111111111/);
  assert.match(ids.innerHTML, /data-copy-excluded-id="11111111-1111-4111-8111-111111111111"/);
  assert.match(ids.innerHTML, /기타 형식 오류 · 예시 ID/);

  const healthy = setup(t, { evidence: { models: [], evidenceDiagnostics: {
    malformedJsonRecords: 0, unreadableRecords: 0, invalidRecordReasons: {},
  } } });
  healthy.ui.open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(healthy.node('#harnessEvidenceNotice').hidden, true);
  assert.equal(healthy.node('#harnessEvidenceNotice').textContent, '');
  assert.equal(healthy.node('#harnessEvidenceDetails').hidden, true);
  assert.equal(healthy.node('#harnessEvidenceIds').innerHTML, '');
});

test('evidence refresh updates diagnostics and model statistics and recovers after request failure', async (t) => {
  const s = setup(t, { evidence: { models: [], evidenceDiagnostics: { invalidRecordReasons: { 'invalid-call': 1 } } } });
  setWebsiteTask(s);
  s.ui.open();
  await new Promise((resolve) => setImmediate(resolve));
  const button = s.node('#harnessEvidenceRefresh');
  assert.match(s.node('#harnessEvidenceStatus').textContent, /^실측 정보를 갱신했습니다 · 마지막 확인 \d{2}:\d{2}$/);
  const initialConfirmedAt = s.node('#harnessEvidenceStatus').textContent.match(/\d{2}:\d{2}$/)?.[0];
  assert.ok(initialConfirmedAt);
  assert.equal(s.evidenceRequestCount(), 1);

  let finishRefresh;
  s.setEvidence(() => new Promise((resolve) => { finishRefresh = resolve; }));
  const refresh = button.fire('click');
  assert.equal(button.disabled, true);
  assert.equal(s.node('#harnessEvidenceStatus').textContent, `실측 정보 갱신 중 · 마지막 확인 ${initialConfirmedAt}`);
  assert.equal(await button.fire('click'), false);
  assert.equal(s.evidenceRequestCount(), 2);
  finishRefresh({ models: [{ role: 'worker', provider: 'api', model: 'jev-test', effort: 'high', type: 'web', runs: 1,
    completionMeasuredRuns: 1, completedRuns: 1, browserQaPassedRuns: 0, browserQaRuns: 0, reportedTokens: 400,
    missingUsageCalls: 0, sufficientEvidence: false }], evidenceDiagnostics: { invalidRecordReasons: {} } });
  assert.equal(await refresh, true);
  assert.equal(button.disabled, false);
  assert.match(s.node('#harnessEvidenceStatus').textContent, /^실측 정보를 갱신했습니다 · 마지막 확인 \d{2}:\d{2}$/);
  const refreshedAt = s.node('#harnessEvidenceStatus').textContent.match(/\d{2}:\d{2}$/)?.[0];
  assert.ok(refreshedAt);
  assert.equal(s.node('#harnessEvidenceNotice').hidden, true);
  assert.match(s.fields.innerHTML, /호출 토큰 400/);

  s.failEvidence(true);
  assert.equal(await button.fire('click'), false);
  assert.equal(button.disabled, false);
  assert.equal(s.node('#harnessEvidenceStatus').textContent, `갱신 실패 · ${refreshedAt} 기준 실측 정보를 표시 중입니다.`);
  assert.match(s.fields.innerHTML, /호출 토큰 400/);
  assert.equal(s.evidenceRequestCount(), 5, 'network failure should stop after the initial request plus two retries');
  assert.ok(s.toasts.includes('실측 진단 정보를 갱신하지 못했습니다. 잠시 후 다시 시도해 주세요.'));
});

test('transient evidence failures retry automatically and keep the refresh control locked', async (t) => {
  const s = setup(t);
  setWebsiteTask(s);
  s.ui.open();
  await new Promise((resolve) => setImmediate(resolve));

  let attempts = 0;
  s.setEvidence(async () => {
    attempts++;
    if (attempts < 3) throw new Error('temporary network failure');
    return { models: [{ role: 'worker', provider: 'api', model: 'jev-test', effort: 'high', type: 'web', runs: 1,
      completionMeasuredRuns: 1, completedRuns: 1, browserQaPassedRuns: 0, browserQaRuns: 0, reportedTokens: 900,
      missingUsageCalls: 0, sufficientEvidence: false }], evidenceDiagnostics: { invalidRecordReasons: {} } };
  });

  const refresh = s.node('#harnessEvidenceRefresh').fire('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.node('#harnessEvidenceRefresh').disabled, true);
  assert.match(s.node('#harnessEvidenceStatus').textContent, /^실측 정보 재시도 1\/2 중/);
  assert.equal(s.evidenceRequestCount(), 2);
  assert.equal(await refresh, true);
  assert.equal(s.evidenceRequestCount(), 4, 'two transient failures should be followed by a successful third attempt');
  assert.equal(s.node('#harnessEvidenceRefresh').disabled, false);
  assert.match(s.node('#harnessEvidenceStatus').textContent, /^실측 정보를 갱신했습니다 · 마지막 확인 \d{2}:\d{2}$/);
  assert.match(s.fields.innerHTML, /호출 토큰 900/);
});

test('non-retryable evidence HTTP errors fail immediately and keep the last confirmed time', async (t) => {
  const s = setup(t);
  s.ui.open();
  await new Promise((resolve) => setImmediate(resolve));
  const status = s.node('#harnessEvidenceStatus').textContent;
  const confirmedAt = status.match(/\d{2}:\d{2}$/)?.[0];
  assert.ok(confirmedAt);

  s.setEvidenceStatus(400);
  assert.equal(await s.node('#harnessEvidenceRefresh').fire('click'), false);
  assert.equal(s.evidenceRequestCount(), 2, 'client errors should not be retried');
  assert.equal(s.node('#harnessEvidenceStatus').textContent, `갱신 실패 · ${confirmedAt} 기준 실측 정보를 표시 중입니다.`);
});

test('excluded evidence ID copy confirms success and reports clipboard failures', async (t) => {
  const id = '11111111-1111-4111-8111-111111111111';
  const s = setup(t, { evidence: { models: [], evidenceDiagnostics: {
    invalidRecordReasons: { 'invalid-call': 1 }, excludedRecordIds: { 'invalid-call': [id] },
  } } });
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => originalNavigator ? Object.defineProperty(globalThis, 'navigator', originalNavigator) : delete globalThis.navigator);
  const copied = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (value) => copied.push(value) } } });
  s.ui.open();
  await new Promise((resolve) => setImmediate(resolve));
  const button = { dataset: { copyExcludedId: id }, textContent: '복사', isConnected: true };
  const click = s.node('#harnessEvidenceDetails').listeners.click;
  await click({ target: { closest: (selector) => selector === '[data-copy-excluded-id]' ? button : null } });
  assert.deepEqual(copied, [id]);
  assert.equal(button.textContent, '복사됨');
  assert.ok(s.toasts.includes('제외된 기록 ID를 복사했습니다.'));

  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => { throw new Error('denied'); } } } });
  const failedButton = { dataset: { copyExcludedId: id }, textContent: '복사', isConnected: true };
  await click({ target: { closest: (selector) => selector === '[data-copy-excluded-id]' ? failedButton : null } });
  assert.equal(failedButton.textContent, '복사');
  assert.ok(s.toasts.includes('클립보드에 복사하지 못했습니다.'));
});

test('loop compute priorities are reorderable, persisted, and keep completion locked at the top', (t) => {
  const s = setup(t); s.ui.open();
  assert.match(s.node('#harnessPriorities').innerHTML, /완료 안정성/);
  assert.match(s.node('#harnessPriorities').innerHTML, /항상 최우선/);
  s.node('#harnessPriorities').fire('click', { closest: (selector) => selector === '[data-priority-move]'
    ? { dataset: { priorityMove: 'speed', direction: 'up' } } : null });
  assert.deepEqual(s.saved().priorities, ['quality', 'reasoning', 'speed', 'tokenEfficiency']);
  assert.match(s.node('#harnessPriorities').innerHTML, /locked/);
  const reloaded = setup(t, { storage: s.storage }); reloaded.ui.open();
  assert.deepEqual(reloaded.saved().priorities, ['quality', 'reasoning', 'speed', 'tokenEfficiency']);
  assert.ok(reloaded.node('#harnessPriorities').innerHTML.indexOf('응답 속도') < reloaded.node('#harnessPriorities').innerHTML.indexOf('토큰 효율'));
});

test('storage failure stays visible and completion retries before closing', (t) => {
  const s = setup(t); s.ui.open(); s.failStorage(true);
  s.node('#harnessRoles').fire('change', { dataset: { harnessRole: 'judge' }, value: 'jev-test' });
  assert.match(s.node('#harnessSaveStatus').textContent, /저장하지 못했습니다/);
  s.node('#harnessSave').fire('click'); assert.equal(s.node('#harnessModal').hidden, false);
  s.failStorage(false); s.node('#harnessSave').fire('click');
  assert.equal(s.node('#harnessModal').hidden, true);
  assert.equal(s.saved().roles.judge.model, 'jev-test');
});

test('opening settings preserves saved effort when the model is temporarily unavailable', (t) => {
  const storage = new Map([[KEY, JSON.stringify({ roles: { worker: { model: 'disconnected', effort: 'high', fallbacks: [] } } })]]);
  const s = setup(t, { storage }); s.ui.open();
  s.node('#harnessAutoApply').fire('change');
  assert.deepEqual(s.saved().roles.worker, { model: 'disconnected', effort: 'high', nativePlugins: true, loopMcp: true, fallbacks: [] });
});


test('native Jev is offered only for the review role', (t) => {
  const s = setup(t, { models: [
    { provider: 'api', id: 'writer', label: 'Writer', source: 'QA', connected: true, reasoningEfforts: [] },
    { provider: 'api', id: 'jev-native', label: 'Jev Native', source: 'TypeSafe', connected: true, decisionOnly: true, reasoningEfforts: [] },
  ] });
  s.ui.open();
  assert.equal((s.node('#harnessRoles').innerHTML.match(/value="jev-native"/g) || []).length, 1);
  assert.match(s.node('#harnessRoles').innerHTML, /Jev 판정 전용/);
});

test('saved fallback model order is visible and changes persist immediately', (t) => {
  const models = ['writer-a', 'writer-b', 'writer-c'].map((id) => ({
    provider: 'api', id, label: id.toUpperCase(), source: 'QA', connected: true, reasoningEfforts: [],
  }));
  const storage = new Map([[KEY, JSON.stringify({ roles: { worker: { fallbacks: ['writer-b', 'writer-c'] } } })]]);
  const s = setup(t, { storage, models });
  s.ui.open();
  const fallbackRows = () => s.fields.innerHTML.match(/aria-label="구현 \/ Implementation 대체 모델 우선순위"[\s\S]*?<ol>([\s\S]*?)<\/ol>/)?.[1] || '';
  assert.ok(fallbackRows().indexOf('WRITER-B') < fallbackRows().indexOf('WRITER-C'));
  s.fields.fire('click', { closest: (selector) => selector === '[data-fallback-move]'
    ? { dataset: { fallbackMove: 'worker', key: 'writer-c', direction: 'up' } } : null });
  assert.deepEqual(s.saved().roles.worker.fallbacks, ['writer-c', 'writer-b']);
  assert.ok(fallbackRows().indexOf('WRITER-C') < fallbackRows().indexOf('WRITER-B'));
});


test('fallback candidate change does not redraw the select before Add', (t) => {
  const models = ['a', 'b'].map((id) => ({ id, label: id, source: 'QA', connected: true }));
  const storage = new Map([[KEY, JSON.stringify({ roles: { worker: { model: 'a', fallbacks: [] } } })]]);
  const s = setup(t, { storage, models }); s.ui.open();
  s.fields.innerHTML = 'unchanged';
  s.fields.fire('change', { dataset: { fallbackSelect: 'worker' }, value: 'b' });
  assert.equal(s.fields.innerHTML, 'unchanged');
  s.node('#fallbackSelect-worker').value = 'b';
  s.fields.fire('click', { closest: (selector) => selector === '[data-fallback-add]'
    ? { dataset: { fallbackAdd: 'worker' } } : null });
  assert.deepEqual(s.saved().roles.worker.fallbacks, ['b']);
});

test('fallback edits use model identity when the primary is hidden from the list', (t) => {
  const models = ['a', 'b', 'c'].map((id) => ({ id, label: id, source: 'QA', connected: true }));
  const storage = new Map([[KEY, JSON.stringify({ roles: { worker: { model: 'a', fallbacks: ['a', 'b', 'c'] } } })]]);
  const s = setup(t, { storage, models }); s.ui.open();
  s.fields.fire('click', { closest: (selector) => selector === '[data-fallback-move]'
    ? { dataset: { fallbackMove: 'worker', key: 'c', direction: 'up' } } : null });
  assert.deepEqual(s.saved().roles.worker.fallbacks, ['a', 'c', 'b']);
  s.fields.fire('click', { closest: (selector) => selector === '[data-fallback-remove]'
    ? { dataset: { fallbackRemove: 'worker', key: 'c' } } : null });
  assert.deepEqual(s.saved().roles.worker.fallbacks, ['a', 'b']);
});

test('search keeps the selected model and automatic reset preserves fallback priority', (t) => {
  const models = ['a', 'b', 'c'].map((id) => ({ id, label: id, source: 'QA', connected: true }));
  const storage = new Map([[KEY, JSON.stringify({ roles: { worker: { model: 'a', effort: 'high', fallbacks: ['c', 'b'] } } })]]);
  const s = setup(t, { storage, models }); s.ui.open();
  s.node('#harnessModelSearch').value = 'nonexistent';
  s.node('#harnessModelSearch').fire('input');
  assert.match(s.fields.innerHTML, /value="a" selected/);
  assert.match(s.fields.innerHTML, /검색 결과 없음/);
  s.node('#harnessUseAutomatic').fire('click');
  assert.deepEqual(s.saved().roles.worker, { model: '', effort: '', nativePlugins: true, loopMcp: true, fallbacks: ['c', 'b'] });
});

test('all role selectors use the concise automatic label with or without Jev', (t) => {
  for (const withJev of [false, true]) {
    const models = [{ id: 'writer', label: 'Writer', provider: 'api', source: 'QA', connected: true }];
    if (withJev) models.push({ id: 'jev', label: 'Jev', provider: 'api', source: 'QA', connected: true, decisionOnly: true });
    const s = setup(t, { models }); s.ui.open();
    for (const role of ['planner', 'worker', 'judge']) {
      const options = s.fields.innerHTML.match(new RegExp(`<select data-harness-role="${role}"[^>]*>([\\s\\S]*?)</select>`))?.[1];
      assert.ok(options, role);
      assert.match(options, /<option value="">자동<\/option>/);
      assert.doesNotMatch(options, /자동 ·/);
    }
  }
});


test('Agent Plugin and Loopline MCP role switches persist independently', (t) => {
  const s = setup(t); s.ui.open();
  s.fields.fire('change', { dataset: { harnessNative: 'worker' }, checked: false });
  s.fields.fire('change', { dataset: { harnessShared: 'judge' }, checked: false });
  assert.equal(s.saved().roles.worker.nativePlugins, false);
  assert.equal(s.saved().roles.worker.loopMcp, true);
  assert.equal(s.saved().roles.judge.nativePlugins, true);
  assert.equal(s.saved().roles.judge.loopMcp, false);
  const reloaded = setup(t, { storage: s.storage }); reloaded.ui.open();
  assert.doesNotMatch(reloaded.fields.innerHTML, /data-harness-native="worker" checked/);
});

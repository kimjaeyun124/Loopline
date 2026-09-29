import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarnessUI } from '../public/harness-ui.js';

const KEY = 'loopline.harness.v1';
// Minimal event surface: exercise the real settings handlers without a browser dependency.
function setup(t, { storage = new Map(), project = null, models = null } = {}) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, hidden: true, textContent: '', dataset: {},
      listeners: {}, focus() {}, addEventListener(name, handler) { this.listeners[name] = handler; },
      fire(name, target = this) { return this.listeners[name]?.({ target, key: 'Escape', stopPropagation() {} }); } });
    return nodes.get(id);
  };
  let failStorage = false;
  for (const key of ['document', 'localStorage', 'window']) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : delete globalThis[key]);
  }
  globalThis.document = { querySelector: node };
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
    saveConversations() {}, render() {}, toast() {}, instructions() {}, onComplete() {} });
  return { ui, node, fields: node('#harnessRoles'), storage, saved: () => JSON.parse(storage.get(KEY)),
    failStorage: (value) => { failStorage = value; } };
}

test('role, effort and options save without the completion button', (t) => {
  const s = setup(t); s.ui.open();
  s.node('#harnessRoles').fire('change', { dataset: { harnessRole: 'worker' }, value: 'jev-test' });
  s.node('#harnessRoles').fire('change', { dataset: { harnessEffort: 'worker' }, value: 'high' });
  s.node('#harnessAutoApply').checked = false; s.node('#harnessAutoApply').fire('change');
  s.node('#harnessClose').fire('click');
  assert.deepEqual(s.saved().roles.worker, { model: 'jev-test', effort: 'high', fallbacks: [] });
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
  assert.deepEqual(reloaded.saved().roles.worker, { model: 'jev-test', effort: 'high', fallbacks: [] });
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
  assert.deepEqual(s.saved().roles.worker, { model: 'disconnected', effort: 'high', fallbacks: [] });
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
  assert.deepEqual(s.saved().roles.worker, { model: '', effort: '', fallbacks: ['c', 'b'] });
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

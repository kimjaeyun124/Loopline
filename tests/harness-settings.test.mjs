import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarnessUI } from '../public/harness-ui.js';

const KEY = 'loopline.harness.v1';
// Minimal event surface: exercise the real settings handlers without a browser dependency.
function setup(t, { storage = new Map(), project = null } = {}) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, hidden: true, textContent: '', dataset: {},
      listeners: {}, focus() {}, addEventListener(name, handler) { this.listeners[name] = handler; },
      fire(name, target = this) { return this.listeners[name]?.({ target, key: 'Escape', stopPropagation() {} }); } });
    return nodes.get(id);
  };
  let failStorage = false, failProject = false, projectSaves = 0;
  for (const key of ['document', 'localStorage', 'window']) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : delete globalThis[key]);
  }
  globalThis.document = { querySelector: node };
  globalThis.window = { looplineWorkspace: { chooseFolder: async () => '/chosen/project' } };
  globalThis.localStorage = { getItem: (key) => storage.get(key), setItem(key, value) { if (failStorage) throw new Error('quota'); storage.set(key, value); } };
  const model = { provider: 'api', id: 'jev-test', label: 'Jev Test', source: 'QA', connected: true, reasoningEfforts: ['medium', 'high'] };
  const state = { conversations: [], activeProjectId: 'project' };
  const ui = createHarnessUI({ state, catalog: () => [model], modelKey: (item) => item.id, currentKey: () => model.id,
    getProject: () => project, saveProjects: () => { projectSaves++; return !failProject; },
    saveConversations() {}, render() {}, toast() {}, instructions() {}, onComplete() {} });
  return { ui, node, storage, saved: () => JSON.parse(storage.get(KEY)),
    failStorage: (value) => { failStorage = value; }, failProject: (value) => { failProject = value; }, projectSaves: () => projectSaves };
}

test('role, effort and options save without the completion button', (t) => {
  const s = setup(t); s.ui.open();
  s.node('#harnessRoles').fire('change', { dataset: { harnessRole: 'worker' }, value: 'jev-test' });
  s.node('#harnessRoles').fire('change', { dataset: { harnessEffort: 'worker' }, value: 'high' });
  s.node('#harnessAutoApply').checked = false; s.node('#harnessAutoApply').fire('change');
  s.node('#harnessClose').fire('click');
  assert.deepEqual(s.saved().roles.worker, { model: 'jev-test', effort: 'high' });
  assert.equal(s.saved().autoApply, false);
  assert.match(s.node('#harnessSaveStatus').textContent, /자동 저장됨/);
});

test('folder and command survive closing and creating a fresh UI instance', (t) => {
  const s = setup(t); s.ui.open();
  s.node('#harnessWorkspace').value = '/work/project'; s.node('#harnessWorkspace').fire('input');
  s.node('#harnessVerify').value = 'npm test'; s.node('#harnessVerify').fire('input');
  s.node('#harnessModal').fire('keydown');
  const reloaded = setup(t, { storage: s.storage }); reloaded.ui.open();
  assert.equal(reloaded.node('#harnessWorkspace').value, '/work/project');
  assert.equal(reloaded.node('#harnessVerify').value, 'npm test');
});

test('native folder picker saves immediately; role changes preserve project settings', async (t) => {
  const project = { workspace: '/project-specific', verifyCommand: 'make check' };
  const s = setup(t, { project }); s.ui.open();
  s.node('#harnessRoles').fire('change', { dataset: { harnessRole: 'planner' }, value: 'jev-test' });
  assert.equal(s.projectSaves(), 0);
  assert.equal(project.workspace, '/project-specific');
  await s.node('#harnessChooseFolder').fire('click');
  assert.equal(project.workspace, '/chosen/project');
  assert.equal(project.verifyCommand, 'make check');
  assert.equal(s.saved().workspace, '/chosen/project');
});

test('storage failure stays visible and completion retries before closing', (t) => {
  const s = setup(t); s.ui.open(); s.failStorage(true);
  s.node('#harnessVerify').value = 'npm test'; s.node('#harnessVerify').fire('input');
  assert.match(s.node('#harnessSaveStatus').textContent, /저장하지 못했습니다/);
  s.node('#harnessSave').fire('click'); assert.equal(s.node('#harnessModal').hidden, false);
  s.failStorage(false); s.node('#harnessSave').fire('click');
  assert.equal(s.node('#harnessModal').hidden, true);
  assert.equal(s.saved().verifyCommand, 'npm test');
});

test('failed project persistence is retried even when config storage succeeds', (t) => {
  const s = setup(t, { project: {} }); s.ui.open(); s.failProject(true);
  s.node('#harnessVerify').value = 'make check'; s.node('#harnessVerify').fire('input');
  assert.match(s.node('#harnessSaveStatus').textContent, /저장하지 못했습니다/);
  s.failProject(false); s.node('#harnessSave').fire('click');
  assert.equal(s.projectSaves(), 2);
  assert.equal(s.node('#harnessModal').hidden, true);
});

test('opening settings preserves saved effort when the model is temporarily unavailable', (t) => {
  const storage = new Map([[KEY, JSON.stringify({ roles: { worker: { model: 'disconnected', effort: 'high' } } })]]);
  const s = setup(t, { storage }); s.ui.open();
  s.node('#harnessAutoApply').fire('change');
  assert.deepEqual(s.saved().roles.worker, { model: 'disconnected', effort: 'high' });
});

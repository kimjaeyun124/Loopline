import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPromptSkillStore,
  normalizePrompt,
  PROMPT_SKILLS_STORAGE_KEY,
} from '../public/prompt-skills.mjs';
import { createPromptSkillsUI } from '../public/prompt-skills-ui.js';

function makeStorage(initialValue = null) {
  const values = new Map(initialValue === null ? [] : [[PROMPT_SKILLS_STORAGE_KEY, initialValue]]);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

function makeStore(options = {}) {
  let nextId = 0;
  let time = 100;
  return createPromptSkillStore({
    storage: makeStorage(),
    now: () => ++time,
    createId: () => `skill-${++nextId}`,
    ...options,
  });
}

function historyWith(prompt, count) {
  return [{ messages: Array.from({ length: count }, () => ({ role: 'user', content: prompt })) }];
}

class FakeElement {
  constructor() {
    this.hidden = false;
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.dataset = {};
    this.listeners = new Map();
    this.attributes = {};
  }

  addEventListener(type, callback) { this.listeners.set(type, callback); }
  focus() { this.focused = true; }
  emit(type, event = {}) { this.listeners.get(type)?.({ target: this, ...event }); }
}

function makeDocument() {
  const ids = [
    'promptSkillsButton', 'promptSkillsModal', 'closePromptSkills', 'promptSkillsSearch',
    'promptSkillsList', 'promptSkillsEmpty', 'saveCurrentPromptSkill', 'promptSkillEditor',
    'promptSkillEditorTitle', 'promptSkillName', 'promptSkillContent', 'promptSkillError',
    'savePromptSkill', 'cancelPromptSkill',
  ];
  const elements = Object.fromEntries(ids.map((id) => [`#${id}`, new FakeElement()]));
  elements['#promptSkillsModal'].hidden = true;
  elements['#promptSkillEditor'].hidden = true;
  const listeners = new Map();
  return {
    elements,
    querySelector: (selector) => elements[selector],
    addEventListener: (type, callback) => listeners.set(type, callback),
    emit: (type, event = {}) => listeners.get(type)?.(event),
  };
}

function clickSkillAction(documentRef, action, id) {
  const card = { dataset: { skillId: id } };
  const button = {
    dataset: { skillAction: action },
    closest: (selector) => selector === '[data-skill-id]' ? card : null,
  };
  const target = { closest: (selector) => selector === '[data-skill-action]' ? button : null };
  documentRef.elements['#promptSkillsList'].emit('click', { target });
}

test('프롬프트 비교는 유니코드와 공백 차이를 정리한다', () => {
  assert.equal(normalizePrompt('  ＣＲ 리뷰\n부탁해  '), normalizePrompt('CR 리뷰 부탁해'));
  assert.notEqual(normalizePrompt('코드를 확인해줘'), normalizePrompt('코드를 확인해 주세요'));
});

test('세 번째로 사용한 긴 프롬프트를 자동 등록하고 큐 항목은 횟수에서 제외한다', () => {
  const store = makeStore();
  const prompt = '이 변경을 검토하고 확인된 문제와 다음 개선 순서를 정리해줘';
  const history = [{ messages: [
    { role: 'user', content: ` ${prompt.replace(' ', '  ')} ` },
    { role: 'user', content: prompt, queued: true },
  ] }];

  assert.equal(store.recordUse(prompt, history).type, 'counted');
  history[0].messages.push({ role: 'user', content: prompt });
  const result = store.recordUse(prompt, history);
  assert.equal(result.type, 'created');
  assert.equal(result.skill.source, 'auto');
  assert.equal(result.skill.uses, 3);
  assert.equal(store.list().length, 1);
});

test('자동 등록에는 과거 사용 횟수를 반영하고 이후 사용은 같은 스킬의 횟수만 늘린다', () => {
  const store = makeStore();
  const prompt = '매번 같은 작업을 안정적으로 처리하고 결과를 점검해줘';
  const result = store.recordUse(prompt, historyWith(prompt, 5));
  assert.equal(result.type, 'created');
  assert.equal(result.skill.uses, 6);

  const next = store.recordUse(prompt, historyWith(prompt, 6));
  assert.equal(next.type, 'used');
  assert.equal(next.skill.uses, 7);
  assert.equal(store.list().length, 1);
});

test('짧은 메시지는 자동 저장하지 않고 사용자가 직접 저장·수정·삭제할 수 있다', () => {
  const store = makeStore();
  assert.equal(store.recordUse('고마워요').type, 'ignored');
  const created = store.save({ name: '검토 요청', prompt: '변경 사항을 검토해줘' });
  assert.equal(created.ok, true);
  const used = store.recordUse('변경 사항을 검토해줘');
  assert.equal(used.skill.uses, 1);
  const edited = store.save({ id: created.skill.id, name: '코드 검토', prompt: '변경 사항을 자세히 검토해줘' });
  assert.equal(edited.ok, true);
  assert.equal(edited.skill.id, created.skill.id);
  assert.equal(edited.skill.uses, 1);
  assert.equal(store.remove(created.skill.id), true);
  assert.equal(store.list().length, 0);
});

test('저장 데이터 손상과 저장 공간 오류를 예외 없이 처리한다', () => {
  const corrupt = createPromptSkillStore({ storage: makeStorage('{broken') });
  assert.deepEqual(corrupt.list(), []);

  const fullStorage = { getItem: () => '[]', setItem: () => { throw new Error('quota exceeded'); } };
  const unavailable = makeStore({ storage: fullStorage });
  assert.equal(unavailable.save({ name: '검토', prompt: '다음 변경을 검토해줘' }).reason, 'storage');
  assert.equal(unavailable.recordUse('다음 변경을 검토하고 근거를 요약해줘', historyWith('다음 변경을 검토하고 근거를 요약해줘', 2)).reason, 'storage');

  const limited = makeStore();
  const oversized = '가'.repeat(8001);
  assert.equal(limited.recordUse(oversized, historyWith(oversized, 5)).type, 'ignored');
  assert.equal(limited.save({ name: '긴 입력', prompt: oversized }).reason, 'too_long');
});

test('보관함에서 저장한 스킬을 현재 입력 뒤에 추가하고 검색·편집·삭제한다', () => {
  const documentRef = makeDocument();
  const store = makeStore();
  let draft = '기존 초안';
  const ui = createPromptSkillsUI({
    getConversations: () => [],
    getDraft: () => draft,
    setDraft: (value) => { draft = value; },
    store,
    documentRef,
    confirmDelete: () => true,
  });
  const element = (id) => documentRef.elements[`#${id}`];

  element('promptSkillsButton').emit('click');
  assert.equal(element('promptSkillsModal').hidden, false);
  element('saveCurrentPromptSkill').emit('click');
  assert.equal(element('promptSkillEditor').hidden, false);
  element('promptSkillName').value = '검토 요청';
  element('promptSkillContent').value = '기존 내용보다 더 정확히 변경 사항을 검토해줘';
  element('savePromptSkill').emit('click');
  assert.equal(store.list().length, 1);
  const skill = store.list()[0];
  assert.match(element('promptSkillsList').innerHTML, /검토 요청/u);

  element('promptSkillsSearch').value = '없는 항목';
  element('promptSkillsSearch').emit('input');
  assert.match(element('promptSkillsEmpty').textContent, /검색 결과가 없습니다/u);
  element('promptSkillsSearch').value = '';
  element('promptSkillsSearch').emit('input');
  clickSkillAction(documentRef, 'insert', skill.id);
  assert.equal(draft, `기존 초안\n\n${skill.prompt}`);
  assert.equal(element('promptSkillsModal').hidden, true);

  ui.open();
  clickSkillAction(documentRef, 'edit', skill.id);
  assert.equal(element('promptSkillEditor').hidden, false);
  element('promptSkillName').value = '수정한 이름';
  element('savePromptSkill').emit('click');
  assert.equal(store.list()[0].name, '수정한 이름');
  clickSkillAction(documentRef, 'delete', skill.id);
  assert.equal(store.list().length, 0);
});

test('스킬 텍스트는 화면 렌더링 시 HTML로 실행되지 않는다', () => {
  const documentRef = makeDocument();
  const store = makeStore();
  store.save({ name: '<img src=x onerror=alert(1)>', prompt: '<script>alert(1)</script> 요청을 확인해줘' });
  const ui = createPromptSkillsUI({ store, documentRef });
  ui.open();
  assert.doesNotMatch(documentRef.elements['#promptSkillsList'].innerHTML, /<script>|<img /u);
  assert.match(documentRef.elements['#promptSkillsList'].innerHTML, /&lt;script&gt;/u);
});

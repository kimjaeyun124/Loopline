import assert from 'node:assert/strict';
import test from 'node:test';
import { initApp } from './app.mjs';

const STORAGE_KEY = 'focus-board-v1';

class FakeElement {
  constructor(tagName = 'div', root = null) {
    this.tagName = tagName.toUpperCase();
    this.root = root;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this._className = '';
    this._text = '';
    this.value = '';
    this.hidden = false;
  }

  set className(value) { this._className = value; }
  get className() { return this._className; }
  get classList() {
    const element = this;
    const tokens = () => new Set(element._className.split(/\s+/).filter(Boolean));
    const write = (values) => { element._className = [...values].join(' '); };
    return {
      add(...names) { const values = tokens(); names.forEach((name) => values.add(name)); write(values); },
      remove(...names) { const values = tokens(); names.forEach((name) => values.delete(name)); write(values); },
      contains(name) { return tokens().has(name); },
      toggle(name, force) {
        const values = tokens();
        const shouldAdd = force === undefined ? !values.has(name) : Boolean(force);
        if (shouldAdd) values.add(name); else values.delete(name);
        write(values);
        return shouldAdd;
      },
    };
  }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  append(...elements) {
    for (const element of elements) {
      element.parentNode = this;
      this.children.push(element);
    }
  }
  replaceChildren(...elements) {
    this.children.forEach((child) => { child.parentNode = null; });
    this.children = [];
    this._text = '';
    if (elements.length) this.append(...elements);
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  dispatch(type) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
  click() { return this.dispatch('click'); }
  focus() { if (this.root) this.root.activeElement = this; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  reset() { for (const input of this.formInputs ?? []) input.value = ''; }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.activeElement = null;
  }
  getElementById(id) { return this.elements.get(id) ?? null; }
  createElement(tagName) { return new FakeElement(tagName, this); }
}

class FakeStorage {
  constructor(entries = []) {
    this.values = new Map(entries);
    this.failWrites = false;
  }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) {
    if (this.failWrites) throw new Error('storage unavailable');
    this.values.set(key, String(value));
  }
}

function makeBoard(storage = new FakeStorage()) {
  const root = new FakeDocument();
  const elements = {};
  const tags = {
    taskForm: 'form', taskTitle: 'input', taskSubject: 'input', taskMinutes: 'input',
    formError: 'p', statusMessage: 'p', taskList: 'ul', emptyState: 'div', searchInput: 'input',
    filterAll: 'button', filterActive: 'button', filterCompleted: 'button',
    totalCount: 'strong', activeCount: 'strong', completedCount: 'strong', totalMinutes: 'strong',
  };
  for (const [id, tag] of Object.entries(tags)) {
    elements[id] = new FakeElement(tag, root);
    root.elements.set(id, elements[id]);
  }
  elements.taskForm.formInputs = [elements.taskTitle, elements.taskSubject, elements.taskMinutes];
  const app = initApp(root, storage);
  return { root, elements, storage, app };
}

function submit(board, { title, subject, minutes }) {
  board.elements.taskTitle.value = title;
  board.elements.taskSubject.value = subject;
  board.elements.taskMinutes.value = String(minutes);
  return board.elements.taskForm.dispatch('submit');
}

function findDescendant(element, predicate) {
  for (const child of element.children) {
    if (predicate(child)) return child;
    const nested = findDescendant(child, predicate);
    if (nested) return nested;
  }
  return null;
}

function actionButton(task, action) {
  const button = findDescendant(task, (element) => element.dataset.action === action);
  assert.ok(button, `missing ${action} action button`);
  return button;
}

function textByClass(task, className) {
  const element = findDescendant(task, (candidate) => candidate.classList.contains(className));
  assert.ok(element, `missing .${className}`);
  return element.textContent;
}

test('입력 오류와 경계를 처리하고 추가·완료·취소·삭제를 저장 및 복원한다', () => {
  const storage = new FakeStorage();
  const board = makeBoard(storage);
  const { elements } = board;

  assert.equal(elements.emptyState.hidden, false);
  assert.equal(elements.totalCount.textContent, '0');
  elements.taskTitle.value = '   ';
  elements.taskSubject.value = '수학';
  elements.taskMinutes.value = '30';
  elements.taskForm.dispatch('submit');
  assert.equal(elements.formError.hidden, false);
  assert.equal(board.root.activeElement, elements.taskTitle);
  assert.equal(elements.taskList.children.length, 0);

  submit(board, {
    title: '  <img src=x onerror=alert(1)>  ',
    subject: ' <script>alert(1)</script> ',
    minutes: 25,
  });
  assert.equal(elements.formError.hidden, true);
  assert.equal(elements.taskList.children.length, 1);
  assert.equal(textByClass(elements.taskList.children[0], 'task-title'), '<img src=x onerror=alert(1)>');
  assert.equal(textByClass(elements.taskList.children[0], 'task-subject'), '<script>alert(1)</script>');
  assert.equal(elements.totalMinutes.textContent, '25');
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).length, 1);

  actionButton(elements.taskList.children[0], 'toggle').click();
  assert.equal(elements.completedCount.textContent, '1');
  assert.equal(elements.activeCount.textContent, '0');
  const restored = makeBoard(storage);
  assert.equal(restored.elements.completedCount.textContent, '1');
  assert.equal(restored.elements.taskList.children.length, 1);
  actionButton(restored.elements.taskList.children[0], 'toggle').click();
  assert.equal(restored.elements.completedCount.textContent, '0');
  assert.equal(restored.elements.activeCount.textContent, '1');
  actionButton(restored.elements.taskList.children[0], 'delete').click();
  assert.equal(restored.elements.taskList.children.length, 0);
  assert.equal(restored.elements.totalCount.textContent, '0');
  assert.equal(restored.elements.totalMinutes.textContent, '0');
  const afterDeleteReload = makeBoard(storage);
  assert.equal(afterDeleteReload.elements.taskList.children.length, 0);
  assert.equal(afterDeleteReload.elements.emptyState.hidden, false);
});

test('제목·과목 길이와 학습 시간 경계를 검증한다', () => {
  const board = makeBoard();
  const { elements } = board;
  const invalid = [
    { title: '가'.repeat(101), subject: '수학', minutes: 1 },
    { title: '작업', subject: '과'.repeat(31), minutes: 1 },
    { title: '작업', subject: '수학', minutes: 0 },
    { title: '작업', subject: '수학', minutes: 481 },
    { title: '작업', subject: '수학', minutes: '1.5' },
    { title: '작업', subject: '수학', minutes: '' },
  ];
  for (const fields of invalid) {
    submit(board, fields);
    assert.equal(elements.formError.hidden, false);
    assert.equal(elements.taskList.children.length, 0);
  }

  submit(board, { title: '가'.repeat(100), subject: '과'.repeat(30), minutes: 480 });
  submit(board, { title: '최소 시간', subject: '수학', minutes: 1 });
  assert.equal(elements.taskList.children.length, 2);
  assert.equal(textByClass(elements.taskList.children[0], 'task-title'), '가'.repeat(100));
  assert.equal(textByClass(elements.taskList.children[0], 'task-subject'), '과'.repeat(30));
  assert.equal(elements.totalMinutes.textContent, '481');
  assert.equal(elements.formError.hidden, true);
});

test('필터와 대소문자 무시 검색은 목록만 바꾸고 전체 요약은 유지한다', () => {
  const board = makeBoard();
  const { elements } = board;
  submit(board, { title: 'JavaScript', subject: 'Web', minutes: 120 });
  submit(board, { title: '수학 문제 풀이', subject: 'Math', minutes: 30 });
  assert.equal(elements.taskList.children.length, 2);
  elements.searchInput.value = 'Python';
  elements.searchInput.dispatch('input');
  assert.equal(elements.taskList.children.length, 0);
  assert.equal(elements.emptyState.hidden, false);
  assert.equal(elements.totalCount.textContent, '2');
  assert.equal(elements.totalMinutes.textContent, '150');

  elements.searchInput.value = 'java';
  elements.searchInput.dispatch('input');
  assert.equal(elements.taskList.children.length, 1);
  assert.equal(elements.emptyState.hidden, true);
  elements.searchInput.value = 'wEb';
  elements.searchInput.dispatch('input');
  assert.equal(elements.taskList.children.length, 1);

  elements.searchInput.value = '';
  elements.searchInput.dispatch('input');
  elements.filterCompleted.click();
  assert.equal(elements.taskList.children.length, 0);
  assert.equal(elements.emptyState.hidden, false);
  elements.filterActive.click();
  assert.equal(elements.taskList.children.length, 2);
  actionButton(elements.taskList.children[0], 'toggle').click();
  assert.equal(elements.taskList.children.length, 1);
  assert.equal(elements.activeCount.textContent, '1');
  assert.equal(elements.completedCount.textContent, '1');
  assert.equal(elements.totalCount.textContent, '2');
  assert.equal(elements.totalMinutes.textContent, '150');
  elements.filterCompleted.click();
  assert.equal(elements.taskList.children.length, 1);
  elements.filterAll.click();
  assert.equal(elements.taskList.children.length, 2);
});

test('손상된 JSON과 형식이 잘못된 저장 값은 안내 후 빈 목록으로 시작한다', () => {
  const invalidValues = [
    '{broken json',
    JSON.stringify([{ id: 'bad', title: '   ', subject: '과학', minutes: 10, completed: false }]),
  ];
  for (const value of invalidValues) {
    const storage = new FakeStorage([[STORAGE_KEY, value]]);
    const board = makeBoard(storage);
    assert.equal(board.elements.taskList.children.length, 0);
    assert.equal(board.elements.emptyState.hidden, false);
    assert.equal(board.elements.totalCount.textContent, '0');
    assert.match(board.elements.statusMessage.textContent, /저장된 작업/);
  }
});

test('저장 실패 때 기존 저장 값은 보존하고 사용자에게 오류를 알린다', () => {
  const original = JSON.stringify([{ id: 'old', title: '기존 작업', subject: '과학', minutes: 20, completed: false }]);
  const storage = new FakeStorage([[STORAGE_KEY, original]]);
  const board = makeBoard(storage);
  storage.failWrites = true;
  submit(board, { title: '새 작업', subject: '수학', minutes: 10 });
  assert.equal(storage.getItem(STORAGE_KEY), original);
  assert.match(board.elements.statusMessage.textContent, /저장에 실패/);
});

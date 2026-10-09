import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

class FakeElement {
  constructor(document, tagName, id = '', className = '') {
    this.ownerDocument = document;
    this.tagName = tagName.toLowerCase();
    this.id = id;
    this._className = className;
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this.value = '';
    this.defaultValue = '';
    this._text = '';
    this.classList = {
      contains: (name) => this._className.split(/\s+/).includes(name),
      add: (...names) => {
        const classes = new Set(this._className.split(/\s+/).filter(Boolean));
        names.forEach((name) => classes.add(name));
        this._className = [...classes].join(' ');
      },
      remove: (...names) => {
        const removed = new Set(names);
        this._className = this._className.split(/\s+/).filter((name) => name && !removed.has(name)).join(' ');
      },
      toggle: (name, force) => {
        const shouldAdd = force === undefined ? !this.classList.contains(name) : Boolean(force);
        if (shouldAdd) this.classList.add(name);
        else this.classList.remove(name);
        return shouldAdd;
      }
    };
  }

  get className() { return this._className; }
  set className(value) { this._className = String(value); }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this._text = String(value);
    this.children.forEach((child) => { child.parentElement = null; });
    this.children = [];
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node.isDocumentFragment) {
        for (const child of [...node.children]) this.append(child);
        node.children = [];
        continue;
      }
      if (node.parentElement) {
        node.parentElement.children = node.parentElement.children.filter((child) => child !== node);
      }
      node.parentElement = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.children.forEach((child) => { child.parentElement = null; });
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }

  setAttribute(name, value) {
    const text = String(value);
    this.attributes.set(name, text);
    if (name === 'id') this.id = text;
    if (name === 'class') this.className = text;
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[key] = text;
    }
  }

  getAttribute(name) {
    if (name === 'id') return this.id || null;
    if (name === 'class') return this.className || null;
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return this.dataset[key] ?? this.attributes.get(name) ?? null;
    }
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name) { return this.getAttribute(name) !== null; }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    event.target ??= this;
    event.currentTarget = this;
    event.defaultPrevented ??= false;
    event.preventDefault ??= function preventDefault() { this.defaultPrevented = true; };
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    return !event.defaultPrevented;
  }

  focus() { this.ownerDocument.activeElement = this; }

  contains(node) {
    return node === this || this.children.some((child) => child.contains(node));
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (matchesSimple(node, selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (parent) => {
      for (const child of parent.children) {
        if (matchesSelector(child, selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
}

function matchesSimple(element, selector) {
  if (selector.startsWith('#')) return element.id === selector.slice(1);
  const match = selector.match(/^([a-z][\w-]*)?(?:\.([\w-]+))?(?:\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\])?$/i);
  if (!match) return false;
  const [, tag, className, attribute, expected] = match;
  if (tag && element.tagName !== tag.toLowerCase()) return false;
  if (className && !element.classList.contains(className)) return false;
  if (attribute) {
    const actual = element.getAttribute(attribute);
    if (actual === null || (expected !== undefined && actual !== expected)) return false;
  }
  return Boolean(tag || className || attribute);
}

function matchesSelector(element, selector) {
  const parts = selector.trim().split(/\s+/);
  if (!matchesSimple(element, parts.at(-1))) return false;
  let ancestor = element.parentElement;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    while (ancestor && !matchesSimple(ancestor, parts[index])) ancestor = ancestor.parentElement;
    if (!ancestor) return false;
    ancestor = ancestor.parentElement;
  }
  return true;
}

class FakeDocument extends FakeElement {
  constructor() {
    super(null, 'document');
    this.ownerDocument = this;
    this.activeElement = null;
  }
  createElement(tagName) { return new FakeElement(this, tagName); }
  createDocumentFragment() {
    const fragment = new FakeElement(this, 'fragment');
    fragment.isDocumentFragment = true;
    return fragment;
  }
}

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

function createDOM() {
  const document = new FakeDocument();
  const element = (parent, tag, id = '', className = '') => {
    const node = new FakeElement(document, tag, id, className);
    parent.append(node);
    return node;
  };
  const input = (parent, id, type = 'text') => {
    const node = element(parent, 'input', id);
    node.type = type;
    node.setAttribute('type', type);
    return node;
  };
  const button = (parent, id) => {
    const node = element(parent, 'button', id);
    node.type = 'button';
    node.setAttribute('type', 'button');
    return node;
  };

  const form = element(document, 'form', 'taskForm');
  form.reset = () => {
    for (const field of form.querySelectorAll('input')) field.value = field.defaultValue;
  };
  const title = input(form, 'taskTitle');
  const subject = input(form, 'taskSubject');
  const minutes = input(form, 'taskMinutes', 'number');
  const add = element(form, 'button', 'addTask');
  add.type = 'submit';
  add.setAttribute('type', 'submit');

  const status = element(document, 'p', 'statusMessage');
  const error = element(document, 'p', 'formError');
  const search = input(document, 'searchInput');
  const filterAll = button(document, 'filterAll');
  const filterActive = button(document, 'filterActive');
  const filterCompleted = button(document, 'filterCompleted');
  const taskList = element(document, 'div', 'taskList');
  const empty = element(document, 'div', 'emptyState');
  element(empty, 'h3');
  element(empty, 'p');
  const stats = {
    total: element(document, 'span', 'totalCount'),
    active: element(document, 'span', 'activeCount'),
    completed: element(document, 'span', 'completedCount'),
    totalMinutes: element(document, 'span', 'totalMinutes')
  };
  return {
    document,
    controls: { form, title, subject, minutes, add, status, error, search, filterAll, filterActive, filterCompleted, taskList, empty, stats }
  };
}

async function boot({ storage = new MemoryStorage(), raw } = {}) {
  if (raw !== undefined) storage.setItem('focus-board-v1', raw);
  const dom = createDOM();
  globalThis.document = dom.document;
  globalThis.localStorage = storage;
  await import(new URL(`./app.mjs?app-test=${Date.now()}-${Math.random()}`, import.meta.url));
  return { ...dom, storage };
}

function fill(element, value) {
  element.value = value;
  element.dispatchEvent({ type: 'input' });
}

function submit(form, source = 'button') {
  const event = { type: 'submit', source, defaultPrevented: false };
  form.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
}

function addTask(controls, title, subject, minutes, source = 'button') {
  controls.title.value = title;
  controls.subject.value = subject;
  controls.minutes.value = minutes;
  submit(controls.form, source);
}

test('index.html이 지정된 입력, 레이블, 필터, 통계 및 안내 DOM 계약을 제공한다', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const openingTag = (tag, id) => {
    const found = html.match(new RegExp(`<${tag}\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i'));
    assert.ok(found, `${tag}#${id}가 있어야 합니다.`);
    return found[0];
  };
  const formTag = openingTag('form', 'taskForm');
  assert.match(formTag, /\bnovalidate\b/);
  const formStart = html.indexOf(formTag);
  const formBody = html.slice(formStart + formTag.length, html.indexOf('</form>', formStart));
  const order = ['taskTitle', 'taskSubject', 'taskMinutes', 'addTask'].map((id) => formBody.indexOf(`id="${id}"`));
  assert.ok(order.every((position) => position >= 0));
  assert.deepEqual(order, [...order].sort((left, right) => left - right));
  assert.match(openingTag('input', 'taskTitle'), /\btype="text"/);
  assert.match(openingTag('input', 'taskSubject'), /\btype="text"/);
  assert.match(openingTag('input', 'taskMinutes'), /\btype="number"/);
  assert.match(openingTag('input', 'searchInput'), /\btype="text"/);
  assert.doesNotMatch(formBody, /\bmaxlength\s*=/i);
  assert.match(openingTag('button', 'addTask'), /\btype="submit"/);
  for (const id of ['taskTitle', 'taskSubject', 'taskMinutes', 'searchInput']) {
    assert.match(html, new RegExp(`<label\\b[^>]*\\bfor=["']${id}["']`), `label[for="${id}"] 연결이 필요합니다.`);
  }
  for (const id of ['formError', 'statusMessage']) {
    assert.match(openingTag('p', id), /\baria-live=["'](?:polite|assertive)["']/);
  }
  for (const id of ['taskList', 'emptyState', 'filterAll', 'filterActive', 'filterCompleted', 'totalCount', 'activeCount', 'completedCount', 'totalMinutes']) {
    assert.ok(html.includes(`id="${id}"`), `#${id}가 있어야 합니다.`);
  }
});

test('입력 오류를 표시하고 빈 제목에 초점을 둔 뒤 유효한 작업을 저장한다', async () => {
  const { controls, storage } = await boot();
  assert.equal(controls.empty.hidden, false);
  controls.subject.value = '수학';
  controls.minutes.value = '60';
  submit(controls.form);
  assert.equal(controls.error.hidden, false);
  assert.equal(controls.title.ownerDocument.activeElement, controls.title);
  assert.equal(controls.taskList.children.length, 0);

  controls.title.value = '   ';
  submit(controls.form);
  assert.equal(controls.error.hidden, false);
  assert.equal(controls.title.ownerDocument.activeElement, controls.title);
  controls.title.value = '정리 노트';
  controls.subject.value = '   ';
  submit(controls.form);
  assert.equal(controls.error.hidden, false);

  controls.title.value = '  정리 노트  ';
  controls.subject.value = '  수학  ';
  submit(controls.form, 'Enter');
  assert.equal(controls.error.hidden, true);
  assert.equal(controls.taskList.children.length, 1);
  assert.equal(controls.taskList.querySelector('.task-title').textContent, '정리 노트');
  assert.equal(controls.taskList.querySelector('.task-subject').textContent, '수학');
  assert.equal(controls.taskList.querySelector('.task-minutes').textContent, '60');
  assert.equal(storage.getItem('focus-board-v1') !== null, true);
  assert.equal(controls.title.value, '');

  controls.title.value = 'x'.repeat(101);
  controls.subject.value = '수학';
  controls.minutes.value = '60';
  submit(controls.form);
  assert.equal(controls.error.hidden, false);
  controls.title.value = '경계 입력';
  controls.subject.value = 'x'.repeat(31);
  submit(controls.form);
  assert.equal(controls.error.hidden, false);
  controls.title.value = 'x'.repeat(100);
  controls.subject.value = 'x'.repeat(30);
  controls.minutes.value = '480';
  submit(controls.form);
  assert.equal(controls.error.hidden, true);
  assert.equal(controls.taskList.children.length, 2);
  assert.equal(controls.stats.totalMinutes.textContent, '540');
});

test('Enter 제출과 저장 복원이 렌더링에 연결된다', async () => {
  const first = await boot();
  addTask(first.controls, '알고리즘 문제 풀이', '컴퓨터공학', '120', 'Enter');
  assert.equal(first.controls.stats.total.textContent, '1');
  const restored = await boot({ storage: first.storage });
  assert.equal(restored.controls.taskList.children.length, 1);
  assert.equal(restored.controls.taskList.querySelector('.task-title').textContent, '알고리즘 문제 풀이');
  assert.equal(restored.controls.stats.total.textContent, '1');
  assert.equal(restored.controls.stats.active.textContent, '1');
  assert.equal(restored.controls.stats.completed.textContent, '0');
  assert.equal(restored.controls.stats.totalMinutes.textContent, '120');
});

test('필터와 검색, 완료 취소, 삭제 후에도 통계는 전체 작업 기준으로 갱신된다', async () => {
  const { controls } = await boot();
  addTask(controls, 'React Study', 'Web', '45');
  addTask(controls, 'Physics Review', 'Science', '30');
  let [reactRow] = controls.taskList.children;
  controls.taskList.dispatchEvent({ type: 'click', target: reactRow.querySelector('button[data-action="toggle"]') });
  assert.equal(controls.stats.total.textContent, '2');
  assert.equal(controls.stats.active.textContent, '1');
  assert.equal(controls.stats.completed.textContent, '1');
  assert.equal(controls.stats.totalMinutes.textContent, '75');

  controls.filterCompleted.dispatchEvent({ type: 'click' });
  assert.equal(controls.taskList.children.length, 1);
  assert.equal(controls.taskList.querySelector('.task-title').textContent, 'React Study');
  controls.filterActive.dispatchEvent({ type: 'click' });
  assert.equal(controls.taskList.querySelector('.task-title').textContent, 'Physics Review');
  fill(controls.search, 'Vue');
  assert.equal(controls.taskList.children.length, 0);
  assert.equal(controls.empty.hidden, false);
  assert.deepEqual(
    [controls.stats.total.textContent, controls.stats.active.textContent, controls.stats.completed.textContent, controls.stats.totalMinutes.textContent],
    ['2', '1', '1', '75']
  );

  fill(controls.search, 'pHySiCs');
  assert.equal(controls.taskList.children.length, 1);
  const physicsRow = controls.taskList.children[0];
  controls.taskList.dispatchEvent({ type: 'click', target: physicsRow.querySelector('button[data-action="delete"]') });
  assert.deepEqual(
    [controls.stats.total.textContent, controls.stats.active.textContent, controls.stats.completed.textContent, controls.stats.totalMinutes.textContent],
    ['1', '0', '1', '45']
  );
  fill(controls.search, '');
  controls.filterAll.dispatchEvent({ type: 'click' });
  reactRow = controls.taskList.children[0];
  assert.equal(reactRow.classList.contains('task'), true);
  assert.equal(reactRow.querySelector('.task-title').textContent, 'React Study');
  assert.ok(reactRow.querySelector('.task-subject'));
  assert.ok(reactRow.querySelector('.task-minutes'));
  assert.ok(reactRow.querySelector('button[data-action="toggle"]'));
  assert.ok(reactRow.querySelector('button[data-action="delete"]'));
  controls.taskList.dispatchEvent({ type: 'click', target: reactRow.querySelector('button[data-action="toggle"]') });
  assert.deepEqual(
    [controls.stats.total.textContent, controls.stats.active.textContent, controls.stats.completed.textContent, controls.stats.totalMinutes.textContent],
    ['1', '1', '0', '45']
  );
  controls.filterCompleted.dispatchEvent({ type: 'click' });
  assert.equal(controls.taskList.children.length, 0);
  assert.equal(controls.empty.hidden, false);
  controls.filterActive.dispatchEvent({ type: 'click' });
  assert.equal(controls.taskList.children.length, 1);
});

test('제목과 과목은 HTML로 해석되지 않고 검색은 대소문자를 무시한다', async () => {
  const { controls } = await boot();
  addTask(controls, '<b>MiXeD Study</b>', '<i>WeB</i>', '15');
  assert.equal(controls.taskList.querySelector('.task-title').textContent, '<b>MiXeD Study</b>');
  assert.equal(controls.taskList.querySelector('.task-subject').textContent, '<i>WeB</i>');
  assert.equal(controls.taskList.querySelector('.task-title').children.length, 0);
  assert.equal(controls.taskList.querySelector('.task-subject').children.length, 0);
  fill(controls.search, 'mixed');
  assert.equal(controls.taskList.children.length, 1);
  fill(controls.search, 'WEB');
  assert.equal(controls.taskList.children.length, 1);
  fill(controls.search, 'NoSuchSubject');
  assert.equal(controls.taskList.children.length, 0);
  assert.equal(controls.empty.hidden, false);
  assert.equal(controls.stats.total.textContent, '1');
  fill(controls.search, '');
  assert.equal(controls.empty.hidden, true);
  assert.equal(controls.taskList.children.length, 1);
});

test('손상된 저장 데이터는 상태 안내 후 빈 목록으로 복구하고 입력을 다시 받는다', async () => {
  for (const raw of ['invalid-json-content', '[{"title":123}]']) {
    const { controls, storage } = await boot({ raw });
    assert.equal(controls.status.hidden, false);
    assert.notEqual(controls.status.textContent, '');
    assert.equal(controls.taskList.children.length, 0);
    assert.equal(controls.empty.hidden, false);
    addTask(controls, '복구 후 작업', '정보', '40');
    assert.equal(controls.error.hidden, true);
    assert.equal(controls.status.hidden, true);
    assert.equal(controls.taskList.children.length, 1);
    const reloaded = await boot({ storage });
    assert.equal(reloaded.controls.taskList.children.length, 1);
    assert.equal(reloaded.controls.taskList.querySelector('.task-title').textContent, '복구 후 작업');
    assert.equal(reloaded.controls.stats.totalMinutes.textContent, '40');
  }
});

test('저장 실패를 상태 안내로 표시하고 현재 모델 작업을 추가하지 않는다', async () => {
  const storage = new MemoryStorage();
  storage.setItem = () => { throw new Error('quota exceeded'); };
  const { controls } = await boot({ storage });
  addTask(controls, '저장 실패 작업', '과학', '20');
  assert.equal(controls.status.hidden, false);
  assert.notEqual(controls.status.textContent, '');
  assert.equal(controls.error.hidden, true);
  assert.equal(controls.taskList.children.length, 0);
  assert.equal(controls.stats.total.textContent, '0');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFocusBoardApp, STORAGE_KEY } from './app.mjs';

class FakeElement {
  constructor(tagName = 'div', ownerDocument = null) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.id = '';
    this.dataset = {};
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.hidden = false;
    this.value = '';
    this._text = '';
    this._className = '';
    this.classList = {
      add: (...names) => {
        const values = new Set(this._className.split(/\s+/).filter(Boolean));
        names.forEach((name) => values.add(name));
        this.className = [...values].join(' ');
      },
      remove: (...names) => {
        const values = new Set(this._className.split(/\s+/).filter(Boolean));
        names.forEach((name) => values.delete(name));
        this.className = [...values].join(' ');
      },
      contains: (name) => this._className.split(/\s+/).includes(name),
      toggle: (name, force) => {
        const shouldAdd = force === undefined ? !this.classList.contains(name) : Boolean(force);
        if (shouldAdd) this.classList.add(name);
        else this.classList.remove(name);
        return shouldAdd;
      },
    };
  }

  get className() { return this._className; }
  set className(value) { this._className = String(value); }
  get textContent() {
    return this.children.length ? this.children.map((child) => child.textContent).join('') : this._text;
  }
  set textContent(value) {
    this.children.forEach((child) => { child.parentNode = null; });
    this.children = [];
    this._text = String(value ?? '');
  }

  append(...nodes) {
    this._text = '';
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) {
    this.children.forEach((child) => { child.parentNode = null; });
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, listener) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(listener);
    this.listeners.set(type, handlers);
  }
  focus() { this.ownerDocument.activeElement = this; }
  contains(candidate) {
    return this === candidate || this.children.some((child) => child.contains(candidate));
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (matches(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

function matches(element, selector) {
  if (selector.startsWith('#')) return element.id === selector.slice(1);
  if (selector.startsWith('.')) return element.classList.contains(selector.slice(1));
  if (selector === 'button[data-action]') return element.tagName === 'BUTTON' && Boolean(element.dataset.action);
  const actionMatch = selector.match(/^button\[data-action="([^"]+)"\]$/);
  if (actionMatch) return element.tagName === 'BUTTON' && element.dataset.action === actionMatch[1];
  return element.tagName.toLowerCase() === selector.toLowerCase();
}

class FakeDocument {
  constructor() {
    this.nodes = new Map();
    this.activeElement = null;
    this.defaultView = {};
  }
  add(id, tagName = 'div') {
    const element = new FakeElement(tagName, this);
    element.id = id;
    this.nodes.set(id, element);
    return element;
  }
  getElementById(id) { return this.nodes.get(id) ?? null; }
  createElement(tagName) { return new FakeElement(tagName, this); }
}

class FakeStorage {
  constructor(initialValue = null) { this.values = new Map(initialValue === null ? [] : [[STORAGE_KEY, initialValue]]); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

function makePage() {
  const document = new FakeDocument();
  document.add('taskForm', 'form');
  document.add('taskTitle', 'input');
  document.add('taskSubject', 'input');
  document.add('taskMinutes', 'input');
  document.add('addTask', 'button');
  document.add('formError', 'p');
  document.add('statusMessage', 'p');
  document.add('taskList');
  const emptyState = document.add('emptyState');
  emptyState.append(document.createElement('h3'), document.createElement('p'));
  document.add('searchInput', 'input');
  document.add('filterAll', 'button');
  document.add('filterActive', 'button');
  document.add('filterCompleted', 'button');
  document.add('totalCount', 'strong');
  document.add('activeCount', 'strong');
  document.add('completedCount', 'strong');
  document.add('totalMinutes', 'span');
  document.getElementById('taskForm').reset = () => {
    for (const id of ['taskTitle', 'taskSubject', 'taskMinutes']) document.getElementById(id).value = '';
  };
  return document;
}

function dispatch(element, type, target = element) {
  const event = { type, target, currentTarget: element, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  for (const listener of element.listeners.get(type) ?? []) listener(event);
  return event;
}

function submit(document) { dispatch(document.getElementById('taskForm'), 'submit'); }
function actionButton(document, action) {
  return document.getElementById('taskList').querySelector(`button[data-action="${action}"]`);
}
function enterTask(document, { title, subject = '수학', minutes = '30' }) {
  document.getElementById('taskTitle').value = title;
  document.getElementById('taskSubject').value = subject;
  document.getElementById('taskMinutes').value = minutes;
  submit(document);
}

 test('폼 제출은 입력을 검증하고 오류 초점 및 정상 추가를 처리한다', () => {
  const document = makePage();
  const storage = new FakeStorage();
  createFocusBoardApp({ document, storage });

  enterTask(document, { title: '   ' });
  assert.equal(document.getElementById('formError').hidden, false);
  assert.equal(document.activeElement, document.getElementById('taskTitle'));
  assert.equal(document.getElementById('taskList').querySelectorAll('.task').length, 0);

  enterTask(document, { title: '정상 제목', minutes: '481' });
  assert.equal(document.getElementById('formError').hidden, false);
  assert.equal(document.getElementById('taskList').querySelectorAll('.task').length, 0);

  enterTask(document, { title: '  미적분 복습  ', subject: '  수학  ', minutes: '30' });
  assert.equal(document.getElementById('formError').hidden, true);
  assert.equal(document.getElementById('taskList').querySelector('.task-title').textContent, '미적분 복습');
  assert.equal(document.getElementById('taskList').querySelector('.task-subject').textContent, '수학');
  assert.equal(document.getElementById('totalCount').textContent, '1');
  assert.equal(document.getElementById('totalMinutes').textContent, '30');
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY))[0].title, '미적분 복습');
});

test('저장 복원, 안전한 문자열 렌더링, 검색·필터, 완료 취소와 삭제를 연결한다', () => {
  const storage = new FakeStorage();
  const firstPage = makePage();
  createFocusBoardApp({ document: firstPage, storage });
  enterTask(firstPage, { title: '<svg onload="x"></svg>', subject: '<b>Math</b>', minutes: '45' });
  enterTask(firstPage, { title: 'Active Reading', subject: 'English', minutes: '35' });

  const list = firstPage.getElementById('taskList');
  assert.equal(list.querySelector('.task-title').textContent, '<svg onload="x"></svg>');
  assert.equal(list.querySelector('.task-subject').textContent, '<b>Math</b>');
  assert.equal(list.querySelectorAll('svg').length, 0);

  dispatch(list, 'click', actionButton(firstPage, 'toggle'));
  assert.equal(firstPage.getElementById('completedCount').textContent, '1');
  assert.equal(firstPage.getElementById('activeCount').textContent, '1');
  assert.equal(firstPage.getElementById('totalMinutes').textContent, '80');
  dispatch(firstPage.getElementById('filterCompleted'), 'click');
  assert.equal(list.querySelectorAll('.task').length, 1);
  assert.equal(firstPage.getElementById('totalCount').textContent, '2');

  const search = firstPage.getElementById('searchInput');
  search.value = 'ENGLISH';
  dispatch(search, 'input');
  assert.equal(list.querySelectorAll('.task').length, 0);
  assert.equal(firstPage.getElementById('emptyState').hidden, false);
  dispatch(firstPage.getElementById('filterActive'), 'click');
  assert.equal(list.querySelector('.task-title').textContent, 'Active Reading');
  search.value = '';
  dispatch(search, 'input');
  assert.equal(list.querySelectorAll('.task').length, 1);

  const restoredPage = makePage();
  createFocusBoardApp({ document: restoredPage, storage });
  const restoredList = restoredPage.getElementById('taskList');
  assert.equal(restoredList.querySelectorAll('.task').length, 2);
  assert.equal(restoredList.querySelector('.task-title').textContent, '<svg onload="x"></svg>');
  assert.equal(restoredPage.getElementById('totalCount').textContent, '2');
  assert.equal(restoredPage.getElementById('completedCount').textContent, '1');

  dispatch(restoredList, 'click', actionButton(restoredPage, 'toggle'));
  assert.equal(restoredPage.getElementById('completedCount').textContent, '0');
  assert.equal(restoredPage.getElementById('activeCount').textContent, '2');
  dispatch(restoredList, 'click', actionButton(restoredPage, 'delete'));
  assert.equal(restoredList.querySelectorAll('.task').length, 1);
  assert.equal(restoredPage.getElementById('totalCount').textContent, '1');
  assert.equal(restoredPage.getElementById('totalMinutes').textContent, '35');
  const finalPage = makePage();
  createFocusBoardApp({ document: finalPage, storage });
  assert.equal(finalPage.getElementById('taskList').querySelector('.task-title').textContent, 'Active Reading');
});

test('손상되었거나 유효하지 않은 저장 데이터는 안내 후 빈 목록으로 시작한다', () => {
  for (const saved of ['{broken json', JSON.stringify([{ id: 'bad', title: '', subject: '수학', minutes: 20, completed: false }])]) {
    const document = makePage();
    createFocusBoardApp({ document, storage: new FakeStorage(saved) });
    assert.match(document.getElementById('statusMessage').textContent, /빈 목록/);
    assert.equal(document.getElementById('taskList').querySelectorAll('.task').length, 0);
    assert.equal(document.getElementById('totalCount').textContent, '0');
    assert.equal(document.getElementById('emptyState').hidden, false);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { initializeApp, STORAGE_KEY } from "./app.mjs";

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toLowerCase();
    this.ownerDocument = ownerDocument;
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.value = "";
    this.defaultValue = "";
    this.hidden = false;
    this._textContent = "";
    this._className = "";
    this.dataset = new Proxy({}, {
      set: (_target, key, value) => {
        const attribute = `data-${String(key).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
        this.setAttribute(attribute, value);
        return true;
      },
      get: (_target, key) => this.getAttribute(`data-${String(key).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`),
    });
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        const shouldAdd = force === undefined ? !names.has(name) : Boolean(force);
        if (shouldAdd) names.add(name);
        else names.delete(name);
        this.className = [...names].join(" ");
        return shouldAdd;
      },
      add: (name) => this.classList.toggle(name, true),
      remove: (name) => this.classList.toggle(name, false),
    };
  }

  get className() { return this._className; }
  set className(value) { this._className = String(value); }

  get textContent() {
    return this.children.length
      ? this.children.map((child) => child.textContent).join("")
      : this._textContent;
  }
  set textContent(value) {
    this.children = [];
    this._textContent = String(value ?? "");
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof FakeElement) {
        node.parentElement = this;
        this.children.push(node);
      } else {
        const text = new FakeElement("#text", this.ownerDocument);
        text.textContent = node;
        text.parentElement = this;
        this.children.push(text);
      }
    }
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this._textContent = "";
    this.append(...nodes);
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    event.target ??= this;
    event.currentTarget = this;
    event.preventDefault ??= () => { event.defaultPrevented = true; };
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return !event.defaultPrevented;
  }

  click() { this.dispatchEvent({ type: "click" }); }
  focus() { this.ownerDocument.activeElement = this; }

  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }

  matchesSimple(selector) {
    const attributePattern = /\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]/g;
    const expectedAttributes = [...selector.matchAll(attributePattern)];
    const base = selector.replace(attributePattern, "");
    const tagMatch = base.match(/^[a-zA-Z][\w-]*/);
    if (tagMatch && this.tagName !== tagMatch[0].toLowerCase()) return false;
    const idMatch = base.match(/#([\w-]+)/);
    if (idMatch && this.getAttribute("id") !== idMatch[1]) return false;
    for (const [, className] of base.matchAll(/\.([\w-]+)/g)) {
      if (!this.classList.contains(className)) return false;
    }
    for (const [, name, doubleQuoted, singleQuoted] of expectedAttributes) {
      if (!this.hasAttribute(name)) return false;
      const expected = doubleQuoted ?? singleQuoted;
      if (expected !== undefined && this.getAttribute(name) !== expected) return false;
    }
    return Boolean(tagMatch || idMatch || base.includes(".") || expectedAttributes.length);
  }

  matchesSelector(selector) {
    const parts = selector.trim().split(/\s+/);
    let node = this;
    if (!node.matchesSimple(parts.at(-1))) return false;
    for (let index = parts.length - 2; index >= 0; index -= 1) {
      node = node.parentElement;
      while (node && !node.matchesSimple(parts[index])) node = node.parentElement;
      if (!node) return false;
    }
    return true;
  }

  querySelectorAll(selector) {
    const selectors = selector.split(",").map((part) => part.trim());
    return this.descendants().filter((element) => selectors.some((part) => element.matchesSelector(part)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

  reset() {
    for (const input of this.querySelectorAll("input")) input.value = input.defaultValue;
  }
}

class FakeDocument extends FakeElement {
  constructor() {
    super("#document", null);
    this.ownerDocument = this;
    this.activeElement = null;
  }
  createElement(tagName) { return new FakeElement(tagName, this); }
}

class FakeStorage {
  constructor(entries = []) { this.values = new Map(entries); this.writeCount = 0; }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.writeCount += 1; this.values.set(key, String(value)); }
}

function createDocument() {
  const document = new FakeDocument();
  const body = document.createElement("body");
  document.append(body);
  const make = (tag, id, attributes = {}) => {
    const element = document.createElement(tag);
    if (id) element.setAttribute("id", id);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    return element;
  };

  const form = make("form", "taskForm", { novalidate: "" });
  const title = make("input", "taskTitle", { type: "text" });
  const subject = make("input", "taskSubject", { type: "text" });
  const minutes = make("input", "taskMinutes", { type: "number" });
  const add = make("button", "addTask", { type: "submit" });
  const formError = make("p", "formError", { "aria-live": "polite" });
  formError.hidden = true;
  const status = make("p", "statusMessage", { "aria-live": "polite" });
  form.append(title, subject, minutes, add, formError, status);
  body.append(form);

  const taskList = make("div", "taskList");
  const emptyState = make("div", "emptyState");
  body.append(taskList, emptyState);
  const search = make("input", "searchInput", { type: "search" });
  body.append(search);

  for (const [id, initial] of [["filterAll", true], ["filterActive", false], ["filterCompleted", false]]) {
    const filter = make("button", id);
    filter.className = initial ? "is-active" : "";
    body.append(filter);
  }
  for (const id of ["totalCount", "activeCount", "completedCount", "totalMinutes"]) {
    body.append(make("span", id));
  }
  return document;
}

function submit(document) {
  let prevented = false;
  document.querySelector("#taskForm").dispatchEvent({
    type: "submit",
    preventDefault() { prevented = true; },
  });
  return prevented;
}

function fill(document, selector, value) {
  const element = document.querySelector(selector);
  element.value = value;
  element.dispatchEvent({ type: "input" });
  return element;
}

function addThroughForm(document, { title, subject, minutes }) {
  fill(document, "#taskTitle", title);
  fill(document, "#taskSubject", subject);
  fill(document, "#taskMinutes", String(minutes));
  assert.equal(submit(document), true);
}

test("입력란에서 Enter를 누르면 폼 제출과 동일한 검증·저장 흐름을 탄다", () => {
  const document = createDocument();
  const storage = new FakeStorage();
  initializeApp({ document, storage });
  fill(document, "#taskTitle", "키보드 작업");
  fill(document, "#taskSubject", "테스트");
  const minutes = fill(document, "#taskMinutes", "30");

  minutes.dispatchEvent({ type: "keydown", key: "Enter" });

  assert.equal(document.querySelectorAll(".task").length, 1);
  assert.equal(document.querySelector(".task-title").textContent, "키보드 작업");
  assert.equal(document.querySelector("#totalMinutes").textContent, "30");
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY))[0].title, "키보드 작업");
  assert.equal(document.activeElement, document.querySelector("#taskTitle"));
});

test("초기 화면은 빈 목록과 전체 요약을 실제 DOM에 표시한다", () => {
  const document = createDocument();
  initializeApp({ document, storage: new FakeStorage() });
  assert.equal(document.querySelector("#emptyState").hidden, false);
  assert.equal(document.querySelector("#totalCount").textContent, "0");
  assert.equal(document.querySelector("#activeCount").textContent, "0");
  assert.equal(document.querySelector("#completedCount").textContent, "0");
  assert.equal(document.querySelector("#totalMinutes").textContent, "0");
  assert.equal(document.querySelector("#formError").hidden, true);
});

test("폼 제출은 입력을 정리해 작업을 렌더링하고 localStorage에 저장한다", () => {
  const document = createDocument();
  const storage = new FakeStorage();
  initializeApp({ document, storage });
  addThroughForm(document, { title: "  공백 포함 제목  ", subject: " 과목 ", minutes: 45 });

  assert.equal(document.querySelector(".task-title").textContent, "공백 포함 제목");
  assert.equal(document.querySelector(".task-subject").textContent, "과목");
  assert.equal(document.querySelector("#taskList .task-minutes").textContent, "45분");
  assert.equal(document.querySelector("#totalCount").textContent, "1");
  assert.equal(document.querySelector("#totalMinutes").textContent, "45");
  assert.equal(document.querySelector("#emptyState").hidden, true);
  assert.equal(document.querySelector("#formError").hidden, true);
  assert.equal(document.activeElement, document.querySelector("#taskTitle"));
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY))[0].title, "공백 포함 제목");
});

test("입력 오류는 표시되고 빈 제목은 제목 입력란에 초점을 돌린다", () => {
  const document = createDocument();
  initializeApp({ document, storage: new FakeStorage() });
  fill(document, "#taskTitle", "   ");
  fill(document, "#taskSubject", "과학");
  fill(document, "#taskMinutes", "30");
  submit(document);
  assert.equal(document.querySelector("#formError").hidden, false);
  assert.equal(document.activeElement, document.querySelector("#taskTitle"));
  assert.equal(document.querySelectorAll(".task").length, 0);

  fill(document, "#taskTitle", "제목");
  fill(document, "#taskSubject", "과학");
  fill(document, "#taskMinutes", "1.5");
  submit(document);
  assert.equal(document.querySelector("#formError").hidden, false);
  assert.equal(document.querySelectorAll(".task").length, 0);
});

test("완료·완료 취소·삭제는 저장되며 새 앱 초기화에서 복원된다", () => {
  const storage = new FakeStorage();
  let document = createDocument();
  initializeApp({ document, storage });
  addThroughForm(document, { title: "저장할 작업", subject: "복습", minutes: 25 });
  document.querySelector('button[data-action="toggle"]').click();
  assert.equal(document.querySelector("#completedCount").textContent, "1");

  document = createDocument();
  initializeApp({ document, storage });
  assert.equal(document.querySelector(".task-title").textContent, "저장할 작업");
  assert.equal(document.querySelector("#completedCount").textContent, "1");
  document.querySelector('button[data-action="toggle"]').click();
  assert.equal(document.querySelector("#activeCount").textContent, "1");
  document.querySelector('button[data-action="delete"]').click();
  assert.equal(document.querySelectorAll(".task").length, 0);
  assert.equal(document.querySelector("#totalCount").textContent, "0");
  assert.equal(document.querySelector("#emptyState").hidden, false);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)), []);
});

test("검색과 상태 필터는 목록만 바꾸고 요약은 전체 작업 기준으로 유지한다", () => {
  const document = createDocument();
  initializeApp({ document, storage: new FakeStorage() });
  addThroughForm(document, { title: "MiXeD Title", subject: "Math", minutes: 20 });
  document.querySelector('button[data-action="toggle"]').click();
  addThroughForm(document, { title: "영어 독해", subject: "Reading", minutes: 30 });

  fill(document, "#searchInput", "mixed title");
  assert.equal(document.querySelectorAll(".task").length, 1);
  assert.equal(document.querySelector(".task-title").textContent, "MiXeD Title");
  assert.equal(document.querySelector("#totalCount").textContent, "2");
  document.querySelector("#filterActive").click();
  assert.equal(document.querySelectorAll(".task").length, 0);
  assert.equal(document.querySelector("#emptyState").hidden, false);
  assert.equal(document.querySelector("#totalMinutes").textContent, "50");

  fill(document, "#searchInput", "reading");
  assert.equal(document.querySelectorAll(".task").length, 1);
  document.querySelector("#filterCompleted").click();
  assert.equal(document.querySelectorAll(".task").length, 0);
  document.querySelector("#filterAll").click();
  assert.equal(document.querySelectorAll(".task").length, 1);
  assert.equal(document.querySelector("#activeCount").textContent, "1");
  assert.equal(document.querySelector("#completedCount").textContent, "1");
});

test("제목과 과목의 HTML 문자는 실행하지 않고 문자 그대로 렌더링한다", () => {
  const document = createDocument();
  initializeApp({ document, storage: new FakeStorage() });
  addThroughForm(document, { title: "<b>HTML 제목</b>", subject: "<i>국어</i>", minutes: 20 });
  assert.equal(document.querySelector(".task-title").textContent, "<b>HTML 제목</b>");
  assert.equal(document.querySelector(".task-subject").textContent, "<i>국어</i>");
  assert.equal(document.querySelector(".task-title b"), null);
  assert.equal(document.querySelector(".task-subject i"), null);
});

test("잘못된 저장 데이터는 안내 후 빈 목록으로 시작하고 자동으로 덮어쓰지 않는다", () => {
  for (const raw of ["{broken", JSON.stringify([{ id: "same", title: "작업", subject: "수학", minutes: 30, completed: "false" }])]) {
    const storage = new FakeStorage([[STORAGE_KEY, raw]]);
    const document = createDocument();
    initializeApp({ document, storage });
    assert.notEqual(document.querySelector("#statusMessage").textContent, "");
    assert.equal(document.querySelectorAll(".task").length, 0);
    assert.equal(document.querySelector("#totalCount").textContent, "0");
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    assert.equal(storage.writeCount, 0);
  }
});

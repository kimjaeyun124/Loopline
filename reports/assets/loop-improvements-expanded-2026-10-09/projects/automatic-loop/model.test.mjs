import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  addTask,
  deleteTask,
  filterTasks,
  getSummary,
  parseSavedTasks,
  SavedTasksError,
  TaskValidationError,
  toggleTask,
  validateTaskInput,
} from "./model.mjs";

const input = (overrides = {}) => ({ title: "수학 문제 풀이", subject: "수학", minutes: 30, ...overrides });
const validationError = (fn, field) => assert.throws(fn, (error) =>
  error instanceof TaskValidationError && error.field === field);
const savedError = (fn) => assert.throws(fn, (error) => error instanceof SavedTasksError);

 test("제목·과목을 다듬고 허용 최대 길이를 포함한다", () => {
  assert.deepEqual(validateTaskInput(input({ title: `  ${"가".repeat(100)}  `, subject: ` ${"A".repeat(30)} ` })), {
    title: "가".repeat(100), subject: "A".repeat(30), minutes: 30,
  });
  validationError(() => validateTaskInput(input({ title: "   " })), "title");
  validationError(() => validateTaskInput(input({ subject: "  " })), "subject");
  validationError(() => validateTaskInput(input({ title: "가".repeat(101) })), "title");
  validationError(() => validateTaskInput(input({ subject: "과목".repeat(16) })), "subject");
});

test("학습 시간 1과 480을 허용하고 범위 밖·소수·빈 값은 거부한다", () => {
  assert.equal(validateTaskInput(input({ minutes: "1" })).minutes, 1);
  assert.equal(validateTaskInput(input({ minutes: 480 })).minutes, 480);
  for (const minutes of ["", "   ", 0, 481, 1.5, "1.5", "30분", Number.NaN, Number.POSITIVE_INFINITY]) {
    validationError(() => validateTaskInput(input({ minutes })), "minutes");
  }
});

test("작업 추가는 입력을 정규화하고 기존 배열을 변경하지 않는다", () => {
  const original = [];
  const result = addTask(original, input({ title: "  단어 암기 ", subject: " 영어 " }), { id: "task-1" });
  assert.deepEqual(result, [{ id: "task-1", title: "단어 암기", subject: "영어", minutes: 30, completed: false }]);
  assert.deepEqual(original, []);
  validationError(() => addTask(result, input({ title: " " }), { id: "task-2" }), "title");
  assert.equal(result.length, 1);
});

test("완료 상태를 전환하고 다시 취소하며 원본을 보존한다", () => {
  const tasks = addTask([], input(), { id: "task-1" });
  const completed = toggleTask(tasks, "task-1");
  const active = toggleTask(completed, "task-1");
  assert.equal(tasks[0].completed, false);
  assert.equal(completed[0].completed, true);
  assert.equal(active[0].completed, false);
  assert.throws(() => toggleTask(tasks, "missing"), RangeError);
});

test("삭제는 지정한 작업만 제거한다", () => {
  const tasks = addTask(addTask([], input(), { id: "one" }), input({ title: "영어 단어" }), { id: "two" });
  assert.deepEqual(deleteTask(tasks, "one").map((task) => task.id), ["two"]);
  assert.equal(tasks.length, 2);
  assert.deepEqual(deleteTask(tasks, "missing"), tasks);
});

test("검색은 제목·과목 대소문자를 무시하고 상태 필터와 요약은 독립적이다", () => {
  const tasks = addTask(addTask([], input({ title: "JavaScript 복습", subject: "Web", minutes: 120 }), { id: "js" }),
    input({ title: "수학 문제 풀이", subject: "Math", minutes: 30 }), { id: "math" });
  const mixed = toggleTask(tasks, "js");
  assert.deepEqual(filterTasks(mixed, { query: "javascript" }).map((task) => task.id), ["js"]);
  assert.deepEqual(filterTasks(mixed, { query: "wEb" }).map((task) => task.id), ["js"]);
  assert.deepEqual(filterTasks(mixed, { status: "active" }).map((task) => task.id), ["math"]);
  assert.deepEqual(filterTasks(mixed, { status: "completed" }).map((task) => task.id), ["js"]);
  assert.deepEqual(filterTasks(mixed, { query: "없음" }), []);
  assert.deepEqual(getSummary(mixed), { totalCount: 2, activeCount: 1, completedCount: 1, totalMinutes: 150 });
});

test("저장 데이터는 파싱 후 복사하고 잘못된 JSON·구조·필드·값을 거부한다", () => {
  const task = { id: "saved-1", title: "복습", subject: "과학", minutes: 45, completed: false };
  assert.deepEqual(parseSavedTasks(JSON.stringify([task])), [task]);
  assert.notEqual(parseSavedTasks(JSON.stringify([task]))[0], task);

  const invalidPayloads = [
    "{broken",
    JSON.stringify({ tasks: [task] }),
    JSON.stringify([{ ...task, extra: true }]),
    JSON.stringify([{ ...task, id: " " }]),
    JSON.stringify([{ ...task, title: " " }]),
    JSON.stringify([{ ...task, title: "가".repeat(101) }]),
    JSON.stringify([{ ...task, subject: "과목".repeat(16) }]),
    JSON.stringify([{ ...task, minutes: 481 }]),
    JSON.stringify([{ ...task, completed: "false" }]),
    JSON.stringify([task, task]),
  ];
  for (const payload of invalidPayloads) savedError(() => parseSavedTasks(payload));
});

test("저장 데이터 파싱 실패는 현재 작업 배열을 변경하지 않는다", () => {
  const current = addTask([], input(), { id: "keep-me" });
  const snapshot = structuredClone(current);
  savedError(() => parseSavedTasks("not-json"));
  savedError(() => parseSavedTasks(JSON.stringify([{ ...current[0], minutes: 0 }])));
  assert.deepEqual(current, snapshot);
});

test("package.json은 지정한 ESM 테스트·실행 명령을 제공한다", () => {
  const config = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  assert.equal(config.type, "module");
  assert.equal(config.scripts.test, "node --test");
  assert.equal(config.scripts.start, "node server.mjs");
});

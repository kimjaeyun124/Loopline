import test from "node:test";
import assert from "node:assert/strict";
import {
  addTask,
  deleteTask,
  filterTasks,
  parseStoredTasks,
  serializeTasks,
  setTaskCompleted,
  summarizeTasks,
  toggleTask,
  validateStoredTasks,
  validateTaskInput,
} from "./model.mjs";

test("입력 경계값을 정리하고 허용한다", () => {
  const result = validateTaskInput({
    title: `  ${"가".repeat(100)}  `,
    subject: `  ${"수".repeat(30)}  `,
    minutes: "480",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.title.length, 100);
  assert.equal(result.value.subject.length, 30);
  assert.equal(result.value.minutes, 480);
  assert.equal(validateTaskInput({ title: "최소 시간", subject: "수학", minutes: 1 }).ok, true);
});

test("필수값, 길이 초과, 정수가 아닌 시간과 범위 밖 시간을 거부한다", () => {
  assert.equal(validateTaskInput({ title: "   ", subject: "과학", minutes: 30 }).field, "title");
  assert.equal(validateTaskInput({ title: "제목", subject: "  ", minutes: 30 }).field, "subject");
  assert.equal(validateTaskInput({ title: "가".repeat(101), subject: "국어", minutes: 30 }).ok, false);
  assert.equal(validateTaskInput({ title: "제목", subject: "수".repeat(31), minutes: 30 }).ok, false);
  for (const minutes of ["", 0, 481, 1.5, "1.5", "abc"]) {
    assert.equal(validateTaskInput({ title: "제목", subject: "수학", minutes }).ok, false);
  }
});

test("작업 추가는 공백을 정리하고 기존 목록을 변경하지 않는다", () => {
  const original = [];
  const result = addTask(original, { title: "  복습  ", subject: "  영어 ", minutes: "25" }, { id: "task-1" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.task, {
    id: "task-1", title: "복습", subject: "영어", minutes: 25, completed: false,
  });
  assert.deepEqual(original, []);
  assert.deepEqual(result.tasks, [result.task]);

  const rejected = addTask(result.tasks, { title: "", subject: "영어", minutes: 25 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.field, "title");
  assert.strictEqual(rejected.tasks, result.tasks);
});

test("완료 처리와 완료 취소가 작업 상태를 전환한다", () => {
  const { tasks } = addTask([], { title: "단어 복습", subject: "영어", minutes: 20 }, { id: "task-1" });
  const completed = toggleTask(tasks, "task-1");
  assert.equal(completed[0].completed, true);
  const reopened = toggleTask(completed, "task-1");
  assert.equal(reopened[0].completed, false);
  assert.equal(setTaskCompleted(reopened, "task-1", true)[0].completed, true);
  assert.strictEqual(toggleTask(tasks, "missing"), tasks);
});

test("삭제는 지정한 작업만 제거한다", () => {
  const first = addTask([], { title: "첫 작업", subject: "수학", minutes: 10 }, { id: "one" }).tasks;
  const tasks = addTask(first, { title: "둘째 작업", subject: "과학", minutes: 15 }, { id: "two" }).tasks;
  assert.deepEqual(deleteTask(tasks, "one").map((task) => task.id), ["two"]);
  assert.equal(tasks.length, 2);
  assert.strictEqual(deleteTask(tasks, "missing"), tasks);
});

test("검색은 제목과 과목을 대소문자 구분 없이 찾고 상태 필터와 결합한다", () => {
  let tasks = addTask([], { title: "MiXeD Title", subject: "Math", minutes: 20 }, { id: "one" }).tasks;
  tasks = addTask(tasks, { title: "영어 독해", subject: "Reading", minutes: 30 }, { id: "two" }).tasks;
  tasks = toggleTask(tasks, "one");

  assert.deepEqual(filterTasks(tasks, { query: "mixed title" }).map((task) => task.id), ["one"]);
  assert.deepEqual(filterTasks(tasks, { query: "MATH" }).map((task) => task.id), ["one"]);
  assert.deepEqual(filterTasks(tasks, { status: "active" }).map((task) => task.id), ["two"]);
  assert.deepEqual(filterTasks(tasks, { status: "completed" }).map((task) => task.id), ["one"]);
  assert.deepEqual(filterTasks(tasks, { status: "active", query: "mixed" }), []);
});

test("요약은 필터 결과가 아니라 전체 작업을 기준으로 계산한다", () => {
  let tasks = addTask([], { title: "완료 작업", subject: "기록", minutes: 20 }, { id: "one" }).tasks;
  tasks = toggleTask(tasks, "one");
  tasks = addTask(tasks, { title: "진행 작업", subject: "기록", minutes: 30 }, { id: "two" }).tasks;

  assert.equal(filterTasks(tasks, { status: "active" }).length, 1);
  assert.deepEqual(summarizeTasks(tasks), {
    totalCount: 2, activeCount: 1, completedCount: 1, totalMinutes: 50,
  });
});

test("저장 데이터 직렬화 후 작업 목록을 정상 복원한다", () => {
  let tasks = addTask([], { title: "  저장할 작업 ", subject: " 복습 ", minutes: 120 }, { id: "saved-1" }).tasks;
  tasks = toggleTask(tasks, "saved-1");
  const restored = parseStoredTasks(serializeTasks(tasks));
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.tasks, tasks);
  assert.deepEqual(parseStoredTasks(null), { ok: true, tasks: [], error: null });
});

test("잘못된 JSON과 구조 또는 값이 잘못된 저장 데이터를 거부한다", () => {
  const malformedJson = parseStoredTasks("{broken");
  assert.equal(malformedJson.ok, false);
  assert.deepEqual(malformedJson.tasks, []);

  for (const value of [
    { tasks: [] },
    [{}],
    [{ id: "one", title: "작업", subject: "수학", minutes: "30", completed: false }],
    [{ id: "one", title: "작업", subject: "수학", minutes: 30, completed: "false" }],
    [
      { id: "same", title: "첫 작업", subject: "수학", minutes: 10, completed: false },
      { id: "same", title: "둘째 작업", subject: "수학", minutes: 15, completed: true },
    ],
  ]) {
    const result = validateStoredTasks(value);
    assert.equal(result.ok, false);
    assert.deepEqual(result.tasks, []);
    assert.ok(result.error);
  }
  assert.throws(() => serializeTasks([{}]), TypeError);
});

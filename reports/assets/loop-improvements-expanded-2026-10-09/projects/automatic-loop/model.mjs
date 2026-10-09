export const TASK_LIMITS = Object.freeze({ title: 100, subject: 30, minMinutes: 1, maxMinutes: 480 });

export class TaskValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "TaskValidationError";
    this.field = field;
  }
}

export class SavedTasksError extends Error {
  constructor(message) {
    super(message);
    this.name = "SavedTasksError";
  }
}

function fail(message, field) {
  throw new TaskValidationError(message, field);
}

export function validateTaskInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("작업 정보를 확인해 주세요.", "title");
  }

  const title = typeof input.title === "string" ? input.title.trim() : "";
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  if (!title) fail("작업 제목을 입력해 주세요.", "title");
  if (title.length > TASK_LIMITS.title) fail("작업 제목은 100자까지 입력할 수 있습니다.", "title");
  if (!subject) fail("과목을 입력해 주세요.", "subject");
  if (subject.length > TASK_LIMITS.subject) fail("과목은 30자까지 입력할 수 있습니다.", "subject");

  const rawMinutes = typeof input.minutes === "string" ? input.minutes.trim() : input.minutes;
  const minutes = rawMinutes === "" ? Number.NaN : Number(rawMinutes);
  if (!Number.isInteger(minutes) || minutes < TASK_LIMITS.minMinutes || minutes > TASK_LIMITS.maxMinutes) {
    fail("학습 시간은 1~480 사이의 정수로 입력해 주세요.", "minutes");
  }
  return { title, subject, minutes };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateSavedTasks(value) {
  if (!Array.isArray(value)) throw new SavedTasksError("저장된 작업 데이터는 배열이어야 합니다.");
  const ids = new Set();
  const expectedKeys = "completed,id,minutes,subject,title";

  return value.map((task, index) => {
    if (!isRecord(task) || Object.keys(task).sort().join(",") !== expectedKeys) {
      throw new SavedTasksError(`${index + 1}번째 작업의 구조가 올바르지 않습니다.`);
    }
    if (typeof task.id !== "string" || !task.id || task.id !== task.id.trim() || ids.has(task.id)) {
      throw new SavedTasksError(`${index + 1}번째 작업의 ID가 올바르지 않습니다.`);
    }
    if (typeof task.completed !== "boolean") {
      throw new SavedTasksError(`${index + 1}번째 작업의 완료 상태가 올바르지 않습니다.`);
    }

    let fields;
    try {
      fields = validateTaskInput(task);
    } catch (error) {
      throw new SavedTasksError(`${index + 1}번째 작업이 올바르지 않습니다: ${error.message}`);
    }
    if (fields.title !== task.title || fields.subject !== task.subject || fields.minutes !== task.minutes) {
      throw new SavedTasksError(`${index + 1}번째 작업의 값이 정규화되지 않았습니다.`);
    }
    ids.add(task.id);
    return { id: task.id, ...fields, completed: task.completed };
  });
}

export function parseSavedTasks(serialized) {
  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new SavedTasksError("저장된 작업 데이터의 JSON 문법이 올바르지 않습니다.");
  }
  return validateSavedTasks(value);
}

function createId(existingIds) {
  let id;
  do {
    id = globalThis.crypto?.randomUUID?.()
      ?? `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  } while (existingIds.has(id));
  return id;
}

export function addTask(tasks, input, options = {}) {
  const current = validateSavedTasks(tasks);
  const fields = validateTaskInput(input);
  const id = options.id ?? createId(new Set(current.map((task) => task.id)));
  if (typeof id !== "string" || !id || id !== id.trim() || current.some((task) => task.id === id)) {
    throw new SavedTasksError("새 작업의 ID가 올바르지 않습니다.");
  }
  return [...current, { id, ...fields, completed: false }];
}

export function toggleTask(tasks, taskId) {
  const current = validateSavedTasks(tasks);
  if (!current.some((task) => task.id === taskId)) throw new RangeError("작업을 찾을 수 없습니다.");
  return current.map((task) => task.id === taskId ? { ...task, completed: !task.completed } : task);
}

export function deleteTask(tasks, taskId) {
  return validateSavedTasks(tasks).filter((task) => task.id !== taskId);
}

export function getSummary(tasks) {
  return validateSavedTasks(tasks).reduce((summary, task) => {
    summary.totalCount += 1;
    summary[task.completed ? "completedCount" : "activeCount"] += 1;
    summary.totalMinutes += task.minutes;
    return summary;
  }, { totalCount: 0, activeCount: 0, completedCount: 0, totalMinutes: 0 });
}

export function filterTasks(tasks, { status = "all", query = "" } = {}) {
  if (!["all", "active", "completed"].includes(status)) {
    throw new TypeError("작업 필터가 올바르지 않습니다.");
  }
  const normalizedQuery = String(query).trim().toLowerCase();
  return validateSavedTasks(tasks).filter((task) => {
    const statusMatches = status === "all" || (status === "completed" ? task.completed : !task.completed);
    const queryMatches = !normalizedQuery
      || task.title.toLowerCase().includes(normalizedQuery)
      || task.subject.toLowerCase().includes(normalizedQuery);
    return statusMatches && queryMatches;
  });
}

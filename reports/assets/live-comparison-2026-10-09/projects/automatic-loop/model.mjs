const MIN_MINUTES = 1;
const MAX_MINUTES = 480;
const MAX_TITLE_LENGTH = 100;
const MAX_SUBJECT_LENGTH = 30;

function invalidInput(field, message) {
  return { ok: false, field, message };
}

function requireTaskArray(tasks) {
  if (!Array.isArray(tasks)) {
    throw new TypeError("작업 목록은 배열이어야 합니다.");
  }
}

function createTaskId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** 입력값을 정리하고 제목·과목·학습 시간 규칙을 검증합니다. */
export function validateTaskInput(input) {
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  const subject = typeof input?.subject === "string" ? input.subject.trim() : "";
  const rawMinutes = input?.minutes;
  const minutes = typeof rawMinutes === "number"
    ? rawMinutes
    : typeof rawMinutes === "string" && rawMinutes.trim() !== ""
      ? Number(rawMinutes)
      : Number.NaN;

  if (!title) return invalidInput("title", "작업 제목을 입력해 주세요.");
  if (title.length > MAX_TITLE_LENGTH) {
    return invalidInput("title", `작업 제목은 ${MAX_TITLE_LENGTH}자까지 입력할 수 있습니다.`);
  }
  if (!subject) return invalidInput("subject", "과목을 입력해 주세요.");
  if (subject.length > MAX_SUBJECT_LENGTH) {
    return invalidInput("subject", `과목은 ${MAX_SUBJECT_LENGTH}자까지 입력할 수 있습니다.`);
  }
  if (!Number.isInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
    return invalidInput("minutes", `학습 시간은 ${MIN_MINUTES}~${MAX_MINUTES} 사이의 정수로 입력해 주세요.`);
  }

  return { ok: true, value: { title, subject, minutes } };
}

/** 유효한 작업을 목록 끝에 추가하고 새 목록을 반환합니다. */
export function addTask(tasks, input, options = {}) {
  requireTaskArray(tasks);
  const validation = validateTaskInput(input);
  if (!validation.ok) {
    return { ok: false, tasks, task: null, error: validation };
  }

  let id = options?.id ?? createTaskId();
  if (typeof id !== "string" || id.trim() === "") {
    throw new TypeError("작업 ID는 비어 있지 않은 문자열이어야 합니다.");
  }
  while (tasks.some((task) => task?.id === id)) {
    id = createTaskId();
  }

  const task = { id, ...validation.value, completed: false };
  return { ok: true, tasks: [...tasks, task], task, error: null };
}

/** 작업의 완료 여부를 지정합니다. */
export function setTaskCompleted(tasks, taskId, completed) {
  requireTaskArray(tasks);
  if (typeof completed !== "boolean") {
    throw new TypeError("완료 상태는 boolean이어야 합니다.");
  }
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index === -1 || tasks[index].completed === completed) return tasks;
  return tasks.map((task, taskIndex) => taskIndex === index ? { ...task, completed } : task);
}

/** 작업의 완료 상태를 반전합니다. */
export function toggleTask(tasks, taskId) {
  requireTaskArray(tasks);
  const task = tasks.find((item) => item.id === taskId);
  return task ? setTaskCompleted(tasks, taskId, !task.completed) : tasks;
}

/** 지정한 작업을 삭제합니다. */
export function deleteTask(tasks, taskId) {
  requireTaskArray(tasks);
  if (!tasks.some((task) => task.id === taskId)) return tasks;
  return tasks.filter((task) => task.id !== taskId);
}

/** 상태 필터와 제목·과목의 대소문자 무시 검색을 적용합니다. */
export function filterTasks(tasks, { status = "all", query = "" } = {}) {
  requireTaskArray(tasks);
  if (!["all", "active", "completed"].includes(status)) {
    throw new RangeError("작업 필터는 all, active, completed 중 하나여야 합니다.");
  }
  const normalizedQuery = String(query ?? "").trim().toLowerCase();
  return tasks.filter((task) => {
    const matchesStatus = status === "all"
      || (status === "active" && !task.completed)
      || (status === "completed" && task.completed);
    const matchesQuery = !normalizedQuery
      || task.title.toLowerCase().includes(normalizedQuery)
      || task.subject.toLowerCase().includes(normalizedQuery);
    return matchesStatus && matchesQuery;
  });
}

/** 필터와 무관하게 전체 작업의 개수와 학습 시간을 요약합니다. */
export function summarizeTasks(tasks) {
  requireTaskArray(tasks);
  const completedCount = tasks.reduce((count, task) => count + Number(task.completed), 0);
  return {
    totalCount: tasks.length,
    activeCount: tasks.length - completedCount,
    completedCount,
    totalMinutes: tasks.reduce((total, task) => total + task.minutes, 0),
  };
}

/** 저장값이 전체 작업 목록 스키마와 값 규칙을 만족하는지 확인합니다. */
export function validateStoredTasks(value) {
  if (!Array.isArray(value)) {
    return { ok: false, tasks: [], error: "저장된 작업 목록 형식이 올바르지 않습니다." };
  }

  const ids = new Set();
  const tasks = [];
  for (const [index, item] of value.entries()) {
    const label = `저장된 작업 ${index + 1}`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, tasks: [], error: `${label}의 형식이 올바르지 않습니다.` };
    }
    if (typeof item.id !== "string" || item.id.trim() === "" || item.id !== item.id.trim()) {
      return { ok: false, tasks: [], error: `${label}의 ID가 올바르지 않습니다.` };
    }
    if (ids.has(item.id)) {
      return { ok: false, tasks: [], error: "저장된 작업에 중복 ID가 있습니다." };
    }
    if (typeof item.minutes !== "number" || typeof item.completed !== "boolean") {
      return { ok: false, tasks: [], error: `${label}의 값 형식이 올바르지 않습니다.` };
    }

    const validation = validateTaskInput(item);
    if (!validation.ok) {
      return { ok: false, tasks: [], error: `${label}: ${validation.message}` };
    }
    ids.add(item.id);
    tasks.push({ id: item.id, ...validation.value, completed: item.completed });
  }

  return { ok: true, tasks, error: null };
}

/** localStorage 원문을 파싱하고 검증합니다. 저장값이 없으면 빈 목록을 반환합니다. */
export function parseStoredTasks(raw) {
  if (raw === null) return { ok: true, tasks: [], error: null };
  if (typeof raw !== "string") {
    return { ok: false, tasks: [], error: "저장된 작업 데이터의 형식이 올바르지 않습니다." };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, tasks: [], error: "저장된 작업 데이터가 올바른 JSON이 아닙니다." };
  }
  return validateStoredTasks(parsed);
}

/** 유효한 작업 목록만 JSON으로 직렬화합니다. */
export function serializeTasks(tasks) {
  const validation = validateStoredTasks(tasks);
  if (!validation.ok) throw new TypeError(validation.error);
  return JSON.stringify(validation.tasks);
}

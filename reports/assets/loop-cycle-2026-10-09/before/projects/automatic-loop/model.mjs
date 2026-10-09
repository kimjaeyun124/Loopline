export const TASK_LIMITS = Object.freeze({
  title: 100,
  subject: 30,
  minutesMin: 1,
  minutesMax: 480,
});

const FILTERS = new Set(['all', 'active', 'completed']);
let idSequence = 0;

function characterCount(value) {
  return Array.from(value).length;
}

function normalizeMinutes(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : NaN;
  }
  if (typeof value !== 'string') return NaN;

  const text = value.trim();
  if (!/^\d+(?:\.0+)?$/.test(text)) return NaN;
  return Number(text);
}

/**
 * Validates user-entered values and returns a trimmed, normalized task payload.
 * The result is suitable for displaying field-specific errors in a UI.
 */
export function validateTaskInput(input) {
  const values = input && typeof input === 'object' && !Array.isArray(input) ? input : {};

  if (typeof values.title !== 'string' || values.title.trim().length === 0) {
    return { ok: false, field: 'title', message: '제목을 입력해 주세요.' };
  }
  const title = values.title.trim();
  if (characterCount(title) > TASK_LIMITS.title) {
    return { ok: false, field: 'title', message: `제목은 ${TASK_LIMITS.title}자까지 입력할 수 있습니다.` };
  }

  if (typeof values.subject !== 'string' || values.subject.trim().length === 0) {
    return { ok: false, field: 'subject', message: '과목을 입력해 주세요.' };
  }
  const subject = values.subject.trim();
  if (characterCount(subject) > TASK_LIMITS.subject) {
    return { ok: false, field: 'subject', message: `과목은 ${TASK_LIMITS.subject}자까지 입력할 수 있습니다.` };
  }

  const minutes = normalizeMinutes(values.minutes);
  if (!Number.isInteger(minutes)) {
    return { ok: false, field: 'minutes', message: '학습 시간은 정수로 입력해 주세요.' };
  }
  if (minutes < TASK_LIMITS.minutesMin || minutes > TASK_LIMITS.minutesMax) {
    return {
      ok: false,
      field: 'minutes',
      message: `학습 시간은 ${TASK_LIMITS.minutesMin}~${TASK_LIMITS.minutesMax}분 사이로 입력해 주세요.`,
    };
  }

  return { ok: true, value: { title, subject, minutes } };
}

export class TaskValidationError extends Error {
  constructor(validation) {
    super(validation.message);
    this.name = 'TaskValidationError';
    this.field = validation.field;
  }
}

/** Validates persisted task records and returns fresh, normalized records. */
export function validateStoredTasks(tasks) {
  if (!Array.isArray(tasks)) {
    throw new TypeError('저장 데이터는 작업 목록이어야 합니다.');
  }

  const ids = new Set();
  return tasks.map((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new TypeError(`저장된 작업 ${index + 1}의 형식이 올바르지 않습니다.`);
    }
    if (typeof record.id !== 'string' || record.id.trim() === '' || record.id !== record.id.trim()) {
      throw new TypeError(`저장된 작업 ${index + 1}의 ID가 올바르지 않습니다.`);
    }
    if (ids.has(record.id)) {
      throw new TypeError(`저장된 작업에 중복된 ID가 있습니다: ${record.id}`);
    }
    ids.add(record.id);

    if (typeof record.title !== 'string' || typeof record.subject !== 'string') {
      throw new TypeError(`저장된 작업 ${index + 1}의 제목 또는 과목 형식이 올바르지 않습니다.`);
    }
    if (typeof record.minutes !== 'number' || typeof record.completed !== 'boolean') {
      throw new TypeError(`저장된 작업 ${index + 1}의 시간 또는 완료 상태 형식이 올바르지 않습니다.`);
    }

    const validation = validateTaskInput(record);
    if (!validation.ok) {
      throw new TypeError(`저장된 작업 ${index + 1}: ${validation.message}`);
    }
    if (validation.value.title !== record.title || validation.value.subject !== record.subject) {
      throw new TypeError(`저장된 작업 ${index + 1}의 제목과 과목은 앞뒤 공백이 없어야 합니다.`);
    }

    return {
      id: record.id,
      ...validation.value,
      completed: record.completed,
    };
  });
}

/** Parses and validates the JSON value stored for the task list. */
export function parseStoredTasks(serialized) {
  if (typeof serialized !== 'string') {
    throw new TypeError('저장 데이터는 JSON 문자열이어야 합니다.');
  }

  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new TypeError('저장 데이터의 JSON 형식이 올바르지 않습니다.');
  }
  return validateStoredTasks(parsed);
}

export function filterTasks(tasks, status = 'all', query = '') {
  if (!Array.isArray(tasks)) throw new TypeError('작업 목록은 배열이어야 합니다.');
  if (!FILTERS.has(status)) throw new RangeError(`알 수 없는 작업 필터입니다: ${status}`);
  if (typeof query !== 'string') throw new TypeError('검색어는 문자열이어야 합니다.');

  const needle = query.trim().toLowerCase();
  return tasks
    .filter((task) => {
      const matchesStatus = status === 'all'
        || (status === 'active' && !task.completed)
        || (status === 'completed' && task.completed);
      const matchesQuery = needle.length === 0
        || task.title.toLowerCase().includes(needle)
        || task.subject.toLowerCase().includes(needle);
      return matchesStatus && matchesQuery;
    })
    .map((task) => ({ ...task }));
}

export function getTaskStats(tasks) {
  const validTasks = validateStoredTasks(tasks);
  const completedCount = validTasks.filter((task) => task.completed).length;
  return {
    totalCount: validTasks.length,
    activeCount: validTasks.length - completedCount,
    completedCount,
    totalMinutes: validTasks.reduce((total, task) => total + task.minutes, 0),
  };
}

function nextTaskId(existingIds) {
  let id;
  do {
    idSequence += 1;
    id = `task-${Date.now().toString(36)}-${idSequence.toString(36)}`;
  } while (existingIds.has(id));
  return id;
}

/** UI-independent in-memory model for creating and managing study tasks. */
export class TaskModel {
  #tasks;

  constructor(tasks = []) {
    this.#tasks = validateStoredTasks(tasks);
  }

  get tasks() {
    return this.#tasks.map((task) => ({ ...task }));
  }

  add(input) {
    const validation = validateTaskInput(input);
    if (!validation.ok) throw new TaskValidationError(validation);

    const task = {
      id: nextTaskId(new Set(this.#tasks.map((item) => item.id))),
      ...validation.value,
      completed: false,
    };
    this.#tasks.push(task);
    return { ...task };
  }

  toggle(id) {
    const task = this.#tasks.find((item) => item.id === id);
    if (!task) return null;
    task.completed = !task.completed;
    return { ...task };
  }

  delete(id) {
    const index = this.#tasks.findIndex((item) => item.id === id);
    if (index === -1) return false;
    this.#tasks.splice(index, 1);
    return true;
  }

  filter(status = 'all', query = '') {
    return filterTasks(this.#tasks, status, query);
  }

  stats() {
    return getTaskStats(this.#tasks);
  }

  toJSON() {
    return this.tasks;
  }
}

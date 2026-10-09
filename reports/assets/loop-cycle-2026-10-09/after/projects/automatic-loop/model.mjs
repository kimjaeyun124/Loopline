export const STORAGE_KEY = 'focus-board-v1';

let idCounter = 0;

export function validateTaskInput(title, subject, minutes) {
  const cleanTitle = typeof title === 'string' ? title.trim() : '';
  const cleanSubject = typeof subject === 'string' ? subject.trim() : '';

  if (!cleanTitle) return { error: '제목을 입력해 주세요.', field: 'title' };
  if (cleanTitle.length > 100) return { error: '제목은 100자까지 입력할 수 있습니다.', field: 'title' };
  if (!cleanSubject) return { error: '과목을 입력해 주세요.', field: 'subject' };
  if (cleanSubject.length > 30) return { error: '과목은 30자까지 입력할 수 있습니다.', field: 'subject' };
  if (typeof minutes !== 'string' || !/^\d+$/.test(minutes)) {
    return { error: '학습 시간은 1~480 사이의 정수로 입력해 주세요.', field: 'minutes' };
  }

  const numericMinutes = Number(minutes);
  if (!Number.isInteger(numericMinutes) || numericMinutes < 1 || numericMinutes > 480) {
    return { error: '학습 시간은 1~480 사이의 정수로 입력해 주세요.', field: 'minutes' };
  }

  return { title: cleanTitle, subject: cleanSubject, minutes: numericMinutes };
}

export function validateStoredTasks(value) {
  if (!Array.isArray(value)) return { ok: false, error: '저장된 작업 목록 형식이 올바르지 않습니다.' };

  const ids = new Set();
  const tasks = [];
  for (const task of value) {
    const validObject = task !== null && typeof task === 'object' && !Array.isArray(task);
    const validText = validObject && typeof task.title === 'string' && task.title === task.title.trim() && task.title.length >= 1 && task.title.length <= 100
      && typeof task.subject === 'string' && task.subject === task.subject.trim() && task.subject.length >= 1 && task.subject.length <= 30;
    const validFields = validObject && typeof task.id === 'string' && task.id.trim().length > 0
      && Number.isInteger(task.minutes) && task.minutes >= 1 && task.minutes <= 480
      && typeof task.completed === 'boolean' && typeof task.createdAt === 'string'
      && !Number.isNaN(Date.parse(task.createdAt));

    if (!validText || !validFields || ids.has(task.id)) {
      return { ok: false, error: '저장된 작업 데이터가 올바르지 않습니다.' };
    }

    ids.add(task.id);
    tasks.push({
      id: task.id,
      title: task.title,
      subject: task.subject,
      minutes: task.minutes,
      completed: task.completed,
      createdAt: task.createdAt
    });
  }

  return { ok: true, tasks };
}

export function getTaskStats(tasks) {
  return tasks.reduce((stats, task) => {
    stats.total += 1;
    if (task.completed) stats.completed += 1;
    else stats.active += 1;
    stats.totalMinutes += task.minutes;
    return stats;
  }, { total: 0, active: 0, completed: 0, totalMinutes: 0 });
}

export function filterTasks(tasks, filter = 'all', search = '') {
  const query = typeof search === 'string' ? search.trim().toLowerCase() : '';
  return tasks.filter((task) => {
    if (filter === 'active' && task.completed) return false;
    if (filter === 'completed' && !task.completed) return false;
    if (!query) return true;
    return task.title.toLowerCase().includes(query) || task.subject.toLowerCase().includes(query);
  });
}

export class TaskModel {
  constructor({ storage = globalThis.localStorage, storageKey = STORAGE_KEY } = {}) {
    this.storage = storage;
    this.storageKey = storageKey;
    this.tasks = [];
    this.statusMessage = '';
  }

  load() {
    this.statusMessage = '';
    try {
      if (!this.storage || typeof this.storage.getItem !== 'function') throw new Error('Storage unavailable');
      const raw = this.storage.getItem(this.storageKey);
      if (raw === null) {
        this.tasks = [];
        return { ok: true, tasks: this.tasks };
      }
      if (typeof raw !== 'string') throw new Error('Invalid storage value');
      const checked = validateStoredTasks(JSON.parse(raw));
      if (!checked.ok) throw new Error(checked.error);
      this.tasks = checked.tasks;
      return { ok: true, tasks: this.tasks };
    } catch {
      this.tasks = [];
      this.statusMessage = '저장된 작업 데이터를 읽을 수 없어 빈 목록으로 시작합니다.';
      return { ok: false, error: this.statusMessage, tasks: this.tasks };
    }
  }

  save(tasks = this.tasks) {
    try {
      if (!this.storage || typeof this.storage.setItem !== 'function') throw new Error('Storage unavailable');
      this.storage.setItem(this.storageKey, JSON.stringify(tasks));
      this.statusMessage = '';
      return { ok: true };
    } catch {
      this.statusMessage = '작업을 저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.';
      return { ok: false, error: this.statusMessage };
    }
  }

  validateTask(title, subject, minutes) {
    return validateTaskInput(title, subject, minutes);
  }

  addTask(title, subject, minutes) {
    const checked = validateTaskInput(title, subject, minutes);
    if (checked.error) return { ok: false, ...checked };

    const task = {
      id: this.#createId(),
      title: checked.title,
      subject: checked.subject,
      minutes: checked.minutes,
      completed: false,
      createdAt: new Date().toISOString()
    };
    const nextTasks = [...this.tasks, task];
    const saved = this.save(nextTasks);
    if (!saved.ok) return saved;
    this.tasks = nextTasks;
    return { ok: true, task: { ...task } };
  }

  toggleTask(id) {
    const index = this.tasks.findIndex((task) => task.id === id);
    if (index < 0) return { ok: false, error: '작업을 찾을 수 없습니다.' };
    const nextTasks = this.tasks.map((task, taskIndex) => taskIndex === index
      ? { ...task, completed: !task.completed }
      : { ...task });
    const saved = this.save(nextTasks);
    if (!saved.ok) return saved;
    this.tasks = nextTasks;
    return { ok: true, task: { ...nextTasks[index] } };
  }

  deleteTask(id) {
    const removedTask = this.tasks.find((task) => task.id === id);
    if (!removedTask) return { ok: false, error: '작업을 찾을 수 없습니다.' };
    const nextTasks = this.tasks.filter((task) => task.id !== id);
    const saved = this.save(nextTasks);
    if (!saved.ok) return saved;
    this.tasks = nextTasks;
    return { ok: true, task: { ...removedTask } };
  }

  getStats() {
    return getTaskStats(this.tasks);
  }

  getFilteredTasks(filter = 'all', search = '') {
    return filterTasks(this.tasks, filter, search).map((task) => ({ ...task }));
  }

  #createId() {
    let id;
    do {
      id = `task-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;
    } while (this.tasks.some((task) => task.id === id));
    return id;
  }
}

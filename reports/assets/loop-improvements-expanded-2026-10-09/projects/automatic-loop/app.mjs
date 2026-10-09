import { addTask, deleteTask, filterTasks, getSummary, parseSavedTasks, toggleTask } from './model.mjs';

const STORAGE_KEY = 'focus-board-v1';
const cloneTasks = (tasks) => tasks.map((task) => ({ ...task }));


function readTasks(storage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return { tasks: [], warning: '' };
    return { tasks: parseSavedTasks(raw), warning: '' };
  } catch {
    return { tasks: [], warning: '저장된 작업을 읽을 수 없어 빈 목록으로 시작합니다.' };
  }
}

export function initApp(root = document, storage = window.localStorage) {
  const byId = (id) => root.getElementById(id);
  const form = byId('taskForm');
  const titleInput = byId('taskTitle');
  const subjectInput = byId('taskSubject');
  const minutesInput = byId('taskMinutes');
  const error = byId('formError');
  const status = byId('statusMessage');
  const list = byId('taskList');
  const empty = byId('emptyState');
  const search = byId('searchInput');
  const filterButtons = {
    all: byId('filterAll'), active: byId('filterActive'), completed: byId('filterCompleted'),
  };
  const loaded = readTasks(storage);
  let tasks = loaded.tasks;
  let filter = 'all';
  let query = '';
  if (loaded.warning) status.textContent = loaded.warning;

  function updateSummary() {
    const summary = getSummary(tasks);
    for (const key of Object.keys(summary)) byId(key).textContent = String(summary[key]);
  }
  function visibleTasks() {
    return filterTasks(tasks, { status: filter, query });
  }
  function render() {
    const shown = visibleTasks();
    list.replaceChildren();
    for (const task of shown) {
      const item = root.createElement('li');
      item.className = `task${task.completed ? ' is-completed' : ''}`;
      const main = root.createElement('div'); main.className = 'task-main';
      const titleRow = root.createElement('div'); titleRow.className = 'task-title-row';
      const title = root.createElement('h3'); title.className = 'task-title'; title.textContent = task.title;
      const badge = root.createElement('span'); badge.className = 'task-status'; badge.textContent = task.completed ? '완료' : '진행 중';
      titleRow.append(title, badge);
      const meta = root.createElement('div'); meta.className = 'task-meta';
      const subject = root.createElement('span'); subject.className = 'task-subject'; subject.textContent = task.subject;
      const minutes = root.createElement('span'); minutes.className = 'task-minutes'; minutes.textContent = `${task.minutes}분`;
      meta.append(subject, minutes); main.append(titleRow, meta);
      const actions = root.createElement('div'); actions.className = 'task-actions';
      const toggle = root.createElement('button'); toggle.type = 'button'; toggle.className = 'task-action'; toggle.dataset.action = 'toggle';
      toggle.textContent = task.completed ? '완료 취소' : '완료'; toggle.setAttribute('aria-label', `${task.title} ${toggle.textContent}`);
      toggle.addEventListener('click', () => {
        tasks = toggleTask(tasks, task.id);
        saveAndRender('작업 상태를 변경했습니다.');
      });
      const remove = root.createElement('button'); remove.type = 'button'; remove.className = 'task-action'; remove.dataset.action = 'delete';
      remove.textContent = '삭제'; remove.setAttribute('aria-label', `${task.title} 삭제`);
      remove.addEventListener('click', () => {
        tasks = deleteTask(tasks, task.id);
        saveAndRender('작업을 삭제했습니다.');
      });
      actions.append(toggle, remove); item.append(main, actions); list.append(item);
    }
    empty.hidden = shown.length !== 0;
    updateSummary();
    for (const [name, button] of Object.entries(filterButtons)) {
      const selected = name === filter;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
  }
  function saveAndRender(message) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(tasks));
      status.textContent = message;
    } catch {
      status.textContent = '저장에 실패했습니다. 현재 브라우저 저장 공간을 확인해 주세요.';
    }
    render();
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const title = titleInput.value.trim();
    const subject = subjectInput.value.trim();
    const minutesText = minutesInput.value.trim();
    const minutes = Number(minutesText);
    let message = '';
    if (!title) { message = '작업 제목을 입력해 주세요.'; titleInput.focus(); }
    else if (title.length > 100) message = '작업 제목은 100자까지 입력할 수 있습니다.';
    else if (!subject) message = '과목을 입력해 주세요.';
    else if (subject.length > 30) message = '과목은 30자까지 입력할 수 있습니다.';
    else if (!minutesText || !Number.isInteger(minutes) || minutes < 1 || minutes > 480) message = '학습 시간은 1분에서 480분 사이의 정수로 입력해 주세요.';
    if (message) { error.textContent = message; error.hidden = false; return; }
    error.textContent = ''; error.hidden = true;
    tasks = addTask(tasks, { title, subject, minutes });
    form.reset();
    saveAndRender('작업을 추가했습니다.');
  });
  for (const [name, button] of Object.entries(filterButtons)) {
    button.addEventListener('click', () => { filter = name; render(); });
  }
  search.addEventListener('input', () => { query = search.value; render(); });
  render();
  return { render, getTasks: () => cloneTasks(tasks) };
}

if (typeof document !== 'undefined' && document.getElementById('taskForm')) {
  let storage;
  try { storage = window.localStorage; } catch { storage = { getItem: () => null, setItem: () => { throw new Error('storage unavailable'); } }; }
  initApp(document, storage);
}

import { TaskModel, parseStoredTasks } from './model.mjs';

export const STORAGE_KEY = 'focus-board-v1';

const FILTERS = Object.freeze({
  all: 'filterAll',
  active: 'filterActive',
  completed: 'filterCompleted',
});

/** Connects the model to the page and a browser-compatible storage object. */
export function createFocusBoardApp({ document: page = globalThis.document, storage } = {}) {
  if (!page) throw new TypeError('화면 문서가 필요합니다.');

  const byId = (id) => page.getElementById(id);
  const form = byId('taskForm');
  const titleInput = byId('taskTitle');
  const subjectInput = byId('taskSubject');
  const minutesInput = byId('taskMinutes');
  const addButton = byId('addTask');
  const formError = byId('formError');
  const statusMessage = byId('statusMessage');
  const taskList = byId('taskList');
  const emptyState = byId('emptyState');
  const searchInput = byId('searchInput');
  const filterButtons = Object.fromEntries(
    Object.entries(FILTERS).map(([filter, id]) => [filter, byId(id)]),
  );
  const statElements = {
    totalCount: byId('totalCount'),
    activeCount: byId('activeCount'),
    completedCount: byId('completedCount'),
    totalMinutes: byId('totalMinutes'),
  };

  let storageArea = storage;
  let model;
  let currentFilter = 'all';
  if (storageArea === undefined) {
    try {
      storageArea = page.defaultView?.localStorage ?? globalThis.localStorage;
    } catch {
      storageArea = null;
    }
  }

  let restoredTasks = [];
  try {
    const serialized = storageArea?.getItem(STORAGE_KEY);
    if (serialized !== null && serialized !== undefined) restoredTasks = parseStoredTasks(serialized);
  } catch {
    statusMessage.textContent = '저장된 작업 데이터를 읽을 수 없어 빈 목록으로 시작합니다.';
  }
  model = new TaskModel(restoredTasks);

  function showError(message, field) {
    formError.textContent = message;
    formError.hidden = false;
    if (field === 'title' && !titleInput.value.trim()) titleInput.focus();
  }

  function clearError() {
    formError.textContent = '';
    formError.hidden = true;
  }

  function saveTasks() {
    if (!storageArea || typeof storageArea.setItem !== 'function') {
      statusMessage.textContent = '이 환경에서는 작업을 저장할 수 없습니다.';
      return false;
    }
    try {
      storageArea.setItem(STORAGE_KEY, JSON.stringify(model.toJSON()));
      return true;
    } catch {
      statusMessage.textContent = '작업을 저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.';
      return false;
    }
  }

  function createTaskCard(task) {
    const card = page.createElement('article');
    card.className = task.completed ? 'task is-completed' : 'task';
    card.dataset.taskId = task.id;

    const main = page.createElement('div');
    main.className = 'task-main';
    const title = page.createElement('h3');
    title.className = 'task-title';
    title.textContent = task.title;
    const details = page.createElement('div');
    details.className = 'task-details';
    const subject = page.createElement('p');
    subject.className = 'task-subject';
    subject.textContent = task.subject;
    const minutes = page.createElement('span');
    minutes.className = 'task-minutes';
    minutes.textContent = `${task.minutes}분`;
    details.append(subject, minutes);
    main.append(title, details);

    const actions = page.createElement('div');
    actions.className = 'task-actions';
    const toggle = page.createElement('button');
    toggle.type = 'button';
    toggle.className = 'action-button';
    toggle.dataset.action = 'toggle';
    toggle.dataset.taskId = task.id;
    toggle.textContent = task.completed ? '완료 취소' : '완료 표시';
    toggle.setAttribute('aria-label', `${task.title} ${toggle.textContent}`);
    const remove = page.createElement('button');
    remove.type = 'button';
    remove.className = 'action-button';
    remove.dataset.action = 'delete';
    remove.dataset.taskId = task.id;
    remove.textContent = '삭제';
    remove.setAttribute('aria-label', `${task.title} 삭제`);
    actions.append(toggle, remove);
    card.append(main, actions);
    return card;
  }

  function render() {
    const visibleTasks = model.filter(currentFilter, searchInput.value);
    taskList.replaceChildren(...visibleTasks.map(createTaskCard));
    emptyState.hidden = visibleTasks.length > 0;
    if (visibleTasks.length === 0) {
      const emptyHeading = emptyState.querySelector('h3');
      const emptyText = emptyState.querySelector('p');
      if (model.stats().totalCount === 0) {
        emptyHeading.textContent = '집중할 일을 정해볼까요?';
        emptyText.textContent = '작업을 추가하면 이곳에서 학습 흐름을 관리할 수 있어요.';
      } else {
        emptyHeading.textContent = '조건에 맞는 작업이 없습니다.';
        emptyText.textContent = '다른 필터나 검색어를 선택해 보세요.';
      }
    }

    const stats = model.stats();
    for (const [key, element] of Object.entries(statElements)) {
      element.textContent = String(stats[key]);
    }
    for (const [filter, button] of Object.entries(filterButtons)) {
      const selected = filter === currentFilter;
      button.setAttribute('aria-pressed', String(selected));
      button.classList.toggle('is-selected', selected);
    }
  }

  function findAction(action, taskId) {
    return Array.from(taskList.querySelectorAll('button[data-action]'))
      .find((button) => button.dataset.action === action && button.dataset.taskId === taskId);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      model.add({ title: titleInput.value, subject: subjectInput.value, minutes: minutesInput.value });
      clearError();
      form.reset();
      statusMessage.textContent = '학습 작업을 추가했습니다.';
      saveTasks();
      render();
    } catch (error) {
      showError(error.message || '입력 내용을 확인해 주세요.', error.field);
    }
  });

  taskList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || !taskList.contains(button)) return;
    const { action, taskId } = button.dataset;
    if (action === 'toggle') {
      model.toggle(taskId);
      statusMessage.textContent = '작업 상태를 변경했습니다.';
      saveTasks();
      render();
      findAction('toggle', taskId)?.focus();
    } else if (action === 'delete') {
      model.delete(taskId);
      statusMessage.textContent = '작업을 삭제했습니다.';
      saveTasks();
      render();
      const nextAction = taskList.querySelector('button[data-action="toggle"]') || filterButtons[currentFilter];
      nextAction?.focus();
    }
  });

  searchInput.addEventListener('input', render);
  for (const [filter, button] of Object.entries(filterButtons)) {
    button.addEventListener('click', () => {
      currentFilter = filter;
      render();
    });
  }
  for (const input of [titleInput, subjectInput, minutesInput]) {
    input.addEventListener('input', () => {
      if (!formError.hidden) clearError();
    });
  }

  render();
  return { model, render };
}

if (typeof document !== 'undefined') {
  const start = () => createFocusBoardApp({ document });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}

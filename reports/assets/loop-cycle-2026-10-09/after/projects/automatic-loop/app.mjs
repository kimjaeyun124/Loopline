import { TaskModel } from './model.mjs';

const model = new TaskModel();
const taskForm = document.querySelector('#taskForm');
const titleInput = document.querySelector('#taskTitle');
const subjectInput = document.querySelector('#taskSubject');
const minutesInput = document.querySelector('#taskMinutes');
const formError = document.querySelector('#formError');
const statusMessage = document.querySelector('#statusMessage');
const taskList = document.querySelector('#taskList');
const emptyState = document.querySelector('#emptyState');
const searchInput = document.querySelector('#searchInput');
const filterButtons = [
  document.querySelector('#filterAll'),
  document.querySelector('#filterActive'),
  document.querySelector('#filterCompleted')
];
const statElements = {
  total: document.querySelector('#totalCount'),
  active: document.querySelector('#activeCount'),
  completed: document.querySelector('#completedCount'),
  totalMinutes: document.querySelector('#totalMinutes')
};

let currentFilter = 'all';

function makeElement(tagName, className, text) {
  const element = document.createElement(tagName);
  element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function makeTaskCard(task) {
  const card = makeElement('article', `task${task.completed ? ' is-completed' : ''}`);
  card.dataset.taskId = task.id;

  const content = makeElement('div', 'task-content');
  const topline = makeElement('div', 'task-topline');
  const badge = makeElement('span', `task-status${task.completed ? ' is-completed' : ''}`, task.completed ? '완료' : '진행 중');
  const title = makeElement('h3', 'task-title', task.title);
  topline.append(badge, title);

  const details = makeElement('div', 'task-details');
  details.append(
    makeElement('span', 'task-subject', task.subject),
    makeElement('span', 'task-separator', '·'),
    makeElement('span', 'task-minutes', task.minutes),
    makeElement('span', 'task-duration-unit', '분')
  );
  content.append(topline, details);

  const actions = makeElement('div', 'task-actions');
  const toggleButton = makeElement('button', 'task-action task-action-toggle', task.completed ? '다시 진행' : '완료 처리');
  toggleButton.type = 'button';
  toggleButton.dataset.action = 'toggle';
  toggleButton.setAttribute('aria-label', `${task.completed ? '완료 취소' : '완료 처리'}: ${task.title}`);
  const deleteButton = makeElement('button', 'task-action task-action-delete', '삭제');
  deleteButton.type = 'button';
  deleteButton.dataset.action = 'delete';
  deleteButton.setAttribute('aria-label', `작업 삭제: ${task.title}`);
  actions.append(toggleButton, deleteButton);

  card.append(content, actions);
  return card;
}

function render() {
  const stats = model.getStats();
  for (const [key, element] of Object.entries(statElements)) element.textContent = String(stats[key]);

  const visibleTasks = model.getFilteredTasks(currentFilter, searchInput.value);
  const fragment = document.createDocumentFragment();
  for (const task of visibleTasks) fragment.append(makeTaskCard(task));
  taskList.replaceChildren(fragment);

  emptyState.hidden = visibleTasks.length !== 0;
  if (searchInput.value.trim()) {
    emptyState.querySelector('h3').textContent = '검색 결과가 없어요';
    emptyState.querySelector('p').textContent = '다른 제목이나 과목으로 다시 검색해 보세요.';
  } else if (currentFilter !== 'all') {
    emptyState.querySelector('h3').textContent = '해당하는 작업이 없어요';
    emptyState.querySelector('p').textContent = '다른 필터를 선택하거나 새 작업을 추가해 보세요.';
  } else {
    emptyState.querySelector('h3').textContent = '아직 등록된 작업이 없어요';
    emptyState.querySelector('p').textContent = '위에서 오늘의 첫 학습 계획을 추가해 보세요.';
  }

  const filterNames = ['all', 'active', 'completed'];
  filterButtons.forEach((button, index) => {
    const selected = currentFilter === filterNames[index];
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  statusMessage.textContent = model.statusMessage;
  statusMessage.hidden = !model.statusMessage;
}

function showFormError(message, field) {
  formError.textContent = message;
  formError.hidden = false;
  if (field === 'title') titleInput.focus();
  else if (field === 'subject') subjectInput.focus();
  else if (field === 'minutes') minutesInput.focus();
}

taskForm.addEventListener('submit', (event) => {
  event.preventDefault();
  formError.textContent = '';
  formError.hidden = true;

  const result = model.addTask(titleInput.value, subjectInput.value, minutesInput.value);
  if (!result.ok) {
    if (result.field) {
      showFormError(result.error, result.field);
    } else {
      model.statusMessage = result.error || model.statusMessage;
      render();
    }
    return;
  }

  taskForm.reset();
  render();
  titleInput.focus();
});

searchInput.addEventListener('input', render);

filterButtons.forEach((button, index) => {
  button.addEventListener('click', () => {
    currentFilter = ['all', 'active', 'completed'][index];
    render();
  });
});

taskList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || !taskList.contains(button)) return;
  const card = button.closest('.task');
  if (!card) return;

  const result = button.dataset.action === 'toggle'
    ? model.toggleTask(card.dataset.taskId)
    : model.deleteTask(card.dataset.taskId);
  if (!result.ok) model.statusMessage = result.error;
  render();
});

model.load();
render();

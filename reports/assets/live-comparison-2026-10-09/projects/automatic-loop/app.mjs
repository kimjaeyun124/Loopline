import {
  addTask,
  deleteTask,
  filterTasks,
  parseStoredTasks,
  serializeTasks,
  toggleTask,
} from "./model.mjs";

export const STORAGE_KEY = "focus-board-v1";

export function initializeApp({ document: documentRef = globalThis.document, storage } = {}) {
  if (!documentRef) throw new TypeError("화면 문서를 찾을 수 없습니다.");
  let storageRef = storage;
  if (storageRef === undefined) {
    try { storageRef = globalThis.localStorage; } catch { storageRef = null; }
  }

  const form = documentRef.querySelector("#taskForm");
  const titleInput = documentRef.querySelector("#taskTitle");
  const subjectInput = documentRef.querySelector("#taskSubject");
  const minutesInput = documentRef.querySelector("#taskMinutes");
  const formError = documentRef.querySelector("#formError");
  const statusMessage = documentRef.querySelector("#statusMessage");
  const taskList = documentRef.querySelector("#taskList");
  const emptyState = documentRef.querySelector("#emptyState");
  const searchInput = documentRef.querySelector("#searchInput");
  const filters = {
    all: documentRef.querySelector("#filterAll"),
    active: documentRef.querySelector("#filterActive"),
    completed: documentRef.querySelector("#filterCompleted"),
  };
  const counters = {
    totalCount: documentRef.querySelector("#totalCount"),
    activeCount: documentRef.querySelector("#activeCount"),
    completedCount: documentRef.querySelector("#completedCount"),
    totalMinutes: documentRef.querySelector("#totalMinutes"),
  };
  let tasks = [];
  let activeFilter = "all";
  let query = "";

  const announce = (message) => { statusMessage.textContent = message; };
  try {
    const result = parseStoredTasks(storageRef.getItem(STORAGE_KEY));
    tasks = result.tasks;
    if (!result.ok) announce(`${result.error} 빈 목록으로 시작합니다.`);
  } catch {
    announce("저장된 작업을 읽지 못했습니다. 빈 목록으로 시작합니다.");
  }

  function persist() {
    try {
      storageRef.setItem(STORAGE_KEY, serializeTasks(tasks));
      return true;
    } catch {
      announce("작업을 저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.");
      return false;
    }
  }

  function makeTaskElement(task) {
    const article = documentRef.createElement("article");
    article.className = task.completed ? "task task--completed" : "task";
    article.setAttribute("role", "listitem");

    const content = documentRef.createElement("div");
    content.className = "task-content";
    const title = documentRef.createElement("h3");
    title.className = "task-title";
    title.textContent = task.title;
    const meta = documentRef.createElement("div");
    meta.className = "task-meta";
    const subject = documentRef.createElement("span");
    subject.className = "task-subject";
    subject.textContent = task.subject;
    const minutes = documentRef.createElement("span");
    minutes.className = "task-minutes";
    minutes.textContent = `${task.minutes}분`;
    const badge = documentRef.createElement("span");
    badge.className = "task-status";
    badge.textContent = task.completed ? "완료" : "진행 중";
    meta.append(subject, minutes, badge);
    content.append(title, meta);

    const actions = documentRef.createElement("div");
    actions.className = "task-actions";
    const toggle = documentRef.createElement("button");
    toggle.type = "button";
    toggle.dataset.action = "toggle";
    toggle.dataset.taskId = task.id;
    toggle.textContent = task.completed ? "완료 취소" : "완료";
    toggle.setAttribute("aria-label", `${task.title} ${toggle.textContent}`);
    toggle.addEventListener("click", () => {
      tasks = toggleTask(tasks, task.id);
      persist();
      render();
      announce(task.completed ? "작업을 진행 중으로 되돌렸습니다." : "작업을 완료했습니다.");
    });
    const remove = documentRef.createElement("button");
    remove.type = "button";
    remove.dataset.action = "delete";
    remove.dataset.taskId = task.id;
    remove.textContent = "삭제";
    remove.setAttribute("aria-label", `${task.title} 삭제`);
    remove.addEventListener("click", () => {
      tasks = deleteTask(tasks, task.id);
      persist();
      render();
      announce("작업을 삭제했습니다.");
    });
    actions.append(toggle, remove);
    article.append(content, actions);
    return article;
  }

  function render() {
    const visibleTasks = filterTasks(tasks, { status: activeFilter, query });
    taskList.replaceChildren(...visibleTasks.map(makeTaskElement));
    emptyState.hidden = visibleTasks.length > 0;
    const summary = {
      totalCount: tasks.length,
      activeCount: tasks.filter((task) => !task.completed).length,
      completedCount: tasks.filter((task) => task.completed).length,
      totalMinutes: tasks.reduce((total, task) => total + task.minutes, 0),
    };
    for (const [key, value] of Object.entries(summary)) counters[key].textContent = String(value);
    for (const [status, button] of Object.entries(filters)) {
      const selected = status === activeFilter;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
  }

  const submitOnEnter = (event) => {
    if (event.key !== "Enter" || event.isComposing || event.defaultPrevented) return;
    event.preventDefault();
    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
    } else {
      form.dispatchEvent({ type: "submit" });
    }
  };
  for (const input of [titleInput, subjectInput, minutesInput]) {
    input.addEventListener("keydown", submitOnEnter);
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    formError.hidden = true;
    formError.textContent = "";
    const result = addTask(tasks, {
      title: titleInput.value,
      subject: subjectInput.value,
      minutes: minutesInput.value,
    });
    if (!result.ok) {
      formError.textContent = result.error.message;
      formError.hidden = false;
      if (result.error.field === "title") titleInput.focus();
      return;
    }
    tasks = result.tasks;
    const saved = persist();
    form.reset();
    render();
    if (saved) announce("작업을 추가했습니다.");
    titleInput.focus();
  });

  for (const [status, button] of Object.entries(filters)) {
    button.addEventListener("click", () => {
      activeFilter = status;
      render();
    });
  }
  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    render();
  });

  render();
  return { getTasks: () => tasks };
}

if (typeof document !== "undefined" && document.querySelector("#taskForm")) {
  initializeApp({ document });
}

import {
  createDemoConnection,
  createExportPayload,
  demoConnections,
  demoEvents,
  filterEvents,
  getEvent,
} from "./state.mjs";

const connectionList = document.querySelector("#connection-list");
const connectionCount = document.querySelector("#connection-count");
const eventList = document.querySelector("#event-list");
const eventDetail = document.querySelector("#event-detail");
const eventFilter = document.querySelector("#event-filter");
const eventCount = document.querySelector("#event-count");
const connectionDialog = document.querySelector("#connection-dialog");
const connectionForm = document.querySelector("#connection-form");
const transportSelect = document.querySelector("#connection-transport");
const commandField = document.querySelector("#command-field");
const urlField = document.querySelector("#url-field");
const formError = document.querySelector("#form-error");
const toast = document.querySelector("#toast");

let connections = [...demoConnections];
let selectedEventId = demoEvents[0].id;
let toastTimer;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderConnections() {
  connectionList.replaceChildren();
  for (const connection of connections) {
    const card = element("article", "connection-card");
    if (connection.status === "unverified") card.classList.add("is-warning");
    if (connection.status === "demo-only") card.classList.add("is-added");

    const top = element("div", "connection-top");
    const brand = element("div", "connection-brand");
    const icon = element("div", "connection-icon", connection.name.slice(0, 1).toUpperCase());
    if (connection.status === "unverified" || connection.status === "demo-only") icon.classList.add("warning");
    const copy = element("div");
    const name = element("p", "connection-name", connection.name);
    const kind = element("p", "connection-kind", connection.kind);
    copy.append(name, kind);
    brand.append(icon, copy);

    const state = element("span", "connection-state");
    if (connection.status === "available") {
      const dot = element("span", "status-dot");
      state.append(dot, document.createTextNode("사용 가능"));
    } else {
      state.classList.add("warning");
      state.textContent = connection.status === "demo-only" ? "데모 항목" : "확인 불가";
    }
    top.append(brand, state);
    card.append(top);

    if (connection.tools?.length) {
      const tools = element("div", "tool-list");
      for (const tool of connection.tools) tools.append(element("span", "tool-chip", tool));
      card.append(tools);
    }
    if (connection.note) card.append(element("p", "connection-note", connection.note));
    connectionList.append(card);
  }
  const count = connections.filter((connection) => connection.status === "available").length;
  connectionCount.textContent = String(count).padStart(2, "0");
}

function renderEvents() {
  const visibleEvents = filterEvents(demoEvents, eventFilter.value);
  eventList.replaceChildren();
  eventCount.textContent = "최근 " + visibleEvents.length + "개";

  if (visibleEvents.length === 0) {
    eventList.append(element("div", "empty-events", "이 조건에 맞는 이벤트가 없습니다."));
    return;
  }

  for (const event of visibleEvents) {
    const button = element("button", "event-card");
    button.type = "button";
    button.setAttribute("aria-current", String(event.id === selectedEventId));
    button.setAttribute("aria-label", event.provider + " " + event.tool + " · " + event.summary);
    button.addEventListener("click", () => {
      selectedEventId = event.id;
      renderEvents();
      renderDetails();
    });

    const icon = element("span", "event-icon", event.status === "completed" ? "✓" : "!");
    if (event.status !== "completed") icon.classList.add("warning");
    const main = element("span", "event-main");
    const titleRow = element("span", "event-title-row");
    titleRow.append(
      element("span", "event-title", event.provider + " · " + event.tool),
      element("span", "event-status" + (event.status === "completed" ? "" : " warning"), event.status === "completed" ? "완료" : "건너뜀"),
    );
    main.append(titleRow, element("span", "event-summary", event.summary));
    button.append(icon, main);
    eventList.append(button);
  }
}

function renderDetails() {
  const event = getEvent(demoEvents, selectedEventId) ?? demoEvents[0];
  const heading = element("div", "detail-heading");
  const titleWrap = element("div");
  titleWrap.append(
    element("h3", "", event.provider + " · " + event.tool),
    element("p", "", "선택한 이벤트의 요청과 응답"),
  );
  const status = element("span", "status-badge" + (event.status === "completed" ? "" : " warning"), event.status === "completed" ? "완료" : "건너뜀");
  heading.append(titleWrap, status);

  const requestSection = element("section", "payload-section");
  const requestHeading = element("div", "payload-heading", "요청 / REQUEST");
  const requestPayload = element("pre", "payload request", event.request ?? "실행 요청 없음");
  if (!event.request) requestPayload.classList.add("payload-empty");
  requestSection.append(requestHeading, requestPayload);

  const responseSection = element("section", "payload-section");
  const responseHeading = element("div", "payload-heading");
  responseHeading.append(
    document.createTextNode("응답 / RESPONSE"),
    element("span", "payload-hint", event.response ? "도구 응답" : "실행하지 않음"),
  );
  const responseValue = event.response ? JSON.stringify(event.response, null, 2) : (event.note ?? "응답 없음");
  const responsePayload = element("pre", "payload", responseValue);
  if (!event.response) responsePayload.classList.add("payload-empty");
  responseSection.append(responseHeading, responsePayload);

  const footer = element("p", "detail-footer", event.note ?? "MCP 응답은 기록된 데모 데이터입니다. 실제 서버 요청은 실행하지 않습니다.");
  eventDetail.replaceChildren(heading, requestSection, responseSection, footer);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function openConnectionDialog() {
  formError.textContent = "";
  connectionDialog.showModal();
  document.querySelector("#connection-name").focus();
}

function updateTransportFields() {
  const isHttp = transportSelect.value === "streamable-http";
  commandField.classList.toggle("hidden", isHttp);
  urlField.classList.toggle("hidden", !isHttp);
  document.querySelector("#connection-command").required = !isHttp;
  document.querySelector("#connection-url").required = isHttp;
}

document.querySelector("#add-connection-button").addEventListener("click", openConnectionDialog);
document.querySelector("#add-connection-icon").addEventListener("click", openConnectionDialog);
document.querySelector("#close-dialog").addEventListener("click", () => connectionDialog.close());
document.querySelector("#cancel-dialog").addEventListener("click", () => connectionDialog.close());
transportSelect.addEventListener("change", updateTransportFields);
eventFilter.addEventListener("change", renderEvents);
document.querySelector("#show-all-events").addEventListener("click", () => {
  eventFilter.value = "all";
  renderEvents();
  showToast("모든 샘플 이벤트를 표시합니다.");
});

connectionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(connectionForm);
  const draft = {
    name: String(form.get("name") ?? ""),
    transport: String(form.get("transport") ?? "stdio"),
    command: String(form.get("command") ?? ""),
    url: String(form.get("url") ?? ""),
  };
  try {
    const connection = createDemoConnection(draft);
    if (connections.some((existing) => existing.name.toLowerCase() === connection.name.toLowerCase())) {
      throw new Error("같은 이름의 연결이 이미 있습니다.");
    }
    connections.push(connection);
    renderConnections();
    connectionForm.reset();
    updateTransportFields();
    connectionDialog.close();
    showToast("데모 목록에 추가했습니다. 실제 서버 연결은 수행하지 않았습니다.");
  } catch (error) {
    formError.textContent = error.message;
  }
});

document.querySelector("#export-button").addEventListener("click", () => {
  const content = JSON.stringify(createExportPayload(), null, 2);
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "loopline-mcp-demo-events.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("샘플 이벤트 기록을 JSON으로 내보냈습니다.");
});

renderConnections();
renderEvents();
renderDetails();
updateTransportFields();

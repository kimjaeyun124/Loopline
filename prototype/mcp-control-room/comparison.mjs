import { runContext, toolEvents, comparisonSummary } from "./qa-data.mjs";

const eventList = document.querySelector("#event-list");
const eventDetail = document.querySelector("#event-detail");
let selectedId = "paper-list";

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderEvents() {
  eventList.replaceChildren();
  for (const event of toolEvents) {
    const row = make("button", `event-row ${event.status === "blocked" ? "is-blocked" : ""}`);
    row.type = "button";
    row.setAttribute("aria-current", String(event.id === selectedId));
    row.setAttribute("aria-label", `${event.title} · ${event.status}`);
    const icon = make("span", "event-icon", event.status === "success" ? "✓" : event.status === "pending" ? "·" : "!");
    const copy = make("span", "event-copy");
    copy.append(make("strong", "", event.title), make("small", "", event.source));
    const status = make("span", "event-state", event.status === "success" ? "성공" : event.status === "pending" ? "확인" : "중단");
    row.append(icon, copy, status);
    row.addEventListener("click", () => { selectedId = event.id; renderEvents(); renderDetail(); });
    eventList.append(row);
  }
}

function renderDetail() {
  const event = toolEvents.find((item) => item.id === selectedId) || toolEvents[0];
  const heading = make("div", "detail-heading");
  const title = make("div");
  title.append(make("h3", "", event.title), make("p", "", event.source));
  const badge = make("span", `detail-badge ${event.status === "blocked" ? "blocked" : ""}`,
    event.status === "success" ? "호출 성공" : event.status === "pending" ? "별도 QA" : "호출 불가");
  heading.append(title, badge);

  const request = make("section", "payload-block");
  request.append(make("p", "payload-title", "요청 / REQUEST"), make("pre", "", JSON.stringify(event.request, null, 2)));
  const response = make("section", "payload-block");
  response.append(make("p", "payload-title", "응답 / RESPONSE"), make("pre", "", JSON.stringify(event.response, null, 2)));
  eventDetail.replaceChildren(heading, request, response, make("p", "detail-note", event.note));
}

function exportReport() {
  const report = {
    createdAt: runContext.date,
    scope: "Paper/Figma MCP connectivity from Loopline",
    findings: toolEvents.map(({ id, title, status, source, request, response, note }) => ({ id, title, status, source, request, response, note })),
    limitation: "Source test fixtures are not evidence of a live Paper or Figma Loopline call.",
  };
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  link.download = "loopline-mcp-connectivity-qa.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

const savings = comparisonSummary();
document.querySelector("#token-saving").textContent = `${savings.tokenSavingPercent}%`;
document.querySelector("#export-report").addEventListener("click", exportReport);
renderEvents();
renderDetail();

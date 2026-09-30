export const demoConnections = [
  {
    id: "paper",
    name: "Paper",
    kind: "디자인 MCP",
    status: "available",
    tools: ["list_files", "get_screenshot", "write_html"],
  },
  {
    id: "figma",
    name: "Figma",
    kind: "디자인 MCP",
    status: "unverified",
    note: "이 실행 환경에서는 Figma MCP 도구를 확인하지 못해 호출하지 않았습니다.",
  },
];

export const demoEvents = [
  {
    id: "paper-list-files",
    provider: "Paper",
    tool: "list_files",
    status: "completed",
    summary: "열려 있는 디자인 파일 2개를 찾았습니다.",
    request: "list_files({ limit: 30 })",
    response: { count: 2, activeFile: "Unique dolphin" },
  },
  {
    id: "paper-basic-info",
    provider: "Paper",
    tool: "get_basic_info",
    status: "completed",
    summary: "선택한 빈 캔버스에 아트보드가 없는 것을 확인했습니다.",
    request: "get_basic_info({ fileId: \"Unique dolphin\" })",
    response: { file: "Unique dolphin", page: "Page 1", artboardCount: 0 },
  },
  {
    id: "figma-tool-discovery",
    provider: "Figma",
    tool: "도구 확인",
    status: "skipped",
    summary: "이번 세션에서 Figma MCP 도구를 찾지 못했습니다.",
    request: null,
    response: null,
    note: "외부 요청은 보내지 않았습니다. Figma 연결 상태를 확인하려면 해당 MCP 도구가 이 세션에 제공되어야 합니다.",
  },
];

export function getEvent(events, id) {
  return events.find((event) => event.id === id) ?? null;
}

export function filterEvents(events, filter = "all") {
  if (filter === "all") return [...events];
  if (filter === "completed") return events.filter((event) => event.status === "completed");
  if (filter === "attention") return events.filter((event) => event.status !== "completed");
  return [];
}

export function validateConnectionDraft(draft) {
  if (!draft.name?.trim()) return "표시 이름을 입력해 주세요.";
  if (draft.transport !== "stdio" && draft.transport !== "streamable-http") return "지원하지 않는 연결 방식입니다.";
  if (draft.transport === "stdio" && !draft.command?.trim()) return "실행 명령을 입력해 주세요.";
  if (draft.transport === "streamable-http") {
    try {
      const url = new URL(draft.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "HTTP 또는 HTTPS 주소를 입력해 주세요.";
    } catch {
      return "올바른 서버 주소를 입력해 주세요.";
    }
  }
  return null;
}

export function createDemoConnection(draft, id = "demo-" + Date.now()) {
  const error = validateConnectionDraft(draft);
  if (error) throw new Error(error);
  return {
    id,
    name: draft.name.trim(),
    kind: draft.transport === "stdio" ? "로컬 명령 · 데모" : "Streamable HTTP · 데모",
    status: "demo-only",
    note: "데모 목록에만 저장했습니다. 실제 서버에는 연결하지 않았습니다.",
    command: draft.transport === "stdio" ? draft.command.trim() : undefined,
    url: draft.transport === "streamable-http" ? draft.url.trim() : undefined,
  };
}

export function createExportPayload(events = demoEvents, createdAt = new Date().toISOString()) {
  return {
    source: "Loopline MCP Control Room demo",
    createdAt,
    events: events.map((event) => ({
      id: event.id,
      provider: event.provider,
      tool: event.tool,
      status: event.status,
      request: event.request,
      response: event.response,
      note: event.note ?? null,
    })),
  };
}

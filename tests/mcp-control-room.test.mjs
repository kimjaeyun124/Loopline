import test from "node:test";
import assert from "node:assert/strict";
import {
  createDemoConnection,
  createExportPayload,
  demoEvents,
  filterEvents,
  getEvent,
  validateConnectionDraft,
} from "../prototype/mcp-control-room/state.mjs";

test("이벤트 선택은 실제 화면 상세에 대응하는 항목을 반환한다", () => {
  const event = getEvent(demoEvents, "paper-list-files");

  assert.equal(event.provider, "Paper");
  assert.equal(event.tool, "list_files");
  assert.deepEqual(event.response, { count: 2, activeFile: "Unique dolphin" });
  assert.equal(getEvent(demoEvents, "missing-event"), null);
});

test("이벤트 필터는 완료와 확인 필요 기록을 구분한다", () => {
  assert.equal(filterEvents(demoEvents, "all").length, 3);
  assert.deepEqual(filterEvents(demoEvents, "completed").map((event) => event.id), [
    "paper-list-files",
    "paper-basic-info",
  ]);
  assert.deepEqual(filterEvents(demoEvents, "attention").map((event) => event.id), [
    "figma-tool-discovery",
  ]);
  assert.deepEqual(filterEvents(demoEvents, "unknown"), []);
});

test("MCP 연결 입력은 이름, 전송 방식, 주소 또는 명령을 검증한다", () => {
  assert.equal(validateConnectionDraft({ name: "  ", transport: "stdio", command: "node server.mjs" }), "표시 이름을 입력해 주세요.");
  assert.equal(validateConnectionDraft({ name: "Local", transport: "stdio", command: " " }), "실행 명령을 입력해 주세요.");
  assert.equal(validateConnectionDraft({ name: "Remote", transport: "streamable-http", url: "not a URL" }), "올바른 서버 주소를 입력해 주세요.");
  assert.equal(validateConnectionDraft({ name: "Remote", transport: "streamable-http", url: "file:///tmp/mcp" }), "HTTP 또는 HTTPS 주소를 입력해 주세요.");
  assert.equal(validateConnectionDraft({ name: "Nope", transport: "other" }), "지원하지 않는 연결 방식입니다.");
  assert.equal(validateConnectionDraft({ name: "Remote", transport: "streamable-http", url: "https://mcp.example.test/mcp" }), null);
});

test("연결 추가는 외부 연결 대신 데모 목록 항목만 만든다", () => {
  const connection = createDemoConnection({
    name: "Local Files",
    transport: "stdio",
    command: "node ./server.mjs",
  }, "demo-test");

  assert.equal(connection.id, "demo-test");
  assert.equal(connection.status, "demo-only");
  assert.equal(connection.command, "node ./server.mjs");
  assert.match(connection.note, /실제 서버에는 연결하지 않았습니다/);
  assert.throws(() => createDemoConnection({ name: "Invalid", transport: "stdio" }), /실행 명령을 입력해 주세요/);
});

test("JSON 내보내기는 데모 출처와 이벤트 요청·응답만 포함한다", () => {
  const payload = createExportPayload(demoEvents, "2026-09-30T00:00:00.000Z");

  assert.equal(payload.source, "Loopline MCP Control Room demo");
  assert.equal(payload.createdAt, "2026-09-30T00:00:00.000Z");
  assert.equal(payload.events.length, 3);
  assert.equal(payload.events[2].request, null);
  assert.equal(payload.events[2].response, null);
  assert.equal(payload.events[2].note.includes("외부 요청은 보내지 않았습니다"), true);
});

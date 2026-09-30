export const runContext = {
  date: "2026-09-30",
  liveBackend: "http://127.0.0.1:41743",
  previewServer: "http://127.0.0.1:4173",
  priorBenchmark: {
    task: "오늘의 작업 · 오프라인 작업 목록 웹사이트",
    solo: {
      name: "GPT-6 Luna Max 단독",
      status: "3회차 뒤 자동 반영 안 됨",
      rounds: "3/3",
      calls: 11,
      elapsed: "16분 48초",
      tokens: 310443,
      internal: "4/4",
      browser: "13/14 수정 전 · 14/14 수동 보정 후",
      human: "파일 적용 및 app.js 보정 1회 · 약 2–5분",
    },
    loop: {
      name: "Loop Harness",
      status: "자동 완료 및 반영",
      rounds: "1/3",
      calls: 9,
      elapsed: "6분 26초",
      tokens: 200910,
      internal: "6/6",
      browser: "14/14 자동 반영 직후",
      human: "첫 Gemini 503 뒤 모델 변경·재실행 · 약 1–3분",
    },
  },
};

export const toolEvents = [
  {
    id: "paper-list",
    title: "Paper · list_files",
    status: "success",
    source: "Codex에 연결된 Paper MCP를 직접 호출",
    request: { limit: 10 },
    response: { count: 3, files: ["Quirky yacht", "Unique dolphin", "MCP Control Room"] },
    note: "실제 응답입니다. 이 호출은 Loopline 경유가 아닙니다.",
  },
  {
    id: "paper-info",
    title: "Paper · get_basic_info",
    status: "success",
    source: "Paper MCP에서 MCP Control Room 문서 조회",
    request: { file: "MCP Control Room" },
    response: { page: "Page 1", artboardCount: 1, artboard: "Desktop · MCP Control Room", dimensions: "1440 × 1000", nodes: 165 },
    note: "화면 문서 메타데이터를 실제로 읽었습니다.",
  },
  {
    id: "paper-shot",
    title: "Paper · get_screenshot",
    status: "success",
    source: "Paper 디자인 아트보드 렌더링",
    request: { file: "MCP Control Room", artboard: "Desktop · MCP Control Room", scale: 1 },
    response: { returned: "PNG image", review: "1440 × 1000 디자인 화면 확인 완료" },
    note: "Paper MCP가 디자인 화면을 반환하는 것까지 확인했습니다.",
  },
  {
    id: "loopline-paper",
    title: "Loopline 어댑터 · Paper stdio 연결",
    status: "blocked",
    source: "Loopline 소스의 MCP 연결 어댑터로 임시 연결 시도",
    request: { transport: "stdio", command: "paper", args: [] },
    response: { connected: false, error: "spawn paper ENOENT" },
    note: "현재 시스템 PATH에서 Codex 설정의 paper 실행 명령을 찾지 못했습니다.",
  },
  {
    id: "loopline-figma",
    title: "Loopline 어댑터 · Figma HTTP 연결",
    status: "blocked",
    source: "Loopline 소스의 Streamable HTTP 어댑터로 인증 없이 연결 확인",
    request: { transport: "Streamable HTTP", endpoint: "https://mcp.figma.com/mcp", authorization: "제공 안 함" },
    response: { connected: false, error: "HTTP 401 Unauthorized" },
    note: "Figma MCP의 OAuth 또는 사용자 토큰이 필요합니다. 인증값은 읽거나 복사하지 않았습니다.",
  },
  {
    id: "codex-figma-tools",
    title: "현재 Codex 세션 · Figma 도구 목록",
    status: "blocked",
    source: "현재 호출 가능한 MCP 도구 이름 점검",
    request: { filter: "figma" },
    response: { exposedToolCount: 0, configuredServerEntry: true },
    note: "Codex 설정에 Figma 서버 항목은 있지만 이 세션에는 Figma MCP 도구가 제공되지 않아 실제 Figma 도구 호출은 할 수 없습니다.",
  },
  {
    id: "live-app",
    title: "실행 중 Loopline 데스크톱 · MCP API",
    status: "blocked",
    source: "실행 중 앱의 로컬 백엔드 상태 확인",
    request: { method: "GET", path: "/api/mcp/servers", port: 41743 },
    response: { httpStatus: 404, mcpConnectionsFilePresent: false },
    note: "현재 실행 중인 패키지 앱은 이 저장소의 MCP 지원 소스보다 오래된 빌드입니다.",
  },
  {
    id: "source-qa",
    title: "Loopline 소스 · MCP 회귀 QA",
    status: "success",
    source: "로컬 stdio 및 원격 Streamable HTTP MCP 픽스처를 이용한 회귀 테스트",
    request: { testFile: "tests/mcp-connections.test.mjs", mode: "local-only fixtures" },
    response: {
      targetedTests: "9/9 passed",
      fullSuite: "91/91 passed",
      sequentialStdioLoad: { calls: 100, successes: 100, failures: 0, p50Ms: 0.06, p95Ms: 0.21, elapsedMs: 9.02 },
      externalApi: false,
    },
    note: "픽스처와 부하 검증은 Loopline 어댑터만 검사합니다. Paper/Figma 실연동 성공으로 계산하지 않습니다.",
  },
];

export function comparisonSummary() {
  const solo = runContext.priorBenchmark.solo;
  const loop = runContext.priorBenchmark.loop;
  return {
    tokenSavingPercent: Math.round((1 - loop.tokens / solo.tokens) * 1000) / 10,
    timeSavingPercent: Math.round((1 - (6 * 60 + 26) / (16 * 60 + 48)) * 1000) / 10,
  };
}

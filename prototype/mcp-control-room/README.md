# MCP Control Room Demo

Loopline MCP 연결·호출 기록을 확인하는 독립형 웹 데모입니다. Paper MCP로 만든 기준 화면과 같은 화면 구조를 사용합니다.

## 실행

프로젝트 루트에서 다음 명령으로 화면을 띄웁니다.

```sh
python3 -m http.server 4173 --directory prototype/mcp-control-room
```

브라우저에서 `http://127.0.0.1:4173/`을 엽니다.

## 화면에서 확인할 수 있는 것

- Paper와 Figma 연결 상태를 구분해 표시합니다.
- 이벤트를 선택하면 요청과 응답 상세가 바뀝니다.
- 이벤트 상태 필터와 JSON 내보내기를 사용할 수 있습니다.
- 연결 추가 폼은 데모 목록만 변경합니다. 서버 명령이나 원격 MCP 서버를 실행하지 않습니다.

## 테스트 범위와 제한

- 표본 이벤트와 Loop 단계는 화면 동작 확인용 데모 데이터입니다.
- Paper MCP 도구로 파일 목록과 빈 캔버스 정보를 실제 조회했습니다.
- 이 실행 환경에서는 Figma MCP 도구가 제공되지 않아 연결 상태와 실제 호출을 확인할 수 없었습니다.
- API 키, 명령 실행, 외부 네트워크 요청은 사용하지 않습니다.

Paper 기준 디자인: [MCP Control Room](https://app.paper.design/file/01M3R69Y5G0G25DGKZGDZVDBJ9/p-1-0)

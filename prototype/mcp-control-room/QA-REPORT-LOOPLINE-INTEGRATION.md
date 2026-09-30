# Loopline Paper·Figma MCP 연결 QA 보고서

검증일: 2026-09-30

## 요약

Codex에 연결된 Paper MCP는 실제 도구 세 가지(`list_files`, `get_basic_info`, `get_screenshot`)를 호출해 정상 응답을 확인했습니다. 그러나 같은 MCP 서버를 Loopline에서 호출하는 데에는 실패했습니다. Paper의 stdio 실행 파일 `paper`를 현재 Loopline 실행 환경에서 찾지 못했고, Figma 원격 MCP 주소는 인증 없이 연결을 시도했을 때 HTTP 401을 반환했습니다. Figma 도구 호출 자체는 인증을 통과하지 못해 실행되지 않았습니다.

현재 실행 중인 패키지 앱의 `GET /api/mcp/servers`도 HTTP 404를 반환했습니다. 저장된 Loopline MCP 연결은 없었습니다. 따라서 **현재 실행 중인 Loopline 앱에서 Paper 또는 Figma를 실제 호출할 수 있다는 증거는 없습니다.** 이 저장소의 최신 소스에는 MCP 서버 경로가 있으며, 로컬 테스트 픽스처를 이용한 일반 MCP 연결·도구 호출은 별도로 검증했습니다.

## 호출 결과

| 경로 | 확인 내용 | 결과 |
| --- | --- | --- |
| Codex → Paper MCP | 파일 목록, 아트보드 메타데이터, 화면 이미지 조회 | 3개 실제 읽기 호출 성공 |
| 현재 Codex 세션 → Figma MCP | 호출 가능한 도구 목록에서 Figma 도구 확인 | Figma 도구 0개; 실제 Figma MCP 도구 호출 불가 |
| Loopline 소스 MCP 어댑터 → Paper | Codex 설정과 같은 stdio 명령 `paper` 실행 | `spawn paper ENOENT`; 실행 파일을 찾지 못함 |
| Loopline 소스 MCP 어댑터 → Figma | `https://mcp.figma.com/mcp`에 인증값 없이 원격 접속 | HTTP 401 Unauthorized |
| 실행 중 Loopline 패키지 앱 | `GET /api/mcp/servers` 및 저장된 연결 목록 확인 | HTTP 404, 연결 0개 |
| Loopline 소스 회귀 테스트 | 로컬 stdio 및 Streamable HTTP 픽스처 | 별도 자동 회귀 검사에서 결과 기록 |

Paper MCP 도구가 Codex에서 작동하는 것과 Loopline이 그 Codex 연결을 공유하는 것은 다른 연결 경로입니다. Loopline 소스는 두 기본 전송 방식을 구현했지만, 실행 명령과 인증 수단이 현재 환경에 전달돼 있지 않습니다. Loopline의 원격 HTTP 연결은 정적 Bearer 토큰 방식만 구성할 수 있어 Codex의 Figma OAuth 세션을 그대로 재사용하지 못합니다.

## 앱 상태

- 현재 데스크톱 앱은 저장소의 MCP 연결 UI/API가 들어간 최신 소스와 다른 패키지 빌드입니다. 실제 앱 포트 `41743`의 MCP 경로가 404였습니다.
- 브라우저의 `http://127.0.0.1:4173/`은 Loopline API가 아니라 MCP Control Room을 보여주는 Python 정적 미리보기입니다.
- 사용자 데이터 폴더에서 Loopline MCP 연결 설정 파일은 발견되지 않았습니다.
- 사용자의 Codex 설정에 `paper`(stdio)와 `figma`(원격 HTTP) 항목 이름이 있는 것은 확인했지만, 인증 정보는 출력·복사·전송하지 않았습니다.
- Codex 설정에 Figma 항목이 존재하는 사실은 확인했으나, 현재 사용할 수 있는 도구 목록에는 Figma MCP 호출 도구가 없어 Codex 경로의 Figma 요청은 보내지 않았습니다.

## 자동 테스트 및 부하 검증

- MCP 연결과 Control Room 단위·통합 테스트: 9/9 통과.
- 전체 Loopline 테스트: `node --test tests/*.test.mjs` — 91/91 통과.
- 로컬 stdio MCP 픽스처에 `get_status`를 순차 호출: 100회 성공, 실패 0회. p50 0.06ms, p95 0.21ms, 전체 9.02ms(약 11,081회/초).
- 부하 수치는 같은 프로세스의 로컬 픽스처 결과입니다. 인터넷 왕복 시간, Paper/Figma 서버 처리량, 모델 토큰·비용을 나타내지 않습니다.
- MCP 연결 QA에서 실행한 외부 실서비스 요청은 Paper의 읽기 전용 도구 3개와 Figma 무인증 연결 1회입니다. 인증 토큰과 모델 API 키는 전달하지 않았습니다.

## 화면 비교: 기존 동일 웹 과제

다음 웹사이트 비교는 과거 `오늘의 작업` 제작 과제의 1회 실행 결과입니다. Paper/Figma MCP를 사용한 결과가 아니며, 이번 MCP 연결 QA의 성공률로 합치지 않습니다.

| 지표 | GPT-6 Luna Max 단독 | Loop Harness |
| --- | ---: | ---: |
| 역할별 모델 | 계획·구현·판정 모두 Luna Max | Luna Max 계획 · Sol 구현 · Jev 판정 |
| 자동 반영 | 3회차 뒤 미반영 | 1회차 자동 완료 및 반영 |
| 실행 시간 | 16분 48초 | 6분 26초 |
| 보고 토큰 | 310,443 | 200,910 |
| 모델 호출 | 11회 | 9회 |
| 독립 브라우저 검사 | 수정 전 13/14, 수동 보정 뒤 14/14 | 자동 반영 직후 14/14 |
| 사람의 코드 수정 | 1회, 약 2–5분 | 0회; 첫 Gemini 503 뒤 재실행 조치 약 1–3분 |

이 표본에서는 Loop가 보고 토큰을 35.3%, 실행 시간을 61.7% 줄였습니다. 한 과제씩의 측정이라 일반적인 성공률로 단정할 수 없으며, 실행별 달러 비용도 확인할 수 없어 산출하지 않았습니다.

웹사이트 스크린샷은 대시보드의 “같은 웹 과제의 산출물 비교” 섹션에서 나란히 확인할 수 있습니다.

## 다음 단계

1. 사용 중인 앱을 최신 소스로 패키징하고 재실행해 MCP API를 활성화합니다.
2. Paper는 Loopline 실행 환경에 MCP 명령을 제공하거나 인증된 원격 MCP 연결을 등록한 뒤 실제 도구를 다시 호출합니다.
3. Figma는 OAuth 로그인 흐름이 Loopline에 추가된 뒤 사용자 세션으로 연결을 검증합니다.
4. 두 서버의 연결이 확인되면 같은 화면 생성 프롬프트와 독립 검증으로 단독 Harness 및 Loop 산출물을 다시 비교합니다.

## 보안 및 한계

- Figma 호출에는 토큰 없이 연결만 시도했습니다. 인증 정보를 읽거나 복사하지 않았습니다.
- Paper·Figma 연결 시험은 임시 설정을 사용하고 종료 후 삭제했습니다.
- 이번 MCP 연결 QA에서 실제 모델로 웹사이트를 생성하지 않았습니다. 스크린샷과 성능표는 명시된 이전 웹 제작 벤치마크 자료입니다.
- 인증·OAuth를 새로 구현하거나 현재 데스크톱 앱을 재시작하지 않았습니다.

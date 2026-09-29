# 실제 모델 토큰·성능 비교 — 2026-09-30

같은 Task Ledger CLI를 새 작업 폴더에서 GPT-6 Luna Max 단독과 Loop로 각각 1회 제작했다. 두 결과 모두 공통 독립 테스트 12개를 통과했다. Loop는 1회차에 검증·Jev 판정·자동 반영까지 마쳤으며, 보고된 총토큰이 80.9%, 전체 완료 시간이 83.8% 적었다. 다만 검증 과정에서 생성한 데이터 파일이 최종 산출물에 포함돼 정리 기준은 보완이 필요하다.

## 비교 결과

| 항목 | GPT-6 Luna Max 단독 | Loop |
| --- | ---: | ---: |
| 완료 시간 | 14분 23.605초 | 2분 20.001초 |
| 제공자가 보고한 총토큰 | 510,617 | 97,654 |
| 공통 독립 검증 | 12/12 PASS | 12/12 PASS |
| 모델 자체 테스트 재실행 | 13/13 PASS | 5/5 PASS |
| 자동 완료 | 완료 | 1/3회차 완료·자동 반영 |
| 사람이 코드 수정 | 없음 | 없음 |
| 최종 산출물 정리 | 검증용 기본 DB 없음 | 검증용 기본 DB 1개 포함 — FAIL |

완료 시간은 요청 시작부터 최종 완료 응답까지다. 별도로 실행한 독립 검증과 성능 측정 시간은 포함하지 않는다. 이번 표의 두 값은 모두 새로 측정한 것이며 과거 보고서 수치를 재사용하지 않았다. 생성 속도는 약 6.17배 차이였지만, 생성된 CLI 자체의 실행 속도 차이는 작았다.

## 실험 조건

- 시험 코드: Loopline 커밋 `be48cd8`. 패키지의 서버·Harness·API 연결·설정 UI 파일이 소스와 일치하는지 확인했다.
- 과제: Node.js 20+ 이상, 외부 의존성 없는 Task Ledger CLI. 추가·목록·완료·삭제·검색, JSON 입출력, 종료 코드, 손상 데이터 보존, 원자적 저장, 오프라인 테스트와 README.
- 시작 상태: 비어 있는 별도 Git 저장소 2개. 두 방식에 같은 과제 텍스트를 전달했다.
- 순서: 단독 실행 후 Loop를 순차 실행. 모델 실행은 서로 겹치지 않았다.
- 단독: Codex CLI 0.155.1, `gpt-6-luna`, effort `max`, 기본 서비스 등급, 임시 세션. 모델이 직접 파일 작성·명령 실행·자체 검증을 수행했다.
- Loop: 계획 `models/gemini-3-flash-preview`, 구현 `gpt-6-sol / high`, 판정 `jev-latest` → 응답 모델 `jev-1.13.0`. Harness가 파일 작업과 검증 명령을 실행했다.
- 대체 순서: 계획 Gemini → Luna high → Sol medium, 구현 Sol high → Luna max, 판정 Jev → Luna high → Sol high. 이 순서를 실행 입력에 저장했다. 이번 실제 호출에서는 한도가 소진되지 않아 대체 모델 전환은 발생하지 않았다.
- Loop 최대 3회차, 검증 명령 자동 구성, 판정 통과 시 자동 반영.
- 실행 환경: v26.8.2, darwin/arm64, Apple M5. 별도 패키지 다운로드 없이 생성된 프로젝트를 검증했다.
- 과제 SHA-256: `17b580d549bba8cdf5a012f08db6e95dcc7b060ee331f450f45ffe6d081326d9`
- 공통 테스트 SHA-256: `4704632edd0cfbd91ce7c17e93fc4666f4d13a4017c3f94f98517ef456ca0f67`

이는 일반적인 두 작업 방식의 비교다. 서로 다른 모델과 도구 실행 방식이 함께 바뀌었으므로 절감 효과를 Loop 구조 하나만의 효과로 분리하지 않았다. 1개 과제·각 1회 결과이므로 대형 프로젝트나 반복 실행 전체로 일반화할 수 없다.

## 모델별 토큰

| 모델·역할 | 완료 호출 | 총토큰 | 입력 | 출력 | 확인된 캐시 입력 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 단독 Luna Max | 단독 실행 1회 | 510,617 | 488,432 | 22,185 | 443,904 |
| Loop Gemini · 계획/검증 방법 제안 | 2 | 8,143 | 6,212 | 798 | 미제공 |
| Loop Sol high · 구현 | 3 | 77,816 | 72,312 | 5,504 | 33,152 |
| Loop Jev · 검증 방법/완료 판정 | 2 | 11,695 | 11,575 | 120 | 미제공 |
| Loop 합계 | 7 | 97,654 | 90,099 | 6,422 | 33,152 + 미제공 부분 |

- 단독 토큰은 CLI의 최종 `turn.completed.usage`, Loop 토큰은 실행별 사용량과 해당 실행 중 기록된 7개 제공자 사용량 기록을 대조했다. 7개 모두 총토큰이 제공됐고 합계가 일치했다.
- 단독의 캐시 입력은 입력 토큰의 부분집합이므로 총토큰에 다시 더하지 않았다. 단독의 캐시 제외 입력은 44,528이다. Loop Sol의 캐시 제외 입력은 39,160이며, Gemini·Jev의 캐시 여부는 공개되지 않았다.
- Gemini의 보고 총토큰은 공개 입력+출력보다 1,133 크다. 이 차이는 제공자가 집계한 추가 토큰으로 보존했으며, 확인되지 않은 세부 분류를 추정하지 않았다.
- Codex 원시 사용량을 관찰할 수 있었던 구현 호출 2개의 누적값은 앱 집계값과 각각 일치했고, 해당 호출에는 네이티브 도구 호출이 없었다. 첫 구현 호출은 앱이 전달받은 사용량 기록을 사용했다.
- 서로 다른 모델의 토크나이저·캐시 정책·가격이 있으므로 총토큰 감소율을 금액 절감률로 해석하지 않는다. **실행별 실제 과금액과 달러 비용은 NOT_RUN(확인 가능한 과금 자료 없음)**이다.
- Codex는 이번 Loop에서 남은 계정 한도 28%→27%를 보고했다. Gemini·Jev는 잔여 토큰을 제공하지 않았다. 계정 잔여 비율에는 같은 계정의 다른 작업이 포함될 수 있어 이 차이를 실행별 비용으로 환산하지 않았다.

## 독립 품질 검증

공통 테스트는 모델에 공개하지 않고 완성된 각 CLI를 새 프로세스로 실행했다. 두 프로젝트 모두 아래 12개 항목을 통과했다.

1. 제목 trim, 유효한 필드, 프로세스 사이 영속성 및 중첩 경로 생성.
2. all/open/done 필터와 생성 순서.
3. 완료 처리 반복 실행과 timestamp.
4. 대소문자를 구분하지 않는 검색.
5. 삭제와 없는 ID의 종료 코드 3.
6. 기본 잘못된 입력의 종료 코드 2 및 오류 출력.
7. 깨진 JSON의 종료 코드 1 및 원본 바이트 보존.
8. 한국어·쉘 메타문자 제목의 문자 그대로 저장.
9. 여러 인자로 전달한 제목과 검색어 결합.
10. 누락·잘못된·초과 인자 거부 및 기존 데이터 보존.
11. JSON 루트와 task 형식이 잘못된 저장 파일 거부.
12. 현재 디렉터리 기본 저장 경로.

추가 산출물 확인에서 Loop는 `.task-ledger.json`에 `Final verification task` 1건을 포함했다. 계획 모델이 검증 명령을 다음과 같이 제안했고 Jev가 승인했기 때문이다.

`npm test && node src/cli.mjs add "Final verification task" && node src/cli.mjs list`

이 명령이 작업 폴더의 기본 DB를 만들었고, 최종 패치에도 해당 파일이 들어갔다. 해당 증거를 유지했으며 사람이 삭제하거나 고친 결과를 자동 성공으로 집계하지 않았다. 검증 명령에는 임시 TASKS_FILE 경로를 쓰고, 검증 과정에서 생긴 파일을 반영 전에 확인하는 기준이 다음 개선 우선순위다. 이는 공통 기능 검사 12개와 별도로 발견한 산출물 정리 문제다.

Jev 최종 판정은 목표 충족 pass 88%, 검증 충족 pass 98%였다. 이 수치는 모델이 반환한 신뢰도이며 정확도의 실측 확률로 해석하지 않는다. 이번 정리 문제는 판정 기준을 구체화할 필요가 있음을 보여준다.

## 생성된 프로그램 실행 속도

1,000개 task를 가진 같은 형식의 DB에서 명령별 워밍업 3회 후 20회를 측정했다. 매 실행 전 DB를 초기화했고 Node.js 프로세스 시작 시간이 포함된다. 값은 중앙값 / p95, 단위는 ms다.

| 명령 | 단독 산출물 | Loop 산출물 |
| --- | ---: | ---: |
| list all | 56.99 / 65.93 | 57.36 / 70.52 |
| search task 99 | 57.61 / 67.93 | 53.70 / 58.14 |
| add | 62.63 / 65.82 | 61.11 / 65.77 |

두 산출물 모두 명령당 중앙값 약 54~63ms 범위였다. 이 소규모 측정에서 프로그램 실행 속도의 큰 우위는 확인되지 않았다. 확인된 이득은 제작 과정의 시간·보고 토큰 감소다.

## 증거와 재현

- [실시간/완료 측정 화면](http://127.0.0.1:41844)
- [실험 조건](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/priority-benchmark-20260930/experiment.json)
- [측정 요약 JSON](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/priority-benchmark-20260930/summary.json)
- [동일 과제](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/priority-benchmark-20260930/prompt.txt)
- [공통 독립 테스트](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/priority-benchmark-20260930/acceptance.test.mjs)
- [실행·성능 평가 스크립트](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/priority-benchmark-20260930/evaluate.mjs)
- [단독 원시 실행 기록](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/priority-benchmark-20260930/solo-events.jsonl)
- [Loop 전체 단계](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/priority-benchmark-20260930/loop-run.json)
- [Loop 단계별 요청 내용](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/priority-benchmark-20260930/loop-prompts.json)
- [Loop 제공자별 사용량](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/priority-benchmark-20260930/loop-usage-records.json)
- [Loop 최종 패치](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/priority-benchmark-20260930/loop-final.patch)
- [독립 검증·성능 원시 결과](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/priority-benchmark-20260930/evaluation.json)

Loop 실행 ID: `9df7a002-229c-4a6a-9161-1f94215875aa`.

프로젝트 경로는 각각 `/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/priority-benchmark-20260930/solo`, `/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/priority-benchmark-20260930/loop`다. 재검증은 해당 경로에서 `node --test`와 `TASK_LEDGER_PROJECT=<프로젝트 경로> node --test <공통 독립 테스트 경로>`로 수행할 수 있다.

이번 평가는 제품 로직을 수정하지 않은 검증 단계다. 실제 한도 소진에 따른 전환은 이번 원격 실행에서 발생하지 않았으며, 이전 커밋의 로컬 회귀 테스트 결과와 구분한다.

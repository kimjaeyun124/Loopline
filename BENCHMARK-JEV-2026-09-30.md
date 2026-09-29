# Jev 자동 모델 배정 Loop와 GPT 단독 재비교 — 2026-09-30

## 요약

동일한 Task Ledger CLI를 새 작업 폴더에서 두 방식으로 다시 제작했다. GPT-6 Luna Max 단독은 12분 39.411초·417,407토큰, Jev 자동 배정 Loop는 2분 50.010초·100,278토큰이었다. 공통 독립 기능 검사 12개는 양쪽 모두 통과했고, 사람이 생성 코드를 수정하지 않았다.

이번 단일 실행에서 Loop의 보고 토큰은 76.0%, 제작 시간은 77.6% 적었다. Loop는 1/3회차에 검증·판정·자동 반영까지 완료했다. Jev는 계획·구현 후보를 평가했으나 두 역할 모두 `keep`을 선택했다. 따라서 Loop 전체의 이점은 관찰했지만, Jev 배정이 추가 품질·효율 향상을 만들었다고 결론 내릴 수는 없다.

## 비교 조건

- 제품 소스: `27bc9b8`(문구 간소화 포함), Jev 배정 구현 `98b5ef4`. 실행 패키지의 Harness 코드와 저장소 코드가 같은지 확인했다.
- 새 빈 Git 저장소 두 개에 동일한 과제를 전달했다. 독립 검사 파일은 모델에 전달하지 않았다.
- 단독: `gpt-6-luna`, reasoning effort `max`, Codex CLI 임시 세션, 기본 서비스 등급, `workspace-write` 실행 환경.
- Loop: 역할별 자동 배정을 켜고, 최대 3회차·검증 자동 구성·판정 통과 시 자동 반영.
- 계획 후보: Gemini 3 Flash Preview → Luna high → Sol medium. 구현 후보: Sol high → Luna max. 판정: Jev latest, 대체 순서 Luna high → Sol high. 이전 비교와 후보를 동일하게 유지했다. 이번 시험은 앱에 연결된 모든 모델 간 탐색 실험이 아니다.
- Jev의 한 번의 모델 배정 요청도 Loop 시간·토큰에 포함했다. 자동 역할의 최종 선택은 Gemini 계획·Sol high 구현이었으며, 판정 응답의 실제 모델은 `jev-1.13.0`이었다.
- 단독 → Loop 순서로 실행했다. 각 실행의 제한 시간은 20분이었고 양쪽 모두 제한 시간 전에 완료했다.
- 환경: macOS arm64, Node.js v26.8.2. 외부 패키지 다운로드 없이 제작·검증했다.
- 이번 시작 시 Codex 계정 잔여 한도는 11%, Loop 실행 기록의 마지막 값은 5%였다. 계정 전체 사용량이므로 이 차이를 실행별 비용으로 환산하지 않는다. 실제 한도 소진이나 대체 모델 전환은 발생하지 않았다.
- 과제와 공통 테스트 SHA-256은 이전 보고서와 같다. 정확한 값은 `experiment.json`에 보관했다.

## 결과

| 항목 | GPT-6 Luna Max 단독 | Jev 자동 배정 Loop |
| --- | ---: | ---: |
| 제작 완료 시간 | 12분 39.411초 | 2분 50.010초 |
| 보고 총토큰 | 417,407 | 100,278 |
| 공통 독립 검사 | 12/12 PASS | 12/12 PASS |
| 자체 테스트 재실행 | 8/8 PASS | 4/4 PASS |
| 자동 완료 | 구현·테스트·최종 응답 완료 | 1회차 검증·판정·자동 반영 완료 |
| 수동 코드 수정 | 없음 | 없음 |
| 검증용 기본 DB 잔존 | 없음 | 없음 |

자체 테스트 수는 구현마다 달라 비교 점수로 삼지 않는다. 공통 독립 검사는 추가·영속성·필터·완료·검색·삭제·종료 코드·손상 파일 보존·한국어/메타문자·여러 인자·잘못된 저장 구조·기본 저장 경로를 같은 조건으로 검사했다. 추가 독립 검사와 아래 실행 속도 측정 시간은 제작 완료 시간에 포함하지 않았다.

단독 모델은 구현 후 Git 커밋을 시도했으나 실행 환경이 `.git/index` 쓰기를 차단했다. 모델은 이를 보고하고 자체 테스트까지 완료했다. 이 시도와 검토 시간도 단독 제작 시간에 포함된다. Loop는 앱이 파일 작업·검증·반영을 수행하므로 실행 방식이 동일하지 않다. 모델 성능만 분리해 평가한 결과는 아니다.

Loop의 이번 검증 명령은 `npm test`였다. 이전 시험에서는 추가 CLI 검증이 기본 DB를 만들어 산출물에 포함됐지만 이번에는 그 파일이 없었다. 해당 제품 결함을 수정한 시험은 아니므로 재발 방지가 검증됐다는 의미는 아니다.

## Jev 모델 배정의 실제 결과

- 계획: `keep` → Gemini 3 Flash Preview 유지.
- 구현: `keep` → GPT-6 Sol high 유지.
- 이유 기록: 두 역할 모두 “근거 부족으로 기본 후보 유지”.
- 배정 호출: **1,826토큰**, 입력 1,734·출력 92.
- 배정 이벤트 시작부터 첫 배정 결과 기록까지: **452ms**. API 내부 지연만 따로 측정한 값은 아니다.
- 전체 Loop 토큰의 약 **1.82%**가 배정 호출에 사용됐다.
- 후보 목록 밖 선택, 실제 한도 소진 전환은 이번 실험에서 발생하지 않았다.

Jev에 주어진 근거에는 이전 Task Ledger 비교 1회의 결과와 후보별 잔여 한도가 포함됐다. 따라서 완전히 새로운 미공개 과제에서의 일반화 시험은 아니다. 다음 단계에서는 다른 난이도의 여러 과제에서 고정 조합 대비 모델 변경 빈도·정확도·총비용을 반복 측정해야 추가 효과를 판단할 수 있다.

## 모델별 토큰

| 모델 | 호출 | 총토큰 | 입력 | 출력 | 캐시 입력 |
| --- | ---: | ---: | ---: | ---: | ---: |
| jev-1.13.0 | 3 | 12,513 | 12,301 | 212 | 미제공 |
| models/gemini-3-flash-preview | 2 | 9,714 | 5,962 | 742 | 미제공 |
| gpt-6-sol | 3 | 78,051 | 71,962 | 6,089 | 33,920 |

단독은 입력 393,394·출력 24,013·캐시 입력 350,208이었다. 캐시 입력은 입력의 부분집합이며 총토큰에 다시 더하지 않았다. 단독의 캐시 제외 입력은 43,186이고, Loop Sol의 캐시 제외 입력은 38,042이다. Gemini·Jev의 캐시 여부는 제공되지 않았다.

Loop 사용량 기록 8개는 모두 토큰 수가 제공됐고, 합계가 실행의 모델별 사용량 100,278과 일치했다. Gemini는 공개 입력+출력보다 총토큰이 3,010 높다. 확인되지 않은 분류를 추정하지 않고 제공자 집계를 유지했다. 모델마다 토크나이저·캐시·과금 정책이 달라 **76.0%는 달러 비용 절감률이 아니다. 실제 실행별 과금액은 NOT_RUN(자료 미제공)**이다.

## 생성된 CLI의 실행 속도

같은 형식의 1,000개 데이터, 명령별 워밍업 3회 후 20회 측정. Node.js 프로세스 시작 포함. 단위 ms, 중앙값 / p95.

| 명령 | 단독 산출물 | Loop 산출물 |
| --- | ---: | ---: |
| list | 51.57 / 64.06 | 59.58 / 67.94 |
| search | 51.95 / 54.58 | 56.57 / 60.75 |
| add | 60.13 / 63.72 | 55.52 / 63.74 |

Loop는 목록·검색에서는 느렸고 추가에서는 빨랐다. 모두 대략 52~60ms의 중앙값이므로 생성 프로그램의 일관된 속도 우위는 확인되지 않았다. 관찰된 주요 이점은 제작 시간과 보고 토큰이다.

## 이전 고정 조합 Loop와 비교

| 항목 | 이전 고정 조합 | 이번 Jev 자동 배정 |
| --- | ---: | ---: |
| 제작 시간 | 140.001초 | 170.010초 |
| 보고 총토큰 | 97,654 | 100,278 |
| 모델 호출 | 7 | 8 |
| 공통 검사 | 12/12 | 12/12 |

이번 Loop는 이전보다 약 30초(21.4%), 2,624토큰(2.7%) 더 사용했다. 이 중 배정 호출은 1,826토큰·약 0.45초였다. 전체 차이를 배정 호출만의 영향으로 해석할 수 없다. 생성 응답·추론량·서비스 지연도 달라졌다. **현재 증거로는 Jev 배정의 추가 성능 이득은 미확인**이며, 작은 추가 비용으로 후보 선택 판단을 한 번 수행한 상태다.

## 재현 자료

- [완료 화면](http://127.0.0.1:41846/)
- [실험 조건](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/jev-routing-benchmark-20260930/experiment.json)
- [측정 요약](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/jev-routing-benchmark-20260930/summary.json)
- [원본 과제](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/jev-routing-benchmark-20260930/prompt.txt)
- [실행 스크립트](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/jev-routing-benchmark-20260930/benchmark.mjs)
- [공통 검사](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/jev-routing-benchmark-20260930/acceptance.test.mjs)
- [독립 검증·실행 속도 측정](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/jev-routing-benchmark-20260930/evaluate.mjs)
- [원시 평가 결과](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/jev-routing-benchmark-20260930/evaluation.json)
- [단독 토큰·시간](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/jev-routing-benchmark-20260930/solo-metrics.json)
- [단독 실행 기록](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/jev-routing-benchmark-20260930/solo-events.jsonl)
- [Loop 실행 기록](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/jev-routing-benchmark-20260930/loop-run.json)
- [Loop 실제 요청](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/jev-routing-benchmark-20260930/loop-prompts.json)
- [제공자 사용량 기록](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/jev-routing-benchmark-20260930/loop-usage-records.json)
- [최종 변경 패치](/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/jev-routing-benchmark-20260930/loop-final.patch)

Loop 실행 ID: `9063ba00-8721-4cd0-bee0-e42602d319f3`.

이번 작업은 측정·평가이며 제품 코드는 변경하지 않았다. 두 산출물은 `/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/jev-routing-benchmark-20260930/solo`, `/Users/dgsw59/Documents/Codex/2026-09-26/sj/outputs/harness-qa/jev-routing-benchmark-20260930/loop`에 원형 그대로 보관했다.

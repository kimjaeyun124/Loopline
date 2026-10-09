import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const readJson = async (path, fallback = null) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } };
const defaultResults = await readJson(join(here, 'results.json'));
const expandedResults = await readJson(join(here, '../loop-improvements-expanded-2026-10-09/results.json'));
const expandedComplete = Boolean(expandedResults?.trials[0]?.finishedAt);
const results = expandedComplete ? expandedResults : defaultResults;
const dataFolder = expandedComplete ? 'loop-improvements-expanded-2026-10-09' : 'loop-improvements-2026-10-09';
const dataPath = expandedComplete ? join(here, '../loop-improvements-expanded-2026-10-09') : here;
const baseline = await readJson(join(here, '../live-comparison-2026-10-09/results.json'));
const validation = await readJson(join(here, 'validation.json'), { status: '검증 진행 중' });
const internal = await readJson(join(dataPath, 'generated-project-tests.json'), []);
const run = await readJson(join(dataPath, 'automatic-loop-run.json'), {});
const postReadme = await readJson(join(dataPath, 'post-benchmark-readme-qa.json'));
const current = results.trials[0];
const before = baseline.trials.find(t => t.configuration === 'automatic-loop');
const esc = value => String(value ?? '미확인').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = value => Number.isFinite(value) ? value.toLocaleString('ko-KR') : '미확인';
const time = ms => Number.isFinite(ms) ? `${Math.floor(ms / 60000)}분 ${(ms % 60000 / 1000).toFixed(1)}초` : '미확인';
const success = t => t.status === 'completed' && t.applied;
const outcome = t => success(t) ? '완료 · 자동 반영 1/1' : t.finishedAt ? `${({limit:'한도 도달',failed:'실패',stopped:'중지',interrupted:'중단'})[t.status] || esc(t.status)} · 자동 반영 0/1` : '실행 중';
const qa = t => t.independentQa?.unavailable ? '미실행 · 화면 미생성' : t.independentQa ? `${n(t.independentQa.passedCheckCount)}/${n(t.independentQa.expectedCheckCount ?? 50)}` : '아직 미실행';
const delta = (a, b) => Number.isFinite(a) && Number.isFinite(b) && b > 0 ? `${(Math.abs(a / b - 1) * 100).toFixed(1)}% ${a < b ? '감소' : '증가'}` : '미확인';
const tokens = t => `${t.missingUsageCalls ? '최소 ' : ''}${n(t.reportedTokens)}`;
const done = Boolean(current.finishedAt);
const calls = current.modelCalls || [];
const attemptedTrials = [...defaultResults.trials, ...(expandedResults?.trials || [])];
const finishedTrials = attemptedTrials.filter(t => t.finishedAt);
const attemptTotals = {
  elapsedMs: finishedTrials.reduce((sum, t) => sum + t.elapsedMs, 0),
  tokens: finishedTrials.reduce((sum, t) => sum + t.reportedTokens, 0),
  missingUsageCalls: finishedTrials.reduce((sum, t) => sum + t.missingUsageCalls, 0),
};
const rows = [
  ['자동 완료·반영', outcome(before), outcome(current)],
  ['전체 실행 시간', time(before.elapsedMs), time(current.elapsedMs)],
  ['보고 토큰', tokens(before), tokens(current)],
  ['실제 모델 호출', n(before.modelCalls?.length), n(calls.length)],
  ['사용량 미보고 호출', n(before.missingUsageCalls), n(current.missingUsageCalls)],
  ['부분 작업 완료', `${before.milestones?.filter(m=>m.status==='completed').length || 0}/${before.milestones?.length || 0}`, `${current.milestones?.filter(m=>m.status==='completed').length || 0}/${current.milestones?.length || 0}`],
  ['자체 브라우저 QA', before.browserQaPassed ? '통과' : '미통과/미도달', current.browserQaPassed ? '통과' : '미통과/미도달'],
  ['동일 외부 브라우저 QA', qa(before), qa(current)],
  ['수동 코드 수정 / 수동 이어가기', '0회 / 0회', `${current.manualCodeEdits ?? 0}회 / ${current.manualResumes ?? 0}회`],
  ['관찰 한도에 의한 중지 요청', before.observationStop ? '1회' : '0회', current.observationStop ? '1회' : '0회'],
  ['첫 구현 전 준비 토큰', '384,401', n(run.preparationReportedTokens)],
  ['첫 구현까지 경과 시간', '약 16분 40초', run.firstWorkerAt ? time(run.firstWorkerAt - run.createdAt) : '구현 미도달'],
];
const groups = new Map();
for (const c of calls) {
  const key = `${c.role} · ${c.model} · ${c.effort}`;
  const g = groups.get(key) || { count: 0, tokens: 0, input: 0, output: 0, cache: 0, detailCount: 0, cacheCount: 0, missing: 0, ms: 0, first: [], fallback: 0 };
  g.count++; g.tokens += c.tokens || 0; g.ms += c.durationMs || 0;
  g.missing += Number.isFinite(c.tokens) ? 0 : 1;
  if (Number.isFinite(c.inputTokens) && Number.isFinite(c.outputTokens)) { g.detailCount++; g.input += c.inputTokens; g.output += c.outputTokens; }
  if (Number.isFinite(c.cachedInputTokens)) { g.cache += c.cachedInputTokens; g.cacheCount++; }
  if (Number.isFinite(c.firstResponseMs)) g.first.push(c.firstResponseMs);
  g.fallback += c.schemaFallback ? 1 : 0; groups.set(key, g);
}
const changes = [
  ['P0', '초기·보완 QA 계약 통일', 'notApplicable의 허용 키·값·기존 검사와의 모순을 같은 함수로 검증합니다. 손상 저장 데이터 등 실행기에서 만들 수 없는 상태는 Node 검증 책임으로 안내합니다.', 'browser-qa.mjs'],
  ['P0', '부분 완료와 최종 통합 기준 연결', '실제 Chromium·README·통합 결과를 요구하는 조건은 integrationCriteria로 보존하고 최종 단계에서 검사합니다. 중간 UI 작업이 아직 실행할 수 없는 최종 증거를 기다리는 충돌을 막습니다.', 'harness-milestones.mjs · harness-engine.mjs'],
  ['P0', 'QA 모의 결과 정상화', '기존 실패 9개의 fixture에 실제 viewport·check·layout 근거를 채웠습니다. 불완전한 증거를 거부하는 제품 검사는 유지합니다.', 'tests/harness-milestones.test.mjs'],
  ['P1', '변경 사례와 누락 질문만 재판정', '검사 및 앞선 상태의 지문이 같으면 통과한 개별 판정을 보존합니다. 변경 사례·영향받은 후속 사례·전체 요구사항 범위는 다시 검토합니다.', 'harness-engine.mjs'],
  ['P1', '제공자에 구조화된 응답 계약 전달', 'Codex outputSchema와 호환 API의 JSON schema를 연결했습니다. 명시적으로 지원하지 않는 매개변수만 제한적으로 제외해 재시도합니다. MCP 도구 프로토콜과 Jev native 판정은 기존 경로를 유지합니다.', 'harness-response-schemas.mjs · api-connections.mjs · server.mjs'],
  ['P1', '준비·전체 실행 예산 분리', '기본·확장·절약 예산을 설정에서 선택합니다. 다음 호출 전 누적 사용량을 확인하고 모델 시간은 호출 중에도 제한합니다. 예산 도달 시 작업 공간과 체크포인트를 보존합니다.', 'public/loop-policy.mjs · harness-engine.mjs · public/harness-ui.js'],
  ['P2', '작업 난도와 우선순위에 맞춘 Effort', '자동 설정만 작업 내용·역할에 맞춰 조정합니다. 폴더 제안은 medium, 복잡한 계획은 high 등으로 구분하며 사용자가 고정한 Max는 유지합니다. 추론 투입량을 최우선으로 두면 지원 최대 강도를 선택합니다.', 'public/loop-policy.mjs · harness-engine.mjs'],
  ['P2', '실패 책임과 상세 사용량 기록', '준비 실패·제공자·QA 환경·예산·중지를 코드 품질 실패와 구분합니다. 입력·출력·캐시·첫 텍스트 응답을 기록하고 미제공 값은 미확인으로 남깁니다. 실제 수동 개입 횟수는 평가 제외 여부와 별도로 보존합니다.', 'harness-evidence.mjs · token-usage.mjs · public/harness-ui.js'],
];
const tests = internal.find(t=>t.configuration==='automatic-loop');
const lastInternalQa = run.qaHistory?.at(-1);
const modelRows = [...groups].map(([key,g])=>`<tr><td>${esc(key)}</td><td>${g.count}</td><td>${n(g.tokens)}${g.missing ? `<br><small>${g.missing}호출 미보고</small>` : ''}</td><td>${g.detailCount ? `${n(g.input)} / ${n(g.output)}<br><small>${g.detailCount}/${g.count}호출 제공</small>` : '미제공'}</td><td>${g.cacheCount ? `${n(g.cache)}<br><small>${g.cacheCount}/${g.count}호출 제공</small>` : '미제공'}</td><td>${g.first.length ? `${time(g.first.reduce((a,b)=>a+b,0)/g.first.length)}<br><small>${g.first.length}/${g.count}호출 제공</small>` : '미제공'}</td><td>${time(g.ms)}</td></tr>`).join('');
const screenshot = (trial, folder, label) => {
  const desktop = trial.independentQa?.screenshots?.find(s=>s.viewport==='desktop' && s.checkId==='filter');
  const mobile = trial.independentQa?.screenshots?.find(s=>s.viewport==='mobile' && s.checkId==='add-and-persist');
  const base = `assets/${folder}/qa-user-data/harness/${trial.runId}/browser-qa/round-1/`;
  return `<figure><figcaption><strong>${label}</strong> · QA ${qa(trial)}</figcaption>${desktop ? `<img alt="${label} 실제 데스크톱 QA 화면" src="${base+desktop.name}">` : '<p>실행 결과에 화면 캡처가 없습니다.</p>'}<p>${trial.exportedFiles?.includes('index.html') ? `<a href="assets/${folder}/projects/automatic-loop/index.html" target="_blank">생성 화면 직접 열기</a>` : ''} ${mobile ? `· <a href="${base+mobile.name}">모바일 캡처</a>` : ''}</p></figure>`;
};
const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loopline 개선 적용·검증 보고서 · 2026-10-09</title>
<style>:root{color-scheme:dark;--bg:#10151b;--card:#1a232e;--line:#364351;--muted:#acbaca;--blue:#92bdff;--ink:#eff4fa}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 system-ui,-apple-system,sans-serif}main{max-width:1380px;margin:auto;padding:52px 34px 80px}h1{font-size:36px;line-height:1.3;letter-spacing:-1px}h2{font-size:24px;margin-top:42px}h3{font-size:18px}a{color:var(--blue)}p{max-width:1100px}.muted,small{color:var(--muted)}.eyebrow{font-size:13px;letter-spacing:2px;color:var(--blue)}.notice{padding:20px 24px;background:#1b2b3e;border-left:3px solid var(--blue);border-radius:4px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:26px 0}.card,figure{background:var(--card);padding:22px;border:1px solid var(--line);border-radius:14px;margin:0}.big{font-size:28px;font-weight:750}.table-wrap{overflow:auto}table{border-collapse:collapse;min-width:750px;width:100%}td,th{padding:15px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:14px}td:first-child{min-width:170px}.compact td:first-child{min-width:50px}code{font-size:13px;background:#273340;padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}.screens{display:grid;grid-template-columns:1fr 1fr;gap:16px}figure{padding:16px}figure img{display:block;width:100%;height:auto;border-radius:8px}figcaption{margin-bottom:16px}li{margin:10px 0}.pill{font-size:13px;color:#a2ead0;border:1px solid #3d735f;padding:3px 10px;border-radius:20px}summary{cursor:pointer}details{border:1px solid var(--line);border-radius:10px;padding:18px;margin-top:20px}@media(max-width:760px){main{padding:28px 18px}h1{font-size:28px}.cards,.screens{grid-template-columns:1fr}}</style>
<main><div class="eyebrow">LOOPLINE · ENGINEERING & LIVE QA</div><h1>개선안 적용과 실제 재검증</h1>
<p class="muted">2026-10-09 · macOS arm64 · 실제 Codex / Gemini / Jev 연결 · 로컬 변경 및 패키징</p>
<p class="notice"><strong>앞선 보고서의 개선안 8개를 구현했습니다.</strong> ${done ? success(current) ? '새 실제 실행은 자체 검증을 거쳐 프로젝트에 자동 반영됐습니다.' : '새 실제 실행도 전체 자동 완료에 도달하지 못했습니다. 구현된 방어와 실제 성공 여부를 분리해 기록합니다.' : '동일 Focus Board 과제로 실제 재측정을 진행하고 있습니다. 결과가 확정되면 이 보고서를 갱신합니다.'}</p>
<div class="cards"><div class="card"><small>전체 자동 완료·반영</small><div class="big">${outcome(current)}</div></div><div class="card"><small>이번 실행 보고 토큰</small><div class="big">${tokens(current)}</div><small>${current.missingUsageCalls ? '미보고 호출이 있어 전체 사용량 비교는 불확실합니다.' : `이전 Loop 대비 ${delta(current.reportedTokens,before.reportedTokens)}`}</small></div><div class="card"><small>이번 실행 경과 시간</small><div class="big">${time(current.elapsedMs)}</div><small>이전 Loop 대비 ${delta(current.elapsedMs,before.elapsedMs)}</small></div></div>
<h2>주요 변경 사항</h2><p>완료·품질을 우선하면서 불필요한 준비 반복을 줄이고, 실패 원인과 사용량을 확인할 수 있도록 변경했습니다. 각 수정과 테스트는 목적별 로컬 커밋으로 분리했습니다.</p>
<div class="table-wrap"><table class="compact"><thead><tr><th>우선순위</th><th>구현</th><th>동작과 책임</th><th>관련 파일</th></tr></thead><tbody>${changes.map(c=>`<tr><td><span class="pill">${c[0]}</span></td><td><strong>${c[1]}</strong></td><td>${c[2]}</td><td><code>${c[3]}</code></td></tr>`).join('')}</tbody></table></div>
<p>후속 점검에서는 검증 명령 제시 전에 허용된 read/list 응답을 거부하던 문제, 캐시 미제공을 0으로 표시하던 문제, 텍스트 조각마다 상태를 저장하던 문제도 최소 범위로 보완했습니다. 잘못된 QA 단계에는 수정 대상 검사 ID를 표시하며, 설정의 자동 최대 회차 안내를 기존 엔진 상한 20회와 맞췄습니다.</p>
<h2>동일 과제의 변경 전·후 실측</h2><p>요구사항 프롬프트·고정 DOM 계약·공통 독립 QA·최대 6회차·45분 관찰 한도는 유지했습니다. ${expandedComplete ? '기본 예산 실행 후 확장 예산으로 새로 실행했습니다. 아래 주 비교는 확장 예산 실행이며, 기본 예산 실패도 별도로 보존했습니다.' : '기본 예산 실행 결과입니다.'} 앞선 단일 모델 결과는 이전 버전의 기록이며 이번 버전에서 재실행한 값은 아닙니다.</p>
<div class="table-wrap"><table><thead><tr><th>비교 항목</th><th>변경 전 자동 Loop</th><th>개선 후 자동 Loop</th></tr></thead><tbody>${rows.map(r=>`<tr>${r.map(v=>`<td>${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
<p>${success(current) ? '성공 산출물의 기능 결과는 아래 공통 독립 QA와 함께 확인해야 합니다.' : '전체 과제를 완료하지 못했으므로 짧은 시간이나 적은 보고 토큰을 성공한 프로그램 제작의 효율 향상으로 해석할 수 없습니다.'}</p>
<p class="notice"><strong>종료 근거</strong><br>${esc(current.summary || '실행 중')}<br>생성 프로젝트 Node 테스트: ${tests ? `${esc(tests.status)} · ${n(tests.passed)}/${n(tests.tests)}` : '아직 미실행'}</p>
<p>각 실행 내부에서 수동 코드 수정과 재개 API 호출은 각각 ${current.manualCodeEdits ?? 0}회·${current.manualResumes ?? 0}회입니다. ${success(current) ? '생성 코드를 사람이 보정해 통과시킨 결과가 아닙니다.' : '개입 0회는 자동 성공을 뜻하지 않습니다. 사람이 미완료 산출물을 완성하는 데 필요한 공수는 측정하지 않았습니다.'} 각 버전 1회라 장기 성공률이나 모든 작업에서의 우위를 추정할 수 없습니다.</p>
${postReadme ? `<h3>실측 후 확인한 실패 원인과 조치</h3><ul>
<li><strong>내부 QA와 화면 제약의 충돌:</strong> 자체 브라우저 QA는 ${lastInternalQa?.checks.filter(c=>c.passed).length}/${lastInternalQa?.checks.length} 통과했습니다. 실패 4건은 제목 101자·과목 31자를 입력한 뒤 오류 메시지를 기대한 검사입니다. 생성 화면에는 각각 maxlength 100·30이 있어 실제 사용자 입력이 제한됩니다. 추가 화면 확인에서도 101자 입력 시 실제 값은 100자였습니다. 이 계획과 구현의 충돌은 실제 실행에서 자동 해소되지 않았으며, 공통 독립 QA 50/50 통과가 내부 실패를 대신하지 않습니다.</li>
<li><strong>README 검증기의 데스크톱 실행 오류 수정:</strong> Electron 하위 프로세스의 process.execPath를 Node 실행 파일로 가정한 코드가 문제였습니다. README에 적힌 node 명령을 기존 격리 환경에서 실행하도록 수정했습니다. 최종 패키지와 동일 생성 코드로 추가 검사한 결과 ${postReadme.result.checks.filter(c=>c.passed).length}/${postReadme.result.checks.length} 통과했습니다. 생성 코드를 수정하거나 AI를 다시 호출하지 않았습니다. <a href="assets/${dataFolder}/post-benchmark-readme-qa.json">추가 검사 원본</a></li>
<li><strong>준비 비용은 여전히 큼:</strong> 첫 구현까지 ${time(run.firstWorkerAt-run.createdAt)}, 준비 토큰 ${n(run.preparationReportedTokens)}이 들었습니다. 변경되지 않은 사례 재판정 재사용은 동작했지만, QA 계획의 의미·경계 조건과 부분 작업 계획 판정에서 추가 호출이 계속 발생했습니다.</li>
<li><strong>자동 완료 지표 유지:</strong> 종료 뒤 수정한 README 실행 오류를 반영해도 해당 실행을 성공으로 고쳐 쓰지 않았습니다. 마지막 수정까지 포함한 새 모델 실행은 하지 않았으며, 실제 기록은 자동 반영 0/1입니다. 기존 6회차 비교 한도를 늘려 성공 수치를 만들지도 않았습니다.</li>
</ul>` : ''}
<h3>앞선 단일 모델 실측 참고</h3><div class="table-wrap"><table><thead><tr><th>이전 버전 구성</th><th>자동 반영</th><th>시간</th><th>토큰</th><th>구현 진입</th></tr></thead><tbody>${baseline.trials.filter(t=>t.configuration!=='automatic-loop').map(t=>`<tr><td>${esc(t.label)}</td><td>${outcome(t)}</td><td>${time(t.elapsedMs)}</td><td>${n(t.reportedTokens)}</td><td>${t.modelCalls.some(c=>c.role==='worker')?'진입':'QA 준비에서 종료'}</td></tr>`).join('')}</tbody></table></div><p class="muted">이 수치로 새 Loop와 단일 모델의 순수 모델 성능 차이를 단정하지 않습니다. 동일 새 버전에서 구성별 반복 실험이 다음 비교 단계입니다.</p>
<h2>이번 실행의 단계별 상세 사용량</h2><div class="table-wrap"><table><thead><tr><th>역할 · 모델 · Effort</th><th>호출</th><th>전체 토큰</th><th>입력 / 출력</th><th>캐시 입력</th><th>평균 첫 텍스트 응답</th><th>호출 시간 합</th></tr></thead><tbody>${modelRows || '<tr><td colspan="7">실행 결과 수집 중</td></tr>'}</tbody></table></div>
<p class="muted">캐시 토큰은 입력 토큰의 일부이며 총합에 다시 더하지 않습니다. 첫 텍스트 응답은 토큰이 아닌 문자열 수신 시각입니다. Jev처럼 스트리밍이 없거나 제공자가 상세 값을 보내지 않으면 미제공으로 표시합니다. 달러 과금액은 실행별 청구 근거가 없어 산출하지 않았습니다.</p>
<h2>이번 개선 후 시도 전체</h2><div class="table-wrap"><table><thead><tr><th>예산 설정 / 측정 코드</th><th>시간</th><th>보고 토큰</th><th>자동 완료</th><th>종료 근거</th></tr></thead><tbody>${[...defaultResults.trials.map(t=>({...t,budgetLabel:'기본 · 준비 15분/50만 · cc6de66'})),...(expandedResults?.trials || []).map(t=>({...t,budgetLabel:'확장 · 준비 30분/100만 · 31687ae'}))].map(t=>`<tr><td>${t.budgetLabel}</td><td>${time(t.elapsedMs)}</td><td>${t.missingUsageCalls ? '최소 ' : ''}${n(t.reportedTokens)}</td><td>${outcome(t)}</td><td>${esc(t.summary || '진행 중')}</td></tr>`).join('')}</tbody></table></div><p class="muted">후속 버전은 수동 개입 통계 보존, 진단 이벤트의 중복 상태 저장 제거, 예산 키 검증을 포함합니다. 실측 후 추가한 검사 ID 오류 안내는 별도 회귀 검사로 확인하며 이 실측의 성능 수치에 소급해 포함하지 않습니다. 첫 시도의 시간·토큰도 누락하지 않았습니다. 기본 예산 중단 뒤 확장 예산으로 새 시험을 시작한 것은 실험 진행자의 설정 조정 1회이며, 엔진이 스스로 예산을 늘려 복구한 것으로 집계하지 않습니다. 사용량이 없는 오류 호출은 전체 토큰 합계가 하한임을 뜻합니다.</p>
<p>이번 개선 후 완료된 ${finishedTrials.length}개 시도의 합계는 <strong>${time(attemptTotals.elapsedMs)} · ${attemptTotals.missingUsageCalls ? '최소 ' : ''}${n(attemptTotals.tokens)}토큰</strong>입니다. 성공한 마지막 시도만으로 전체 사용량을 계산하지 않습니다. 이후 추가한 QA 오류 안내와 회차 표시 변경은 실측용 앱 버전 31687ae 이후 변경이므로 위 실행 시간·토큰에 소급 적용하지 않았습니다.</p>
<h2>화면 비교</h2><div class="screens">${screenshot(before,'live-comparison-2026-10-09','변경 전 · 부분 산출물')}${screenshot(current,dataFolder,'개선 후 · 실제 산출물')}</div>
<h2>회귀 검사와 앱 반영</h2><p>${esc(validation.summary || validation.status)}</p><ul>${(validation.items || []).map(i=>`<li>${esc(i)}</li>`).join('')}</ul>
<h2>설정과 주의 사항</h2><ul><li>기본 실행 예산은 전체 200만 토큰·모델 호출 시간 60분, 준비 단계 50만 토큰·15분입니다. 확장과 절약을 설정 화면에서 선택할 수 있습니다. 모델 시간은 전체 벽시계 시간과 다릅니다.</li><li>토큰 수는 응답 후 집계하므로 한 호출만큼 예산을 넘을 수 있습니다. 미보고 토큰을 0으로 확정하지 않으며 시간 한도를 함께 사용합니다.</li><li>예산 도달은 자동 완료가 아닙니다. 작업 공간과 체크포인트를 보존하지만 예산을 자동으로 무한 증액하지 않습니다. 기존 예산 소진 실행의 원클릭 증액·재개는 이번 범위에 포함되지 않았습니다.</li><li>기존 기록은 세부 계측이 없으므로 새 값으로 추정하거나 소급 보정하지 않습니다. 새 실패 분류는 관찰 가능한 오류·실행 단계에 근거하며 모든 실패의 원인을 확정하는 진단기는 아닙니다.</li><li>이번 실측은 이전과 동일하게 MCP와 native plugin을 비활성화했습니다. Paper/Figma 연결이나 휴대폰·Tailscale 왕복 성능을 평가한 결과는 아닙니다.</li><li>구조화 스키마는 형식을 안정화하는 수단입니다. 올바른 구현·QA 기준·테스트 성공은 실제 검증으로 따로 확인합니다.</li></ul>
<p>Codex의 turn별 <code>outputSchema</code>는 <a href="https://learn.chatgpt.com/docs/app-server">공식 App Server 문서</a>를 확인해 적용했고, 엄격한 JSON 구조는 <a href="https://developers.openai.com/api/docs/guides/structured-outputs">공식 Structured Outputs 문서</a>의 형식 제한에 맞췄습니다.</p>
<h2>재현 자료</h2><ul><li><a href="assets/${dataFolder}/results.json">이번 실제 실행 결과 JSON</a> · <a href="assets/${dataFolder}/protocol.json">비교 조건·소스 버전</a></li><li><a href="assets/${dataFolder}/automatic-loop-run.json">실행 이벤트·모델 호출 기록</a> · <a href="assets/loop-improvements-2026-10-09/validation.json">검증 기록</a> · <a href="assets/loop-improvements-2026-10-09/results.json">기본 예산 시도 원본</a></li><li><a href="current-performance-comparison-2026-10-09.html">변경 전 보고서</a></li></ul>
<p class="muted">로컬 보고서 · GitHub 게시 없음 · 자동 생성 ${esc(new Date().toISOString())}</p></main></html>`;
await writeFile(join(here, '../../loop-improvements-2026-10-09.html'), html);
console.log('reports/loop-improvements-2026-10-09.html');

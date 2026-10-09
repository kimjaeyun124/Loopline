import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const folder = 'loop-input-contract-2026-10-09';
const previousFolder = 'loop-improvements-expanded-2026-10-09';
const readJson = async (name) => JSON.parse(await readFile(join(here, name), 'utf8'));
const results = await readJson('results.json');
const current = results.trials[0];
if (!current?.finishedAt) throw new Error('실제 실행이 끝난 뒤 보고서를 생성하세요.');
const run = await readJson('automatic-loop-run.json');
const before = (await readJson(`../${previousFolder}/results.json`)).trials[0];
const beforeRun = await readJson(`../${previousFolder}/automatic-loop-run.json`);
const beforeTests = (await readJson(`../${previousFolder}/generated-project-tests.json`))[0];
const tests = (await readJson('generated-project-tests.json'))[0];
const notes = await readJson('evaluation.json');
const verification = await readJson('validation.json');
const followup = await readJson('followup-validation.json');
const css = await readFile(join(here, '../loop-improvements-2026-10-09/report.css'), 'utf8');
const esc = value => String(value ?? '미확인').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = v => Number.isFinite(v) ? v.toLocaleString('ko-KR') : '미확인';
const time = ms => Number.isFinite(ms) ? `${Math.floor(ms / 60000)}분 ${(ms % 60000 / 1000).toFixed(1)}초` : '미확인';
const delta = (a, b) => Number.isFinite(a) && b > 0 ? `${(Math.abs(a / b - 1) * 100).toFixed(1)}% ${a < b ? '감소' : '증가'}` : '미확인';
const complete = trial => trial.status === 'completed' && trial.applied === true;
const outcome = trial => complete(trial) ? '완료 · 자동 반영 1/1' : `${({limit:'회차 한도',failed:'실패',stopped:'중지',interrupted:'중단'})[trial.status] || esc(trial.status)} · 자동 반영 0/1`;
const qa = trial => trial.independentQa?.unavailable ? '미실행' : trial.independentQa ? `${n(trial.independentQa.passedCheckCount)}/${n(trial.independentQa.checks.length)}` : '미확인';
const internalQa = r => { const last = r.qaHistory?.at(-1); return last ? `${last.checks.filter(c => c.passed).length}/${last.checks.length}` : '미실행'; };
const readmeQa = r => { const last = r.readmeQaHistory?.at(-1); return last ? `${last.passed ? '통과' : '실패'} · ${last.checks.filter(c => c.passed).length}/${last.checks.length}` : '미실행'; };
const milestones = trial => trial.milestones?.length ? `${trial.milestones.filter(m => m.status === 'completed').length}/${trial.milestones.length}` : '미진입';
const tokens = trial => `${trial.missingUsageCalls ? '최소 ' : ''}${n(trial.reportedTokens)}`;
const rows = [
  ['자동 완료·반영', outcome(before), outcome(current)],
  ['전체 실행 시간', time(before.elapsedMs), time(current.elapsedMs)],
  ['보고된 토큰', tokens(before), tokens(current)],
  ['실제 모델 호출 / 사용량 미보고', `${before.modelCalls.length}회 / ${before.missingUsageCalls}회`, `${current.modelCalls.length}회 / ${current.missingUsageCalls}회`],
  ['부분 작업 완료', milestones(before), milestones(current)],
  ['자체 브라우저 QA · 마지막 결과', internalQa(beforeRun), internalQa(run)],
  ['README 실제 실행 · 마지막 결과', readmeQa(beforeRun), readmeQa(run)],
  ['동일 독립 브라우저 QA', qa(before), qa(current)],
  ['생성 프로젝트 Node 테스트', `${n(beforeTests.passed)}/${n(beforeTests.tests)}`, tests.status === 'NOT_RUN' ? '미실행' : `${n(tests.passed)}/${n(tests.tests)}`],
  ['첫 구현까지 시간', beforeRun.firstWorkerAt ? time(beforeRun.firstWorkerAt - beforeRun.createdAt) : '미도달', run.firstWorkerAt ? time(run.firstWorkerAt - run.createdAt) : '미도달'],
  ['첫 구현 전 준비 토큰', n(beforeRun.preparationReportedTokens), n(run.preparationReportedTokens)],
  ['실행 중 수동 코드 수정 / 수동 재개', `${before.manualCodeEdits}회 / ${before.manualResumes}회`, `${current.manualCodeEdits}회 / ${current.manualResumes}회`],
  ['45분 관찰 한도에 따른 중지', before.observationStop ? '1회' : '0회', current.observationStop ? '1회' : '0회'],
];
const calls = current.modelCalls || [];
const groups = new Map();
for (const c of calls) {
  const key = `${c.role} · ${c.model} · ${c.effort}`;
  const g = groups.get(key) || { count: 0, tokens: 0, missing: 0, ms: 0, input: 0, output: 0, details: 0, cached: 0, cacheDetails: 0 };
  g.count++; g.tokens += c.tokens || 0; g.missing += Number.isFinite(c.tokens) ? 0 : 1; g.ms += c.durationMs || 0;
  if (Number.isFinite(c.inputTokens) && Number.isFinite(c.outputTokens)) { g.input += c.inputTokens; g.output += c.outputTokens; g.details++; }
  if (Number.isFinite(c.cachedInputTokens)) { g.cached += c.cachedInputTokens; g.cacheDetails++; }
  groups.set(key, g);
}
const roleCards = [['planner','계획'], ['worker','구현'], ['judge','판정']].map(([role,label]) => {
  const selected = calls.filter(c => c.role === role);
  const total = selected.reduce((sum,c) => sum + (c.tokens || 0), 0);
  const share = current.reportedTokens > 0 ? (100 * total / current.reportedTokens).toFixed(1) : '0';
  return `<article class="role-card"><div class="role-head"><h3>${label}</h3><small>${selected.length}회 · ${share}%</small></div><div class="role-tokens">${n(total)}<small>보고 토큰</small></div><div class="usage-track" aria-hidden="true"><span style="width:${share}%"></span></div><div class="model-tags">${[...new Set(selected.map(c => c.model))].map(m => `<span class="model-tag">${esc(m)}</span>`).join('')}</div></article>`;
}).join('');
const screenshot = (trial, dataFolder, label) => {
  const image = trial.independentQa?.screenshots?.find(s => s.viewport === 'desktop' && s.checkId === 'filter');
  const mobile = trial.independentQa?.screenshots?.find(s => s.viewport === 'mobile' && s.checkId === 'add-and-persist');
  const base = `assets/${dataFolder}/qa-user-data/harness/${trial.runId}/browser-qa/round-1/`;
  return `<figure class="screen"><figcaption><strong>${label}</strong><small>독립 QA ${qa(trial)}</small></figcaption>${image ? `<a class="screen-image" href="${base + image.name}"><img src="${base + image.name}" alt="${label}의 실제 데스크톱 QA 화면" width="1440" height="900" loading="lazy"></a>` : '<div class="detail-body">화면이 생성되지 않아 브라우저 QA를 실행하지 못했습니다.</div>'}<div class="screen-footer">${trial.exportedFiles?.includes('index.html') ? `<a href="assets/${dataFolder}/projects/automatic-loop/index.html">생성 화면 직접 열기 ↗</a>` : ''}${mobile ? `<a href="${base + mobile.name}">모바일 캡처 ↗</a>` : ''}</div></figure>`;
};
const list = items => `<ul>${items.map(text => `<li>${esc(text)}</li>`).join('')}</ul>`;
const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loopline · 입력 계약 개선 실측 · 2026-10-09</title><style>${css}</style></head>
<body id="top"><a class="skip-link" href="#summary">본문으로 건너뛰기</a>
<header class="topbar"><div class="shell topbar-inner"><a class="brand" href="#top"><span class="brand-mark" aria-hidden="true">∞</span>Loopline<span class="brand-divider" aria-hidden="true"></span><small>Continuous improvement</small></a><div class="topbar-meta"><span>실측 · 수정 · 재검증</span><time datetime="2026-10-09">2026. 10. 09</time></div></div></header>
<div class="shell hero"><div class="eyebrow">LIVE MEASUREMENT</div><div class="hero-heading"><div><h1>입력 계약 개선 후 실제 결과</h1><p class="hero-description">실제 Chromium 입력 제약을 계획·구현 단계에 전달하고, 같은 Focus Board 과제로 다시 측정했습니다.</p></div><a class="button primary" href="#comparison">이전 결과와 비교 ↗</a></div><div class="hero-meta"><span>macOS arm64</span><span>Codex · Gemini · Jev</span><span>6회차 · 확장 예산</span><span>관찰 한도 45분</span></div></div>
<nav class="section-nav" aria-label="보고서 목차"><div class="shell nav-links"><a href="#summary">결과 요약</a><a href="#comparison">변경 전·후</a><a href="#screens">결과 화면</a><a href="#usage">모델 사용량</a><a href="#changes">개선·검증</a><a href="#next">다음 실측</a></div></nav>
<main class="shell"><section id="summary"><div class="section-head"><div><span class="section-label">01 / RESULT</span><h2>이번 실행의 결론</h2></div><span class="status-badge ${complete(current) ? 'success' : ''}">${complete(current) ? '자동 완료' : '추가 개선 필요'}</span></div>
<div class="result-banner ${complete(current) ? 'success' : ''}"><div><h2>${esc(notes.headline)}</h2><p>${esc(notes.summary)}</p></div></div>
<div class="metric-grid"><article class="metric"><span class="metric-label">자동 완료·반영</span><div class="metric-value ${complete(current) ? 'positive' : 'warning'}">${complete(current) ? 1 : 0}<em>/ 1</em></div><span class="metric-note">부분 작업 · ${milestones(current)}</span></article><article class="metric"><span class="metric-label">전체 실행 시간</span><div class="metric-value">${time(current.elapsedMs)}</div><span class="metric-note">이전 대비 ${delta(current.elapsedMs,before.elapsedMs)}</span></article><article class="metric"><span class="metric-label">보고된 토큰</span><div class="metric-value">${tokens(current)}</div><span class="metric-note">${current.missingUsageCalls ? `${current.missingUsageCalls}회 사용량 미보고 · 하한값` : `이전 대비 ${delta(current.reportedTokens,before.reportedTokens)}`}</span></article><article class="metric"><span class="metric-label">공통 독립 브라우저 QA</span><div class="metric-value ${current.independentQa?.passed ? 'positive' : 'warning'}">${qa(current)}</div><span class="metric-note">자동 완료와 별도 지표</span></article></div>
<div class="milestone-panel"><div class="panel-heading"><h3>실제 부분 작업 진행</h3><p>${milestones(current)}</p></div><ol class="milestones">${(current.milestones || []).map((m,i) => `<li class="${m.status === 'completed' ? 'complete' : ''}"><span class="stage-number">${m.status === 'completed' ? '✓' : i+1}</span><div><h3>${esc(m.title)}</h3><p>${m.status === 'completed' ? '완료' : '미완료'} · ${n(m.attempts)}회 시도</p></div></li>`).join('')}</ol>${current.milestones?.length ? '' : '<p class="section-note">QA 계획 단계에서 종료되어 구현·통합 검증에 진입하지 못했습니다.</p>'}</div></section>
<section id="comparison"><div class="section-head"><div><span class="section-label">02 / COMPARISON</span><h2>변경 전·후, 같은 과제로</h2><p>동일 프롬프트·공통 QA·확장 예산·6회차·45분 관찰 한도. 각 버전 1회 실측입니다.</p></div></div>
<div class="comparison-card"><table class="comparison-table" aria-label="변경 전후 실측 비교"><thead><tr><th scope="col">비교 항목</th><th scope="col">이전 확장 실행</th><th scope="col">입력 계약 개선 후</th></tr></thead><tbody>${rows.map((r,i) => `<tr class="${i === 0 ? 'important' : ''}"><th scope="row">${r[0]}</th><td data-label="변경 전">${r[1]}</td><td data-label="개선 후">${r[2]}</td></tr>`).join('')}</tbody></table></div>
<p class="table-note">두 버전 모두 연결·잔여 사용량·누적 선택 기록은 실행 시점의 앱 상태를 사용했습니다. 모델 응답 변동, 실제 선택 모델, README 실행 경로 수정도 영향을 줄 수 있으므로 시간·토큰 차이 전체를 입력 계약 변경만의 효과로 단정하지 않습니다. 단일 모델은 이번 회차에서 재실행하지 않았습니다.</p>
<details><summary>판정 근거와 비교의 한계<span class="summary-meta">종료 원인 · 수동 개입</span></summary><div class="detail-body"><p><strong>엔진 종료 근거</strong><br>${esc(current.summary)}</p>${list(notes.findings)}<p>실험 준비와 제품 수정은 이 실행 밖에서 진행했습니다. 실행 중 생성 코드 수동 수정 ${current.manualCodeEdits}회, 수동 이어가기 ${current.manualResumes}회, 관찰 한도 중지 ${current.observationStop ? 1 : 0}회입니다. 이 수치에 제품 개발 공수와 보고서 작성 시간은 포함되지 않습니다. ${complete(current) ? '이번 1회 성공으로 장기 성공률을 추정할 수 없습니다.' : '개입 0회가 자동 성공을 의미하지 않으며 미완료 결과는 그대로 기록합니다.'}</p></div></details></section>
<section id="screens"><div class="section-head"><div><span class="section-label">03 / OUTPUT</span><h2>실제 산출물을 직접 확인</h2><p>공통 독립 QA의 데스크톱·모바일 화면입니다. 이미지와 링크를 눌러 원본을 볼 수 있습니다.</p></div></div><div class="screens">${screenshot(before,previousFolder,'이전 실행 · 부분 산출물')}${screenshot(current,folder,'이번 실행 · 실제 산출물')}</div></section>
<section id="usage"><div class="section-head"><div><span class="section-label">04 / MODEL USAGE</span><h2>역할별 모델과 토큰</h2><p>사용량이 보고된 실제 호출만 합산했습니다.</p></div></div><div class="role-grid">${roleCards}</div>
<details><summary>모델·Effort별 상세 사용량<span class="summary-meta">${calls.length}회 호출 · ${groups.size}개 조합</span></summary><div class="detail-body"><div class="table-wrap" tabindex="0" role="region" aria-label="모델별 상세 사용량"><table class="usage-table"><thead><tr><th scope="col">역할 · 모델 · Effort</th><th scope="col">호출</th><th scope="col">보고 토큰</th><th scope="col">입력 / 출력</th><th scope="col">캐시 입력</th><th scope="col">호출 시간 합</th></tr></thead><tbody>${[...groups].map(([key,g]) => `<tr><td>${esc(key)}</td><td>${g.count}</td><td>${n(g.tokens)}${g.missing ? `<br><small>${g.missing}회 미보고</small>` : ''}</td><td>${g.details ? `${n(g.input)} / ${n(g.output)}<br><small>${g.details}/${g.count}회 제공</small>` : '미제공'}</td><td>${g.cacheDetails ? `${n(g.cached)}<br><small>${g.cacheDetails}/${g.count}회 제공</small>` : '미제공'}</td><td>${time(g.ms)}</td></tr>`).join('')}</tbody></table></div><p class="table-note">캐시 입력은 전체 토큰에 다시 더하지 않습니다. 모델마다 토큰 정의와 보고 범위가 다를 수 있습니다. 실행별 청구 금액 근거가 없어 달러 비용은 추정하지 않았습니다.</p></div></details></section>
<section id="changes"><div class="section-head"><div><span class="section-label">05 / IMPLEMENTATION</span><h2>확인된 원인을 좁게 수정</h2><p>브라우저 입력과 오류 메시지 요구가 충돌하던 문제를 다뤘습니다.</p></div></div>
<div class="finding-grid"><article class="finding"><div class="finding-header"><span class="status-badge">원인</span><h3>브라우저에서 입력이 잘림</h3></div><p>이전 생성 화면은 제목·과목을 maxlength로 제한했습니다. QA가 제한을 넘는 문자를 넣어도 실제 입력값은 잘려, 애플리케이션의 초과 오류가 나타날 수 없었습니다.</p></article><article class="finding"><div class="finding-header"><span class="status-badge success">수정</span><h3>계약 전달과 실패 근거 보강</h3></div><p>계획·구현·판정에 실제 입력 동작과 요구사항을 전달합니다. 실패하면 요청 길이·실제 길이·maxlength·입력 유형을 모델에 보여 줍니다. 입력값을 강제로 바꾸거나 검사 기준을 낮추지 않았습니다.</p></article></div>
<div class="validation-strip" style="margin-top:20px"><div class="validation-stat"><strong>${verification.tests.passed}/${verification.tests.tests}</strong><span>전체 제품 회귀 검사</span></div><div class="validation-stat"><strong>2/2</strong><span>입력 계약 대상 검사</span></div><div class="validation-stat"><strong>3/3</strong><span>패키지 소스 해시 일치</span></div></div>
<details><summary>수정 파일·책임·검증 범위<span class="summary-meta">로컬 커밋 분리</span></summary><div class="detail-body"><ul><li><code>browser-qa.mjs</code>: 모델에 전달할 실제 브라우저 입력 계약.</li><li><code>harness-engine.mjs</code>: 계획·구현 프롬프트에 입력 계약 연결.</li><li><code>desktop/browser-qa.mjs</code>: 실패 시 입력 전달 차이를 수집해 진단 근거에 추가.</li><li><code>tests/browser-input-qa.test.mjs</code>: 실제 Chromium에서 maxlength 4에 5자 입력 → 진단, 유효 경계 4자 → 통과, fixture 구현 수정 후 동일 검사 10/10 통과.</li><li><code>tests/browser-qa.test.mjs</code>: 계획·구현 모델이 계약을 받는지 검사.</li></ul><p><code>58991ac fix: 브라우저 입력 제약과 QA 오류 계약의 충돌 예방</code><br><code>c21de18 test: 실제 Chromium 입력 경계와 실패 진단 검증</code></p><p>패키징 성공 후 앱을 정상 재시작했습니다. 실제 실행 도중 제품·생성 코드·검사 기준을 변경하지 않았습니다.</p></div></details>
<div class="finding-grid"><article class="finding"><div class="finding-header"><span class="status-badge success">실측 후 보완</span><h3>QA 분류와 실제 동작 일치</h3></div><p>빈 입력도 fill(value:"")로 명시하고, 키보드 검사는 실제 press 이후 결과를 확인하도록 안내합니다. 같은 검사에서 빠진 분류별 동작을 함께 진단합니다. 다른 검사의 동작으로 현재 검사의 근거를 대신할 수 없습니다.</p></article><article class="finding"><div class="finding-header"><span class="status-badge success">후속 회귀 검증</span><h3>${followup.tests.passed}/${followup.tests.tests} 통과</h3></div><p>분류 진단 대상 검사 2/2 통과. 실제 모델 전체 재실측은 이 후속 수정 후에 다시 진행하지 않았습니다. 위 실측은 수정 전의 실패 기록을 유지합니다.</p><p><code>${esc(followup.fixCommit)}</code> 구현 · <code>${esc(followup.testCommit)}</code> 테스트</p></article></div>
<div class="resource-links">${[['원본 실행 기록','automatic-loop-run.json'],['측정 결과 JSON','results.json'],['공통 독립 QA','automatic-loop-independent-qa.json'],['최종 제품 회귀 로그','final-regression-tests.log'],['실험 조건과 해시','protocol.json'],['패키지 소스 확인','package-checks.json']].map(([label,file]) => `<a class="resource-link" href="assets/${folder}/${file}">${label}<span>↗</span></a>`).join('')}</div></section>
<section id="next"><div class="section-head"><div><span class="section-label">06 / NEXT CYCLE</span><h2>지속 실측과 다음 우선순위</h2></div><span class="status-badge success">매일 오전 9시 등록</span></div><p class="section-note">이 대화에 연결된 일일 자동화를 활성화했습니다. 기존 실행이 있으면 결과 수집부터 이어가고, 근거가 확인된 문제 한 가지를 수정한 뒤 같은 조건으로 다시 측정합니다. 인증·구조·저장·동시성 등 승인 대상 변경은 구체적인 제안으로 보고합니다.</p>${list(notes.nextSteps)}<p class="section-note">로컬 앱과 연결 계정을 사용할 수 있어야 실제 측정이 가능합니다. 연결 불가·사용량 한도·검사 미실행도 그대로 남깁니다. 이전 실행 자료는 보존하며 GitHub에는 게시하지 않습니다.</p></section>
<footer class="footer"><span>Loopline · 측정 코드 ${esc(results.protocol.sourceCommit)} · 실행 ${esc(current.runId)}</span><a href="loop-improvements-2026-10-09.html">이전 개선 보고서 ↗</a></footer></main></body></html>`;
await writeFile(join(here, '../../loop-input-contract-2026-10-09.html'), html);
console.log('reports/loop-input-contract-2026-10-09.html');

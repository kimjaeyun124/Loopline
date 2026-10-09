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
  return `<figure class="screen"><figcaption><strong>${label}</strong><small>독립 QA ${qa(trial)}</small></figcaption>${desktop ? `<a class="screen-image" href="${base+desktop.name}" aria-label="${label} 데스크톱 캡처 크게 보기"><img alt="${label} 실제 데스크톱 QA 화면" src="${base+desktop.name}" loading="lazy" width="1440" height="900"></a>` : '<p>실행 결과에 화면 캡처가 없습니다.</p>'}<div class="screen-footer">${trial.exportedFiles?.includes('index.html') ? `<a href="assets/${folder}/projects/automatic-loop/index.html">생성 화면 직접 열기 <span aria-hidden="true">↗</span></a>` : ''}${mobile ? `<a href="${base+mobile.name}">모바일 캡처 <span aria-hidden="true">↗</span></a>` : ''}</div></figure>`;
};
const completedMilestones = current.milestones?.filter(m => m.status === 'completed').length || 0;
const roleCards = [['planner', '계획'], ['worker', '구현'], ['judge', '판정']].map(([role, label]) => {
  const roleCalls = calls.filter(c => c.role === role);
  const reported = roleCalls.reduce((sum, c) => sum + (c.tokens || 0), 0);
  const share = current.reportedTokens > 0 ? (reported / current.reportedTokens * 100).toFixed(1) : 0;
  return `<article class="role-card"><div class="role-head"><h3>${label}</h3><small>${roleCalls.length}회 호출 · 토큰 ${share}%</small></div><div class="role-tokens">${n(reported)}<small>보고 토큰</small></div><div class="usage-track" aria-hidden="true"><span style="width:${share}%"></span></div><div class="model-tags">${[...new Set(roleCalls.map(c => c.model))].map(model => `<span class="model-tag">${esc(model)}</span>`).join('')}</div></article>`;
}).join('');
const css = await readFile(join(here, 'report.css'), 'utf8');
const html = `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loopline · 개선 적용과 실측 보고서 · 2026-10-09</title><style>${css}</style></head>
<body id="top">
<a class="skip-link" href="#summary">본문으로 건너뛰기</a>
<header class="topbar"><div class="shell topbar-inner"><a class="brand" href="#top" aria-label="Loopline 보고서 처음으로"><span class="brand-mark" aria-hidden="true">∞</span>Loopline<span class="brand-divider" aria-hidden="true"></span><small>Engineering report</small></a><div class="topbar-meta"><span>실제 실행 기록</span><time datetime="2026-10-09">2026. 10. 09</time></div></div></header>
<div class="shell hero">
  <div class="eyebrow">IMPROVEMENT REVIEW</div>
  <div class="hero-heading"><div><h1>개선 적용과 실측 보고서</h1><p class="hero-description">8개 개선안 적용 후, 같은 Focus Board 과제로 다시 확인한 실행 결과입니다.</p></div><a class="button primary" href="#screens">결과 화면 비교 <span aria-hidden="true">↗</span></a></div>
  <div class="hero-meta"><span>macOS arm64</span><span>Codex · Gemini · Jev</span><span>최대 6회차</span><span>${expandedComplete ? '확장 예산 실행' : '기본 예산 실행'}</span></div>
</div>
<nav class="section-nav" aria-label="보고서 목차"><div class="shell nav-links"><a href="#summary">결과 요약</a><a href="#comparison">변경 전·후</a><a href="#screens">화면 비교</a><a href="#usage">모델 사용량</a><a href="#changes">개선 내역</a><a href="#evidence">검증·근거</a></div></nav>
<main class="shell">
<section id="summary" aria-labelledby="summary-title">
  <div class="section-head"><div><span class="section-label">01 / OVERVIEW</span><h2 id="summary-title">이번 실행의 핵심 결과</h2></div><span class="status-badge ${success(current) ? 'success' : ''}">${done ? success(current) ? '자동 완료' : '추가 개선 필요' : '실행 중'}</span></div>
  <div class="result-banner ${success(current) ? 'success' : ''}"><div><h2>${done ? success(current) ? '검증을 마치고 프로젝트에 자동 반영했습니다.' : `부분 작업 ${completedMilestones}/${current.milestones?.length || 0} 완료. 전체 자동 반영은 미완료입니다.` : '동일 과제로 실제 재측정하고 있습니다.'}</h2><p>${done ? success(current) ? '아래 비교표에서 실행 비용과 독립 QA 결과를 함께 확인할 수 있습니다.' : `공통 독립 QA ${qa(current)} 통과와 전체 자동 완료는 별도 지표입니다. 전체 통합 검증이 남아 있으며, 회차 한도에서 근거와 작업 공간을 보존했습니다.` : '완료된 수치와 실행 중인 상태를 구분해 표시합니다.'}</p></div></div>
  <div class="metric-grid">
    <article class="metric"><span class="metric-label">자동 완료·반영</span><div class="metric-value ${success(current) ? 'positive' : 'warning'}">${done ? success(current) ? '1' : '0' : '–'}<em>/ 1</em></div><span class="metric-note">${done ? success(current) ? '전체 통합 검증 완료' : '완료 조건 미충족' : '진행 중'}</span></article>
    <article class="metric"><span class="metric-label">전체 실행 시간</span><div class="metric-value">${time(current.elapsedMs)}</div><span class="metric-note">이전 Loop 대비 <span class="${current.elapsedMs < before.elapsedMs ? 'positive' : 'negative'}">${delta(current.elapsedMs,before.elapsedMs)}</span></span></article>
    <article class="metric"><span class="metric-label">보고된 토큰</span><div class="metric-value">${tokens(current)}</div><span class="metric-note">${current.missingUsageCalls ? `${current.missingUsageCalls}회 사용량 미보고 · 하한값` : `이전 Loop 대비 <span class="${current.reportedTokens < before.reportedTokens ? 'positive' : 'negative'}">${delta(current.reportedTokens,before.reportedTokens)}</span>`}</span></article>
    <article class="metric"><span class="metric-label">공통 독립 브라우저 QA</span><div class="metric-value positive">${qa(current)}</div><span class="metric-note">생성 산출물 대상 · 자동 완료와 별도</span></article>
  </div>
  <div class="milestone-panel"><div class="panel-heading"><h3>부분 작업 진행</h3><p>${completedMilestones}/${current.milestones?.length || 0} 완료 · 검증 근거 기준</p></div><ol class="milestones">${(current.milestones || []).map((m, i) => `<li class="${m.status === 'completed' ? 'complete' : ''}"><span class="stage-number" aria-hidden="true">${m.status === 'completed' ? '✓' : String(i+1).padStart(2,'0')}</span><div><h3>${esc(m.title)}</h3><p>${m.status === 'completed' ? '완료' : '미완료'} · ${n(m.attempts)}회 시도</p></div></li>`).join('')}</ol></div>
</section>
<section id="comparison" aria-labelledby="comparison-title">
  <div class="section-head"><div><span class="section-label">02 / COMPARISON</span><h2 id="comparison-title">변경 전·후, 같은 기준으로</h2><p>동일 프롬프트·DOM 계약·독립 QA · 최대 6회차 · 관찰 한도 45분</p></div></div>
  <div class="comparison-card"><table class="comparison-table" aria-label="변경 전후 자동 Loop 실측 비교" role="table"><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">비교 항목</th><th scope="col" role="columnheader">변경 전 자동 Loop</th><th scope="col" role="columnheader">개선 후 자동 Loop</th></tr></thead><tbody role="rowgroup">${rows.map((r,i)=>`<tr role="row" class="${i===0 ? 'important' : ''}"><th scope="row" role="rowheader">${r[0]}</th><td role="cell" data-label="변경 전">${r[1]}</td><td role="cell" data-label="개선 후">${r[2]}</td></tr>`).join('')}</tbody></table></div>
  <p class="table-note">${expandedComplete ? '주 비교는 확장 예산으로 새로 시작한 실행입니다. 기본 예산 시도의 실패도 아래 전체 시도 기록에 포함했습니다.' : '기본 예산 실행 결과입니다.'} ${success(current) ? '자동 완료와 기능 검증 결과를 함께 확인하세요.' : '전체 과제가 미완료이므로 시간 차이를 성공한 프로그램 제작의 효율 향상으로 해석할 수 없습니다.'}</p>
  ${postReadme ? `<div class="finding-grid"><article class="finding"><div class="finding-header"><span class="status-badge">남은 문제</span><h3>입력 제약과 내부 QA의 충돌</h3></div><p>자체 브라우저 QA ${lastInternalQa?.checks.filter(c=>c.passed).length}/${lastInternalQa?.checks.length} 통과. 제목 101자·과목 31자 입력 뒤 오류를 기대했지만, 화면의 maxlength 100·30이 입력을 제한했습니다. 실패 4건은 실행 중 자동 해소되지 않았습니다.</p></article><article class="finding"><div class="finding-header"><span class="status-badge success">실측 후 수정</span><h3>README 검증 실행 경로</h3></div><p>Electron 실행 파일을 Node로 사용하던 오류를 수정했습니다. 최종 패키지에서 같은 생성 코드로 ${postReadme.result.checks.filter(c=>c.passed).length}/${postReadme.result.checks.length} 재검사를 통과했습니다. 해당 실행의 자동 완료 수치는 0/1로 유지합니다.</p></article></div>` : ''}
  <details><summary>판정 근거와 사람의 개입<span class="summary-meta">종료 원인 · 측정의 한계</span></summary><div class="detail-body"><p><strong>종료 근거</strong><br>${esc(current.summary || '실행 중')}</p><p>생성 프로젝트 Node 테스트: ${tests ? `${esc(tests.status)} · ${n(tests.passed)}/${n(tests.tests)}` : '아직 미실행'}</p><p>각 실행 내부에서 수동 코드 수정은 ${current.manualCodeEdits ?? 0}회, 수동 재개 API 호출은 ${current.manualResumes ?? 0}회입니다. ${success(current) ? '생성 코드를 사람이 보정해 통과시킨 결과가 아닙니다.' : '개입 0회는 자동 성공을 뜻하지 않습니다. 미완료 산출물을 사람이 완성하는 데 필요한 공수는 측정하지 않았습니다.'} 구성별 1회이므로 장기 성공률이나 모든 작업에서의 우위를 추정할 수 없습니다.</p>${postReadme ? `<h3>실측 후 원인 확인</h3><ul><li>내부 QA는 제목 101자·과목 31자 입력 후 오류 메시지를 기대했습니다. 화면은 maxlength 100·30으로 제한하며, 추가 화면 확인에서도 101자 입력의 실제 값은 100자였습니다. 공통 독립 QA 50/50 통과가 내부 실패를 대신하지 않습니다.</li><li>README 검증에서는 Electron 하위 프로세스의 process.execPath를 Node 실행 파일로 가정한 것이 원인이었습니다. README의 node 명령을 기존 격리 환경에서 실행하도록 수정했고, 최종 패키지에서 재검사 ${postReadme.result.checks.filter(c=>c.passed).length}/${postReadme.result.checks.length}를 통과했습니다. 생성 코드 수정·AI 재호출은 없었습니다. <a href="assets/${dataFolder}/post-benchmark-readme-qa.json">추가 검사 원본</a></li><li>첫 구현까지 ${time(run.firstWorkerAt-run.createdAt)}, 준비 토큰 ${n(run.preparationReportedTokens)}이 들었습니다. 변경되지 않은 사례의 재판정 재사용은 동작했지만, QA 의미·경계 조건과 부분 작업 계획 판정에서 추가 호출이 발생했습니다.</li><li>README 오류 수정 후 새 모델 실행은 하지 않았습니다. 실제 기록의 자동 반영 0/1을 유지하고 기존 6회차 한도도 늘리지 않았습니다.</li></ul>` : ''}</div></details>
  <details><summary>앞선 단일 모델 실측<span class="summary-meta">이전 버전의 참고 기록</span></summary><div class="detail-body"><p>이번 버전에서 단일 모델을 다시 실행한 값은 아닙니다. 새 Loop와의 순수 모델 성능 차이를 단정할 수 없으며, 동일 새 버전의 반복 실험이 다음 비교 단계입니다.</p><p class="table-scroll-hint">표가 넓으면 좌우로 스크롤해 확인하세요.</p><div class="table-wrap" tabindex="0" role="region" aria-label="이전 버전 단일 모델 비교표"><table class="detail-table"><thead><tr><th scope="col">이전 버전 구성</th><th scope="col">자동 반영</th><th scope="col">시간</th><th scope="col">토큰</th><th scope="col">구현 진입</th></tr></thead><tbody>${baseline.trials.filter(t=>t.configuration!=='automatic-loop').map(t=>`<tr><td>${esc(t.label)}</td><td>${outcome(t)}</td><td>${time(t.elapsedMs)}</td><td>${n(t.reportedTokens)}</td><td>${t.modelCalls.some(c=>c.role==='worker')?'진입':'QA 준비에서 종료'}</td></tr>`).join('')}</tbody></table></div></div></details>
</section>
<section id="screens" aria-labelledby="screens-title">
  <div class="section-head"><div><span class="section-label">03 / PREVIEW</span><h2 id="screens-title">실제 산출물 화면 비교</h2><p>같은 독립 QA에서 캡처한 화면입니다. 이미지를 누르면 원본 크기로 볼 수 있습니다.</p></div></div>
  <div class="screens">${screenshot(before,'live-comparison-2026-10-09','변경 전 · 부분 산출물')}${screenshot(current,dataFolder,'개선 후 · 실제 산출물')}</div>
  <p class="section-note">데스크톱 1440×900 · 모바일 390×844. 화면과 독립 QA 통과는 최종 통합 검증·자동 반영 완료를 의미하지 않습니다.</p>
</section>
<section id="usage" aria-labelledby="usage-title">
  <div class="section-head"><div><span class="section-label">04 / MODEL USAGE</span><h2 id="usage-title">어디에 모델과 토큰을 썼는지</h2><p>이번 비교 실행의 역할별 보고 토큰입니다. Effort·상세 입출력·응답 시간은 아래에서 확인하세요.</p></div></div>
  <div class="role-grid">${roleCards}</div>
  <details><summary>모델·Effort별 상세 사용량<span class="summary-meta">${calls.length}회 호출 · ${groups.size}개 조합</span></summary><div class="detail-body"><p class="table-scroll-hint">좌우 스크롤로 입력·출력, 캐시와 응답 시간을 확인할 수 있습니다.</p><div class="table-wrap" tabindex="0" role="region" aria-label="역할 모델 Effort별 상세 사용량"><table class="usage-table"><thead><tr><th scope="col">역할 · 모델 · Effort</th><th scope="col">호출</th><th scope="col">전체 토큰</th><th scope="col">입력 / 출력</th><th scope="col">캐시 입력</th><th scope="col">평균 첫 텍스트 응답</th><th scope="col">호출 시간 합</th></tr></thead><tbody>${modelRows || '<tr><td colspan="7">실행 결과 수집 중</td></tr>'}</tbody></table></div><p class="table-note">캐시는 입력 토큰의 일부로 총합에 다시 더하지 않습니다. 첫 텍스트 응답은 문자열 수신 시각입니다. Jev처럼 스트리밍이 없거나 상세 값이 없으면 미제공으로 표시합니다. 실행별 청구 근거가 없어 달러 비용은 산출하지 않았습니다.</p></div></details>
  <details><summary>기본·확장 예산의 전체 시도<span class="summary-meta">${finishedTrials.length}개 종료 · ${attemptTotals.missingUsageCalls ? '최소 ' : ''}${n(attemptTotals.tokens)}토큰</span></summary><div class="detail-body"><p>전체 ${finishedTrials.length}개 종료 시도 합계는 <strong>${time(attemptTotals.elapsedMs)} · ${attemptTotals.missingUsageCalls ? '최소 ' : ''}${n(attemptTotals.tokens)}토큰</strong>입니다. 첫 시도의 실패·시간·토큰도 포함했습니다.</p><p class="table-scroll-hint">표가 넓으면 좌우로 스크롤해 확인하세요.</p><div class="table-wrap" tabindex="0" role="region" aria-label="기본 확장 예산 시도 비교"><table class="detail-table"><thead><tr><th scope="col">예산 설정 / 측정 코드</th><th scope="col">시간</th><th scope="col">보고 토큰</th><th scope="col">자동 완료</th><th scope="col">종료 근거</th></tr></thead><tbody>${[...defaultResults.trials.map(t=>({...t,budgetLabel:'기본 · 준비 15분/50만 · cc6de66'})),...(expandedResults?.trials || []).map(t=>({...t,budgetLabel:'확장 · 준비 30분/100만 · 31687ae'}))].map(t=>`<tr><td>${t.budgetLabel}</td><td>${time(t.elapsedMs)}</td><td>${t.missingUsageCalls ? '최소 ' : ''}${n(t.reportedTokens)}</td><td>${outcome(t)}</td><td>${esc(t.summary || '진행 중')}</td></tr>`).join('')}</tbody></table></div><p class="table-note">기본 예산 중단 후 확장 예산으로 새 시험을 시작한 것은 실험 진행자의 설정 조정 1회입니다. 엔진이 스스로 예산을 늘린 복구로 집계하지 않습니다. 사용량 미보고 호출이 있어 전체 토큰 합계는 하한입니다.</p><p>후속 버전에는 수동 개입 통계 보존, 진단 이벤트의 중복 상태 저장 제거, 예산 키 검증이 포함됐습니다. 실측 뒤 추가한 검사 ID 오류 안내·회차 표시 변경·README 실행 오류 수정은 별도 회귀 검사로 확인했으며 실측용 앱 31687ae의 시간·토큰에 소급 반영하지 않았습니다.</p></div></details>
</section>
<section id="changes" aria-labelledby="changes-title">
  <div class="section-head"><div><span class="section-label">05 / CHANGELOG</span><h2 id="changes-title">적용한 8가지 개선</h2><p>각 항목을 펼치면 동작과 파일 책임을 확인할 수 있습니다. 수정과 테스트는 목적별 로컬 커밋으로 분리했습니다.</p></div></div>
  <div class="change-list">${changes.map(c=>`<details><summary><span class="priority">${c[0]}</span>${c[1]}</summary><div class="detail-body"><p>${c[2]}</p><span class="file-list">${c[3].split(' · ').map(file=>`<code>${file}</code>`).join(' ')}</span></div></details>`).join('')}</div>
  <p class="section-note">후속 점검에서 검증 명령 제시 전 read/list 응답을 거부하던 문제, 캐시 미제공을 0으로 표시하던 문제, 텍스트 조각마다 상태를 저장하던 문제도 보완했습니다. QA 오류에는 검사 ID를 추가하고 자동 최대 회차 안내를 엔진 상한 20회와 맞췄습니다.</p>
</section>
<section id="evidence" aria-labelledby="evidence-title">
  <div class="section-head"><div><span class="section-label">06 / EVIDENCE</span><h2 id="evidence-title">검증 기록과 재현 자료</h2><p>제품 소스 ${esc(validation.sourceCommit || '미확인')}의 기존 검증 기록입니다. 모델 실행 성과와 구분해 확인하세요.</p></div></div>
  <div class="validation-strip"><div class="validation-stat"><strong>${validation.tests ? `${validation.tests.passed}/${validation.tests.tests}` : '미확인'}</strong><span>제품 회귀 검사</span></div><div class="validation-stat"><strong>${tests ? `${n(tests.passed)}/${n(tests.tests)}` : '미실행'}</strong><span>생성 프로젝트 Node 검사</span></div><div class="validation-stat"><strong>${postReadme ? `${postReadme.result.checks.filter(c=>c.passed).length}/${postReadme.result.checks.length}` : '미실행'}</strong><span>수정 후 README 재검사</span></div></div>
  <details><summary>회귀 검사와 앱 반영 기록<span class="summary-meta">검증 범위 전체 보기</span></summary><div class="detail-body"><p>${esc(validation.summary || validation.status)}</p><ul>${(validation.items || []).map(i=>`<li>${esc(i)}</li>`).join('')}</ul></div></details>
  <details><summary>측정 조건과 해석 시 주의 사항<span class="summary-meta">예산 · 계측 · 평가 범위</span></summary><div class="detail-body"><ul><li>기본 예산은 전체 200만 토큰·모델 호출 시간 60분, 준비 50만 토큰·15분입니다. 확장·절약은 설정에서 선택합니다. 모델 시간은 전체 벽시계 시간과 다릅니다.</li><li>토큰은 응답 후 집계하므로 한 호출만큼 예산을 넘을 수 있습니다. 미보고 토큰을 0으로 확정하지 않고 시간 한도를 함께 적용합니다.</li><li>예산 도달은 자동 완료가 아닙니다. 작업 공간·체크포인트는 보존하되 예산을 무한 증액하지 않습니다. 기존 예산 소진 실행의 원클릭 증액·재개는 이번 범위에 포함되지 않았습니다.</li><li>기존 기록에 없는 상세 계측은 추정하거나 소급 보정하지 않았습니다. 실패 분류는 관찰한 오류·실행 단계에 근거하며 모든 실패 원인을 확정하는 진단기는 아닙니다.</li><li>이전과 동일하게 MCP·native plugin을 비활성화했습니다. Paper/Figma 연결, 휴대폰·Tailscale 왕복 성능을 평가한 결과가 아닙니다.</li><li>구조화 스키마는 응답 형식을 안정화합니다. 구현·QA 기준·테스트 성공은 실제 검증으로 따로 확인합니다.</li></ul><p>Codex의 turn별 <code>outputSchema</code>는 <a href="https://learn.chatgpt.com/docs/app-server">공식 App Server 문서</a>를 확인해 적용했고 엄격한 JSON 구조는 <a href="https://developers.openai.com/api/docs/guides/structured-outputs">공식 Structured Outputs 문서</a>의 형식 제한에 맞췄습니다.</p></div></details>
  <div class="resource-links"><a class="resource-link" href="assets/${dataFolder}/results.json">실제 실행 결과 JSON <span aria-hidden="true">↗</span></a><a class="resource-link" href="assets/${dataFolder}/protocol.json">비교 조건·소스 버전 <span aria-hidden="true">↗</span></a><a class="resource-link" href="assets/${dataFolder}/automatic-loop-run.json">이벤트·모델 호출 기록 <span aria-hidden="true">↗</span></a><a class="resource-link" href="assets/loop-improvements-2026-10-09/validation.json">제품 검증 기록 <span aria-hidden="true">↗</span></a><a class="resource-link" href="assets/loop-improvements-2026-10-09/results.json">기본 예산 시도 원본 <span aria-hidden="true">↗</span></a><a class="resource-link" href="current-performance-comparison-2026-10-09.html">변경 전 보고서 <span aria-hidden="true">↗</span></a></div>
</section>
<footer class="footer"><div>Loopline · 로컬 실측 보고서<br>실행일 2026. 10. 09 · 보고서 생성 ${esc(new Date().toISOString())}</div><a href="#top">맨 위로 <span aria-hidden="true">↑</span></a></footer>
</main></body></html>`;
await writeFile(join(here, '../../loop-improvements-2026-10-09.html'), html);
console.log('reports/loop-improvements-2026-10-09.html');

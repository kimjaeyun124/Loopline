import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const folder = 'loop-cycle-2026-10-09';
const json = async file => JSON.parse(await readFile(join(root, file), 'utf8'));
const phases = await Promise.all(['before', 'after'].map(async phase => {
  const result = await json(`${phase}/results.json`);
  if (!result.trials[0]?.finishedAt) throw new Error(`${phase} 실측 미완료`);
  return { phase, label: phase === 'before' ? '수정 전' : '수정 후', result, trial: result.trials[0], run: await json(`${phase}/automatic-loop-run.json`), tests: (await json(`${phase}/generated-project-tests.json`))[0] };
}));
const [before, after] = phases, evaluation = await json('evaluation.json'), validation = await json('validation.json');
const css = await readFile(join(root, '../loop-improvements-2026-10-09/report.css'), 'utf8');
const esc = value => String(value ?? '미확인').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const n = value => Number.isFinite(value) ? value.toLocaleString('ko-KR') : '미확인';
const time = ms => Number.isFinite(ms) ? `${Math.floor(ms / 60000)}분 ${(ms % 60000 / 1000).toFixed(1)}초` : '미확인';
const success = t => t.status === 'completed' && t.applied === true;
const tokens = t => `${t.missingUsageCalls ? '최소 ' : ''}${n(t.reportedTokens)}`;
const qa = t => t.independentQa?.unavailable ? '미실행' : t.independentQa ? `${n(t.independentQa.passedCheckCount)} / ${n(t.independentQa.checks.length)}` : '미확인';
const qaHistory = history => history?.length ? `${history.at(-1).checks.filter(c => c.passed).length} / ${history.at(-1).checks.length}` : '미실행';
const status = t => success(t) ? '완료 · 자동 반영 1/1' : `${({failed:'실패',limit:'회차 한도',stopped:'중지',interrupted:'중단'})[t.status] || t.status} · 자동 반영 0/1`;
const prepTokens = run => run.modelCalls.filter(c => c.phase === 'preparation').reduce((s,c) => s + (c.tokens || 0), 0);
const rows = [
  ['자동 완료·반영', p => status(p.trial)],
  ['전체 실행 시간', p => time(p.trial.elapsedMs)],
  ['보고된 토큰', p => tokens(p.trial)],
  ['모델 호출 / 사용량 미확인', p => `${p.trial.modelCalls.length}회 / ${p.trial.missingUsageCalls}회`],
  ['첫 구현까지 시간', p => p.run.firstWorkerAt ? time(p.run.firstWorkerAt - p.run.createdAt) : '미도달'],
  ['준비 단계 보고 토큰', p => n(prepTokens(p.run))],
  ['부분 작업 완료', p => p.trial.milestones.length ? `${p.trial.milestones.filter(m => m.status === 'completed').length}/${p.trial.milestones.length}` : '미진입'],
  ['제품 내부 브라우저 QA · 마지막 결과', p => qaHistory(p.run.qaHistory)],
  ['동일 독립 브라우저 QA', p => qa(p.trial)],
  ['추가 저장 복구 진단 · 양쪽 동일 검사', p => p.trial.storageQa?.unavailable ? '미실행' : p.trial.storageQa ? `${p.trial.storageQa.passedCheckCount} / ${p.trial.storageQa.checks.length}` : '미확인'],
  ['생성 프로젝트 Node 테스트', p => p.tests.status === 'NOT_RUN' ? '미실행' : `${n(p.tests.passed)} / ${n(p.tests.tests)}`],
  ['README 실행 QA · 마지막 결과', p => qaHistory(p.run.readmeQaHistory)],
  ['실행 중 수동 코드 수정 / 수동 재개', p => `${p.trial.manualCodeEdits}회 / ${p.trial.manualResumes}회`],
  ['45분 관찰 한도 중지', p => p.trial.observationStop ? '1회' : '0회'],
];
const list = (items, tag = 'ul') => `<${tag}>${items.map(item => `<li>${esc(tag === 'ol' ? item.replace(/^\d+\.\s*/, '') : item)}</li>`).join('')}</${tag}>`;
const screenshots = p => {
  const t = p.trial, shots = t.independentQa?.screenshots || [], desktop = shots.find(s => s.viewport === 'desktop' && s.checkId === 'filter') || shots.find(s => s.viewport === 'desktop'), mobile = shots.find(s => s.viewport === 'mobile' && s.checkId === 'add-and-persist') || shots.find(s => s.viewport === 'mobile');
  const base = `assets/${folder}/${p.phase}/qa-user-data/harness/${t.runId}/browser-qa/round-1/`;
  return `<figure class="screen"><figcaption><strong>${p.label} · 실제 산출물</strong><small>독립 QA ${qa(t)}</small></figcaption>${desktop ? `<a class="screen-image" href="${base}${esc(desktop.name)}"><img width="1440" height="900" loading="lazy" src="${base}${esc(desktop.name)}" alt="${p.label} 실제 데스크톱 QA 화면"></a>` : '<div class="detail-body">실행 가능한 화면이 생성되지 않아 브라우저 QA를 실행하지 못했습니다.</div>'}<div class="screen-footer">${t.exportedFiles.includes('index.html') ? `<a href="assets/${folder}/${p.phase}/projects/automatic-loop/index.html">생성 화면 직접 열기 ↗</a>` : ''}${mobile ? `<a href="${base}${esc(mobile.name)}">모바일 캡처 ↗</a>` : ''}</div></figure>`;
};
const modelTable = p => {
  const groups = new Map();
  for (const c of p.trial.modelCalls) { const key = `${c.role} · ${c.model} · ${c.effort}`; const g = groups.get(key) || {count:0,tokens:0,missing:0,ms:0}; g.count++; g.tokens += c.tokens || 0; g.missing += Number.isFinite(c.tokens) ? 0 : 1; g.ms += c.durationMs || 0; groups.set(key,g); }
  return `<details><summary>${p.label} 모델·Effort별 사용량<span class="summary-meta">${p.trial.modelCalls.length}회</span></summary><div class="detail-body"><div class="table-wrap" tabindex="0" role="region" aria-label="${p.label} 모델 사용량"><table class="usage-table"><thead><tr><th>역할 · 모델 · Effort</th><th>호출</th><th>보고 토큰</th><th>사용량 미확인</th><th>호출 시간 합</th></tr></thead><tbody>${[...groups].map(([key,g]) => `<tr><td>${esc(key)}</td><td>${g.count}</td><td>${n(g.tokens)}</td><td>${g.missing}</td><td>${time(g.ms)}</td></tr>`).join('')}</tbody></table></div></div></details>`;
};
const artifacts = [['수정 전 측정','before/results.json'],['수정 후 측정','after/results.json'],['수정 전 원본 이벤트','before/automatic-loop-run.json'],['수정 후 원본 이벤트','after/automatic-loop-run.json'],['고정 실험 조건','after/protocol.json'],['회귀 검사 로그','regression-tests.log'],['수정 전 공통 독립 QA','before/automatic-loop-independent-qa.json'],['수정 후 공통 독립 QA','after/automatic-loop-independent-qa.json'],['수정 전 저장 복구 진단','before/automatic-loop-storage-qa.json'],['수정 후 저장 복구 진단','after/automatic-loop-storage-qa.json'],['자동 반영 파일 일치 확인','after/auto-apply-check.json'],['보고서 화면 QA','report-ui-qa.json']];
const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loopline · 수정 전후 실측 보고서 · 2026-10-09</title><style>${css}</style></head><body id="top"><a class="skip-link" href="#summary">본문으로 건너뛰기</a>
<header class="topbar"><div class="shell topbar-inner"><a class="brand" href="#top"><span class="brand-mark" aria-hidden="true">∞</span>Loopline<span class="brand-divider" aria-hidden="true"></span><small>Measurement cycle</small></a><div class="topbar-meta"><span>실측 → 수정 → 재실측</span><time datetime="2026-10-09">2026. 10. 09</time></div></div></header>
<div class="shell hero"><div class="eyebrow">REAL BEFORE / AFTER</div><div class="hero-heading"><div><h1>실제 실행으로 확인한 개선 결과</h1><p class="hero-description">Focus Board 제작 과제를 같은 조건으로 실행하고, 발견된 원인을 수정한 뒤 다시 측정했습니다.</p></div><a class="button primary" href="#comparison">수정 전·후 비교 ↗</a></div><div class="hero-meta"><span>macOS arm64</span><span>Jev · Gemini · GPT</span><span>각 1회 · 최대 6회차</span><span>공통 독립 검사 50개</span><span>추가 저장 복구 진단 14개</span></div></div>
<nav class="section-nav" aria-label="보고서 목차"><div class="shell nav-links"><a href="#summary">결과 요약</a><a href="#comparison">실측 비교</a><a href="#changes">원인과 수정</a><a href="#screens">결과 화면</a><a href="#usage">모델 사용량</a><a href="#next">남은 과제</a></div></nav>
<main class="shell"><section id="summary"><div class="section-head"><div><span class="section-label">01 / RESULT</span><h2>이번 측정의 결론</h2></div><span class="status-badge ${success(after.trial) ? 'success' : ''}">${success(after.trial) ? '자동 완료' : '추가 개선 필요'}</span></div><div class="result-banner"><div><h2>${esc(evaluation.headline)}</h2><p>${esc(evaluation.summary)}</p></div></div>
<div class="metric-grid"><article class="metric"><span class="metric-label">수정 후 자동 완료·반영</span><div class="metric-value ${success(after.trial) ? 'positive' : 'warning'}">${success(after.trial) ? 1 : 0}<em>/ 1</em></div><span class="metric-note">${esc(after.trial.status)}</span></article><article class="metric"><span class="metric-label">수정 후 실행 시간</span><div class="metric-value">${time(after.trial.elapsedMs)}</div><span class="metric-note">수정 전 ${time(before.trial.elapsedMs)}</span></article><article class="metric"><span class="metric-label">수정 후 보고 토큰</span><div class="metric-value">${tokens(after.trial)}</div><span class="metric-note">${after.trial.missingUsageCalls}회 사용량 미확인</span></article><article class="metric"><span class="metric-label">공통 독립 브라우저 QA</span><div class="metric-value">${qa(after.trial)}</div><span class="metric-note">실행 결과와 자동 완료는 별도 지표</span></article></div>${list(evaluation.findings)}</section>
<section id="comparison"><div class="section-head"><div><span class="section-label">02 / COMPARISON</span><h2>동일 요구사항으로 비교</h2><p>동일 프롬프트·공통 QA·확장 예산·6회차·45분 관찰 한도. 자동 모델 선택을 그대로 사용했습니다.</p></div></div><div class="comparison-card"><table class="comparison-table" aria-label="수정 전후 실측 비교"><thead><tr><th scope="col">지표</th><th scope="col">수정 전</th><th scope="col">수정 후</th></tr></thead><tbody>${rows.map(([label, get],i) => `<tr class="${i === 0 ? 'important' : ''}"><th scope="row">${label}</th>${phases.map(p => `<td data-label="${p.label}">${esc(get(p))}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="table-note">각 버전 1회이므로 장기 성공률이나 수정의 인과 효과를 확정할 수 없습니다. 모델 서비스 장애·응답 변동·잔여 한도·누적 선택 기록은 실행 시점의 실제 상태입니다. 단일 GPT 모델은 이번에 새로 측정하지 않았습니다.</p><details><summary>완료 판정과 사람의 개입 정의<span class="summary-meta">실패 기록 보존</span></summary><div class="detail-body">${phases.map(p => `<h3>${p.label} 종료 근거</h3><p>${esc(p.trial.summary)}</p>`).join('')}<p>수동 개입은 실행 중 생성 코드 수정, 수동 이어가기, 관찰 시간 초과 중지를 각각 기록합니다. 실험 준비·제품 수정·보고서 작성 공수는 이 수치에서 제외했습니다. 수동 개입 0회만으로 자동 성공을 의미하지 않습니다. 실행하지 못한 검사는 실패 개수로 환산하지 않고 미실행으로 표시합니다.</p></div></details></section>
<section id="changes"><div class="section-head"><div><span class="section-label">03 / FIX</span><h2>실측 원인과 최소 수정</h2></div></div><div class="finding-grid"><article class="finding"><h3>확인된 원인</h3>${list(evaluation.causes)}</article><article class="finding"><h3>실제 변경</h3>${list(evaluation.changes)}</article></div><div class="validation-strip" style="margin-top:20px"><div class="validation-stat"><strong>${n(validation.passed)} / ${n(validation.tests)}</strong><span>제품 회귀 검사</span></div><div class="validation-stat"><strong>${esc(validation.targeted)}</strong><span>해당 오류 대상 검사</span></div><div class="validation-stat"><strong>${validation.packageMatched ? '일치' : '미확인'}</strong><span>패키지와 수정 소스 해시</span></div></div><p class="section-note">${esc(validation.notes)}</p><details><summary>구현·테스트 커밋<span class="summary-meta">로컬 기록</span></summary><div class="detail-body">${list(validation.commits)}</div></details></section>
<section id="screens"><div class="section-head"><div><span class="section-label">04 / OUTPUT</span><h2>산출물을 직접 비교</h2><p>이미지는 실제 독립 브라우저 QA에서 캡처했습니다. 미완료 산출물도 원래 결과대로 보존합니다.</p></div></div><div class="screens">${phases.map(screenshots).join('')}</div></section>
<section id="usage"><div class="section-head"><div><span class="section-label">05 / USAGE</span><h2>각 단계에서 사용한 AI</h2><p>준비·구현·판정의 실제 호출 내역을 기준으로 집계했습니다.</p></div></div>${phases.map(modelTable).join('')}<p class="table-note">보고 토큰은 제공자가 반환한 값의 합이며 사용량 미확인 호출은 0토큰으로 간주하지 않습니다. 캐시 입력은 중복 합산하지 않습니다. 실행별 청구 금액이 없어 달러 비용은 추정하지 않았습니다.</p></section>
<section id="next"><div class="section-head"><div><span class="section-label">06 / NEXT</span><h2>다음 개선 우선순위</h2></div></div>${list(evaluation.nextSteps, 'ol')}<div class="resource-links">${artifacts.map(([label,path]) => `<a class="resource-link" href="assets/${folder}/${path}">${label}<span>↗</span></a>`).join('')}</div><details><summary>재현 조건과 데이터 보존<span class="summary-meta">프롬프트·QA 해시</span></summary><div class="detail-body"><p>프롬프트 SHA-256: <code>${esc(after.result.protocol.promptSha256)}</code></p><p>공통 QA SHA-256: <code>${esc(after.result.protocol.qaSha256)}</code></p>${phases.map(p => `<p>${p.label} · 소스 <code>${esc(p.result.protocol.sourceCommit)}</code> · 실행 <code>${esc(p.trial.runId)}</code></p>`).join('')}<p>기존 보고서와 실패 기록은 보존했습니다. GitHub에는 게시하지 않았습니다.</p></div></details></section>
<footer class="footer"><span>Loopline · 실제 수정 전후 비교</span><a href="loop-input-contract-2026-10-09.html">직전 보고서 ↗</a></footer></main></body></html>`;
await writeFile(join(root, '../../loop-cycle-2026-10-09.html'), html);
console.log('reports/loop-cycle-2026-10-09.html');

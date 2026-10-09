import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const result = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'));
const analyses = [];
for (const trial of result.trials.filter(t => t.finishedAt)) {
  const run = JSON.parse(await readFile(join(directory, `${trial.configuration}-run.json`), 'utf8'));
  const roles = {};
  for (const role of ['planner', 'worker', 'judge']) {
    const calls = trial.modelCalls.filter(c => c.role === role);
    roles[role] = { calls: calls.length, reportedTokens: calls.reduce((sum, c) => sum + (c.tokens || 0), 0),
      missingUsage: calls.filter(c => !Number.isFinite(c.tokens)).length,
      durationMs: calls.reduce((sum, c) => sum + (c.durationMs || 0), 0),
      failures: calls.filter(c => c.status !== 'success').length };
  }
  const categories = {
    formatFallbacks: /Invalid output|Repair structured response/,
    planFeedbackRecovery: /Plan review feedback recovery|Refine QA contract|Milestone plan feedback/,
    prioritySwitches: /Priority model selected/,
    workerRouting: /Plan-aware worker|부분 작업.*모델|구현 모델.*배정/,
    automaticRecoveries: /Automatic recovery|자동 복구|자동 재개/,
  };
  const events = Object.fromEntries(Object.entries(categories).map(([key, pattern]) => [key, (run.events || []).filter(e => pattern.test(e.title)).map(e => ({ title: e.title, status: e.status, detail: e.detail }))]));
  const measuredModelTimeMs = Object.values(roles).reduce((sum, role) => sum + role.durationMs, 0);
  const summedCallTokens = Object.values(roles).reduce((sum, role) => sum + role.reportedTokens, 0);
  analyses.push({
    configuration: trial.configuration, status: trial.status,
    autonomousApplied: trial.status === 'completed' && trial.applied,
    independentTaskSuccess: trial.status === 'completed' && trial.applied && trial.independentQa?.passed === true,
    roles, events, measuredModelTimeMs,
    modelTimeFraction: measuredModelTimeMs / trial.elapsedMs,
    nonModelTimeMs: Math.max(0, trial.elapsedMs - measuredModelTimeMs),
    summedCallTokens, aggregateTokenDifference: trial.reportedTokens - summedCallTokens,
    implementationTokenFraction: trial.reportedTokens ? roles.worker.reportedTokens / trial.reportedTokens : null,
    expectedCommonChecks: 50,
    independentQa: trial.independentQa ? { passed: trial.independentQa.passed, checksPassed: trial.independentQa.passedCheckCount,
      actualCheckCount: trial.independentQa.checks.length, failures: trial.independentQa.failures } : null,
    humanIntervention: { manualCodeEdits: 0, manualResumes: trial.humanActions?.manualResumes ?? 0,
      stopRequests: trial.humanActions?.stopRequests ?? 0,
      observationStop: trial.observationStop, repairPersonMinutes: null,
      explanation: '미완료 결과를 수동 수리하지 않았음. 복구에 필요한 사람 시간은 0이 아니라 미측정.' },
  });
}
const comparisons = [];
const loop = result.trials.find(t => t.configuration === 'automatic-loop' && t.finishedAt);
for (const id of ['gpt-6-luna-max', 'gpt-6-sol-max']) {
  const single = result.trials.find(t => t.configuration === id && t.finishedAt);
  if (!single || !loop) continue;
  comparisons.push({ against: id, loopTimeRatio: loop.elapsedMs / single.elapsedMs,
    loopReportedTokenRatio: loop.reportedTokens / single.reportedTokens,
    equalSuccessOutcome: analyses.find(a => a.configuration === loop.configuration).independentTaskSuccess
      === analyses.find(a => a.configuration === single.configuration).independentTaskSuccess,
    warning: '미완료 실행의 적은 시간/토큰은 성공 산출물의 효율 개선으로 해석할 수 없음. 제공자별 토큰과 과금 단위는 다를 수 있음.' });
}
const output = { analyzedAt: new Date().toISOString(), configurations: analyses, comparisons };
await writeFile(join(directory, 'analysis.json'), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(output, null, 2));

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MIN_RUNS = 3;
const plain = (value) => String(value || '').replace(/[\r\n\0]/g, ' ').slice(0, 160);
export function taskType(task) {
  if (/(?:\bCLI\b|command.line|명령줄)/i.test(task)) return 'cli';
  if (/(?:website|web\s*(?:app|page|site)|dashboard|front.end|\bUI\b|웹|화면|디자인)/i.test(task)) return 'web';
  if (/(?:API|backend|server|서버|백엔드)/i.test(task)) return 'backend';
  return 'general';
}
const modelKey = (selection, role, type) => JSON.stringify([type, role, selection.provider, selection.model, selection.reasoningEffort || selection.effort || 'default']);
const sum = (values) => values.reduce((a, b) => a + b, 0);
const average = (values) => values.length ? Math.round(sum(values) / values.length) : null;
function wilsonLowerBound(successes, runs, z = 1.96) {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(runs) || runs < 1 || successes < 0 || successes > runs) return null;
  const rate = successes / runs, zSquared = z * z;
  const margin = z * Math.sqrt((rate * (1 - rate) + zSquared / (4 * runs)) / runs);
  return (rate + zSquared / (2 * runs) - margin) / (1 + zSquared / runs);
}

export class HarnessEvidence {
  constructor(directory) { this.directory = join(directory, 'evidence'); }
  async record(run) {
    if (!/^[a-f0-9-]{36}$/.test(run.id) || run.status === 'interrupted') return;
    const calls = (run.modelCalls || []).map((call) => ({
      role: plain(call.role), provider: plain(call.provider), model: plain(call.model), effort: plain(call.effort || 'default'),
      round: call.round || 0, durationMs: call.durationMs || 0, tokens: Number.isSafeInteger(call.tokens) ? call.tokens : null,
      status: plain(call.status), failureKind: plain(call.failureKind),
    }));
    const recoveryBreakdown = {
      modelRetries: run.events.filter((event) => /복구|재요청|대체 모델|모델 전환|모델 교체|정체/.test(event.title)).length,
      browserQaFailures: (run.qaHistory || []).filter((qa) => qa.passed === false).length,
      milestoneFailures: run.events.filter((event) => event.title.startsWith('부분 작업 수정 / Milestone failed')).length,
    };
    const actions = run.humanActions && typeof run.humanActions === 'object' ? run.humanActions : null;
    const result = { version: 2, id: run.id, type: taskType(run.task), finishedAt: run.finishedAt, status: run.status,
      completed: run.status === 'completed' && run.applied === true,
      durationMs: Math.max(0, run.finishedAt - run.createdAt), rounds: run.round,
      verificationPassed: run.verificationPassed === true,
      browserQaRequired: run.qaRequired === true, browserQaPassed: run.browserQaPassed === true,
      recoveries: sum(Object.values(recoveryBreakdown)), recoveryBreakdown,
      autoResumeAttempts: run.autoResumeAttempts || 0,
      humanIntervention: actions ? {
        measurement: 'observed-actions',
        coverage: actions.completeCoverage === true ? 'full-run' : 'partial-run',
        manualResumes: Number.isSafeInteger(actions.manualResumes) ? Math.max(0, actions.manualResumes) : 0,
        stopRequests: Number.isSafeInteger(actions.stopRequests) ? Math.max(0, actions.stopRequests) : 0,
      } : null,
      calls,
    };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, `${run.id}.json`), temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(result), { mode: 0o600, flag: 'wx' }); await rename(temporary, file);
  }
  async records() {
    let names;
    try { names = await readdir(this.directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = [];
    for (const name of names.filter((v) => /^[a-f0-9-]{36}\.json$/.test(v)).slice(-2000)) {
      try { const value = JSON.parse(await readFile(join(this.directory, name), 'utf8')); if ([1, 2].includes(value.version) && Array.isArray(value.calls)) records.push(value); }
      catch { /* A damaged measurement must not prevent program execution or become routing evidence. */ }
    }
    return records;
  }
  async summary(type) {
    const records = (await this.records()).filter((r) => !type || r.type === type);
    const groups = new Map();
    const measuredInterventions = records.filter((run) => run.humanIntervention?.measurement === 'observed-actions');
    const humanIntervention = {
      measuredRuns: measuredInterventions.length,
      partiallyMeasuredRuns: measuredInterventions.filter((run) => run.humanIntervention.coverage !== 'full-run').length,
      runsWithManualResume: measuredInterventions.filter((run) => run.humanIntervention.manualResumes > 0).length,
      manualResumes: sum(measuredInterventions.map((run) => run.humanIntervention.manualResumes)),
      runsWithStopRequest: measuredInterventions.filter((run) => run.humanIntervention.stopRequests > 0).length,
      stopRequests: sum(measuredInterventions.map((run) => run.humanIntervention.stopRequests)),
      runsWithObservedActions: measuredInterventions.filter((run) => run.humanIntervention.manualResumes > 0 || run.humanIntervention.stopRequests > 0).length,
      personTimeMinutes: null,
    };
    for (const run of records) {
      const grouped = new Map();
      for (const call of run.calls) {
        const key = modelKey(call, call.role, run.type);
        if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(call);
      }
      // Whole-run outcomes cannot be credited to every candidate used during
      // fallback. Only attribute them when a role used one model configuration.
      const isolatedRoleKeys = new Set();
      const roleKeys = new Map();
      for (const call of run.calls) {
        if (!roleKeys.has(call.role)) roleKeys.set(call.role, new Set());
        roleKeys.get(call.role).add(modelKey(call, call.role, run.type));
      }
      for (const keys of roleKeys.values()) if (keys.size === 1) isolatedRoleKeys.add(keys.values().next().value);
      for (const [key, calls] of grouped) {
        if (!groups.has(key)) groups.set(key, { type: run.type, role: calls[0].role, provider: calls[0].provider, model: calls[0].model, effort: calls[0].effort,
          runs: 0, completionMeasuredRuns: 0, completedRuns: 0, verificationMeasuredRuns: 0, verifiedRuns: 0, browserQaRuns: 0, browserQaPassedRuns: 0, calls: 0, successfulCalls: 0, missingUsageCalls: 0, reportedTokens: 0, providerFailures: 0, formatFailures: 0,
          humanInterventionMeasuredRuns: 0, partiallyMeasuredInterventionRuns: 0, fullyMeasuredInterventionRuns: 0, fullyMeasuredRunsWithObservedActions: 0,
          runsWithObservedActions: 0, runsWithManualResume: 0, manualResumes: 0, runsWithStopRequest: 0, stopRequests: 0,
          durations: [], tokenSamples: [], recoverySamples: [] });
        const group = groups.get(key);
        const outcomeAttributed = isolatedRoleKeys.has(key);
        const intervention = run.humanIntervention?.measurement === 'observed-actions' ? run.humanIntervention : null;
        if (intervention && outcomeAttributed) {
          const hasObservedActions = intervention.manualResumes > 0 || intervention.stopRequests > 0;
          group.humanInterventionMeasuredRuns++;
          group.partiallyMeasuredInterventionRuns += Number(intervention.coverage !== 'full-run');
          group.fullyMeasuredInterventionRuns += Number(intervention.coverage === 'full-run');
          group.fullyMeasuredRunsWithObservedActions += Number(intervention.coverage === 'full-run' && hasObservedActions);
          group.runsWithObservedActions += Number(hasObservedActions);
          group.runsWithManualResume += Number(intervention.manualResumes > 0);
          group.manualResumes += intervention.manualResumes;
          group.runsWithStopRequest += Number(intervention.stopRequests > 0);
          group.stopRequests += intervention.stopRequests;
        }
        // A user-stopped run remains useful for interaction counts, but not for completion or cost comparisons.
        if (['stopped', 'interrupted'].includes(run.status)) continue;
        group.runs++;
        if (outcomeAttributed) {
          group.completionMeasuredRuns++;
          group.completedRuns += Number(run.completed);
          group.verificationMeasuredRuns++;
          group.verifiedRuns += Number(run.verificationPassed);
          group.browserQaRuns += Number(run.browserQaRequired);
          group.browserQaPassedRuns += Number(run.browserQaRequired && run.browserQaPassed);
          group.recoverySamples.push(run.recoveries);
        }
        group.calls += calls.length; group.successfulCalls += calls.filter((c) => c.status === 'success').length;
        group.providerFailures += calls.filter((c) => ['quota', 'transport', 'authentication'].includes(c.failureKind)).length;
        group.formatFailures += calls.filter((c) => c.failureKind === 'format').length;
        group.missingUsageCalls += calls.filter((c) => c.tokens === null).length;
        group.reportedTokens += sum(calls.map((c) => c.tokens || 0));
        group.durations.push(sum(calls.map((c) => c.durationMs)));
        if (calls.every((c) => c.tokens !== null)) group.tokenSamples.push(sum(calls.map((c) => c.tokens)));
      }
    }
    const performanceRecords = records.filter((run) => !['stopped', 'interrupted'].includes(run.status));
    return { minimumRuns: MIN_RUNS, recordedRuns: performanceRecords.length, humanIntervention,
      attribution: '모델 호출·토큰·시간은 해당 호출에 직접 귀속합니다. 완료·검증·QA·개입·복구는 같은 역할에서 단일 모델 설정만 사용한 실행만 집계합니다. 같은 역할에서 대체·전환된 실행은 해당 지표에서 제외합니다. 나머지 완료율도 협업 실행의 관찰값이지 모델 하나의 인과 성능은 아닙니다. 사람 개입은 앱 내 수동 재개·중지 동작만 측정하며 실제 사람 투입 시간과 앱 밖의 수정은 포함하지 않습니다.', models: [...groups.entries()].map(([key, group]) => {
      const { durations, tokenSamples, recoverySamples, ...metrics } = group;
      const observedActionRate = group.fullyMeasuredInterventionRuns >= MIN_RUNS
        ? group.fullyMeasuredRunsWithObservedActions / group.fullyMeasuredInterventionRuns : null;
      return { key, ...metrics, durationRuns: durations.length, sufficientEvidence: group.completionMeasuredRuns >= MIN_RUNS,
        completionRate: group.completionMeasuredRuns ? group.completedRuns / group.completionMeasuredRuns : null, browserQaPassRate: group.browserQaRuns ? group.browserQaPassedRuns / group.browserQaRuns : null,
        completionConfidenceLowerBound: wilsonLowerBound(group.completedRuns, group.completionMeasuredRuns),
        verificationPassRate: group.verificationMeasuredRuns ? group.verifiedRuns / group.verificationMeasuredRuns : null,
        observedActionRate, humanInterventionSufficientEvidence: observedActionRate !== null,
        meanModelTimeMs: average(durations), meanReportedTokens: average(tokenSamples), fullyReportedRuns: tokenSamples.length, meanRunRecoveries: average(recoverySamples) };
    }) };
  }
  async candidate(selection, role, task, snapshot) {
    const key = modelKey(selection, role, taskType(task));
    const summary = snapshot || await this.summary(taskType(task));
    return summary.models.find((item) => item.key === key) || { runs: 0, completionMeasuredRuns: 0, durationRuns: 0, sufficientEvidence: false, minimumRuns: MIN_RUNS, completionRate: null, meanModelTimeMs: null, meanReportedTokens: null };
  }
}

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

export class HarnessEvidence {
  constructor(directory) { this.directory = join(directory, 'evidence'); }
  async record(run) {
    if (!/^[a-f0-9-]{36}$/.test(run.id) || ['interrupted', 'stopped'].includes(run.status)) return;
    const calls = (run.modelCalls || []).map((call) => ({
      role: plain(call.role), provider: plain(call.provider), model: plain(call.model), effort: plain(call.effort || 'default'),
      round: call.round || 0, durationMs: call.durationMs || 0, tokens: Number.isSafeInteger(call.tokens) ? call.tokens : null,
      status: plain(call.status), failureKind: plain(call.failureKind),
    }));
    const result = { version: 1, id: run.id, type: taskType(run.task), finishedAt: run.finishedAt, status: run.status,
      completed: run.status === 'completed' && run.applied === true,
      durationMs: Math.max(0, run.finishedAt - run.createdAt), rounds: run.round,
      verificationPassed: run.verificationPassed === true,
      browserQaRequired: run.qaRequired === true, browserQaPassed: run.browserQaPassed === true,
      recoveries: run.events.filter((event) => /복구|재요청|대체 모델|모델 전환|모델 교체|정체/.test(event.title)).length,
      autoResumeAttempts: run.autoResumeAttempts || 0,
      humanIntervention: 'not-measured', calls,
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
      try { const value = JSON.parse(await readFile(join(this.directory, name), 'utf8')); if (value.version === 1 && Array.isArray(value.calls)) records.push(value); }
      catch { /* A damaged measurement must not prevent program execution or become routing evidence. */ }
    }
    return records;
  }
  async summary(type) {
    const records = (await this.records()).filter((r) => !type || r.type === type);
    const groups = new Map();
    for (const run of records) {
      const grouped = new Map();
      for (const call of run.calls) {
        const key = modelKey(call, call.role, run.type);
        if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(call);
      }
      for (const [key, calls] of grouped) {
        if (!groups.has(key)) groups.set(key, { type: run.type, role: calls[0].role, provider: calls[0].provider, model: calls[0].model, effort: calls[0].effort,
          runs: 0, completedRuns: 0, verifiedRuns: 0, browserQaRuns: 0, browserQaPassedRuns: 0, calls: 0, successfulCalls: 0, missingUsageCalls: 0, reportedTokens: 0, providerFailures: 0, formatFailures: 0, durations: [], tokenSamples: [], recoverySamples: [] });
        const group = groups.get(key);
        group.runs++; group.completedRuns += Number(run.completed); group.verifiedRuns += Number(run.verificationPassed);
        group.browserQaRuns += Number(run.browserQaRequired); group.browserQaPassedRuns += Number(run.browserQaRequired && run.browserQaPassed);
        group.calls += calls.length; group.successfulCalls += calls.filter((c) => c.status === 'success').length;
        group.providerFailures += calls.filter((c) => ['quota', 'transport', 'authentication'].includes(c.failureKind)).length;
        group.formatFailures += calls.filter((c) => c.failureKind === 'format').length;
        group.missingUsageCalls += calls.filter((c) => c.tokens === null).length;
        group.reportedTokens += sum(calls.map((c) => c.tokens || 0));
        group.durations.push(sum(calls.map((c) => c.durationMs)));
        if (calls.every((c) => c.tokens !== null)) group.tokenSamples.push(sum(calls.map((c) => c.tokens)));
        group.recoverySamples.push(run.recoveries);
      }
    }
    return { minimumRuns: MIN_RUNS, recordedRuns: records.length, attribution: '혼합 모델 실행의 관찰값입니다. 단독 모델의 인과적 성능으로 해석하지 않습니다. 사용자 공수는 별도 계측 전까지 확인 불가입니다.', models: [...groups.entries()].map(([key, group]) => {
      const { durations, tokenSamples, recoverySamples, ...metrics } = group;
      return { key, ...metrics, sufficientEvidence: group.runs >= MIN_RUNS,
        completionRate: group.completedRuns / group.runs, browserQaPassRate: group.browserQaRuns ? group.browserQaPassedRuns / group.browserQaRuns : null,
        meanModelTimeMs: average(durations), meanReportedTokens: average(tokenSamples), fullyReportedRuns: tokenSamples.length, meanRunRecoveries: average(recoverySamples) };
    }) };
  }
  async candidate(selection, role, task, snapshot) {
    const key = modelKey(selection, role, taskType(task));
    const summary = snapshot || await this.summary(taskType(task));
    return summary.models.find((item) => item.key === key) || { runs: 0, sufficientEvidence: false, minimumRuns: MIN_RUNS, completionRate: null, meanModelTimeMs: null, meanReportedTokens: null };
  }
}

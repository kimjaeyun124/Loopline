import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectAutomaticLoopModel, recommendLoopEffort } from '../../../public/loop-policy.mjs';

const phase = process.argv[2];
if (!['before', 'after'].includes(phase)) throw new Error('before 또는 after 측정 단계를 지정하세요.');
const directory = join(dirname(fileURLToPath(import.meta.url)), phase);
const base = process.env.LOOPLINE_BENCHMARK_URL || 'http://127.0.0.1:41743';
const protocol = JSON.parse(await readFile(join(directory, 'protocol.json'), 'utf8'));
const task = await readFile(join(directory, 'prompt.txt'), 'utf8');
const priorities = ['quality', 'reasoning', 'tokenEfficiency', 'speed'];
const api = async (path, body) => {
  const response = await fetch(base + path, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  const value = await response.json();
  if (!response.ok) throw new Error(`Loopline HTTP ${response.status}: ${String(value.error || '요청 실패').slice(0, 300)}`);
  return value;
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const status = await api('/api/status');
const { connections } = await api('/api/connections');
const account = status.codexAccounts.find(a => a.connected && a.id === 'default');
if (!account) throw new Error('연결된 기본 Codex 계정이 없습니다.');
const allowedGpt = new Set(['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra']);
const models = (account.models || []).filter(m => allowedGpt.has(m.id)).map(m => ({
  ...m, provider: 'openai', codexAccountId: account.id, connected: true,
  supportedReasoningEfforts: (m.supportedReasoningEfforts || m.reasoningEfforts || []).map(e => typeof e === 'string' ? e : e.reasoningEffort),
}));
for (const connection of connections.filter(c => c.connected)) {
  for (const model of connection.models || []) {
    if (!['models/gemini-3-flash-preview', 'jev-latest'].includes(model.id)) continue;
    models.push({ ...model, provider: 'api', connectionId: connection.id, connected: true,
      supportedReasoningEfforts: model.reasoningEfforts || [], decisionOnly: connection.decisionOnly === true || model.decisionOnly === true });
  }
}
const key = m => `${m.provider}:${m.connectionId || m.codexAccountId || ''}:${m.id}`;
const selection = (model, effort, automatic = false) => ({
  provider: model.provider, model: model.id, label: model.label || model.id,
  supportedReasoningEfforts: model.supportedReasoningEfforts,
  ...(model.connectionId ? { connectionId: model.connectionId } : { codexAccountId: model.codexAccountId }),
  decisionOnly: model.decisionOnly === true, reasoningEffort: effort,
  automatic, automaticEffort: true, nativePlugins: false, loopMcp: false, instructions: '', fallbacks: [],
});
const autoRoles = Object.fromEntries(['planner', 'worker', 'judge'].map(role => {
  const selected = selectAutomaticLoopModel(role, models, key);
  if (!selected) throw new Error(`${role}에 사용할 연결된 모델이 없습니다.`);
  const primary = selection(selected, recommendLoopEffort(role, selected.supportedReasoningEfforts, task, priorities), true);
  primary.fallbacks = models.filter(m => key(m) !== key(selected) && (role === 'judge' || !m.decisionOnly))
    .map(m => selection(m, recommendLoopEffort(role, m.supportedReasoningEfforts, task, priorities)));
  return [role, primary];
}));
const configurations = [{ id: 'automatic-loop', label: '자동 Loop · Jev/Gemini/GPT', roles: autoRoles }];
for (const id of []) {
  const model = models.find(m => m.id === id && m.provider === 'openai');
  if (!model) throw new Error(`연결 목록에 ${id}가 없습니다.`);
  if (!model.supportedReasoningEfforts.includes('max')) throw new Error(`${id}에 max가 제공되지 않습니다.`);
  configurations.push({ id: `${id}-max`, label: `${model.label || id} Max 단일 Harness`, roles: Object.fromEntries(['planner', 'worker', 'judge'].map(role => [role, selection(model, 'max')])) });
}
await writeFile(join(directory, 'configurations.json'), JSON.stringify(configurations, null, 2) + '\n');
const result = { measuredAt: new Date().toISOString(), benchmarkKind: 'live connected providers through packaged Loopline Electron backend', protocol, trials: [] };
const save = async () => writeFile(join(directory, 'results.json'), JSON.stringify(result, null, 2) + '\n');
const publicFields = ['id', 'task', 'status', 'stage', 'round', 'rounds', 'createdAt', 'finishedAt', 'summary', 'source', 'workspace', 'projectName', 'applied', 'verificationPassed', 'browserQaPassed', 'readmeQaPassed', 'readmeQaRequired', 'roles', 'events', 'modelCalls', 'modelUsage', 'humanActions', 'milestones', 'qaHistory', 'readmeQaHistory', 'autoResumeAttempts', 'recoveryHistory', 'qualityRecoveries', 'modelRoutingHistory', 'verifyCommand', 'executionBudget', 'budgetExceeded', 'failureContext', 'firstWorkerAt', 'preparationReportedTokens'];
const projectFiles = ['index.html', 'styles.css', 'app.mjs', 'model.mjs', 'model.test.mjs', 'server.mjs', 'package.json', 'README.md'];
for (const configuration of configurations) {
  const started = Date.now();
  const created = await api('/api/harness/runs', { task, rounds: protocol.implementationRounds, priorities, budgetProfile: 'extended', autoApply: true, roles: configuration.roles, mcpTools: [] });
  const trial = { configuration: configuration.id, label: configuration.label, runId: created.id, startedAt: started, initialRoles: configuration.roles, observationStop: false, progress: [] };
  result.trials.push(trial); await save();
  console.log(JSON.stringify({ event: 'start', configuration: configuration.id, runId: created.id }));
  let run, lastProgress = '';
  while (true) {
    run = await api(`/api/harness/runs/${created.id}`);
    const progressKey = `${run.status}/${run.stage}/${run.round}/${run.modelCalls?.length || 0}`;
    if (progressKey !== lastProgress) {
      const progress = { at: Date.now(), elapsedMs: Date.now() - started, status: run.status, stage: run.stage, round: run.round, calls: run.modelCalls?.length || 0, tokens: Object.values(run.modelUsage || {}).reduce((sum, item) => sum + item.totalTokens, 0) };
      trial.progress.push(progress); lastProgress = progressKey; await save();
      console.log(JSON.stringify({ event: 'progress', configuration: configuration.id, ...progress }));
    }
    if (!['running', 'stopping'].includes(run.status)) break;
    if (Date.now() - started > protocol.perRunObservationCeilingMs && !trial.observationStop) {
      trial.observationStop = true;
      await api(`/api/harness/runs/${created.id}/stop`, {});
      console.log(JSON.stringify({ event: 'observation-ceiling-stop', configuration: configuration.id }));
    }
    await pause(5000);
  }
  trial.finishedAt = Date.now();
  trial.elapsedMs = Number.isFinite(run.finishedAt) && Number.isFinite(run.createdAt) ? run.finishedAt - run.createdAt : trial.finishedAt - started;
  trial.status = run.status; trial.stage = run.stage; trial.summary = run.summary;
  trial.rounds = run.round; trial.applied = run.applied === true;
  trial.verificationPassed = run.verificationPassed === true; trial.browserQaPassed = run.browserQaPassed === true;
  trial.readmeQaPassed = run.readmeQaPassed === true; trial.readmeQaRequired = run.readmeQaRequired === true;
  trial.reportedTokens = Object.values(run.modelUsage || {}).reduce((sum, item) => sum + item.totalTokens, 0);
  trial.modelUsage = Object.values(run.modelUsage || {});
  trial.modelCalls = run.modelCalls || [];
  trial.missingUsageCalls = trial.modelCalls.filter(call => !Number.isFinite(call.tokens)).length;
  trial.failedCalls = trial.modelCalls.filter(call => call.status !== 'success').length;
  trial.humanActions = run.humanActions; trial.manualCodeEdits = 0; trial.manualResumes = 0;
  trial.autoResumeAttempts = run.autoResumeAttempts || 0;
  trial.milestones = (run.milestones || []).map(m => ({ id: m.id, title: m.title, status: m.status, attempts: m.attempts, evidence: m.evidence }));
  trial.source = run.source; trial.workspace = run.workspace;
  trial.finalRoles = run.roles;
  const raw = Object.fromEntries(publicFields.filter(field => field in run).map(field => [field, run[field]]));
  await writeFile(join(directory, `${configuration.id}-run.json`), JSON.stringify(raw, null, 2) + '\n');
  const target = join(directory, 'projects', configuration.id); await mkdir(target, { recursive: true });
  trial.exportedFiles = [];
  const from = trial.applied ? run.source : run.workspace;
  const files = new Set(await readdir(from));
  for (const file of projectFiles) if (files.has(file)) { await copyFile(join(from, file), join(target, file)); trial.exportedFiles.push(file); }
  await save(); console.log(JSON.stringify({ event: 'finished', configuration: configuration.id, status: trial.status, elapsedMs: trial.elapsedMs, reportedTokens: trial.reportedTokens, calls: trial.modelCalls.length, missingUsageCalls: trial.missingUsageCalls, applied: trial.applied }));
}
result.finishedAt = new Date().toISOString(); await save();

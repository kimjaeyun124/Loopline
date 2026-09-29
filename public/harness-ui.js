import { modelEffortCapability } from './model-capabilities.mjs';
import { recommendLoopEffort, selectAutomaticLoopModel } from './loop-policy.mjs';

const KEY = 'loopline.harness.v1';
const DONE = new Set(['completed', 'reviewed', 'failed', 'stopped', 'limit', 'blocked', 'interrupted']);
const ROLES = [['planner', '계획 / Planning'], ['worker', '구현 / Implementation'], ['judge', '판정 / Review']];
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createHarnessUI({ state, catalog, modelKey, currentKey, getProject, saveProjects, saveConversations, render, toast, instructions, onComplete }) {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }
  const config = {
    enabled: saved?.enabled !== false, autoApply: saved?.autoApply !== false,
    roles: Object.fromEntries(ROLES.map(([role]) => [role, { model: typeof saved?.roles?.[role]?.model === 'string' ? saved.roles[role].model : '', effort: typeof saved?.roles?.[role]?.effort === 'string' ? saved.roles[role].effort : '' }])),
  };
  const modal = document.querySelector('#harnessModal');
  const fields = document.querySelector('#harnessRoles');
  const saveStatus = document.querySelector('#harnessSaveStatus');
  let activeRunId = null, watching = false, starting = false, stopRequested = false;
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(config));
      saveStatus.textContent = '자동 저장됨 · 다음 실행부터 적용';
      return true;
    } catch {
      saveStatus.textContent = '저장하지 못했습니다. 완료를 눌러 다시 시도하세요.';
      toast('Harness 설정을 저장하지 못했습니다. 저장 공간을 확인해 주세요.');
      return false;
    }
  };
  const currentProject = () => getProject(state.conversations.find((c) => c.id === state.activeId)?.projectId || state.activeProjectId);
  const connected = () => catalog().filter((model) => model.connected);
  const efforts = (model) => model?.provider === 'openai'
    ? (model.supportedReasoningEfforts || []).map((item) => item.reasoningEffort)
    : model?.provider === 'anthropic' ? modelEffortCapability('anthropic', model.id)?.reasoningEfforts || [] : model?.reasoningEfforts || [];
  const choose = (role) => {
    const models = connected().filter((model) => role === 'judge' || !model.decisionOnly);
    if (config.roles[role].model) return models.find((model) => modelKey(model) === config.roles[role].model);
    return selectAutomaticLoopModel(role, models, modelKey, { currentModelKey: currentKey(), workerModelKey: config.roles.worker.model });
  };
  const resolveEffort = (role, model, task = '') => {
    const allowed = efforts(model);
    if (config.roles[role].effort && !allowed.includes(config.roles[role].effort)) throw new Error(`${model.label}의 추론 강도를 다시 선택해 주세요.`);
    return config.roles[role].effort || recommendLoopEffort(role, allowed, task);
  };
  const roleGuidance = {
    planner: '자동 배정은 구현 모델을 공유해 간단한 계획 호출 비용을 줄입니다.',
    worker: '선택한 구현 모델이 코드를 작성하고, 복합 작업에는 높은 추론 강도를 사용합니다.',
    judge: 'Jev를 우선 사용하고, 없으면 가능할 때 구현과 다른 연결로 검토합니다.',
  };
  function renderRoles() {
    fields.innerHTML = ROLES.map(([role, title]) => {
      const model = choose(role), supported = efforts(model);
      const unavailableEffort = config.roles[role].effort && !supported.includes(config.roles[role].effort);
      const effortLabel = config.roles[role].effort
        ? `${config.roles[role].effort} · 직접 지정`
        : supported.length ? '자동 · 작업 난이도에 따라 조정' : model?.decisionOnly ? 'Jev 판정 전용' : '서비스 기본 추론';
      return `<div class="harness-role"><label class="project-field"><span>${title}</span><select data-harness-role="${role}" aria-label="${title} 모델"><option value="">${role === 'judge' ? '자동 · Jev 또는 독립 검토' : role === 'planner' ? '자동 · 구현 모델과 공유' : '자동 · 현재 선택 모델'}</option>${config.roles[role].model && !model ? `<option selected value="${escape(config.roles[role].model)}">저장된 모델 · 연결 확인 필요</option>` : ''}${connected().filter((item) => role === 'judge' || !item.decisionOnly).map((item) => `<option value="${escape(modelKey(item))}"${config.roles[role].model === modelKey(item) ? ' selected' : ''}>${escape(item.label)} · ${escape(item.source)}</option>`).join('')}</select></label><label class="project-field"><span>Effort</span><select data-harness-effort="${role}" aria-label="${title} 추론 강도"${!supported.length ? ' disabled' : ''}><option value="">${supported.length ? '자동' : '서비스 기본값'}</option>${unavailableEffort ? `<option selected value="${escape(config.roles[role].effort)}">${escape(config.roles[role].effort)} · 지원 확인 필요</option>` : ''}${supported.map((value) => `<option value="${escape(value)}"${config.roles[role].effort === value ? ' selected' : ''}>${escape(value)}</option>`).join('')}</select></label><small>${model ? `${escape(model.label)} · ${escape(effortLabel)} · ${escape(roleGuidance[role])}` : role === 'judge' ? 'Jev 또는 연결된 판정 모델이 필요합니다.' : '연결된 모델이 필요합니다.'}</small></div>`;
    }).join('');
  }
  function open() {
    if (state.busy) return toast('실행이 끝난 뒤 구성을 변경해 주세요.');
    document.querySelector('#harnessAutoApply').checked = config.autoApply;
    renderRoles(); modal.hidden = false; document.querySelector('#harnessClose').focus();
  }
  function close() { modal.hidden = true; document.querySelector('#harnessConfigure').focus(); }
  fields.addEventListener('change', (event) => {
    if (event.target.dataset.harnessRole) { const role = event.target.dataset.harnessRole; config.roles[role] = { model: event.target.value, effort: '' }; }
    if (event.target.dataset.harnessEffort) config.roles[event.target.dataset.harnessEffort].effort = event.target.value;
    save(); renderRoles();
  });
  document.querySelector('#harnessAutoApply').addEventListener('change', (event) => {
    config.autoApply = event.target.checked; save();
  });
  document.querySelector('#harnessSave').addEventListener('click', () => { if (save()) close(); });
  document.querySelector('#harnessClose').addEventListener('click', close);
  modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
  modal.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
  document.querySelector('#harnessConfigure').addEventListener('click', open);
  document.querySelector('#loopExecutionMode').value = config.enabled ? 'harness' : 'repeat';
  document.querySelector('#loopExecutionMode').addEventListener('change', (event) => { config.enabled = event.target.value === 'harness'; save(); render(); });
  document.querySelector('#messages').addEventListener('click', async (event) => {
    const link = event.target.closest('a');
    if (!link) return;
    const url = new URL(link.href);
    if (url.origin !== location.origin || !/^\/api\/harness\/runs\/[a-f0-9-]{36}\/patch$/.test(url.pathname)) return;
    event.preventDefault();
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error('패치를 내려받지 못했습니다.');
      const href = URL.createObjectURL(await response.blob());
      const download = document.createElement('a'); download.href = href; download.download = 'harness.patch';
      document.body.append(download); download.click(); download.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (error) { toast(error.message); }
  });

  async function request(path, body) {
    const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Harness 서버에 연결하지 못했습니다.'), { status: response.status });
    return data;
  }
  function update(run, message, conversation) {
    const pending = !DONE.has(run.status);
    message.harnessRunId = run.id; message.harnessStatus = run.status; message.pending = pending;
    if (run.stageModels) message.harnessStageModels = run.stageModels;
    message.startedAt = run.createdAt; message.workedForMs = (run.finishedAt || Date.now()) - run.createdAt;
    message.activityMode = 'native';
    message.activities = run.events.slice(-100).map((event) => ({ ...event,
      ...(event.status !== 'running' && event.detail && !event.model && !event.title.startsWith('파일 작업') ? { kind: 'commentary', text: `**${event.title}**\n\n${event.detail}` } : {}),
    }));
    message.error = ['failed', 'blocked', 'interrupted'].includes(run.status);
    message.content = pending ? `Harness · ${run.round}/${run.rounds}회차 · ${run.status === 'stopping' ? '중지 중' : ({ prepare: '작업 공간 준비', configuring: '판정 모델이 실행 환경 구성', planning: '계획 작성', working: '파일 작업', verifying: '검증', judging: '판정', applying: '프로젝트 반영' })[run.stage] || run.stage}`
      : `${run.summary || '실행을 마쳤습니다.'}${run.applied ? '\n\n프로젝트에 변경을 자동 반영했습니다.' : ''}${run.source ? `\n\n프로젝트: \`${run.source}\`` : ''}${run.workspace && run.status !== 'completed' ? `\n\n작업 공간: \`${run.workspace}\`` : ''}${run.patchAvailable ? `\n\n[변경 패치 내려받기](${location.origin}/api/harness/runs/${run.id}/patch)` : ''}`;
    if (run.source) {
      conversation.harnessWorkspace = run.source;
      const project = getProject(conversation.projectId);
      if (project && !project.workspace) { project.workspace = run.source; saveProjects(); }
    }
    conversation.updatedAt = Date.now(); saveConversations(); render();
  }
  async function watch(id, message, conversation) {
    if (watching) return;
    watching = true; activeRunId = id;
    state.busy = true; state.loopEngineeringRunning = true;
    let failures = 0;
    const poll = async () => {
      try {
        const run = await request(`/api/harness/runs/${id}`); failures = 0;
        state.busy = !DONE.has(run.status); state.loopEngineeringRunning = state.busy;
        update(run, message, conversation);
        if (DONE.has(run.status)) { watching = false; activeRunId = null; state.loopStopRequested = false; render(); if (run.status === 'completed') onComplete?.(conversation); return; }
      } catch (error) {
        if (error.status === 404) {
          watching = false; activeRunId = null; state.busy = false; state.loopEngineeringRunning = false;
          message.pending = false; message.error = true; message.harnessStatus = 'interrupted';
          message.content = '이 서버에서 실행 기록을 찾을 수 없습니다. 작업 폴더의 변경 상태를 확인한 뒤 새 실행을 시작해 주세요.';
          saveConversations(); render(); return;
        }
        failures++;
        if (failures === 3) { message.content = '진행 상태 연결을 다시 시도하고 있습니다. 서버에서 실행이 계속될 수 있습니다.'; render(); }
        if (failures === 10) toast('서버 연결을 기다립니다. 연결이 복구되면 실행 결과를 다시 표시합니다.');
      }
      setTimeout(poll, failures ? 5000 : 800);
    };
    await poll();
  }
  async function start(task, message, conversation) {
    const project = currentProject();
    const roles = {};
    for (const [role] of ROLES) {
      const model = choose(role);
      if (!model) { open(); throw new Error(role === 'judge' ? 'Jev를 연결하거나 판정 모델을 선택해 주세요.' : '사용할 모델을 연결해 주세요.'); }
      roles[role] = { provider: model.provider, source: model.source, model: model.id, label: model.label, connectionId: model.connectionId,
        codexAccountId: state.activeCodexAccountId, reasoningEffort: resolveEffort(role, model, task), instructions: instructions(model.provider) };
    }
    const workspace = project?.workspace || conversation.harnessWorkspace || undefined;
    starting = true; stopRequested = false;
    state.busy = true; state.loopEngineeringRunning = true; render();
    try {
      const run = await request('/api/harness/runs', { task, roles, workspace, rounds: state.loopEngineeringRounds, autoApply: config.autoApply, instructions: project ? `${project.instructions || ''}\n${project.knowledge || ''}` : '' });
      activeRunId = run.id;
      update(run, message, conversation);
      if (stopRequested) await stop();
      await watch(run.id, message, conversation);
    } catch (error) { state.busy = false; state.loopEngineeringRunning = false; render(); throw error; }
    finally { starting = false; }
  }
  async function stop() {
    stopRequested = true;
    if (!activeRunId) return;
    try { await request(`/api/harness/runs/${activeRunId}/stop`, {}); toast('현재 작업과 다음 회차를 중지합니다.'); }
    catch (error) { toast(error.message); }
  }
  async function resume() {
    for (const conversation of state.conversations) {
      const message = [...conversation.messages].reverse().find((item) => item.harnessRunId && !DONE.has(item.harnessStatus));
      if (message) { await watch(message.harnessRunId, message, conversation); return; }
    }
  }
  return { enable: () => { config.enabled = true; document.querySelector('#loopExecutionMode').value = 'harness'; save(); }, enabled: () => config.enabled, active: () => starting || Boolean(activeRunId), open, start, stop, resume };
}

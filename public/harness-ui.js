import { modelEffortCapability } from './model-capabilities.mjs';

const KEY = 'loopline.harness.v1';
const DONE = new Set(['completed', 'reviewed', 'failed', 'stopped', 'limit', 'blocked', 'interrupted']);
const ROLES = [['planner', '계획 / Planning'], ['worker', '구현 / Implementation'], ['judge', '판정 / Review']];
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createHarnessUI({ state, catalog, modelKey, currentKey, getProject, saveProjects, saveConversations, render, toast, instructions, onComplete }) {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }
  const config = {
    enabled: saved?.enabled !== false, workspace: typeof saved?.workspace === 'string' ? saved.workspace : '',
    verifyCommand: typeof saved?.verifyCommand === 'string' ? saved.verifyCommand : '', autoApply: saved?.autoApply !== false,
    roles: Object.fromEntries(ROLES.map(([role]) => [role, { model: typeof saved?.roles?.[role]?.model === 'string' ? saved.roles[role].model : '', effort: typeof saved?.roles?.[role]?.effort === 'string' ? saved.roles[role].effort : '' }])),
  };
  const modal = document.querySelector('#harnessModal');
  const fields = document.querySelector('#harnessRoles');
  let activeRunId = null, watching = false, starting = false, stopRequested = false;
  const save = () => localStorage.setItem(KEY, JSON.stringify(config));
  const currentProject = () => getProject(state.conversations.find((c) => c.id === state.activeId)?.projectId || state.activeProjectId);
  const connected = () => catalog().filter((model) => model.connected);
  const efforts = (model) => model?.provider === 'openai'
    ? (model.supportedReasoningEfforts || []).map((item) => item.reasoningEffort)
    : model?.provider === 'anthropic' ? modelEffortCapability('anthropic', model.id)?.reasoningEfforts || [] : model?.reasoningEfforts || [];
  const choose = (role) => {
    const models = connected();
    if (config.roles[role].model) return models.find((model) => modelKey(model) === config.roles[role].model);
    if (role === 'judge') return models.find((model) => /\bjev\b/i.test(`${model.id} ${model.label} ${model.source}`));
    const selected = models.find((model) => modelKey(model) === currentKey());
    if (role === 'worker') return selected || models[0];
    return (efforts(selected).includes('high') ? selected : models.find((model) => efforts(model).includes('high'))) || selected || models[0];
  };
  const resolveEffort = (role, model) => {
    const allowed = efforts(model);
    if (config.roles[role].effort && !allowed.includes(config.roles[role].effort)) throw new Error(`${model.label}의 추론 강도를 다시 선택해 주세요.`);
    return config.roles[role].effort || (role === 'worker' ? ['medium', 'high', 'low'] : ['high', 'medium', 'low']).find((effort) => allowed.includes(effort)) || null;
  };
  function renderRoles() {
    fields.innerHTML = ROLES.map(([role, title]) => {
      const model = choose(role), supported = efforts(model);
      return `<div class="harness-role"><label class="project-field"><span>${title}</span><select data-harness-role="${role}" aria-label="${title} 모델"><option value="">${role === 'judge' ? '자동 · Jev 연결' : '자동 · 모델 기능에 맞춰 배정'}</option>${connected().map((item) => `<option value="${escape(modelKey(item))}"${config.roles[role].model === modelKey(item) ? ' selected' : ''}>${escape(item.label)} · ${escape(item.source)}</option>`).join('')}</select></label><label class="project-field"><span>Effort</span><select data-harness-effort="${role}" aria-label="${title} 추론 강도"${!supported.length ? ' disabled' : ''}><option value="">${supported.length ? '자동' : '서비스 기본값'}</option>${supported.map((value) => `<option value="${escape(value)}"${config.roles[role].effort === value ? ' selected' : ''}>${escape(value)}</option>`).join('')}</select></label><small>${model ? `${escape(model.label)} · ${escape(resolveEffort(role, model) || '서비스 기본 추론')}` : role === 'judge' ? 'Jev를 연결하거나 사용할 판정 모델을 직접 선택하세요.' : '연결된 모델이 필요합니다.'}</small></div>`;
    }).join('');
  }
  function open() {
    if (state.busy) return toast('실행이 끝난 뒤 구성을 변경해 주세요.');
    const project = currentProject();
    document.querySelector('#harnessWorkspace').value = project?.workspace || config.workspace;
    document.querySelector('#harnessVerify').value = project?.verifyCommand || config.verifyCommand;
    document.querySelector('#harnessAutoApply').checked = config.autoApply;
    for (const [role] of ROLES) if (!efforts(choose(role)).includes(config.roles[role].effort)) config.roles[role].effort = '';
    renderRoles(); modal.hidden = false; document.querySelector('#harnessWorkspace').focus();
  }
  function close() { modal.hidden = true; document.querySelector('#harnessConfigure').focus(); }
  fields.addEventListener('change', (event) => {
    if (event.target.dataset.harnessRole) { const role = event.target.dataset.harnessRole; config.roles[role] = { model: event.target.value, effort: '' }; }
    if (event.target.dataset.harnessEffort) config.roles[event.target.dataset.harnessEffort].effort = event.target.value;
    renderRoles();
  });
  document.querySelector('#harnessSave').addEventListener('click', () => {
    config.workspace = document.querySelector('#harnessWorkspace').value.trim();
    config.verifyCommand = document.querySelector('#harnessVerify').value.trim();
    config.autoApply = document.querySelector('#harnessAutoApply').checked;
    const project = currentProject();
    if (project) { project.workspace = config.workspace; project.verifyCommand = config.verifyCommand; saveProjects(); }
    save(); close(); toast('Harness 구성을 저장했습니다.');
  });
  document.querySelector('#harnessChooseFolder').addEventListener('click', async () => {
    if (!window.looplineWorkspace) { document.querySelector('#harnessWorkspace').focus(); return toast('웹에서는 프로젝트의 절대 경로를 입력해 주세요.'); }
    try { const path = await window.looplineWorkspace.chooseFolder(); if (path) document.querySelector('#harnessWorkspace').value = path; }
    catch { toast('폴더를 선택하지 못했습니다. 경로를 직접 입력할 수 있습니다.'); }
  });
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
    message.startedAt = run.createdAt; message.workedForMs = (run.finishedAt || Date.now()) - run.createdAt;
    message.activityMode = 'native';
    message.activities = run.events.slice(-100).map((event) => ({ ...event,
      ...(event.status !== 'running' && event.detail && !event.title.startsWith('파일 작업') ? { kind: 'commentary', text: `**${event.title}**\n\n${event.detail}` } : {}),
    }));
    message.error = ['failed', 'blocked', 'interrupted'].includes(run.status);
    message.content = pending ? `Harness · ${run.round}/${run.rounds}회차 · ${run.status === 'stopping' ? '중지 중' : ({ prepare: '작업 공간 준비', planning: '계획 작성', working: '파일 작업', verifying: '검증', judging: '판정', applying: '프로젝트 반영' })[run.stage] || run.stage}`
      : `${run.summary || '실행을 마쳤습니다.'}${run.applied ? '\n\n프로젝트에 변경을 자동 반영했습니다.' : ''}${run.workspace && run.status !== 'completed' ? `\n\n작업 공간: \`${run.workspace}\`` : ''}${run.patchAvailable ? `\n\n[변경 패치 내려받기](${location.origin}/api/harness/runs/${run.id}/patch)` : ''}`;
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
      roles[role] = { provider: model.provider, model: model.id, label: model.label, connectionId: model.connectionId,
        codexAccountId: state.activeCodexAccountId, reasoningEffort: resolveEffort(role, model), instructions: instructions(model.provider) };
    }
    const workspace = project?.workspace || config.workspace, verifyCommand = project?.verifyCommand || config.verifyCommand;
    if (!workspace || !verifyCommand) { open(); throw new Error('Harness 구성에서 작업 폴더와 검증 명령을 지정해 주세요.'); }
    starting = true; stopRequested = false;
    state.busy = true; state.loopEngineeringRunning = true; render();
    try {
      const run = await request('/api/harness/runs', { task, roles, workspace, verifyCommand, rounds: state.loopEngineeringRounds, autoApply: config.autoApply, instructions: project ? `${project.instructions || ''}\n${project.knowledge || ''}` : '' });
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
  return { enabled: () => config.enabled, active: () => starting || Boolean(activeRunId), open, start, stop, resume };
}

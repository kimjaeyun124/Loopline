import { modelEffortCapability, modelSelectionStrength } from './model-capabilities.mjs';
import { DEFAULT_LOOP_PRIORITIES, LOOP_PRIORITY_DIMENSIONS, normalizeLoopPriorities, recommendLoopEffort, selectAutomaticLoopModel } from './loop-policy.mjs';

const KEY = 'loopline.harness.v1';
const DONE = new Set(['completed', 'reviewed', 'failed', 'stopped', 'limit', 'blocked', 'interrupted']);
const ROLES = [['planner', '계획 / Planning'], ['worker', '구현 / Implementation'], ['judge', '판정 / Review']];
const MAX_FALLBACKS = 8;
const MAX_LOOP_MCP_TOOLS = 64;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createHarnessUI({ state, catalog, modelKey, currentKey, getProject, saveProjects, saveConversations, render, toast, instructions, onComplete, getMcpTools = () => [], refreshMcpTools = null }) {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }
  const config = {
    enabled: saved?.enabled !== false, autoApply: saved?.autoApply !== false,
    mcpTools: Array.isArray(saved?.mcpTools) ? saved.mcpTools.filter((tool) => tool && typeof tool.serverId === 'string' && typeof tool.name === 'string').slice(0, MAX_LOOP_MCP_TOOLS) : [],
    priorities: normalizeLoopPriorities(saved?.priorities),
    roles: Object.fromEntries(ROLES.map(([role]) => [role, {
      model: typeof saved?.roles?.[role]?.model === 'string' ? saved.roles[role].model : '',
      nativePlugins: saved?.roles?.[role]?.nativePlugins !== false, loopMcp: saved?.roles?.[role]?.loopMcp !== false,
      effort: typeof saved?.roles?.[role]?.effort === 'string' ? saved.roles[role].effort : '',
      fallbacks: Array.isArray(saved?.roles?.[role]?.fallbacks) ? saved.roles[role].fallbacks.filter((value) => typeof value === 'string').slice(0, MAX_FALLBACKS) : [],
      fallbacksConfigured: Array.isArray(saved?.roles?.[role]?.fallbacks),
    }])),
  };
  const modal = document.querySelector('#harnessModal');
  const fields = document.querySelector('#harnessRoles');
  const mcpFields = document.querySelector('#harnessMcpTools');
  const priorityFields = document.querySelector('#harnessPriorities');
  const saveStatus = document.querySelector('#harnessSaveStatus');
  const search = document.querySelector('#harnessModelSearch');
  const expandedFallbacks = new Set();
  let measuredModels = [];
  let activeRunId = null, watching = false, starting = false, stopRequested = false;
  const save = () => {
    try {
      const persisted = { ...config, priorities: normalizeLoopPriorities(config.priorities), roles: Object.fromEntries(ROLES.map(([role]) => [role, {
        model: config.roles[role].model, effort: config.roles[role].effort, nativePlugins: config.roles[role].nativePlugins, loopMcp: config.roles[role].loopMcp, fallbacks: config.roles[role].fallbacks.slice(0, MAX_FALLBACKS),
      }])) };
      localStorage.setItem(KEY, JSON.stringify(persisted));
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
  const modelByKey = (key) => connected().find((model) => modelKey(model) === key) || null;
  const choose = (role) => {
    const models = connected().filter((model) => role === 'judge' || !model.decisionOnly);
    if (config.roles[role].model) return models.find((model) => modelKey(model) === config.roles[role].model);
    return selectAutomaticLoopModel(role, models, modelKey, { currentModelKey: currentKey(), workerModelKey: config.roles.worker.model });
  };
  const resolveEffort = (role, model, task = '') => {
    const allowed = efforts(model);
    if (config.roles[role].effort && !allowed.includes(config.roles[role].effort)) throw new Error(`${model.label}의 추론 강도를 다시 선택해 주세요.`);
    return config.roles[role].effort || recommendLoopEffort(role, allowed, task, config.priorities);
  };
  const resolveFallbackEffort = (role, model, task) => {
    const allowed = efforts(model);
    return allowed.includes(config.roles[role].effort)
      ? config.roles[role].effort
      : recommendLoopEffort(role, allowed, task, config.priorities);
  };
  function suggestedFallbacks(role) {
    const primary = choose(role);
    if (!primary) return [];
    const models = connected().filter((model) => role === 'judge' || !model.decisionOnly);
    const preferred = [];
    if (role === 'judge') preferred.push(...models.filter((model) => model.decisionOnly));
    for (const [otherRole] of ROLES) {
      if (otherRole === role) continue;
      const other = choose(otherRole);
      if (other) preferred.push(other);
    }
    const current = models.find((model) => modelKey(model) === currentKey());
    if (current) preferred.push(current);
    preferred.push(...models);
    const seen = new Set([modelKey(primary)]);
    return preferred.filter((model) => {
      if (role !== 'judge' && model.decisionOnly) return false;
      const key = modelKey(model);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, MAX_FALLBACKS).map(modelKey);
  }
  function ensureFallbackPriority() {
    let changed = false;
    for (const [role] of ROLES) {
      const settings = config.roles[role];
      if (settings.fallbacksConfigured) continue;
      settings.fallbacks = suggestedFallbacks(role);
      settings.fallbacksConfigured = true;
      changed = true;
    }
    if (changed) save();
  }
  const roleGuidance = {
    planner: '자동은 작업 적합도와 완료 우선순위를 기준으로 후보를 고릅니다.',
    worker: '자동은 개인 연산 우선순위를 반영하고, 품질 우선이면 높은 추론 강도를 사용합니다.',
    judge: '이 모델은 자동 배정 판단과 실행 결과 검토에 사용됩니다.',
  };
  const budgetLabel = (model) => Number.isFinite(model?.remainingPercent)
    ? `계정 한도 ${Math.max(0, Math.min(100, model.remainingPercent))}% 남음` : '잔여 한도 미제공';
  function modelOptions(models, selected = '') {
    const query = search.value.trim().toLocaleLowerCase();
    const visible = models.filter((model) => modelKey(model) === selected
      || `${model.label} ${model.id} ${model.source} ${modelSelectionStrength(model)}`.toLocaleLowerCase().includes(query));
    const groups = new Map();
    for (const model of visible) {
      const group = model.source || '연결된 모델';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(model);
    }
    return [...groups].map(([source, items]) => `<optgroup label="${escape(source)}">${items.map((model) => `<option value="${escape(modelKey(model))}"${selected === modelKey(model) ? ' selected' : ''}>${escape(model.label)}${modelSelectionStrength(model) ? ` · ${escape(modelSelectionStrength(model))}` : ''}${Number.isFinite(model.remainingPercent) ? ` · 한도 ${Math.max(0, model.remainingPercent)}%` : ''}</option>`).join('')}</optgroup>`).join('')
      || '<option disabled>검색 결과 없음</option>';
  }
  function renderRoles() {
    fields.innerHTML = ROLES.map(([role, title]) => {
      const model = choose(role), supported = efforts(model);
      const unavailableEffort = config.roles[role].effort && !supported.includes(config.roles[role].effort);
      const effortLabel = config.roles[role].effort
        ? `${config.roles[role].effort} · 직접 지정`
        : supported.length ? '자동 · 작업 난이도에 따라 조정' : model?.decisionOnly ? 'Jev 판정 전용' : '서비스 기본 추론';
      const primaryKey = model ? modelKey(model) : '';
      const savedFallbacks = config.roles[role].fallbacks.filter((key) => key !== primaryKey);
      const fallbackModels = savedFallbacks.map((key) => ({ key, model: modelByKey(key) }));
      const available = connected().filter((item) => role === 'judge' || !item.decisionOnly);
      const eligible = available.filter((item) => modelKey(item) !== primaryKey && !savedFallbacks.includes(modelKey(item)));
      const fallbackList = fallbackModels.map(({ key, model: fallback }, index) => `<li class="harness-fallback-item">
        <span class="harness-fallback-index">${index + 1}</span>
        <span class="harness-fallback-name">${fallback ? `${escape(fallback.label)} · ${escape(fallback.source)}${role !== 'judge' && fallback.decisionOnly ? ' · 판정 전용, 이 역할에서 건너뜀' : ''}` : '연결을 확인할 수 없는 저장 모델'}</span>
        <span class="harness-fallback-actions">
          <button type="button" data-fallback-move="${role}" data-key="${escape(key)}" data-direction="up" aria-label="${title} ${index + 1}순위 올리기"${index === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" data-fallback-move="${role}" data-key="${escape(key)}" data-direction="down" aria-label="${title} ${index + 1}순위 내리기"${index === fallbackModels.length - 1 ? ' disabled' : ''}>↓</button>
          <button type="button" data-fallback-remove="${role}" data-key="${escape(key)}" aria-label="${title} ${index + 1}순위 제거">×</button>
        </span></li>`).join('');
      return `<div class="harness-role">
        <label class="project-field"><span>${title}</span><select data-harness-role="${role}" aria-label="${title} 모델">
          <option value="">자동</option>
          ${config.roles[role].model && !model ? `<option selected value="${escape(config.roles[role].model)}">저장된 모델 · 연결 확인 필요</option>` : ''}
          ${modelOptions(available, config.roles[role].model)}</select></label>
        <label class="project-field"><span>추론 강도</span><select data-harness-effort="${role}" aria-label="${title} 추론 강도"${!supported.length ? ' disabled' : ''}>
          <option value="">${supported.length ? '자동' : '서비스 기본값'}</option>
          ${unavailableEffort ? `<option selected value="${escape(config.roles[role].effort)}">${escape(config.roles[role].effort)} · 지원 확인 필요</option>` : ''}
          ${supported.map((value) => `<option value="${escape(value)}"${config.roles[role].effort === value ? ' selected' : ''}>${escape(value)}</option>`).join('')}</select></label>
        <div class="harness-role-summary"><strong>${!config.roles[role].model ? '기본 후보 · ' : ''}${model ? escape(model.label) : '사용 가능한 모델 없음'}</strong><span>${model ? escape(budgetLabel(model)) : '연결과 잔여 한도를 확인하세요.'}</span></div>
        <div class="harness-measured">${(() => { const item = measuredModels.find((m) => m.role === role && m.provider === model?.provider && m.model === model?.id && m.effort === (config.roles[role].effort || resolveEffort(role, model) || 'default')); if (!item) return '실측 기록 축적 중 · 같은 작업 유형·역할·Effort로 비교'; const completionRuns = item.completionMeasuredRuns ?? 0; const switchedRoles = item.runs > completionRuns; return `${item.type} 실행 참여 ${item.runs}회 · 역할 단독 완료 ${item.completedRuns}/${completionRuns}${switchedRoles ? ' (역할 내 모델 전환 실행 제외)' : ''} · QA ${item.browserQaPassedRuns}/${item.browserQaRuns} · 호출 토큰 ${item.reportedTokens.toLocaleString()}${item.missingUsageCalls ? ` (사용량 누락 ${item.missingUsageCalls}호출)` : ''}${item.humanInterventionMeasuredRuns ? ` · 개입 계측 ${item.humanInterventionMeasuredRuns}개 실행${item.partiallyMeasuredInterventionRuns ? ' (일부 기록)' : ''} · 수동 재개 ${item.manualResumes}회 · 중지 요청 ${item.stopRequests}회` : ''} · ${item.sufficientEvidence ? '선택 근거 제공' : '표본 축적 중'}`; })()}</div>
        <small>${model ? `${escape(modelSelectionStrength(model) || effortLabel)} · ${escape(effortLabel)} · ${escape(roleGuidance[role])}` : '모델을 연결하거나 직접 선택해 주세요.'}</small>
        <div class="harness-agent-tools"><label><input type="checkbox" data-harness-native="${role}"${config.roles[role].nativePlugins ? ' checked' : ''}> 이 Agent의 Plugin·Skill·MCP 사용</label><label><input type="checkbox" data-harness-shared="${role}"${config.roles[role].loopMcp ? ' checked' : ''}> Loopline MCP 사용</label><small>Codex·Claude의 기존 연결을 사용합니다. API 모델은 Loopline MCP를 사용하며 Jev 판정에는 도구를 전달하지 않습니다.</small></div>
        <details class="harness-fallbacks" data-fallback-details="${role}"${expandedFallbacks.has(role) ? ' open' : ''}>
          <summary class="harness-fallback-heading"><strong>한도 소진 시 대체 순서</strong><span>${fallbackModels.length}개 · 펼쳐서 편집</span></summary>
          <section aria-label="${title} 대체 모델 우선순위"><ol>${fallbackList || '<li class="harness-fallback-empty">대체 모델이 없습니다.</li>'}</ol>
          <div class="harness-fallback-add"><select data-fallback-select="${role}" aria-label="${title} 대체 모델 선택"><option value="">대체 모델 추가…</option>${modelOptions(eligible)}</select>
          <button type="button" data-fallback-add="${role}"${config.roles[role].fallbacks.length >= MAX_FALLBACKS || !eligible.length ? ' disabled' : ''}>추가</button></div></section>
          <small>판정 모델이 대체 순서를 제안하고, 실행 중에는 잔여 한도와 실패 여부를 확인해 다음 후보로 전환합니다. 잔여 한도 미제공은 사용 가능량을 알 수 없다는 뜻입니다.</small>
        </details></div>`;
    }).join('');
  }
  function renderPriorities() {
    const movable = normalizeLoopPriorities(config.priorities);
    priorityFields.innerHTML = `<ol class="harness-priority-list"><li class="harness-priority-item locked"><span class="harness-priority-index">1</span><strong>완료 안정성</strong><span class="harness-priority-lock">항상 최우선</span></li>${movable.map((id, index) => {
      const item = LOOP_PRIORITY_DIMENSIONS.find((dimension) => dimension.id === id);
      return `<li class="harness-priority-item"><span class="harness-priority-index">${index + 2}</span><strong>${escape(item.label)}</strong><span class="harness-priority-actions"><button type="button" data-priority-move="${id}" data-direction="up" aria-label="${escape(item.label)} 우선순위 올리기"${index === 0 ? ' disabled' : ''}>↑</button><button type="button" data-priority-move="${id}" data-direction="down" aria-label="${escape(item.label)} 우선순위 내리기"${index === movable.length - 1 ? ' disabled' : ''}>↓</button></span></li>`;
    }).join('')}</ol>`;
  }
  function renderMcpTools() {
    const available = typeof getMcpTools === 'function' ? getMcpTools() : [];
    const automaticCount = available.filter((tool) => tool.autoRun).length;
    if (!available.length) {
      mcpFields.innerHTML = `<p class="settings-footnote">사용 가능한 MCP 도구가 없습니다. Paper 또는 Figma를 연결 설정에서 자동 사용으로 켜면 다음 Loop 실행부터 포함됩니다. <button type="button" class="text-button" data-open-mcp-settings>MCP 연결 설정 열기</button></p>${config.mcpTools.length ? '<p class="harness-mcp-warning">저장한 도구 연결이 없습니다. MCP 연결을 다시 열고 Loop 구성을 새로 저장해 주세요.</p>' : ''}`;
      return;
    }
    const keys = new Set(available.map((tool) => JSON.stringify([tool.serverId, tool.name])));
    const missing = config.mcpTools.filter((tool) => !keys.has(JSON.stringify([tool.serverId, tool.name])));
    mcpFields.innerHTML = `<p class="settings-footnote">${automaticCount}개 도구가 연결 설정에 따라 자동 제공됩니다. 호출은 각 Loop 단계에서 확인할 수 있습니다.</p><div class="harness-mcp-list">${available.map((tool) => {
      const key = JSON.stringify([tool.serverId, tool.name]);
      const checked = config.mcpTools.some((savedTool) => savedTool.serverId === tool.serverId && savedTool.name === tool.name);
      const automatic = tool.autoRun === true;
      return `<label class="harness-mcp-tool"><input type="checkbox" data-harness-mcp-tool="${escape(key)}"${automatic || checked ? ' checked' : ''}${automatic ? ' disabled title="연결 설정에서 자동 제공됩니다."' : !checked && config.mcpTools.length + automaticCount >= MAX_LOOP_MCP_TOOLS ? ' disabled' : ''} /><span><strong>${escape(tool.name)}${automatic ? ' · 자동' : ''}</strong><small>${escape(tool.serverName)}${tool.description ? ` · ${escape(tool.description)}` : ''}</small></span></label>`;
    }).join('')}</div>${missing.length ? `<p class="harness-mcp-warning">이전에 고른 도구 ${missing.length}개가 현재 연결에서 보이지 않습니다. 해당 MCP 서버에 다시 연결한 뒤 선택을 갱신하세요.</p>` : ''}`;
  }
  function open() {
    if (state.busy) return toast('실행이 끝난 뒤 구성을 변경해 주세요.');
    document.querySelector('#harnessAutoApply').checked = config.autoApply;
    search.value = ''; ensureFallbackPriority(); renderPriorities(); renderRoles(); renderMcpTools(); modal.hidden = false; document.querySelector('#harnessClose').focus();
    void request('/api/harness/evidence').then((evidence) => { measuredModels = evidence.models || []; renderRoles(); }).catch(() => {});
    if (typeof refreshMcpTools === 'function') void Promise.resolve(refreshMcpTools({ quiet: true })).then(renderMcpTools);
  }
  function close() { modal.hidden = true; document.querySelector('#harnessConfigure').focus(); }
  search.addEventListener('input', renderRoles);
  fields.addEventListener('toggle', (event) => {
    const role = event.target.dataset.fallbackDetails;
    if (role) event.target.open ? expandedFallbacks.add(role) : expandedFallbacks.delete(role);
  }, true);
  priorityFields.addEventListener('click', (event) => {
    const button = event.target.closest('[data-priority-move]');
    if (!button) return;
    const index = config.priorities.indexOf(button.dataset.priorityMove);
    const next = index + (button.dataset.direction === 'up' ? -1 : 1);
    if (index < 0 || next < 0 || next >= config.priorities.length) return;
    [config.priorities[index], config.priorities[next]] = [config.priorities[next], config.priorities[index]];
    save(); renderPriorities();
  });
  mcpFields.addEventListener('change', (event) => {
    const checkbox = event.target.closest('[data-harness-mcp-tool]');
    if (!checkbox) return;
    let serverId, name;
    try { [serverId, name] = JSON.parse(checkbox.dataset.harnessMcpTool); } catch { checkbox.checked = false; return; }
    const index = config.mcpTools.findIndex((tool) => tool.serverId === serverId && tool.name === name);
    if (checkbox.checked && index < 0) {
      const automaticCount = (typeof getMcpTools === 'function' ? getMcpTools() : []).filter((tool) => tool.autoRun).length;
      if (config.mcpTools.length + automaticCount >= MAX_LOOP_MCP_TOOLS) { checkbox.checked = false; toast(`자동 제공 도구를 포함해 Loop에는 최대 ${MAX_LOOP_MCP_TOOLS}개 MCP 도구를 사용할 수 있습니다.`); return; }
      config.mcpTools.push({ serverId, name });
    } else if (!checkbox.checked && index >= 0) config.mcpTools.splice(index, 1);
    save(); renderMcpTools();
  });
  mcpFields.addEventListener('click', (event) => {
    if (event.target.closest('[data-open-mcp-settings]')) {
      close();
      document.querySelector('#settingsButtonTop').click();
      document.querySelector('#mcpTab').click();
    }
  });
  document.querySelector('#harnessUseAutomatic').addEventListener('click', () => {
    for (const [role] of ROLES) {
      config.roles[role].model = ''; config.roles[role].effort = '';
    }
    search.value = ''; save(); renderRoles();
  });
  fields.addEventListener('change', (event) => {
    const native = event.target.dataset.harnessNative, shared = event.target.dataset.harnessShared;
    if (native || shared) { config.roles[native || shared][native ? 'nativePlugins' : 'loopMcp'] = event.target.checked; save(); return; }
    // Choosing an add candidate must survive until the Add button is pressed.
    if (!event.target.dataset.harnessRole && !event.target.dataset.harnessEffort) return;
    if (event.target.dataset.harnessRole) {
      const role = event.target.dataset.harnessRole;
      config.roles[role].model = event.target.value;
      config.roles[role].effort = '';
    }
    if (event.target.dataset.harnessEffort) config.roles[event.target.dataset.harnessEffort].effort = event.target.value;
    save(); renderRoles();
  });
  fields.addEventListener('click', (event) => {
    const add = event.target.closest('[data-fallback-add]');
    const move = event.target.closest('[data-fallback-move]');
    const remove = event.target.closest('[data-fallback-remove]');
    const role = add?.dataset.fallbackAdd || move?.dataset.fallbackMove || remove?.dataset.fallbackRemove;
    if (!role || !config.roles[role]) return;
    const fallbacks = config.roles[role].fallbacks;
    expandedFallbacks.add(role);
    if (add) {
      const select = fields.querySelector(`[data-fallback-select="${role}"]`);
      const key = select?.value;
      const candidate = modelByKey(key);
      if (!candidate || (role !== 'judge' && candidate.decisionOnly) || key === modelKey(choose(role) || {}) || fallbacks.includes(key) || fallbacks.length >= MAX_FALLBACKS) return;
      fallbacks.push(key);
      select.value = '';
    } else if (remove) {
      const index = fallbacks.indexOf(remove.dataset.key);
      if (index < 0) return;
      fallbacks.splice(index, 1);
    } else {
      const visible = fallbacks.filter((key) => key !== modelKey(choose(role) || {}));
      const position = visible.indexOf(move.dataset.key);
      const neighbor = visible[position + (move.dataset.direction === 'up' ? -1 : 1)];
      const index = fallbacks.indexOf(move.dataset.key), next = fallbacks.indexOf(neighbor);
      if (position < 0 || index < 0 || next < 0) return;
      [fallbacks[index], fallbacks[next]] = [fallbacks[next], fallbacks[index]];
    }
    config.roles[role].fallbacksConfigured = true;
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
    message.harnessCanResume = run.canResume === true;
    if (run.stageModels) message.harnessStageModels = run.stageModels;
    message.startedAt = run.createdAt; message.workedForMs = (run.finishedAt || Date.now()) - run.createdAt;
    message.activityMode = 'native';
    message.activities = run.events.slice(-100).map((event) => ({ ...event,
      ...(event.status !== 'running' && event.detail && !event.model && !event.title.startsWith('파일 작업') ? { kind: 'commentary', text: `**${event.title}**\n\n${event.detail}` } : {}),
    }));
    message.error = ['failed', 'blocked', 'interrupted'].includes(run.status);
    message.content = pending ? `Harness · ${run.round}/${run.rounds}회차${run.autoRounds ? ' · 자동 최대 10회' : ''} · ${run.status === 'stopping' ? '중지 중' : ({ selecting: '판정 모델이 주·대체 모델 순위 선택', prepare: '작업 공간 준비', configuring: '판정 모델이 실행 환경 구성', planning: '계획 작성', working: '파일 작업', verifying: '프로젝트 검증', 'browser-qa': '독립 브라우저 QA', 'milestone-qa': '부분 작업 검증', judging: '판정', applying: '프로젝트 반영' })[run.stage] || run.stage}`
      : `${run.summary || '실행을 마쳤습니다.'}${run.applied ? '\n\n프로젝트에 변경을 자동 반영했습니다.' : ''}${run.source ? `\n\n프로젝트: \`${run.source}\`` : ''}${run.workspace && run.status !== 'completed' ? `\n\n작업 공간: \`${run.workspace}\`` : ''}${run.milestones?.length ? `\n\n부분 작업 ${run.milestones.filter((task) => task.status === 'completed').length}/${run.milestones.length} 완료\n${run.milestones.map((task) => `- ${task.status === 'completed' ? '✓' : task.status === 'needs-review' ? '↻' : '○'} ${task.title} · ${task.evidence?.reviewed ? '검증 근거 보존' : '검증 대기'}`).join('\n')}` : ''}${run.qaHistory?.length ? `\n\n독립 브라우저 QA: ${run.browserQaPassed ? '통과' : '실패'} · ${run.qaHistory.at(-1).checks?.length || 0}개 검사\n${(run.qaHistory.at(-1).screenshots || []).map((image) => `[${image.viewport} · ${image.checkId}](${location.origin}/api/harness/runs/${run.id}/qa/${run.qaHistory.at(-1).round}/${image.name})`).join(' · ')}` : ''}${run.patchAvailable ? `\n\n[변경 패치 내려받기](${location.origin}/api/harness/runs/${run.id}/patch)` : ''}`;
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
    ensureFallbackPriority();
    const roleSelection = (role, model, primary) => ({
      provider: model.provider, source: model.source, model: model.id, label: model.label,
      description: typeof model.description === 'string' ? model.description.slice(0, 600) : '',
      supportedReasoningEfforts: efforts(model),
      connectionId: model.connectionId,
      ...(model.provider === 'openai' ? {
        codexAccountId: model.codexAccountId || state.activeCodexAccountId,
        ...(Number.isFinite(model.remainingPercent) ? { remainingPercent: model.remainingPercent } : {}),
      } : {}),
      ...(model.decisionOnly ? { decisionOnly: true } : {}),
      reasoningEffort: primary ? resolveEffort(role, model, task) : resolveFallbackEffort(role, model, task),
      instructions: instructions(model.provider), nativePlugins: config.roles[role].nativePlugins, loopMcp: config.roles[role].loopMcp,
    });
    for (const [role] of ROLES) {
      const model = choose(role);
      if (!model) { open(); throw new Error(role === 'judge' ? 'Jev를 연결하거나 판정 모델을 선택해 주세요.' : '사용할 모델을 연결해 주세요.'); }
      const fallbacks = config.roles[role].fallbacks.map(modelByKey)
        .filter((candidate) => candidate && (role === 'judge' || !candidate.decisionOnly) && modelKey(candidate) !== modelKey(model));
      roles[role] = { ...roleSelection(role, model, true), automatic: !config.roles[role].model, fallbacks: fallbacks.map((candidate) => roleSelection(role, candidate, false)) };
    }
    const workspace = project?.workspace || conversation.harnessWorkspace || undefined;
    starting = true; stopRequested = false;
    state.busy = true; state.loopEngineeringRunning = true; render();
    try {
      const run = await request('/api/harness/runs', { task, roles, priorities: config.priorities, workspace, rounds: state.loopEngineeringRounds, autoApply: config.autoApply, mcpTools: config.mcpTools, instructions: project ? `${project.instructions || ''}\n${project.knowledge || ''}` : '' });
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
  async function resumeRun(message, conversation) {
    if (!message?.harnessRunId || starting || watching) return;
    starting = true; state.busy = true; state.loopEngineeringRunning = true; render();
    try {
      const run = await request(`/api/harness/runs/${message.harnessRunId}/resume`, {});
      activeRunId = run.id;
      update(run, message, conversation);
      await watch(run.id, message, conversation);
    } catch (error) {
      state.busy = false; state.loopEngineeringRunning = false; render();
      toast(error.message);
    } finally { starting = false; }
  }
  return { enable: () => { config.enabled = true; document.querySelector('#loopExecutionMode').value = 'harness'; save(); }, enabled: () => config.enabled, active: () => starting || Boolean(activeRunId), open, start, stop, resume, resumeRun };
}

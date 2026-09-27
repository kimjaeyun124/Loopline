import { parseProviderExport } from './export-importer.js';

const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    mark: '◉',
    models: [
      { id: 'gpt-5.6', label: 'GPT-5.6 Sol' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    ],
  },
  anthropic: {
    label: 'Claude',
    mark: '✳',
    models: [
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'claude-opus-5', label: 'Claude Opus 5' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    ],
  },
};

const STORAGE_KEY = 'mosaic-ai.conversations.v1';
const PREFERENCE_KEY = 'mosaic-ai.preferences.v1';
const PROJECT_STORAGE_KEY = 'mosaic-ai.projects.v1';
const state = {
  conversations: loadConversations(),
  projects: loadProjects(),
  pendingProjectImport: null,
  activeId: null,
  activeProjectId: null,
  editingProjectId: null,
  movingConversationId: null,
  provider: 'openai',
  model: 'gpt-5.6',
  fastMode: false,
  providers: {
    openai: { installed: false, connected: false, label: '상태 확인 중' },
    anthropic: { installed: false, connected: false, label: '상태 확인 중' },
  },
  loginJobs: {},
  loginUrls: {},
  busy: false,
  controller: null,
  codexAccounts: [],
  activeCodexAccountId: 'default',
  busyCodexAccountIds: new Set(),
  busyClaudeDisconnect: false,
};
state.activeId = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id || null;

const elements = {
  sidebar: document.querySelector('#sidebar'),
  conversationList: document.querySelector('#conversationList'),
  projectList: document.querySelector('#projectList'),
  projectModal: document.querySelector('#projectModal'),
  projectMoveModal: document.querySelector('#projectMoveModal'),
  projectNameInput: document.querySelector('#projectNameInput'),
  projectInstructionsInput: document.querySelector('#projectInstructionsInput'),
  projectKnowledgeInput: document.querySelector('#projectKnowledgeInput'),
  projectImportModal: document.querySelector('#projectImportModal'),
  projectImportFile: document.querySelector('#projectImportFile'),
  projectImportName: document.querySelector('#projectImportName'),
  projectImportProvider: document.querySelector('#projectImportProvider'),
  projectImportSummary: document.querySelector('#projectImportSummary'),
  projectImportError: document.querySelector('#projectImportError'),
  projectMoveSelect: document.querySelector('#projectMoveSelect'),
  conversationProjectBar: document.querySelector('#conversationProjectBar'),
  conversationProjectLabel: document.querySelector('#conversationProjectLabel'),
  conversationProjectAction: document.querySelector('#conversationProjectAction'),
  chatScroll: document.querySelector('#chatScroll'),
  welcome: document.querySelector('#welcome'),
  messages: document.querySelector('#messages'),
  composerForm: document.querySelector('#composerForm'),
  messageInput: document.querySelector('#messageInput'),
  sendButton: document.querySelector('#sendButton'),
  modelSelect: document.querySelector('#modelSelect'),
  fastModeToggle: document.querySelector('#fastModeToggle'),
  providerSelectButton: document.querySelector('#providerSelectButton'),
  providerMenu: document.querySelector('#providerMenu'),
  codexAccountSelect: document.querySelector('#codexAccountSelect'),
  codexAccountsList: document.querySelector('#codexAccountsList'),
  addCodexAccountButton: document.querySelector('#addCodexAccount'),
  settingsModal: document.querySelector('#settingsModal'),
  searchModal: document.querySelector('#searchModal'),
  searchInput: document.querySelector('#searchInput'),
  searchResults: document.querySelector('#searchResults'),
  searchEmpty: document.querySelector('#searchEmpty'),
  toast: document.querySelector('#toast'),
};

function loadConversations() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item) => item && typeof item.id === 'string' && Array.isArray(item.messages))
      .map((item) => ({
        id: item.id,
        title: String(item.title || '새 대화').slice(0, 80),
        provider: Object.hasOwn(PROVIDERS, item.provider) ? item.provider : 'openai',
        model: String(item.model || 'gpt-5.6'),
        codexThreadId: typeof item.codexThreadId === 'string' ? item.codexThreadId : null,
        codexAccountId: typeof item.codexAccountId === 'string' ? item.codexAccountId : 'default',
        projectId: typeof item.projectId === 'string' ? item.projectId : null,
        importSource: ['openai', 'anthropic'].includes(item.importSource) ? item.importSource : null,
        sourceId: typeof item.sourceId === 'string' ? item.sourceId.slice(0, 240) : null,
        updatedAt: Number(item.updatedAt) || Date.now(),
        messages: item.messages.filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message.content === 'string')
          .map((message) => ({ role: message.role, content: message.content.slice(0, 40_000) })),
      }));
  } catch {
    return [];
  }
}

function loadProjects() {
  try {
    const value = JSON.parse(localStorage.getItem(PROJECT_STORAGE_KEY) || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item) => item && typeof item.id === 'string')
      .map((item) => ({
        id: item.id,
        name: String(item.name || '새 프로젝트').trim().slice(0, 60) || '새 프로젝트',
        instructions: typeof item.instructions === 'string' ? item.instructions.slice(0, 8000) : '',
        knowledge: typeof item.knowledge === 'string' ? item.knowledge.slice(0, 16000) : '',
        importSource: ['openai', 'anthropic'].includes(item.importSource) ? item.importSource : null,
        sourceId: typeof item.sourceId === 'string' ? item.sourceId.slice(0, 240) : null,
        createdAt: Number(item.createdAt) || Date.now(),
        updatedAt: Number(item.updatedAt) || Date.now(),
      }));
  } catch {
    return [];
  }
}

function saveProjects() {
  try {
    localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(state.projects));
  } catch {
    showToast('브라우저 저장 공간이 부족해 프로젝트를 저장하지 못했습니다.');
  }
}

function saveConversations() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.conversations));
  } catch {
    showToast('브라우저 저장 공간이 부족해 대화를 저장하지 못했습니다.');
  }
}

function loadPreferences() {
  try {
    const preferences = JSON.parse(localStorage.getItem(PREFERENCE_KEY) || '{}');
    if (Object.hasOwn(PROVIDERS, preferences.provider)) state.provider = preferences.provider;
    if (typeof preferences.codexAccountId === 'string') state.activeCodexAccountId = preferences.codexAccountId;
    if (typeof preferences.activeProjectId === 'string') state.activeProjectId = preferences.activeProjectId;
    if (typeof preferences.fastMode === 'boolean') state.fastMode = preferences.fastMode;
    if (PROVIDERS[state.provider].models.some((model) => model.id === preferences.model)) state.model = preferences.model;
  } catch {
    // 기본 모델 설정을 유지합니다.
  }
}

function savePreferences() {
  localStorage.setItem(PREFERENCE_KEY, JSON.stringify({
    provider: state.provider,
    model: state.model,
    codexAccountId: state.activeCodexAccountId,
    activeProjectId: state.activeProjectId,
    fastMode: state.fastMode,
  }));
}

function activeConversation() {
  return state.conversations.find((conversation) => conversation.id === state.activeId) || null;
}

function createConversation() {
  const conversation = {
    id: crypto.randomUUID(),
    title: '새 대화',
    provider: state.provider,
    model: state.model,
    codexAccountId: state.provider === 'openai' ? state.activeCodexAccountId : 'default',
    projectId: state.activeProjectId,
    updatedAt: Date.now(),
    messages: [],
  };
  state.conversations.unshift(conversation);
  state.activeId = conversation.id;
  saveConversations();
  render();
  elements.messageInput.focus();
  closeMobileSidebar();
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function renderConversationList() {
  const sorted = [...state.conversations]
    .filter((conversation) => !state.activeProjectId || conversation.projectId === state.activeProjectId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  elements.conversationList.innerHTML = sorted.map((conversation) => `
    <div class="conversation-row${conversation.id === state.activeId ? ' active' : ''}" data-id="${escapeHtml(conversation.id)}" role="button" tabindex="0" aria-label="${escapeHtml(conversation.title)} 열기">
      <span class="conversation-provider-mark">${PROVIDERS[conversation.provider]?.mark || '◉'}</span>
      <span class="conversation-title">${escapeHtml(conversation.title)}</span>
      <button class="delete-conversation" type="button" data-delete="${escapeHtml(conversation.id)}" aria-label="대화 삭제">×</button>
    </div>`).join('');
}

function project(projectId) {
  return state.projects.find((item) => item.id === projectId) || null;
}

function renderProjectList() {
  const rows = [`
    <div class="project-row${state.activeProjectId === null ? ' active' : ''}">
      <button class="project-select-button" type="button" data-select-project="all"><span class="project-icon">⌂</span><span>모든 대화</span></button>
    </div>`, ...state.projects.map((item) => `
    <div class="project-row${item.id === state.activeProjectId ? ' active' : ''}">
      <button class="project-select-button" type="button" data-select-project="${escapeHtml(item.id)}"><span class="project-icon" title="${item.importSource === 'anthropic' ? 'Claude에서 가져옴' : item.importSource === 'openai' ? 'ChatGPT에서 가져옴' : 'Mosaic 프로젝트'}">${item.importSource === 'anthropic' ? '✳' : item.importSource === 'openai' ? '◉' : '▧'}</span><span class="project-name">${escapeHtml(item.name)}</span><span class="project-count">${state.conversations.filter((conversation) => conversation.projectId === item.id).length}</span></button>
      <button class="project-edit-button" type="button" data-edit-project="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.name)} 프로젝트 편집" title="프로젝트 편집">•••</button>
    </div>`)];
  elements.projectList.innerHTML = rows.join('');
  const conversation = activeConversation();
  const projectBar = elements.conversationProjectBar;
  projectBar.hidden = !conversation;
  elements.conversationProjectLabel.textContent = conversation?.projectId
    ? `프로젝트: ${project(conversation.projectId)?.name || '알 수 없는 프로젝트'}`
    : '프로젝트 미지정';
  elements.conversationProjectAction.textContent = conversation?.projectId ? '이동 / 해제' : '프로젝트 지정';
}

function renderSearchResults() {
  const query = elements.searchInput.value.trim().toLocaleLowerCase('ko-KR');
  const matches = [...state.conversations]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((conversation) => !query || `${conversation.title} ${conversation.messages.map((message) => message.content).join(' ')}`
      .toLocaleLowerCase('ko-KR').includes(query))
    .slice(0, 12);

  elements.searchResults.innerHTML = matches.map((conversation) => `
    <button class="search-result${conversation.id === state.activeId ? ' active' : ''}" type="button" role="option" aria-selected="${conversation.id === state.activeId}" data-search-id="${escapeHtml(conversation.id)}">
      <span class="search-result-icon">${PROVIDERS[conversation.provider]?.mark || '◉'}</span>
      <span class="search-result-copy"><strong>${escapeHtml(conversation.title)}</strong><small>${escapeHtml(conversation.messages.find((message) => message.role === 'user')?.content || '아직 메시지가 없습니다.')}</small></span>
    </button>`).join('');
  elements.searchEmpty.hidden = matches.length > 0;
  elements.searchResults.hidden = matches.length === 0;
}

function renderMessages() {
  const conversation = activeConversation();
  const messages = conversation?.messages || [];
  elements.welcome.hidden = messages.length > 0;
  elements.messages.classList.toggle('visible', messages.length > 0);
  if (!messages.length) {
    elements.messages.innerHTML = '';
    return;
  }

  elements.messages.innerHTML = messages.map((message) => {
    const assistant = message.role === 'assistant';
    const errorClass = message.error ? ' error' : '';
    const content = message.pending && !message.content
      ? '<span class="typing-dots" aria-label="응답 생성 중"><i></i><i></i><i></i></span>'
      : escapeHtml(message.content);
    return `<article class="message ${assistant ? 'assistant' : 'user'}${errorClass}" data-message-id="${escapeHtml(message.id || '')}">
      ${assistant ? '<span class="assistant-mark" aria-hidden="true">✳</span>' : ''}
      <div class="message-content">${content}${message.pending && message.content ? '<span class="typing-dots" aria-label="응답 생성 중"><i></i><i></i><i></i></span>' : ''}</div>
    </article>`;
  }).join('');
  elements.chatScroll.scrollTop = elements.chatScroll.scrollHeight;
}

function activeCodexAccount() {
  return state.codexAccounts.find((account) => account.id === state.activeCodexAccountId) || null;
}

function modelsForProvider(providerId = state.provider) {
  if (providerId === 'openai') {
    const account = activeCodexAccount();
    return account?.models?.length ? account.models : PROVIDERS.openai.models;
  }
  return PROVIDERS[providerId].models;
}

function codexUsageText(account) {
  if (!account.connected) return '로그인 후 이 계정의 사용 한도를 확인합니다.';
  const usage = account.usageSummary;
  if (!usage?.available || !Array.isArray(usage.windows) || usage.windows.length === 0) return '사용 한도 정보를 현재 확인할 수 없습니다.';
  return usage.windows.map((window) => {
    const duration = formatUsageWindow(window.windowDurationMins, window.period);
    const resets = formatUsageReset(window.resetsAt);
    return `${window.limitName || 'Codex'} ${duration} 남은 ${window.remainingPercent}%${resets ? ` · ${resets} 초기화` : ''}`;
  }).join(' / ');
}

function renderCodexAccounts() {
  elements.codexAccountsList.innerHTML = state.codexAccounts.map((account) => {
    const selected = account.id === state.activeCodexAccountId;
    const job = account.loginJob;
    const waiting = job?.state === 'starting' || job?.state === 'running';
    const busy = state.busyCodexAccountIds.has(account.id);
    const loginLabel = waiting ? '로그인 중' : account.installed ? '로그인' : 'CLI 설치 필요';
    const accountHint = [account.accountEmail, account.planType || (!account.accountEmail ? account.label : '')].filter(Boolean).join(' · ') || 'Codex 계정';
    const accountActions = account.connected
      ? `<button class="account-use-button" type="button" data-use-codex-account="${escapeHtml(account.id)}"${selected || busy ? ' disabled' : ''}>${selected ? '선택됨' : '사용'}</button><button class="account-unlink-button" type="button" data-disconnect-codex-account="${escapeHtml(account.id)}"${busy ? ' disabled' : ''}>${busy ? '처리 중…' : '연결 해제'}</button>`
      : waiting
        ? `<button class="account-cancel-button" type="button" data-cancel-codex-login="${escapeHtml(account.id)}"${busy ? ' disabled' : ''}>로그인 취소</button>`
        : `<button class="connect-button" type="button" data-connect-codex-account="${escapeHtml(account.id)}"${!account.installed || busy ? ' disabled' : ''}>${account.disconnected ? '다시 연결' : loginLabel}</button>${!account.disconnected ? `<button class="account-unlink-button" type="button" data-disconnect-codex-account="${escapeHtml(account.id)}"${busy ? ' disabled' : ''}>연결 해제</button>` : ''}`;
    const deleteAction = account.isDefault ? '' : `<button class="account-delete-button" type="button" data-delete-codex-account="${escapeHtml(account.id)}"${busy ? ' disabled' : ''}>삭제</button>`;
    return `<article class="codex-account-card${selected ? ' active' : ''}">
      <span class="connection-logo openai-logo">◉</span>
      <div class="connection-details"><div class="codex-account-title"><strong>${escapeHtml(account.name)}</strong>${selected ? '<span class="active-account-badge">사용 중</span>' : ''}</div>
        <small class="codex-account-plan">${escapeHtml(accountHint)}</small>
        <small class="usage-status">${escapeHtml(codexUsageText(account))}</small>
        ${!account.installed && account.installCommand ? `<code class="install-command">${escapeHtml(account.installCommand)}</code>` : ''}
      </div>
      <div class="connection-actions"><span class="connection-status${account.connected ? ' ready' : ''}">${account.connected ? '연결됨' : waiting ? '인증 중' : account.disconnected ? '로그아웃됨' : '로그인 필요'}</span>
        <div class="account-button-group">${accountActions}${deleteAction}</div>
      </div>
    </article>`;
  }).join('');
  elements.addCodexAccountButton.disabled = state.addingCodexAccount === true;
  elements.addCodexAccountButton.textContent = state.addingCodexAccount ? '계정 준비 중…' : '＋ 계정 추가';
}

function renderCodexAccountSelect() {
  const visible = state.provider === 'openai';
  elements.codexAccountSelect.hidden = !visible;
  if (!visible) return;
  elements.codexAccountSelect.innerHTML = state.codexAccounts.length
    ? state.codexAccounts.map((account) => `<option value="${escapeHtml(account.id)}"${account.id === state.activeCodexAccountId ? ' selected' : ''}${!account.connected ? ' disabled' : ''}>${escapeHtml(account.name)}${account.connected ? '' : ' · 로그인 필요'}</option>`).join('')
    : '<option value="default">Codex 계정 확인 중…</option>';
  elements.codexAccountSelect.value = state.activeCodexAccountId;
}

function renderModelSelect() {
  const provider = PROVIDERS[state.provider];
  const models = modelsForProvider();
  elements.modelSelect.disabled = models.length === 0;
  elements.modelSelect.innerHTML = models.length
    ? models.map((model) =>
      `<option value="${escapeHtml(model.id)}"${model.id === state.model ? ' selected' : ''}>${escapeHtml(model.label)}</option>`).join('')
    : '<option value="">로그인 후 모델 표시</option>';
  document.querySelector('#providerSelectLabel').textContent = provider.label;
  document.querySelector('#miniProviderMark').textContent = provider.mark;
  const codexAccount = state.provider === 'openai' ? activeCodexAccount() : null;
  document.querySelector('#providerPillText').textContent = codexAccount?.name || `${provider.label} 계정`;
  document.querySelector('#providerDot').classList.toggle('connected', state.provider === 'openai'
    ? codexAccount?.connected === true
    : state.providers[state.provider]?.connected === true);
  document.querySelectorAll('.provider-menu [data-provider]').forEach((button) => {
    button.classList.toggle('selected', button.dataset.provider === state.provider);
  });
  const fastEfforts = models.find((model) => model.id === state.model)?.supportedReasoningEfforts || [];
  const fastAvailable = fastEfforts.some((item) => item.reasoningEffort === 'low');
  elements.fastModeToggle.hidden = state.provider !== 'openai';
  elements.fastModeToggle.disabled = !fastAvailable;
  elements.fastModeToggle.classList.toggle('active', state.fastMode && fastAvailable);
  elements.fastModeToggle.setAttribute('aria-pressed', String(state.fastMode && fastAvailable));
  const fastTierAvailable = (models.find((model) => model.id === state.model)?.serviceTiers || [])
    .some((tier) => /fast|priority/i.test(`${tier.id} ${tier.name}`));
  elements.fastModeToggle.title = fastAvailable
    ? fastTierAvailable
      ? '낮은 추론 단계와 이 모델이 광고한 Fast 서비스 티어를 요청합니다.'
      : '낮은 추론 단계로 빠르게 응답합니다. 이 모델은 별도 Fast 서비스 티어를 광고하지 않습니다.'
    : '선택한 모델이 빠른 추론 단계를 제공하지 않습니다.';
}

function render() {
  if (state.activeProjectId && !project(state.activeProjectId)) state.activeProjectId = null;
  if (state.activeId && state.activeProjectId && activeConversation()?.projectId !== state.activeProjectId) {
    state.activeId = [...state.conversations]
      .filter((conversation) => conversation.projectId === state.activeProjectId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id || null;
  }
  renderConversationList();
  renderProjectList();
  renderMessages();
  renderCodexAccounts();
  renderCodexAccountSelect();
  renderModelSelect();
  document.querySelector('#connectionSummary').textContent = connectionSummary();
  const conversation = activeConversation();
  const activeProject = project(conversation?.projectId || state.activeProjectId);
  document.querySelector('#modeLabel').textContent = conversation?.messages.length
    ? conversation.title
    : activeProject ? `${activeProject.name} · 새 대화` : '새 대화';
  if (!elements.searchModal.hidden) renderSearchResults();
}

function connectionSummary() {
  const codexCount = state.codexAccounts.filter((account) => account.connected).length;
  const claudeConnected = state.providers.anthropic?.connected === true;
  const parts = [];
  if (codexCount) parts.push(`Codex ${codexCount}개`);
  if (claudeConnected) parts.push('Claude');
  return parts.length ? `${parts.join(' · ')} 연결됨` : '계정 연결 필요';
}

let statusRequestInProgress = false;
let statusPollTimer = null;

function updateConnectionControls() {
  const feedback = document.querySelector('#loginFeedback');
  const messages = [];
  const anthropic = state.providers.anthropic || {};
  const claudeJob = state.loginJobs.anthropic;
  document.querySelector('#anthropicStatus').textContent = anthropic.label || '상태 확인 실패';
  document.querySelector('#anthropicStatus').classList.toggle('ready', anthropic.connected === true);
  const claudeButton = document.querySelector('#connectClaude');
  const claudeLoginRunning = claudeJob?.state === 'running' || claudeJob?.state === 'starting';
  claudeButton.textContent = state.busyClaudeDisconnect ? '해제 중…' : anthropic.connected ? '연결 해제' : claudeLoginRunning ? '진행 중' : anthropic.installed ? '로그인' : '설치 필요';
  claudeButton.disabled = state.busyClaudeDisconnect || anthropic.installed !== true || claudeLoginRunning;
  claudeButton.classList.remove('connected');
  claudeButton.classList.toggle('disconnect-button', anthropic.connected === true);
  document.querySelector('#anthropicInstall').textContent = anthropic.installCommand || '';
  document.querySelector('#anthropicInstall').hidden = anthropic.installed !== false || !anthropic.installCommand;
  document.querySelector('#anthropicUsage').textContent = anthropic.usageSummary?.message || (anthropic.connected
    ? 'Claude Code에서 /usage를 실행해 플랜 사용량을 확인하세요.'
    : 'Claude Code CLI 로그인 후 /usage에서 플랜 사용량을 확인하세요.');
  if (!anthropic.connected && claudeJob?.output) messages.push(`Claude 로그인 안내:\n${claudeJob.output.trim()}`);
  else if (!anthropic.connected && (claudeJob?.state === 'running' || claudeJob?.state === 'starting')) messages.push('Claude 공식 로그인 창에서 인증을 완료해 주세요.');
  else if (!anthropic.connected && claudeJob?.state === 'failed') messages.push('Claude 로그인 절차가 종료되었습니다. CLI 상태를 새로고침해 주세요.');

  for (const account of state.codexAccounts) {
    const job = account.loginJob;
    const key = `openai:${account.id}`;
    if (account.connected) {
      delete state.loginUrls[key];
      continue;
    }
    if (job?.output) messages.push(`${account.name} 로그인 안내:\n${job.output.trim()}`);
    else if (job?.state === 'running' || job?.state === 'starting') messages.push(`${account.name} ChatGPT 로그인 창에서 인증을 완료해 주세요.`);
    else if (job?.state === 'failed') messages.push(`${account.name} 로그인 절차가 종료되었습니다. 다시 시도해 주세요.`);
  }

  feedback.replaceChildren(document.createTextNode(messages.join('\n\n')));
  const authLinks = state.codexAccounts
    .map((account) => ({ account, url: safeChatGptAuthUrl(state.loginUrls[`openai:${account.id}`] || '') }))
    .filter(({ account, url }) => !account.connected && url);
  for (const { account, url } of authLinks) {
    if (messages.length || feedback.childNodes.length) feedback.append(document.createTextNode('\n\n'));
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `${account.name} ChatGPT 로그인 창 열기`;
    feedback.append(link);
  }
  feedback.hidden = messages.length === 0 && authLinks.length === 0;
  renderCodexAccounts();
}

function formatUsageWindow(durationMins, period) {
  if (Number.isFinite(durationMins) && durationMins >= 10_080 && durationMins % 10_080 === 0) {
    const weeks = durationMins / 10_080;
    return weeks === 1 ? '7일 창' : `${weeks}주 창`;
  }
  if (Number.isFinite(durationMins) && durationMins >= 1_440 && durationMins % 1_440 === 0) {
    const days = durationMins / 1_440;
    return `${days}일 창`;
  }
  if (Number.isFinite(durationMins) && durationMins >= 60 && durationMins % 60 === 0) {
    const hours = durationMins / 60;
    return `${hours}시간 창`;
  }
  if (Number.isFinite(durationMins) && durationMins > 0) return `${durationMins}분 창`;
  return period === 'secondary' ? '긴 기간 창' : '짧은 기간 창';
}

function formatUsageReset(resetsAt) {
  if (!Number.isFinite(resetsAt) || resetsAt <= 0) return '';
  const date = new Date(resetsAt * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date);
}

async function refreshStatus() {
  if (statusRequestInProgress) return;
  statusRequestInProgress = true;
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    const status = await response.json();
    state.providers = status.providers || state.providers;
    state.loginJobs = status.loginJobs || {};
    state.codexAccounts = Array.isArray(status.codexAccounts) ? status.codexAccounts : [];
    if (!state.codexAccounts.some((account) => account.id === state.activeCodexAccountId && account.connected)) {
      state.activeCodexAccountId = state.codexAccounts.find((account) => account.id !== state.activeCodexAccountId && account.connected)?.id || 'default';
    }
    const defaultModels = state.codexAccounts.find((account) => account.id === 'default')?.models;
    if (Array.isArray(defaultModels) && defaultModels.length) {
      PROVIDERS.openai.models = defaultModels.map((model) => ({ ...model }));
    }
    const codexModels = modelsForProvider('openai');
    if (codexModels.length && !codexModels.some((model) => model.id === state.model)) {
      state.model = codexModels.find((model) => model.isDefault)?.id || codexModels[0].id;
      savePreferences();
    }
    savePreferences();
  } catch {
    state.providers = {
      openai: { installed: false, connected: false, label: '서버 연결 실패' },
      anthropic: { installed: false, connected: false, label: '서버 연결 실패' },
    };
  } finally {
    statusRequestInProgress = false;
  }
  updateConnectionControls();
  render();
}

async function connectProvider(provider) {
  const feedback = document.querySelector('#loginFeedback');
  feedback.hidden = false;
  feedback.textContent = 'Claude 공식 CLI 로그인 절차를 여는 중입니다…';
  try {
    const response = await fetch(`/api/connect/${provider}`, { method: 'POST' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      feedback.textContent = [data.error, data.installCommand].filter(Boolean).join('\n');
      showToast(data.error || '로그인을 시작하지 못했습니다.');
    } else {
      feedback.textContent = data.message || '공식 로그인 절차를 확인해 주세요.';
      if (!statusPollTimer) statusPollTimer = setInterval(refreshStatus, 2500);
    }
  } catch {
    feedback.textContent = '로그인 요청을 처리하지 못했습니다. Mosaic 서버가 실행 중인지 확인해 주세요.';
  }
  refreshStatus();
}

async function connectCodexAccount(accountId = null) {
  const feedback = document.querySelector('#loginFeedback');
  const loginWindow = window.open('about:blank', '_blank');
  state.addingCodexAccount = accountId === null;
  feedback.hidden = false;
  feedback.textContent = accountId
    ? 'Codex app-server에서 이 계정의 로그인을 시작하는 중입니다…'
    : '새 Codex 계정 프로필을 준비하고 로그인을 시작하는 중입니다…';
  renderCodexAccounts();

  try {
    const endpoint = accountId
      ? `/api/codex/accounts/${encodeURIComponent(accountId)}/connect`
      : '/api/codex/accounts';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: accountId ? undefined : { 'Content-Type': 'application/json' },
      body: accountId ? undefined : JSON.stringify({}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      loginWindow?.close();
      feedback.textContent = [data.error, data.installCommand].filter(Boolean).join('\n');
      showToast(data.error || 'Codex 계정을 연결하지 못했습니다.');
      if (data.accountId) await refreshStatus();
      return;
    }
    accountId = data.accountId || accountId;
    if (data.connected) {
      loginWindow?.close();
      feedback.textContent = data.message || '이 계정은 이미 연결되어 있습니다.';
      await refreshStatus();
      return;
    }
    feedback.textContent = data.message || 'ChatGPT 로그인 창에서 인증을 완료해 주세요.';
    if (data.authUrl && accountId) {
      const authUrl = safeChatGptAuthUrl(data.authUrl);
      if (!authUrl) throw new Error('안전하지 않은 ChatGPT 로그인 주소를 받았습니다.');
      state.loginUrls[`openai:${accountId}`] = authUrl;
      if (loginWindow) {
        loginWindow.opener = null;
        loginWindow.location.replace(authUrl);
      } else {
        showToast('팝업이 차단되었습니다. 아래 로그인 링크를 눌러 계속해 주세요.');
      }
    }
    if (!statusPollTimer) statusPollTimer = setInterval(refreshStatus, 2500);
  } catch (error) {
    loginWindow?.close();
    feedback.textContent = error.message || 'Codex 로그인을 시작하지 못했습니다.';
    showToast(error.message || 'Codex 로그인을 시작하지 못했습니다.');
  } finally {
    state.addingCodexAccount = false;
    renderCodexAccounts();
  }
  await refreshStatus();
}

async function updateCodexAccountLink(accountId, action) {
  const account = state.codexAccounts.find((item) => item.id === accountId);
  if (!account) return;
  if (action === 'disconnect') {
    const impact = account.isDefault
      ? '기본 계정은 ~/.codex를 Codex CLI와 공유합니다. 로그아웃하면 이 앱과 Codex CLI 양쪽에서 다시 로그인해야 합니다.'
      : 'Codex app-server에서 로그아웃합니다. 이 계정 항목과 Codex 대화 기록은 남기며, 다시 로그인해 사용할 수 있습니다.';
    if (!window.confirm(`${account.name}을 연결 해제할까요?\n\n${impact}`)) return;
  } else if (action === 'delete') {
    if (account.isDefault) return;
    const impact = '계정 인증 정보와 이 Mosaic 계정 전용 Codex 프로필·세션 기록을 삭제합니다. Mosaic 대화 본문은 남지만 Codex 세션 연결을 끊고, 다음 응답은 남은 계정에서 대화 내용으로 이어집니다.';
    if (!window.confirm(`${account.name}을 계정 목록에서 삭제할까요?\n\n${impact}`)) return;
  }
  if (state.busyCodexAccountIds.has(accountId)) return;
  state.busyCodexAccountIds.add(accountId);
  renderCodexAccounts();
  const label = action === 'cancel' ? '로그인 취소' : action === 'delete' ? '계정 삭제' : '연결 해제';
  try {
    const response = action === 'delete'
      ? await fetch(`/api/codex/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' })
      : await fetch(`/api/codex/accounts/${encodeURIComponent(accountId)}/${action}`, { method: 'POST' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `${label}에 실패했습니다.`);
    if (action === 'delete') {
      const replacement = state.codexAccounts.find((item) => item.id !== accountId && item.connected)
        || state.codexAccounts.find((item) => item.id !== accountId && item.id === 'default');
      const replacementId = replacement?.id || 'default';
      for (const conversation of state.conversations) {
        if (conversation.provider === 'openai' && conversation.codexAccountId === accountId) {
          conversation.codexAccountId = replacementId;
          conversation.codexThreadId = null;
        }
      }
      state.codexAccounts = state.codexAccounts.filter((item) => item.id !== accountId);
      if (state.activeCodexAccountId === accountId) state.activeCodexAccountId = replacementId;
      saveConversations();
      savePreferences();
      showToast('Codex 계정을 삭제했습니다. Mosaic 대화 본문은 남아 있습니다.');
    } else if (action === 'disconnect' && accountId === state.activeCodexAccountId) {
      state.activeCodexAccountId = state.codexAccounts.find((item) => item.id !== accountId && item.connected)?.id || 'default';
      savePreferences();
    }
    if (action === 'cancel') delete state.loginUrls[`openai:${accountId}`];
    if (action !== 'delete') showToast(action === 'cancel' ? 'Codex OAuth 로그인 요청을 취소했습니다.' : 'Codex에서 로그아웃했습니다. 계정 항목과 대화 기록은 보존됩니다.');
  } catch (error) {
    showToast(error.message || `${label}에 실패했습니다.`);
  } finally {
    state.busyCodexAccountIds.delete(accountId);
    await refreshStatus();
  }
}

async function disconnectClaudeAccount() {
  if (state.busyClaudeDisconnect) return;
  if (!window.confirm('Claude Code CLI에서 로그아웃할까요?\n\n이 로그아웃은 Mosaic와 터미널 등 Claude Code CLI를 사용하는 곳에 영향을 줍니다.')) return;
  state.busyClaudeDisconnect = true;
  updateConnectionControls();
  try {
    const response = await fetch('/api/disconnect/anthropic', { method: 'POST' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Claude 연결을 해제하지 못했습니다.');
    showToast('Claude Code CLI에서 로그아웃했습니다.');
  } catch (error) {
    showToast(error.message || 'Claude 연결을 해제하지 못했습니다.');
  } finally {
    state.busyClaudeDisconnect = false;
    await refreshStatus();
  }
}

function toggleClaudeConnection() {
  if (state.providers.anthropic?.connected) return disconnectClaudeAccount();
  return connectProvider('anthropic');
}

function activeProjectInstructions() {
  const conversation = activeConversation();
  const projectId = conversation?.projectId || state.activeProjectId;
  const activeProject = project(projectId);
  if (!activeProject) return '';
  const context = [
    activeProject.instructions ? `Project instructions:\n${activeProject.instructions}` : '',
    activeProject.knowledge ? `Project reference material:\n${activeProject.knowledge}` : '',
  ].filter(Boolean).join('\n\n');
  return context.slice(0, 24_000);
}

function openProjectEditor(projectId = null) {
  const item = project(projectId);
  state.editingProjectId = item?.id || null;
  document.querySelector('#projectModalTitle').textContent = item ? '프로젝트 편집' : '프로젝트 만들기';
  elements.projectNameInput.value = item?.name || '';
  elements.projectInstructionsInput.value = item?.instructions || '';
  elements.projectKnowledgeInput.value = item?.knowledge || '';
  document.querySelector('#deleteProjectButton').hidden = !item;
  elements.projectModal.hidden = false;
  elements.projectNameInput.focus();
}

function closeProjectEditor() {
  elements.projectModal.hidden = true;
  state.editingProjectId = null;
}

function saveProjectEditor() {
  const name = elements.projectNameInput.value.trim();
  if (!name) {
    elements.projectNameInput.focus();
    showToast('프로젝트 이름을 입력해 주세요.');
    return;
  }
  const instructions = elements.projectInstructionsInput.value.trim().slice(0, 8000);
  const knowledge = elements.projectKnowledgeInput.value.trim().slice(0, 16000);
  const now = Date.now();
  if (state.editingProjectId) {
    const item = project(state.editingProjectId);
    if (!item) return closeProjectEditor();
    item.name = name.slice(0, 60);
    item.instructions = instructions;
    item.knowledge = knowledge;
    item.updatedAt = now;
  } else {
    const item = { id: crypto.randomUUID(), name: name.slice(0, 60), instructions, knowledge, createdAt: now, updatedAt: now };
    state.projects.unshift(item);
    state.activeProjectId = item.id;
    state.activeId = null;
  }
  saveProjects();
  savePreferences();
  closeProjectEditor();
  render();
}

function deleteActiveProject() {
  const item = project(state.editingProjectId);
  if (!item || !window.confirm(`“${item.name}” 프로젝트를 삭제할까요?\n프로젝트에 속한 대화는 삭제되지 않고 ‘모든 대화’로 이동합니다.`)) return;
  for (const conversation of state.conversations) {
    if (conversation.projectId === item.id) conversation.projectId = null;
  }
  state.projects = state.projects.filter((candidate) => candidate.id !== item.id);
  if (state.activeProjectId === item.id) state.activeProjectId = null;
  saveProjects();
  saveConversations();
  savePreferences();
  closeProjectEditor();
  render();
}

function selectProject(projectId) {
  state.activeProjectId = projectId && project(projectId) ? projectId : null;
  const nextConversation = [...state.conversations]
    .filter((conversation) => !state.activeProjectId || conversation.projectId === state.activeProjectId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (nextConversation) {
    selectConversation(nextConversation);
    // Opening the most recent conversation normally selects its project. The
    // all-conversations view is an explicit filter and must remain unfiltered.
    if (!projectId) {
      state.activeProjectId = null;
      savePreferences();
      render();
    }
  } else {
    state.activeId = null;
    savePreferences();
    render();
  }
}

function openProjectMove(conversationId = state.activeId) {
  const conversation = state.conversations.find((item) => item.id === conversationId);
  if (!conversation) return;
  state.movingConversationId = conversation.id;
  elements.projectMoveSelect.innerHTML = '<option value="">프로젝트 미지정</option>' + state.projects
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
  elements.projectMoveSelect.value = project(conversation.projectId) ? conversation.projectId : '';
  elements.projectMoveModal.hidden = false;
}

function closeProjectMove() {
  elements.projectMoveModal.hidden = true;
  state.movingConversationId = null;
}

function moveConversationToProject() {
  const conversation = state.conversations.find((item) => item.id === state.movingConversationId);
  if (!conversation) return closeProjectMove();
  conversation.projectId = project(elements.projectMoveSelect.value) ? elements.projectMoveSelect.value : null;
  state.activeId = conversation.id;
  state.activeProjectId = conversation.projectId;
  saveConversations();
  savePreferences();
  closeProjectMove();
  render();
}

function importSourceName(provider) {
  return provider === 'anthropic' ? 'Claude' : 'ChatGPT';
}

async function selectProjectImportFile(file) {
  if (!file) return;
  const importButton = document.querySelector('#importProjectButton');
  importButton.disabled = true;
  importButton.textContent = '…';
  try {
    const parsed = await parseProviderExport(file);
    state.pendingProjectImport = { ...parsed, fileName: file.name };
    elements.projectImportProvider.value = parsed.suggestedProvider;
    elements.projectImportName.value = `${importSourceName(parsed.suggestedProvider)} 가져오기`.slice(0, 60);
    const importedProjectCount = parsed.projects.length;
    const conversationCount = parsed.conversations.length;
    elements.projectImportSummary.textContent = `${file.name} · 프로젝트 ${importedProjectCount.toLocaleString()}개 · 대화 ${conversationCount.toLocaleString()}개 · JSON ${parsed.sourceFileCount.toLocaleString()}개`;
    elements.projectImportError.hidden = true;
    elements.projectImportError.textContent = '';
    elements.projectImportModal.hidden = false;
    elements.projectImportName.focus();
  } catch (error) {
    showToast(error.message || '내보내기 파일을 읽지 못했습니다.');
  } finally {
    importButton.disabled = false;
    importButton.textContent = '↓';
    elements.projectImportFile.value = '';
  }
}

function closeProjectImport() {
  elements.projectImportModal.hidden = true;
  elements.projectImportError.hidden = true;
  elements.projectImportError.textContent = '';
  state.pendingProjectImport = null;
}

function importFingerprint(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `derived-${(hash >>> 0).toString(16)}`;
}

function commitProjectImport() {
  const pending = state.pendingProjectImport;
  if (!pending) return closeProjectImport();
  const provider = elements.projectImportProvider.value === 'anthropic' ? 'anthropic' : 'openai';
  const importName = elements.projectImportName.value.trim().slice(0, 60);
  if (!importName) {
    elements.projectImportError.textContent = '가져오기 프로젝트 이름을 입력해 주세요.';
    elements.projectImportError.hidden = false;
    elements.projectImportName.focus();
    return;
  }

  const stagedProjects = [];
  const projectIds = new Map();
  const importKeyFor = (sourceId, fallbackName) => sourceId || `project-${importFingerprint(`${provider}:${fallbackName}`)}`;
  const ensureProject = (name, sourceId, instructions = '', knowledge = '') => {
    const stableId = importKeyFor(sourceId, name);
    const key = `${provider}:${stableId}`;
    if (projectIds.has(key)) return projectIds.get(key);
    const existing = state.projects.find((item) => item.importSource === provider && item.sourceId === stableId);
    if (existing) {
      projectIds.set(key, existing.id);
      return existing.id;
    }
    const staged = stagedProjects.find((item) => item.importSource === provider && item.sourceId === stableId);
    if (staged) {
      projectIds.set(key, staged.id);
      return staged.id;
    }
    const item = {
      id: crypto.randomUUID(),
      name: String(name || importName).trim().slice(0, 60) || importName,
      instructions: String(instructions || '').slice(0, 8_000),
      knowledge: String(knowledge || '').slice(0, 16_000),
      importSource: provider,
      sourceId: stableId.slice(0, 240),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    stagedProjects.push(item);
    projectIds.set(key, item.id);
    return item.id;
  };

  const externalProjectMap = new Map();
  for (const item of pending.projects) {
    const projectId = ensureProject(item.name, item.sourceId, item.instructions, item.knowledge);
    if (item.sourceId) externalProjectMap.set(item.sourceId, projectId);
  }

  const sourceIdForConversation = (item) => item.sourceId || importFingerprint(`${item.title}:${item.createdAt}:${item.messages[0]?.content || ''}`);
  const newConversations = [];
  const duplicates = [];
  const availableModels = provider === 'openai'
    ? modelsForProvider('openai')
    : PROVIDERS.anthropic.models;
  const defaultModel = availableModels.find((item) => item.isDefault)?.id || availableModels[0]?.id || '';
  const defaultProjectSourceId = `default-${importFingerprint(`${pending.fileName}:${importName}`)}`;

  for (const item of pending.conversations) {
    const sourceId = sourceIdForConversation(item);
    const duplicate = state.conversations.some((conversation) => conversation.importSource === provider && conversation.sourceId === sourceId)
      || newConversations.some((conversation) => conversation.importSource === provider && conversation.sourceId === sourceId);
    if (duplicate) {
      duplicates.push(item);
      continue;
    }

    let projectId = item.sourceProjectId ? externalProjectMap.get(item.sourceProjectId) : null;
    if (!projectId && item.sourceProjectId) {
      projectId = ensureProject(item.sourceProjectName || `${importSourceName(provider)} 프로젝트`, item.sourceProjectId);
      externalProjectMap.set(item.sourceProjectId, projectId);
    }
    if (!projectId) projectId = ensureProject(importName, defaultProjectSourceId);

    newConversations.push({
      id: crypto.randomUUID(),
      title: item.title,
      provider,
      model: defaultModel,
      codexThreadId: null,
      codexAccountId: state.activeCodexAccountId,
      projectId,
      importSource: provider,
      sourceId,
      updatedAt: Number(item.createdAt) || Date.now(),
      messages: item.messages.map((message) => ({ role: message.role, content: message.content.slice(0, 40_000) })),
    });
  }

  if (!stagedProjects.length && !newConversations.length) {
    closeProjectImport();
    showToast('이 내보내기의 프로젝트와 대화는 이미 가져왔습니다.');
    return;
  }

  const nextProjects = [...stagedProjects, ...state.projects];
  const nextConversations = [...newConversations, ...state.conversations];
  const storageKeys = [STORAGE_KEY, PROJECT_STORAGE_KEY];
  const otherStorageBytes = Object.keys(localStorage)
    .filter((key) => !storageKeys.includes(key))
    .reduce((total, key) => total + (key.length + (localStorage.getItem(key) || '').length) * 2, 0);
  const estimatedBytes = otherStorageBytes
    + (JSON.stringify(nextProjects).length + JSON.stringify(nextConversations).length) * 2;
  if (estimatedBytes > 3_800_000) {
    elements.projectImportError.textContent = '가져온 자료가 앱의 현재 로컬 저장 한도를 넘습니다. 더 작은 내보내기 파일로 나누어 가져와 주세요. 이번 가져오기는 저장되지 않았습니다.';
    elements.projectImportError.hidden = false;
    return;
  }

  state.projects = nextProjects;
  state.conversations = nextConversations;
  state.activeProjectId = newConversations[0]?.projectId || stagedProjects[0]?.id || null;
  saveProjects();
  saveConversations();
  savePreferences();
  closeProjectImport();
  if (newConversations.length) selectConversation(newConversations[0]);
  else render();
  const duplicateNotice = duplicates.length ? ` · 중복 대화 ${duplicates.length.toLocaleString()}개 건너뜀` : '';
  showToast(`${importSourceName(provider)} 가져오기 완료 · 프로젝트 ${stagedProjects.length.toLocaleString()}개 · 대화 ${newConversations.length.toLocaleString()}개${duplicateNotice}`);
}

function safeChatGptAuthUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['chatgpt.com', 'auth.openai.com'].includes(url.hostname)) return '';
    return url.href;
  } catch {
    return '';
  }
}

let toastTimeout;
function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => elements.toast.classList.remove('visible'), 3800);
}

function setProvider(provider) {
  if (!Object.hasOwn(PROVIDERS, provider)) return;
  state.provider = provider;
  const models = modelsForProvider(provider);
  if (!models.some((model) => model.id === state.model)) state.model = models[0]?.id || '';
  const conversation = activeConversation();
  if (conversation && conversation.messages.length === 0) {
    conversation.provider = provider;
    conversation.model = state.model;
    conversation.codexAccountId = provider === 'openai' ? state.activeCodexAccountId : 'default';
  }
  savePreferences();
  saveConversations();
  render();
  elements.providerMenu.hidden = true;
}

function setModel(model) {
  if (!modelsForProvider().some((item) => item.id === model)) return;
  state.model = model;
  const conversation = activeConversation();
  if (conversation && conversation.messages.length === 0) conversation.model = model;
  savePreferences();
  saveConversations();
  renderModelSelect();
}

function toggleFastMode() {
  if (elements.fastModeToggle.disabled || state.provider !== 'openai') return;
  state.fastMode = !state.fastMode;
  savePreferences();
  renderModelSelect();
  if (state.fastMode) {
    const model = modelsForProvider().find((item) => item.id === state.model);
    const serviceTierAvailable = (model?.serviceTiers || []).some((tier) => /fast|priority/i.test(`${tier.id} ${tier.name}`));
    showToast(serviceTierAvailable ? 'Fast 응답과 모델 우선순위 티어를 요청합니다.' : 'Fast 응답을 켰습니다. 이 모델에는 낮은 추론 단계가 적용됩니다.');
  }
}

function setCodexAccount(accountId) {
  const account = state.codexAccounts.find((item) => item.id === accountId && item.connected);
  if (!account) return;
  if (state.busy) {
    showToast('응답이 끝난 뒤 Codex 계정을 전환해 주세요.');
    renderCodexAccountSelect();
    return;
  }
  const previousId = state.activeCodexAccountId;
  state.activeCodexAccountId = account.id;
  if (state.provider === 'openai') {
    const models = account.models || [];
    if (!models.some((model) => model.id === state.model)) state.model = models.find((model) => model.isDefault)?.id || models[0]?.id || '';
    const conversation = activeConversation();
    if (conversation?.provider === 'openai' && conversation.codexAccountId !== account.id) {
      conversation.codexAccountId = account.id;
      conversation.codexThreadId = null;
      if (!models.some((model) => model.id === conversation.model)) conversation.model = state.model;
      if (conversation.messages.length) showToast('계정을 바꿨습니다. 이전 대화 내용을 새 계정에 이어 전달합니다.');
    }
  }
  savePreferences();
  saveConversations();
  render();
  if (previousId !== account.id && state.provider !== 'openai') showToast('새 Codex 대화에 사용할 계정을 바꿨습니다.');
}

function updateConversationTitle(conversation, firstMessage) {
  if (conversation.messages.filter((message) => message.role === 'user').length !== 1) return;
  conversation.title = firstMessage.replace(/\s+/g, ' ').slice(0, 42) || '새 대화';
}

function parseSseBlock(block) {
  const lines = block.split(/\r?\n/);
  const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
  const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
  if (!data) return null;
  try { return { event, data: JSON.parse(data) }; } catch { return null; }
}

async function streamResponse(response, assistantMessage, conversation) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawDone = false;

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    buffer = buffer.replace(/\r\n/g, '\n');
    let separator;
    while ((separator = buffer.indexOf('\n\n')) !== -1) {
      const parsed = parseSseBlock(buffer.slice(0, separator));
      buffer = buffer.slice(separator + 2);
      if (!parsed) continue;
      if (parsed.event === 'account' && typeof parsed.data.id === 'string') {
        conversation.codexAccountId = parsed.data.id;
        state.activeCodexAccountId = parsed.data.id;
        savePreferences();
        saveConversations();
        render();
      }
      if (parsed.event === 'thread' && typeof parsed.data.threadId === 'string') {
        conversation.codexThreadId = parsed.data.threadId;
        if (typeof parsed.data.accountId === 'string') conversation.codexAccountId = parsed.data.accountId;
        saveConversations();
      }
      if (parsed.event === 'retry' && typeof parsed.data.accountId === 'string') {
        assistantMessage.content = '';
        assistantMessage.error = false;
        conversation.codexThreadId = null;
        conversation.codexAccountId = parsed.data.accountId;
        state.activeCodexAccountId = parsed.data.accountId;
        savePreferences();
        saveConversations();
      }
      if (parsed.event === 'delta') assistantMessage.content += parsed.data.text || '';
      if (parsed.event === 'error') {
        assistantMessage.content = `오류: ${parsed.data.error || '응답 생성에 실패했습니다.'}`;
        assistantMessage.error = true;
      }
      if (parsed.event === 'done') sawDone = true;
      renderMessages();
    }
    if (done) break;
  }
  if (!sawDone && !assistantMessage.error && !assistantMessage.content) {
    assistantMessage.content = '응답이 중단되었습니다.';
    assistantMessage.error = true;
  }
  assistantMessage.pending = false;
  conversation.updatedAt = Date.now();
  saveConversations();
  render();
}

async function sendMessage(value) {
  const message = value.trim();
  if (!message || state.busy) return;
  let conversation = activeConversation();
  if (!conversation) {
    createConversation();
    conversation = activeConversation();
  }
  if (conversation.provider !== state.provider && state.provider === 'openai') conversation.codexThreadId = null;
  conversation.provider = state.provider;
  conversation.model = state.model;
  if (state.provider === 'openai') {
    if (conversation.codexAccountId !== state.activeCodexAccountId) conversation.codexThreadId = null;
    conversation.codexAccountId = state.activeCodexAccountId;
  }
  updateConversationTitle(conversation, message);
  conversation.messages.push({ role: 'user', content: message, id: crypto.randomUUID() });
  const assistantMessage = { role: 'assistant', content: '', id: crypto.randomUUID(), pending: true };
  conversation.messages.push(assistantMessage);
  conversation.updatedAt = Date.now();
  saveConversations();
  render();

  elements.messageInput.value = '';
  resizeInput();
  state.busy = true;
  state.controller = new AbortController();
  elements.sendButton.disabled = false;
  elements.sendButton.classList.add('busy');
  elements.sendButton.setAttribute('aria-label', '응답 중지');

  const messages = conversation.messages.filter((item) => !item.pending).map(({ role, content }) => ({ role, content }));
  const projectInstructions = activeProjectInstructions();
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: state.provider,
        model: state.model,
        ...(state.provider === 'openai' ? { fastMode: state.fastMode } : {}),
        ...(state.provider === 'openai' ? { codexAccountId: conversation.codexAccountId || 'default' } : {}),
        ...(projectInstructions ? { projectInstructions } : {}),
        messages,
        ...(state.provider === 'openai' && conversation.codexThreadId ? { codexThreadId: conversation.codexThreadId } : {}),
      }),
      signal: state.controller.signal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `요청에 실패했습니다 (${response.status}).`);
    }
    await streamResponse(response, assistantMessage, conversation);
  } catch (error) {
    assistantMessage.pending = false;
    assistantMessage.error = error.name !== 'AbortError';
    assistantMessage.content = error.name === 'AbortError'
      ? (assistantMessage.content || '응답을 중지했습니다.')
      : `오류: ${error.message || '서버에 연결할 수 없습니다.'}`;
    conversation.updatedAt = Date.now();
    saveConversations();
    render();
  } finally {
    state.busy = false;
    state.controller = null;
    elements.sendButton.classList.remove('busy');
    elements.sendButton.setAttribute('aria-label', '메시지 보내기');
    elements.sendButton.disabled = false;
  }
}

function resizeInput() {
  elements.messageInput.style.height = 'auto';
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 170)}px`;
}

function showSettings() {
  elements.settingsModal.hidden = false;
  refreshStatus();
  if (!statusPollTimer) statusPollTimer = setInterval(refreshStatus, 2500);
  document.querySelector('#closeSettings').focus();
}

function showSearch() {
  elements.searchModal.hidden = false;
  elements.searchInput.value = '';
  renderSearchResults();
  requestAnimationFrame(() => elements.searchInput.focus());
}

function hideSearch() {
  elements.searchModal.hidden = true;
  elements.searchInput.value = '';
}

function selectConversation(conversation) {
  if (state.busy) {
    showToast('응답이 끝난 뒤 대화를 전환해 주세요.');
    return false;
  }
  state.activeId = conversation.id;
  state.activeProjectId = project(conversation.projectId) ? conversation.projectId : null;
  state.provider = conversation.provider;
  if (state.provider === 'openai') {
    state.activeCodexAccountId = state.codexAccounts.some((account) => account.id === conversation.codexAccountId)
      ? conversation.codexAccountId
      : 'default';
  }
  const models = modelsForProvider(state.provider);
  state.model = models.some((model) => model.id === conversation.model)
    ? conversation.model
    : models[0]?.id || '';
  savePreferences();
  render();
  closeMobileSidebar();
  return true;
}

function hideSettings() {
  elements.settingsModal.hidden = true;
  clearInterval(statusPollTimer);
  statusPollTimer = null;
}

function closeMobileSidebar() {
  elements.sidebar.classList.remove('mobile-open');
}

document.querySelector('#newChatButton').addEventListener('click', createConversation);
document.querySelector('#addProjectButton').addEventListener('click', () => openProjectEditor());
document.querySelector('#importProjectButton').addEventListener('click', () => elements.projectImportFile.click());
elements.projectImportFile.addEventListener('change', (event) => selectProjectImportFile(event.target.files?.[0]));
document.querySelector('#commitProjectImport').addEventListener('click', commitProjectImport);
document.querySelector('#cancelProjectImport').addEventListener('click', closeProjectImport);
document.querySelector('#closeProjectImport').addEventListener('click', closeProjectImport);
document.querySelector('#saveProjectButton').addEventListener('click', saveProjectEditor);
document.querySelector('#cancelProjectModal').addEventListener('click', closeProjectEditor);
document.querySelector('#closeProjectModal').addEventListener('click', closeProjectEditor);
document.querySelector('#deleteProjectButton').addEventListener('click', deleteActiveProject);
elements.projectList.addEventListener('click', (event) => {
  const editButton = event.target.closest('[data-edit-project]');
  if (editButton) {
    openProjectEditor(editButton.dataset.editProject);
    return;
  }
  const selectButton = event.target.closest('[data-select-project]');
  if (selectButton) selectProject(selectButton.dataset.selectProject === 'all' ? null : selectButton.dataset.selectProject);
});
elements.conversationProjectAction.addEventListener('click', () => openProjectMove());
document.querySelector('#saveProjectMove').addEventListener('click', moveConversationToProject);
document.querySelector('#cancelProjectMove').addEventListener('click', closeProjectMove);
document.querySelector('#closeProjectMoveModal').addEventListener('click', closeProjectMove);
document.querySelector('#searchChatButton').addEventListener('click', showSearch);
document.querySelector('#sidebarToggle').addEventListener('click', () => elements.sidebar.classList.toggle('collapsed'));
document.querySelector('#mobileMenu').addEventListener('click', () => elements.sidebar.classList.toggle('mobile-open'));
document.querySelector('#settingsButton').addEventListener('click', showSettings);
document.querySelector('#settingsButtonTop').addEventListener('click', showSettings);
document.querySelector('#closeSettings').addEventListener('click', hideSettings);
document.querySelector('#doneSettings').addEventListener('click', hideSettings);
document.querySelector('#refreshStatus').addEventListener('click', refreshStatus);
document.querySelector('#connectClaude').addEventListener('click', toggleClaudeConnection);
elements.addCodexAccountButton.addEventListener('click', () => connectCodexAccount());
elements.codexAccountsList.addEventListener('click', (event) => {
  const connectButton = event.target.closest('[data-connect-codex-account]');
  if (connectButton) {
    connectCodexAccount(connectButton.dataset.connectCodexAccount);
    return;
  }
  const useButton = event.target.closest('[data-use-codex-account]');
  if (useButton) setCodexAccount(useButton.dataset.useCodexAccount);
  const cancelButton = event.target.closest('[data-cancel-codex-login]');
  if (cancelButton) updateCodexAccountLink(cancelButton.dataset.cancelCodexLogin, 'cancel');
  const disconnectButton = event.target.closest('[data-disconnect-codex-account]');
  if (disconnectButton) updateCodexAccountLink(disconnectButton.dataset.disconnectCodexAccount, 'disconnect');
  const deleteButton = event.target.closest('[data-delete-codex-account]');
  if (deleteButton) updateCodexAccountLink(deleteButton.dataset.deleteCodexAccount, 'delete');
});
elements.settingsModal.addEventListener('click', (event) => { if (event.target === elements.settingsModal) hideSettings(); });
elements.projectModal.addEventListener('click', (event) => { if (event.target === elements.projectModal) closeProjectEditor(); });
elements.projectMoveModal.addEventListener('click', (event) => { if (event.target === elements.projectMoveModal) closeProjectMove(); });
elements.projectImportModal.addEventListener('click', (event) => { if (event.target === elements.projectImportModal) closeProjectImport(); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!elements.searchModal.hidden) hideSearch();
    hideSettings();
    closeProjectEditor();
    closeProjectMove();
    closeProjectImport();
    elements.providerMenu.hidden = true;
    closeMobileSidebar();
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    showSearch();
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    hideSearch();
    createConversation();
  }
});

elements.searchInput.addEventListener('input', renderSearchResults);
elements.searchModal.addEventListener('click', (event) => {
  if (event.target === elements.searchModal) hideSearch();
});
elements.searchResults.addEventListener('click', (event) => {
  const result = event.target.closest('[data-search-id]');
  if (!result) return;
  const conversation = state.conversations.find((item) => item.id === result.dataset.searchId);
  if (conversation && selectConversation(conversation)) hideSearch();
});

elements.conversationList.addEventListener('click', (event) => {
  const deleteButton = event.target.closest('[data-delete]');
  if (deleteButton) {
    event.stopPropagation();
    const id = deleteButton.dataset.delete;
    const conversation = state.conversations.find((item) => item.id === id);
    if (state.busy && state.activeId === id) {
      showToast('응답이 끝난 뒤 대화를 삭제해 주세요.');
      return;
    }
    if (conversation?.provider === 'openai' && conversation.codexThreadId) {
      fetch('/api/thread/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: conversation.codexThreadId, codexAccountId: conversation.codexAccountId || 'default' }),
      }).then(async (response) => {
        if (!response.ok) showToast('브라우저 대화는 삭제했지만 Codex 기록은 삭제하지 못했습니다.');
      }).catch(() => showToast('브라우저 대화는 삭제했지만 Codex 기록을 서버에 전달하지 못했습니다.'));
    }
    state.conversations = state.conversations.filter((conversation) => conversation.id !== id);
    if (state.activeId === id) state.activeId = null;
    saveConversations();
    render();
    return;
  }
  const row = event.target.closest('[data-id]');
  if (!row) return;
  const conversation = state.conversations.find((item) => item.id === row.dataset.id);
  if (!conversation) return;
  selectConversation(conversation);
});
elements.conversationList.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.conversation-row')) event.target.click();
});

elements.providerSelectButton.addEventListener('click', () => { elements.providerMenu.hidden = !elements.providerMenu.hidden; });
elements.providerMenu.addEventListener('click', (event) => {
  const button = event.target.closest('[data-provider]');
  if (button) setProvider(button.dataset.provider);
});
document.addEventListener('click', (event) => {
  if (!elements.providerMenu.hidden && !elements.providerMenu.contains(event.target) && !elements.providerSelectButton.contains(event.target)) {
    elements.providerMenu.hidden = true;
  }
});
elements.modelSelect.addEventListener('change', (event) => setModel(event.target.value));
elements.fastModeToggle.addEventListener('click', toggleFastMode);
elements.codexAccountSelect.addEventListener('change', (event) => setCodexAccount(event.target.value));
elements.composerForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (state.busy) {
    state.controller?.abort();
    return;
  }
  sendMessage(elements.messageInput.value);
});
elements.messageInput.addEventListener('input', resizeInput);
elements.messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!state.busy) sendMessage(elements.messageInput.value);
  }
});
document.querySelectorAll('.suggestion').forEach((button) => {
  button.addEventListener('click', () => {
    elements.messageInput.value = button.dataset.prompt;
    resizeInput();
    elements.messageInput.focus();
  });
});

loadPreferences();
render();
refreshStatus();

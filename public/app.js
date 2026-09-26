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
const state = {
  conversations: loadConversations(),
  activeId: null,
  provider: 'openai',
  model: 'gpt-5.6',
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
};
state.activeId = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id || null;

const elements = {
  sidebar: document.querySelector('#sidebar'),
  conversationList: document.querySelector('#conversationList'),
  chatScroll: document.querySelector('#chatScroll'),
  welcome: document.querySelector('#welcome'),
  messages: document.querySelector('#messages'),
  composerForm: document.querySelector('#composerForm'),
  messageInput: document.querySelector('#messageInput'),
  sendButton: document.querySelector('#sendButton'),
  modelSelect: document.querySelector('#modelSelect'),
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
        updatedAt: Number(item.updatedAt) || Date.now(),
        messages: item.messages.filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message.content === 'string')
          .map((message) => ({ role: message.role, content: message.content.slice(0, 40_000) })),
      }));
  } catch {
    return [];
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
  const sorted = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  elements.conversationList.innerHTML = sorted.map((conversation) => `
    <div class="conversation-row${conversation.id === state.activeId ? ' active' : ''}" data-id="${escapeHtml(conversation.id)}" role="button" tabindex="0" aria-label="${escapeHtml(conversation.title)} 열기">
      <span class="conversation-provider-mark">${PROVIDERS[conversation.provider]?.mark || '◉'}</span>
      <span class="conversation-title">${escapeHtml(conversation.title)}</span>
      <button class="delete-conversation" type="button" data-delete="${escapeHtml(conversation.id)}" aria-label="대화 삭제">×</button>
    </div>`).join('');
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
    const loginLabel = waiting ? '로그인 중' : account.installed ? '로그인' : 'CLI 설치 필요';
    const accountHint = [account.accountEmail, account.planType || (!account.accountEmail ? account.label : '')].filter(Boolean).join(' · ') || 'Codex 계정';
    return `<article class="codex-account-card${selected ? ' active' : ''}">
      <span class="connection-logo openai-logo">◉</span>
      <div class="connection-details"><div class="codex-account-title"><strong>${escapeHtml(account.name)}</strong>${selected ? '<span class="active-account-badge">사용 중</span>' : ''}</div>
        <small class="codex-account-plan">${escapeHtml(accountHint)}</small>
        <small class="usage-status">${escapeHtml(codexUsageText(account))}</small>
        ${!account.installed && account.installCommand ? `<code class="install-command">${escapeHtml(account.installCommand)}</code>` : ''}
      </div>
      <div class="connection-actions"><span class="connection-status${account.connected ? ' ready' : ''}">${account.connected ? '연결됨' : waiting ? '인증 중' : '로그인 필요'}</span>
        ${account.connected
          ? `<button class="account-use-button" type="button" data-use-codex-account="${escapeHtml(account.id)}"${selected ? ' disabled' : ''}>${selected ? '선택됨' : '사용'}</button>`
          : `<button class="connect-button" type="button" data-connect-codex-account="${escapeHtml(account.id)}"${!account.installed || waiting ? ' disabled' : ''}>${loginLabel}</button>`}
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
}

function render() {
  renderConversationList();
  renderMessages();
  renderCodexAccounts();
  renderCodexAccountSelect();
  renderModelSelect();
  document.querySelector('#connectionSummary').textContent = connectionSummary();
  const conversation = activeConversation();
  document.querySelector('#modeLabel').textContent = conversation?.messages.length ? conversation.title : '새 대화';
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
  claudeButton.textContent = anthropic.connected ? '연결됨' : claudeJob?.state === 'running' || claudeJob?.state === 'starting' ? '진행 중' : anthropic.installed ? '로그인' : '설치 필요';
  claudeButton.disabled = anthropic.connected === true || anthropic.installed !== true || claudeJob?.state === 'running' || claudeJob?.state === 'starting';
  claudeButton.classList.toggle('connected', anthropic.connected === true);
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
    if (!state.codexAccounts.some((account) => account.id === state.activeCodexAccountId)) state.activeCodexAccountId = 'default';
    const defaultModels = state.codexAccounts.find((account) => account.id === 'default')?.models;
    if (Array.isArray(defaultModels) && defaultModels.length) {
      PROVIDERS.openai.models = defaultModels.map((model) => ({ id: model.id, label: model.label }));
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
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: state.provider,
        model: state.model,
        ...(state.provider === 'openai' ? { codexAccountId: conversation.codexAccountId || 'default' } : {}),
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
document.querySelector('#searchChatButton').addEventListener('click', showSearch);
document.querySelector('#sidebarToggle').addEventListener('click', () => elements.sidebar.classList.toggle('collapsed'));
document.querySelector('#mobileMenu').addEventListener('click', () => elements.sidebar.classList.toggle('mobile-open'));
document.querySelector('#settingsButton').addEventListener('click', showSettings);
document.querySelector('#settingsButtonTop').addEventListener('click', showSettings);
document.querySelector('#closeSettings').addEventListener('click', hideSettings);
document.querySelector('#doneSettings').addEventListener('click', hideSettings);
document.querySelector('#refreshStatus').addEventListener('click', refreshStatus);
document.querySelector('#connectClaude').addEventListener('click', () => connectProvider('anthropic'));
elements.addCodexAccountButton.addEventListener('click', () => connectCodexAccount());
elements.codexAccountsList.addEventListener('click', (event) => {
  const connectButton = event.target.closest('[data-connect-codex-account]');
  if (connectButton) {
    connectCodexAccount(connectButton.dataset.connectCodexAccount);
    return;
  }
  const useButton = event.target.closest('[data-use-codex-account]');
  if (useButton) setCodexAccount(useButton.dataset.useCodexAccount);
});
elements.settingsModal.addEventListener('click', (event) => { if (event.target === elements.settingsModal) hideSettings(); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!elements.searchModal.hidden) hideSearch();
    hideSettings();
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

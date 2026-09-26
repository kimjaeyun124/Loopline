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
  busy: false,
  controller: null,
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
  settingsModal: document.querySelector('#settingsModal'),
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
    if (PROVIDERS[state.provider].models.some((model) => model.id === preferences.model)) state.model = preferences.model;
  } catch {
    // 기본 모델 설정을 유지합니다.
  }
}

function savePreferences() {
  localStorage.setItem(PREFERENCE_KEY, JSON.stringify({ provider: state.provider, model: state.model }));
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

function renderModelSelect() {
  const provider = PROVIDERS[state.provider];
  elements.modelSelect.innerHTML = provider.models.map((model) =>
    `<option value="${model.id}"${model.id === state.model ? ' selected' : ''}>${model.label}</option>`).join('');
  document.querySelector('#providerSelectLabel').textContent = provider.label;
  document.querySelector('#miniProviderMark').textContent = provider.mark;
  document.querySelector('#providerPillText').textContent = `${provider.label} 계정`;
  document.querySelector('#providerDot').classList.toggle('connected', state.providers[state.provider]?.connected === true);
  document.querySelectorAll('.provider-menu [data-provider]').forEach((button) => {
    button.classList.toggle('selected', button.dataset.provider === state.provider);
  });
}

function render() {
  renderConversationList();
  renderMessages();
  renderModelSelect();
  document.querySelector('#connectionSummary').textContent = connectionSummary();
}

function connectionSummary() {
  const count = Object.values(state.providers).filter((provider) => provider?.connected).length;
  if (count === 0) return '계정 연결 필요';
  return `${count}개 계정 연결됨`;
}

let statusRequestInProgress = false;
let statusPollTimer = null;

function updateConnectionControls() {
  const feedback = document.querySelector('#loginFeedback');
  const rows = [
    ['openai', 'openaiStatus', 'connectOpenAI', 'openaiInstall'],
    ['anthropic', 'anthropicStatus', 'connectClaude', 'anthropicInstall'],
  ];
  const messages = [];

  for (const [provider, statusId, buttonId, installId] of rows) {
    const details = state.providers[provider] || {};
    const job = state.loginJobs[provider];
    const statusElement = document.querySelector(`#${statusId}`);
    const button = document.querySelector(`#${buttonId}`);
    const installElement = document.querySelector(`#${installId}`);
    statusElement.textContent = details.label || '상태 확인 실패';
    statusElement.classList.toggle('ready', details.connected === true);
    button.textContent = details.connected ? '연결됨' : job?.state === 'running' || job?.state === 'starting' ? '진행 중' : details.installed ? '로그인' : '설치 필요';
    button.disabled = details.connected === true || details.installed !== true || job?.state === 'running' || job?.state === 'starting';
    button.classList.toggle('connected', details.connected === true);
    installElement.textContent = details.installCommand || '';
    installElement.hidden = details.installed !== false || !details.installCommand;

    if (details.connected) continue;
    if (job?.output) messages.push(`${PROVIDERS[provider].label} 로그인 안내:\n${job.output.trim()}`);
    else if (job?.state === 'running' || job?.state === 'starting') messages.push(`${PROVIDERS[provider].label} 공식 로그인 창에서 인증을 완료해 주세요.`);
    else if (job?.state === 'failed') messages.push(`${PROVIDERS[provider].label} 로그인 절차가 종료되었습니다. CLI 상태를 새로고침해 주세요.`);
  }

  feedback.textContent = messages.join('\n\n');
  feedback.hidden = messages.length === 0;
}

async function refreshStatus() {
  if (statusRequestInProgress) return;
  statusRequestInProgress = true;
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    const status = await response.json();
    state.providers = status.providers || state.providers;
    state.loginJobs = status.loginJobs || {};
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
  feedback.textContent = `${PROVIDERS[provider].label} 공식 CLI 로그인 절차를 여는 중입니다…`;
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
  if (!PROVIDERS[provider].models.some((model) => model.id === state.model)) state.model = PROVIDERS[provider].models[0].id;
  const conversation = activeConversation();
  if (conversation && conversation.messages.length === 0) {
    conversation.provider = provider;
    conversation.model = state.model;
  }
  savePreferences();
  saveConversations();
  render();
  elements.providerMenu.hidden = true;
}

function setModel(model) {
  if (!PROVIDERS[state.provider].models.some((item) => item.id === model)) return;
  state.model = model;
  const conversation = activeConversation();
  if (conversation && conversation.messages.length === 0) conversation.model = model;
  savePreferences();
  saveConversations();
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
  conversation.provider = state.provider;
  conversation.model = state.model;
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
      body: JSON.stringify({ provider: state.provider, model: state.model, messages }),
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

function hideSettings() {
  elements.settingsModal.hidden = true;
  clearInterval(statusPollTimer);
  statusPollTimer = null;
}

function closeMobileSidebar() {
  elements.sidebar.classList.remove('mobile-open');
}

document.querySelector('#newChatButton').addEventListener('click', createConversation);
document.querySelector('#sidebarToggle').addEventListener('click', () => elements.sidebar.classList.toggle('collapsed'));
document.querySelector('#mobileMenu').addEventListener('click', () => elements.sidebar.classList.toggle('mobile-open'));
document.querySelector('#settingsButton').addEventListener('click', showSettings);
document.querySelector('#settingsButtonTop').addEventListener('click', showSettings);
document.querySelector('#closeSettings').addEventListener('click', hideSettings);
document.querySelector('#doneSettings').addEventListener('click', hideSettings);
document.querySelector('#refreshStatus').addEventListener('click', refreshStatus);
document.querySelector('#connectOpenAI').addEventListener('click', () => connectProvider('openai'));
document.querySelector('#connectClaude').addEventListener('click', () => connectProvider('anthropic'));
elements.settingsModal.addEventListener('click', (event) => { if (event.target === elements.settingsModal) hideSettings(); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    hideSettings();
    elements.providerMenu.hidden = true;
    closeMobileSidebar();
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    createConversation();
  }
});

elements.conversationList.addEventListener('click', (event) => {
  const deleteButton = event.target.closest('[data-delete]');
  if (deleteButton) {
    event.stopPropagation();
    const id = deleteButton.dataset.delete;
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
  if (state.busy) {
    showToast('응답이 끝난 뒤 대화를 전환해 주세요.');
    return;
  }
  state.activeId = conversation.id;
  state.provider = conversation.provider;
  state.model = PROVIDERS[state.provider].models.some((model) => model.id === conversation.model)
    ? conversation.model
    : PROVIDERS[state.provider].models[0].id;
  savePreferences();
  render();
  closeMobileSidebar();
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

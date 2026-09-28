import { icon } from './icons.js';
import { parseProviderExport } from './export-importer.js';
import { createApiConnectionsUI } from './api-connections-ui.js';
import { createHistoryImportUI } from './history-import-ui.js';
import { createChatGptUI } from './chatgpt-ui.js';
import { createModelVisibilityUI } from './model-visibility-ui.js';
import { createAccountMenuUI } from './account-menu-ui.js';
import { createUsageActivityUI } from './usage-activity-ui.js';
import { modelEffortCapability } from './model-capabilities.mjs';
import { renderMarkdown } from './markdown.js';

const PROVIDERS = {
  openai: {
    label: 'Codex',
    mark: icon('terminal'),
    models: [
      { id: 'gpt-5.6', label: 'GPT-5.6 Sol' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    ],
  },
  anthropic: {
    label: 'Claude',
    mark: icon('asterisk'),
    models: [
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'claude-opus-5', label: 'Claude Opus 5' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    ],
  },
  api: { label: 'API', mark: icon('plug'), models: [] },
};

const STORAGE_KEY = 'mosaic-ai.conversations.v1';
const PREFERENCE_KEY = 'mosaic-ai.preferences.v1';
const PROJECT_STORAGE_KEY = 'mosaic-ai.projects.v1';
const SIDEBAR_WIDTH_DEFAULT = 248;
const SIDEBAR_WIDTH_MIN = 208;
const SIDEBAR_WIDTH_MAX = 440;
const state = {
  conversations: loadConversations(),
  projects: loadProjects(),
  pendingProjectImport: null,
  activeId: null,
  activeProjectId: null,
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  editingProjectId: null,
  movingConversationId: null,
  provider: '',
  model: '',
  activeConnectionId: null,
  apiConnections: [],
  keyStorage: 'session',
  fastMode: false,
  reasoningEfforts: {},
  agentInstructions: {
    shared: '',
    codex: '',
    claude: '',
    codexUsesShared: true,
    claudeUsesShared: true,
  },
  providers: {
    openai: { installed: false, connected: false, linked: false, label: '상태 확인 중' },
    anthropic: { installed: false, connected: false, label: '상태 확인 중' },
  },
  webServices: { chatgpt: false, gemini: false },
  loginJobs: {},
  loginUrls: {},
  busy: false,
  controller: null,
  codexAccounts: [],
  activeCodexAccountId: 'default',
  busyCodexAccountIds: new Set(),
  busyClaudeConnectionChange: false,
  statusUpdatedAt: null,
  statusError: false,
};
state.activeId = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id || null;

const elements = {
  sidebar: document.querySelector('#sidebar'),
  sidebarResizeHandle: document.querySelector('#sidebarResizeHandle'),
  sidebarToggle: document.querySelector('#sidebarToggle'),
  mobileMenu: document.querySelector('#mobileMenu'),
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
  conversationActions: document.querySelector('#conversationActions'),
  copyLastResponseButton: document.querySelector('#copyLastResponse'),
  exportConversationButton: document.querySelector('#exportConversation'),
  composerForm: document.querySelector('#composerForm'),
  messageInput: document.querySelector('#messageInput'),
  sendButton: document.querySelector('#sendButton'),
  stopResponseButton: document.querySelector('#stopResponseButton'),
  providerSelectButton: document.querySelector('#providerSelectButton'),
  modelSelectButton: document.querySelector('#modelSelectButton'),
  modelMenu: document.querySelector('#modelMenu'),
  modelSearch: document.querySelector('#modelSearch'),
  modelOptions: document.querySelector('#modelOptions'),
  composerReasoningControl: document.querySelector('#composerReasoningControl'),
  composerReasoningEffortSelect: document.querySelector('#composerReasoningEffortSelect'),
  fastModeToggle: document.querySelector('#fastModeToggle'),
  codexAccountsList: document.querySelector('#codexAccountsList'),
  addCodexAccountButton: document.querySelector('#addCodexAccount'),
  settingsModal: document.querySelector('#settingsModal'),
  sharedAgentInstructions: document.querySelector('#sharedAgentInstructions'),
  codexAgentInstructions: document.querySelector('#codexAgentInstructions'),
  claudeAgentInstructions: document.querySelector('#claudeAgentInstructions'),
  codexUsesSharedInstructions: document.querySelector('#codexUsesSharedInstructions'),
  claudeUsesSharedInstructions: document.querySelector('#claudeUsesSharedInstructions'),
  agentInstructionsSaveStatus: document.querySelector('#agentInstructionsSaveStatus'),
  searchModal: document.querySelector('#searchModal'),
  searchInput: document.querySelector('#searchInput'),
  searchResults: document.querySelector('#searchResults'),
  searchEmpty: document.querySelector('#searchEmpty'),
  toast: document.querySelector('#toast'),
};
let modelMenuMode = 'providers';
let workedForInterval = null;
let workedForMessageId = null;
const apiConnectionsUI = createApiConnectionsUI({ onChange: refreshApiConnections, showToast });
const accountMenuUI = createAccountMenuUI({
  onOpen: () => { closeModelMenu(); void refreshStatus(); },
  onUsage: () => showSettings('usage'),
  onSettings: () => showSettings(),
  formatAccountName: codexAccountDisplayName,
  formatWindow: formatUsageWindow,
  formatReset: formatUsageReset,
});
const usageActivityUI = createUsageActivityUI({
  getAccounts: () => state.codexAccounts.filter((account) => account.linked),
  getActiveAccountId: () => state.activeCodexAccountId,
  formatAccountName: codexAccountDisplayName,
});
const modelVisibilityUI = createModelVisibilityUI({
  getModels: modelCatalog,
  getModelKey: modelKey,
  getSelectedKey: selectedModelKey,
  onChange: () => { if (!elements.modelMenu.hidden) renderModelOptions(); },
  showToast,
});
let projectImportReturnsToSettings = false;
const historyImportUI = createHistoryImportUI({
  getProjects: () => state.projects,
  isImported: historyAlreadyImported,
  onImport: commitHistoryImport,
  onFileImport: () => elements.projectImportFile.click(),
  onClose: () => showSettings('history'),
  isBusy: () => state.busy,
  showToast,
});
if (new URLSearchParams(location.search).get('desktop') === '1') {
  document.body.classList.add('desktop');
  document.querySelector('.brand').href = '/?desktop=1';
}
const chatGptUI = createChatGptUI({
  beforeOpen: () => { accountMenuUI.close(); hideSettings(); hideSearch(); closeModelMenu(); },
  onWorkspace: () => elements.messageInput.focus(),
});

function loadConversations() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(value)) return [];
    let titlesMigrated = false;
    const conversations = value.filter((item) => item && typeof item.id === 'string' && Array.isArray(item.messages))
      .map((item) => {
        const messages = item.messages.filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message.content === 'string')
          .map((message) => {
            const normalized = {
              role: message.role,
              content: message.content.slice(0, item.historySourceLabel ? 1_600_000 : 40_000),
            };
            if (typeof message.id === 'string') normalized.id = message.id.slice(0, 120);
            if (message.role === 'assistant' && Number.isFinite(message.workedForMs) && message.workedForMs >= 0) {
              normalized.workedForMs = Math.floor(message.workedForMs);
            }
            if (message.role === 'assistant' && Array.isArray(message.activities)) {
              normalized.activities = message.activities.slice(-60).flatMap((activity) => {
                if (!activity || typeof activity.id !== 'string' || typeof activity.title !== 'string') return [];
                const status = ['pending', 'running', 'completed', 'failed', 'stopped'].includes(activity.status)
                  ? activity.status
                  : 'completed';
                return [{
                  id: activity.id.slice(0, 120),
                  title: activity.title.slice(0, 220),
                  detail: typeof activity.detail === 'string' ? activity.detail.slice(0, 240) : '',
                  status,
                  ...(activity.kind === 'commentary' ? {
                    kind: 'commentary',
                    text: typeof activity.text === 'string' ? activity.text.slice(0, 6000) : '',
                  } : {}),
                }];
              });
              const responseActivityIndex = normalized.activities.findIndex((activity) => activity.id === 'response');
              if (responseActivityIndex >= 0 && responseActivityIndex !== normalized.activities.length - 1) {
                normalized.activities.push(normalized.activities.splice(responseActivityIndex, 1)[0]);
              }
              if (typeof message.activityExpanded === 'boolean') normalized.activityExpanded = message.activityExpanded;
            }
            if (message.role === 'user' && message.queued === true) {
              normalized.queued = true;
              const options = message.queueOptions && typeof message.queueOptions === 'object' ? message.queueOptions : {};
              normalized.queueOptions = {
                provider: Object.hasOwn(PROVIDERS, options.provider) ? options.provider : '',
                model: typeof options.model === 'string' ? options.model.slice(0, 160) : '',
                connectionId: typeof options.connectionId === 'string' ? options.connectionId.slice(0, 160) : null,
                codexAccountId: typeof options.codexAccountId === 'string' ? options.codexAccountId.slice(0, 120) : null,
                reasoningEffort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(options.reasoningEffort) ? options.reasoningEffort : '',
                fastMode: options.fastMode === true,
              };
            }
            return normalized;
          });
        const storedTitle = String(item.title || '새 대화').slice(0, 80);
        const firstUserMessage = messages.find((message) => message.role === 'user')?.content;
        const title = ['새 작업', '새 대화'].includes(storedTitle) && firstUserMessage
          ? conversationTitleFromMessage(firstUserMessage)
          : storedTitle;
        if (title !== storedTitle) titlesMigrated = true;
        return {
          id: item.id,
          title,
          provider: Object.hasOwn(PROVIDERS, item.provider) ? item.provider : '',
          model: String(item.model || ''),
          connectionId: typeof item.connectionId === 'string' ? item.connectionId : null,
          codexThreadId: typeof item.codexThreadId === 'string' ? item.codexThreadId : null,
          codexAccountId: typeof item.codexAccountId === 'string' ? item.codexAccountId : 'default',
          projectId: typeof item.projectId === 'string' ? item.projectId : null,
          importSource: ['openai', 'anthropic', 'cline', 'opencode', 'ollama'].includes(item.importSource) ? item.importSource : null,
          sourceId: typeof item.sourceId === 'string' ? item.sourceId.slice(0, 240) : null,
          historySourceLabel: typeof item.historySourceLabel === 'string' ? item.historySourceLabel.slice(0, 80) : null,
          updatedAt: Number(item.updatedAt) || Date.now(),
          messages,
        };
      });
    if (titlesMigrated) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations)); } catch { /* Keep the migrated titles visible for this session. */ }
    }
    return conversations;
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

function historyAlreadyImported(item) {
  return state.conversations.some((conversation) => conversation.sourceId === item.sourceKey
    || (item.provider === 'openai' && conversation.codexThreadId === item.id && conversation.codexAccountId === item.accountId));
}

function commitHistoryImport(items, projectId) {
  if (state.busy) throw new Error('응답이 끝난 뒤 대화를 가져와 주세요.');
  const additions = [];
  const seen = new Set();
  for (const item of items) {
    if (historyAlreadyImported(item) || seen.has(item.sourceKey)) continue;
    seen.add(item.sourceKey);
    const provider = ['openai', 'anthropic'].includes(item.provider)
      ? item.provider
      : Object.hasOwn(PROVIDERS, state.provider) ? state.provider : 'openai';
    const models = modelsForProvider(provider);
    const model = models.some((candidate) => candidate.id === item.model)
      ? item.model
      : models.some((candidate) => candidate.id === state.model) ? state.model : models[0]?.id || '';
    additions.push({
      id: crypto.randomUUID(), title: item.title.slice(0, 80), provider,
      model, connectionId: provider === 'api' ? state.activeConnectionId : null, codexThreadId: null,
      codexAccountId: provider === 'openai' ? (item.provider === 'openai' ? item.accountId : state.activeCodexAccountId) : 'default',
      projectId: project(projectId)?.id || null,
      importSource: item.provider, sourceId: item.sourceKey,
      historySourceLabel: item.sourceLabel, updatedAt: item.updatedAt || Date.now(),
      messages: item.messages.map(({ role, content }) => ({ role, content })),
    });
  }
  const next = [...additions, ...state.conversations];
  const serialized = JSON.stringify(next);
  const otherBytes = Object.keys(localStorage).filter((key) => key !== STORAGE_KEY)
    .reduce((total, key) => total + (key.length + (localStorage.getItem(key) || '').length) * 2, 0);
  if (otherBytes + (STORAGE_KEY.length + serialized.length) * 2 > 3_800_000) {
    throw new Error('선택한 대화가 앱의 남은 저장 공간보다 큽니다. 대화 개수를 줄여 주세요.');
  }
  // Commit one storage value before changing visible state, so a quota failure leaves the import untouched.
  try { localStorage.setItem(STORAGE_KEY, serialized); }
  catch { throw new Error('대화를 저장할 공간이 부족합니다. 이번 가져오기는 저장되지 않았습니다.'); }
  state.conversations = next;
  if (additions.length) selectConversation(additions[0]);
  else render();
  return additions.length;
}

function loadPreferences() {
  try {
    const preferences = JSON.parse(localStorage.getItem(PREFERENCE_KEY) || '{}');
    if (Number.isFinite(preferences.sidebarWidth)) {
      state.sidebarWidth = Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.round(preferences.sidebarWidth)));
    }
    if (Object.hasOwn(PROVIDERS, preferences.provider)) state.provider = preferences.provider;
    if (typeof preferences.codexAccountId === 'string') state.activeCodexAccountId = preferences.codexAccountId;
    if (typeof preferences.activeProjectId === 'string') state.activeProjectId = preferences.activeProjectId;
    if (typeof preferences.fastMode === 'boolean') state.fastMode = preferences.fastMode;
    if (preferences.agentInstructions && typeof preferences.agentInstructions === 'object' && !Array.isArray(preferences.agentInstructions)) {
      const saved = preferences.agentInstructions;
      if (typeof saved.shared === 'string') state.agentInstructions.shared = saved.shared.slice(0, 12_000);
      if (typeof saved.codex === 'string') state.agentInstructions.codex = saved.codex.slice(0, 8_000);
      if (typeof saved.claude === 'string') state.agentInstructions.claude = saved.claude.slice(0, 8_000);
      if (typeof saved.codexUsesShared === 'boolean') state.agentInstructions.codexUsesShared = saved.codexUsesShared;
      if (typeof saved.claudeUsesShared === 'boolean') state.agentInstructions.claudeUsesShared = saved.claudeUsesShared;
    }
    if (state.provider && typeof preferences.model === 'string') state.model = preferences.model;
    if (typeof preferences.connectionId === 'string') state.activeConnectionId = preferences.connectionId;
    if (preferences.reasoningEfforts && typeof preferences.reasoningEfforts === 'object' && !Array.isArray(preferences.reasoningEfforts)) {
      for (const [key, effort] of Object.entries(preferences.reasoningEfforts).slice(0, 500)) {
        if (typeof effort !== 'string' || !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) continue;
        try {
          const selection = JSON.parse(key);
          if (Array.isArray(selection) && selection.length === 4
            && ['openai', 'anthropic', 'api'].includes(selection[0])
            && selection.every((part) => typeof part === 'string')) {
            state.reasoningEfforts[key] = effort;
          }
        } catch { /* Ignore malformed saved model preferences. */ }
      }
    }
    // Migrate the earlier single-model preference without changing the selected value.
    if (preferences.provider === 'openai' && typeof preferences.reasoningEffort === 'string' && preferences.reasoningEffort.trim()) {
      const key = reasoningPreferenceKey();
      if (!Object.hasOwn(state.reasoningEfforts, key)) state.reasoningEfforts[key] = preferences.reasoningEffort;
    }
  } catch {
    // 선택 이력이 없거나 읽을 수 없으면 모델을 자동 지정하지 않습니다.
  }
}

function savePreferences() {
  localStorage.setItem(PREFERENCE_KEY, JSON.stringify({
    provider: state.provider,
    model: state.model,
    connectionId: state.activeConnectionId,
    codexAccountId: state.activeCodexAccountId,
    activeProjectId: state.activeProjectId,
    sidebarWidth: state.sidebarWidth,
    fastMode: state.fastMode,
    agentInstructions: state.agentInstructions,
    reasoningEffort: reasoningSettings().selectedEffort,
    reasoningEfforts: state.reasoningEfforts,
  }));
}

function activeConversation() {
  return state.conversations.find((conversation) => conversation.id === state.activeId) || null;
}

function createConversation() {
  chatGptUI.showWorkspace();
  if (state.busy) { showToast('응답을 중지하거나 완료한 뒤 새 작업을 시작해 주세요.'); return; }
  const conversation = {
    id: crypto.randomUUID(),
    title: '새 작업',
    provider: state.provider,
    model: state.model,
    connectionId: state.provider === 'api' ? state.activeConnectionId : null,
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
      <span class="conversation-provider-mark">${PROVIDERS[conversation.provider]?.mark || icon('terminal')}</span>
      <span class="conversation-title">${escapeHtml(conversation.title)}</span>
      <button class="delete-conversation" type="button" data-delete="${escapeHtml(conversation.id)}" aria-label="대화 삭제">${icon('trash')}</button>
    </div>`).join('');
}

function project(projectId) {
  return state.projects.find((item) => item.id === projectId) || null;
}

function renderProjectList() {
  const rows = [`
    <div class="project-row${state.activeProjectId === null ? ' active' : ''}">
      <button class="project-select-button" type="button" data-select-project="all"><span class="project-icon">${icon('chat')}</span><span>모든 작업</span></button>
    </div>`, ...state.projects.map((item) => `
    <div class="project-row${item.id === state.activeProjectId ? ' active' : ''}">
      <button class="project-select-button" type="button" data-select-project="${escapeHtml(item.id)}"><span class="project-icon" title="${item.importSource === 'anthropic' ? 'Claude에서 가져옴' : item.importSource === 'openai' ? 'ChatGPT에서 가져옴' : item.importSource === 'cline' ? 'Cline에서 가져옴' : item.importSource === 'opencode' ? 'OpenCode에서 가져옴' : item.importSource === 'ollama' ? 'Ollama에서 가져옴' : 'Loopline 프로젝트'}">${icon('folder')}</span><span class="project-name">${escapeHtml(item.name)}</span><span class="project-count">${state.conversations.filter((conversation) => conversation.projectId === item.id).length}</span></button>
      <button class="project-edit-button" type="button" data-edit-project="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.name)} 프로젝트 편집" title="프로젝트 편집">${icon('more')}</button>
    </div>`)];
  elements.projectList.innerHTML = rows.join('');
  const conversation = activeConversation();
  const projectBar = elements.conversationProjectBar;
  projectBar.hidden = !conversation || (!conversation.messages.length && !conversation.projectId);
  elements.conversationProjectLabel.textContent = conversation?.projectId
    ? `프로젝트: ${project(conversation.projectId)?.name || '알 수 없는 프로젝트'}`
    : '프로젝트 미지정';
  if (conversation?.historySourceLabel) {
    elements.conversationProjectLabel.textContent = `${conversation.historySourceLabel}에서 가져옴 · ${elements.conversationProjectLabel.textContent}`;
  }
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
      <span class="search-result-icon">${PROVIDERS[conversation.provider]?.mark || icon('terminal')}</span>
      <span class="search-result-copy"><strong>${escapeHtml(conversation.title)}</strong><small>${escapeHtml(conversation.messages.find((message) => message.role === 'user')?.content || '아직 메시지가 없습니다.')}</small></span>
    </button>`).join('');
  elements.searchEmpty.hidden = matches.length > 0;
  elements.searchResults.hidden = matches.length === 0;
}

function renderMessages() {
  const conversation = activeConversation();
  const messages = conversation?.messages || [];
  document.querySelector('.main-panel').classList.toggle('empty', messages.length === 0);
  elements.welcome.hidden = messages.length > 0;
  elements.messages.classList.toggle('visible', messages.length > 0);
  const lastAssistantMessage = [...messages].reverse().find((message) => message.role === 'assistant');
  elements.conversationActions.hidden = messages.length === 0;
  elements.copyLastResponseButton.disabled = !lastAssistantMessage?.content || lastAssistantMessage.pending;
  elements.exportConversationButton.disabled = !messages.length || messages.some((message) => message.pending);
  if (!messages.length) {
    elements.messages.innerHTML = '';
    return;
  }

  const queuedMessages = messages.filter((message) => message.role === 'user' && message.queued);
  elements.messages.innerHTML = messages.map((message, index) => {
    const assistant = message.role === 'assistant';
    const errorClass = message.error ? ' error' : '';
    const content = message.pending && !message.content
      ? '<span class="typing-dots" aria-label="응답 생성 중"><i></i><i></i><i></i></span>'
      : assistant ? renderMarkdown(message.content, { copyDisabled: message.pending }) : escapeHtml(message.content);
    const copyLabel = assistant ? '답변' : '질문';
    const copyButton = `<button class="message-copy-button" type="button" data-copy-message-index="${index}" aria-label="${copyLabel} 복사" title="${copyLabel} 복사">${icon('copy')}<span>복사</span></button>`;
    const queuePosition = message.queued ? queuedMessages.findIndex((item) => item.id === message.id) + 1 : 0;
    const queueControls = message.queued
      ? `<span class="queue-status">대기열 ${Math.max(queuePosition, 1)}</span>${queuePosition === 1 && !state.busy ? '<button class="queue-retry-button" type="button" data-retry-queue="true">다시 시도</button>' : ''}<button class="queue-cancel-button" type="button" data-cancel-queued="${escapeHtml(message.id || '')}" aria-label="대기 메시지 취소">취소</button>`
      : '';
    if (assistant) {
      const hasWorkedFor = message.pending || Number.isFinite(message.workedForMs);
      const elapsedMs = message.pending ? Date.now() - (message.startedAt || Date.now()) : message.workedForMs;
      const activityItems = Array.isArray(message.activities) ? message.activities : [];
      const activityMarkup = activityItems.length ? `<details class="worked-for-details" data-activity-message-id="${escapeHtml(message.id || '')}"${message.activityExpanded === true || (message.activityExpanded !== false && message.pending) ? ' open' : ''}>
        <summary class="worked-for-row"><span class="worked-for-label" data-worked-for="${escapeHtml(message.id || '')}">${hasWorkedFor ? formatWorkedFor(elapsedMs) : '작업 과정'}</span>${message.pending ? '<span class="worked-for-live"><i aria-hidden="true"></i>진행 중</span>' : ''}</summary>
        <ol class="assistant-activity-list" aria-label="작업 단계">${activityItems.map((activity) => activity.kind === 'commentary'
          ? `<li class="activity-commentary activity-${escapeHtml(activity.status)}"><div class="activity-commentary-text">${renderMarkdown(activity.text || '', { copyDisabled: true })}</div></li>`
          : `<li class="activity-${escapeHtml(activity.status)}"><span class="activity-marker" aria-hidden="true"></span><div><span class="activity-event-label">${icon(activityIconName(activity))}<strong>${escapeHtml(activity.title)}</strong><span class="activity-state">${activityStatusLabel(activity.status)}</span></span>${activity.detail ? `<small>${escapeHtml(activity.detail)}</small>` : ''}</div></li>`).join('')}</ol>
      </details>` : hasWorkedFor ? `<div class="worked-for-row"><span class="worked-for-label" data-worked-for="${escapeHtml(message.id || '')}">${formatWorkedFor(elapsedMs)}</span>${message.pending ? '<span class="worked-for-live"><i aria-hidden="true"></i>진행 중</span>' : ''}</div>` : '';
      return `<article class="message assistant${errorClass}" data-message-id="${escapeHtml(message.id || '')}">
        <div class="assistant-response">
          ${activityMarkup}
          <section class="assistant-result" aria-label="${message.pending ? '응답' : '결과'}">
            <div class="assistant-result-label">${message.pending ? '응답' : '결과'}</div>
            <div class="message-content markdown-content">${content}${message.pending && message.content ? '<span class="typing-dots" aria-label="응답 생성 중"><i></i><i></i><i></i></span>' : ''}</div>
          </section>
          ${!message.pending && message.content ? `<div class="message-actions">${copyButton}</div>` : ''}
        </div>
      </article>`;
    }
    return `<article class="message user${errorClass}" data-message-id="${escapeHtml(message.id || '')}">
      <div class="user-message-group">
        <div class="message-content">${content}</div>
        <div class="message-actions">${queueControls}${copyButton}</div>
      </div>
    </article>`;
  }).join('');
  elements.chatScroll.scrollTop = elements.chatScroll.scrollHeight;
}

function activityStatusLabel(status) {
  return ({ pending: '대기', running: '진행 중', completed: '완료', failed: '실패', stopped: '중지' })[status] || '완료';
}

function activityIconName(activity) {
  const label = `${activity.title} ${activity.detail}`;
  if (/명령|도구 실행|실행/.test(label)) return 'terminal';
  if (/파일|읽기|변경/.test(label)) return 'pen';
  if (/검색/.test(label)) return 'search';
  if (/검토|분석|계획/.test(label)) return 'reasoning';
  return 'list';
}

function updateAssistantActivity(message, activity) {
  if (!message || !activity || typeof activity.id !== 'string' || typeof activity.title !== 'string') return;
  const status = ['pending', 'running', 'completed', 'failed', 'stopped'].includes(activity.status)
    ? activity.status
    : 'completed';
  const next = {
    id: activity.id.slice(0, 120),
    title: activity.title.replace(/\s+/g, ' ').trim().slice(0, 220),
    detail: typeof activity.detail === 'string' ? activity.detail.replace(/\s+/g, ' ').trim().slice(0, 240) : '',
    status,
    ...(activity.kind === 'commentary' ? {
      kind: 'commentary',
      text: typeof activity.text === 'string' ? activity.text.slice(0, 6000) : '',
    } : {}),
  };
  if (!next.id || !next.title) return;
  if (!Array.isArray(message.activities)) message.activities = [];
  const index = message.activities.findIndex((item) => item.id === next.id);
  if (index >= 0) {
    message.activities[index] = next;
    if (next.id === 'response') message.activities.push(message.activities.splice(index, 1)[0]);
  }
  else message.activities.push(next);
  if (message.activities.length > 60) message.activities.splice(0, message.activities.length - 60);
}

function updateAssistantProgress(message, progress) {
  if (!message || !progress || typeof progress.id !== 'string' || typeof progress.text !== 'string') return;
  const existing = message.activities?.find((item) => item.id === progress.id);
  const text = progress.append === true
    ? `${existing?.text || ''}${progress.text}`
    : progress.text;
  updateAssistantActivity(message, {
    id: progress.id,
    kind: 'commentary',
    title: '진행 안내',
    text,
    status: ['pending', 'running', 'completed', 'failed', 'stopped'].includes(progress.status)
      ? progress.status
      : 'running',
  });
}

function updateResponseActivity(message, status, title, detail = '') {
  updateAssistantActivity(message, { id: 'response', status, title, detail });
}

function formatWorkedFor(milliseconds) {
  const seconds = Math.floor(Math.max(0, Number(milliseconds) || 0) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours) return `Worked for ${hours}h ${minutes}m`;
  if (minutes) return `Worked for ${minutes}m ${remainder}s`;
  return `Worked for ${remainder}s`;
}

function updateWorkedForLabel(message) {
  const label = [...elements.messages.querySelectorAll('[data-worked-for]')]
    .find((element) => element.dataset.workedFor === message.id);
  if (!label) return;
  label.textContent = formatWorkedFor(Date.now() - message.startedAt);
}

function startWorkedForTimer(message) {
  clearInterval(workedForInterval);
  workedForMessageId = message.id;
  workedForInterval = setInterval(() => {
    if (workedForMessageId === message.id && message.pending) updateWorkedForLabel(message);
  }, 1000);
}

function finishAssistantWork(message) {
  if (Number.isFinite(message.startedAt)) {
    message.workedForMs = Math.max(0, Date.now() - message.startedAt);
    delete message.startedAt;
  }
  if (workedForMessageId === message.id) {
    clearInterval(workedForInterval);
    workedForInterval = null;
    workedForMessageId = null;
  }
}

function activeCodexAccount() {
  return state.codexAccounts.find((account) => account.id === state.activeCodexAccountId) || null;
}

function modelsForProvider(providerId = state.provider) {
  if (providerId === 'openai') {
    const account = activeCodexAccount();
    return account?.models?.length ? account.models : PROVIDERS.openai.models;
  }
  if (providerId === 'api') return state.apiConnections.find((item) => item.id === state.activeConnectionId)?.models || [];
  return PROVIDERS[providerId]?.models || [];
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

function codexAccountDisplayName(account) {
  if (!account.connected || !account.accountEmail) return account.name;
  return account.accountEmail;
}

function codexAccountHint(account, displayName) {
  const isGeneratedName = account.isDefault || /^Codex 계정 \d+$/.test(account.name);
  const alias = displayName !== account.name && !isGeneratedName ? account.name : '';
  return [alias, account.planType || (!account.accountEmail ? account.label : '')]
    .filter(Boolean).join(' · ') || (account.accountEmail ? 'Codex 계정' : '');
}

function renderCodexAccounts() {
  const linkedAccounts = state.codexAccounts.filter((account) => account.linked === true);
  elements.codexAccountsList.innerHTML = linkedAccounts.map((account) => {
    const selected = account.id === state.activeCodexAccountId;
    const job = account.loginJob;
    const waiting = job?.state === 'starting' || job?.state === 'running';
    const busy = state.busyCodexAccountIds.has(account.id);
    const displayName = codexAccountDisplayName(account);
    const loginLabel = waiting ? '로그인 중' : account.installed ? '로그인' : 'CLI 설치 필요';
    const accountHint = codexAccountHint(account, displayName);
    const accountActions = account.connected
      ? `<button class="account-use-button" type="button" data-use-codex-account="${escapeHtml(account.id)}"${selected || busy ? ' disabled' : ''}>${selected ? '선택됨' : '사용'}</button>${account.isDefault ? '' : `<button class="account-unlink-button" type="button" data-disconnect-codex-account="${escapeHtml(account.id)}"${busy ? ' disabled' : ''}>${busy ? '처리 중…' : '로그아웃'}</button>`}`
      : waiting
        ? `<button class="account-cancel-button" type="button" data-cancel-codex-login="${escapeHtml(account.id)}"${busy ? ' disabled' : ''}>로그인 취소</button>`
        : `<button class="connect-button" type="button" data-connect-codex-account="${escapeHtml(account.id)}"${!account.installed || busy ? ' disabled' : ''}>${account.disconnected ? '다시 연결' : loginLabel}</button>${!account.isDefault && !account.disconnected ? `<button class="account-unlink-button" type="button" data-disconnect-codex-account="${escapeHtml(account.id)}"${busy ? ' disabled' : ''}>로그아웃</button>` : ''}`;
    const deleteAction = account.isDefault
      ? `<button class="account-delete-button" type="button" data-unlink-codex-connection="${escapeHtml(account.id)}"${busy ? ' disabled' : ''}>앱에서 삭제</button>`
      : `<button class="account-delete-button" type="button" data-delete-codex-account="${escapeHtml(account.id)}"${busy ? ' disabled' : ''}>삭제</button>`;
    return `<article class="codex-account-card${selected ? ' active' : ''}">
      <span class="connection-logo openai-logo" aria-hidden="true">${icon('terminal')}</span>
      <div class="connection-details"><div class="codex-account-title"><strong>${escapeHtml(displayName)}</strong>${selected ? '<span class="active-account-badge">사용 중</span>' : ''}</div>
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
  elements.addCodexAccountButton.innerHTML = state.addingCodexAccount ? `${icon('loader', 'spinning')}<span>계정 준비 중…</span>` : `${icon('plus')}<span>계정 추가</span>`;
}

function modelCatalog() {
  return [
    ...(state.codexAccounts.some((account) => account.linked) ? modelsForProvider('openai').map((model) => ({ ...model, provider: 'openai', source: 'Codex', connected: activeCodexAccount()?.connected === true })) : []),
    ...(state.providers.anthropic?.linked ? PROVIDERS.anthropic.models.map((model) => ({ ...model, provider: 'anthropic', source: 'Claude Code', connected: state.providers.anthropic.connected === true })) : []),
    ...state.apiConnections.flatMap((connection) => connection.models.map((model) => ({ ...model, provider: 'api', connectionId: connection.id, source: connection.name, connected: connection.connected }))),
  ];
}

function modelKey(model) {
  return JSON.stringify([model.provider, model.connectionId || '', model.id]);
}

function providerCatalog() {
  const codexAccounts = state.codexAccounts.filter((account) => account.linked);
  const codexCount = codexAccounts.filter((account) => account.connected).length;
  return [
    ...(codexAccounts.length ? [{ provider: 'openai', label: 'Codex', connected: activeCodexAccount()?.linked === true && activeCodexAccount()?.connected === true, detail: codexCount ? `${codexCount}개 계정 연결됨` : '계정 로그인' }] : []),
    ...(state.providers.anthropic?.linked ? [{ provider: 'anthropic', label: 'Claude Code', connected: state.providers.anthropic.connected === true, detail: state.providers.anthropic.connected ? '구독 계정 연결됨' : '계정 로그인' }] : []),
    ...state.apiConnections.map((connection) => ({ provider: 'api', connectionId: connection.id, label: connection.name, connected: connection.connected, detail: connection.connected ? `${connection.models.length}개 모델 · API` : 'API 키 연결 필요' })),
  ];
}

function providerKey(provider) {
  return JSON.stringify([provider.provider, provider.connectionId || '']);
}

function isSelectedProvider(item) {
  return item.provider === state.provider && (item.provider !== 'api' || item.connectionId === state.activeConnectionId);
}

function selectedModelKey() {
  return modelKey({ provider: state.provider, connectionId: state.provider === 'api' ? state.activeConnectionId : null, id: state.model });
}

function reasoningPreferenceKey() {
  return JSON.stringify([
    state.provider,
    state.provider === 'openai' ? state.activeCodexAccountId : '',
    state.provider === 'api' ? state.activeConnectionId || '' : '',
    state.model,
  ]);
}

function selectedReasoningEffort() {
  return state.reasoningEfforts[reasoningPreferenceKey()] || null;
}

function reasoningEffortLabel(effort) {
  if (effort === 'xhigh') return 'XHigh';
  return effort ? effort[0].toUpperCase() + effort.slice(1) : '자동';
}

function reasoningSettings() {
  const model = state.provider === 'openai'
    ? modelsForProvider('openai').find((item) => item.id === state.model)
    : state.provider === 'anthropic'
      ? modelEffortCapability('anthropic', state.model)
      : null;
  const efforts = state.provider === 'openai'
    ? [...new Set((model?.supportedReasoningEfforts || [])
      .map((item) => item.reasoningEffort)
      .filter((effort) => typeof effort === 'string' && effort.trim()))]
    : [...(model?.reasoningEfforts || [])];
  const savedEffort = selectedReasoningEffort();
  const selectedEffort = efforts.includes(savedEffort) ? savedEffort : null;
  const fastTierAvailable = (model?.serviceTiers || []).some((tier) => /fast|priority/i.test(`${tier.id} ${tier.name}`));
  // A selected effort takes precedence over the legacy Fast shortcut to Low.
  const fastAvailable = fastTierAvailable
    || ((!selectedEffort || selectedEffort === 'low') && efforts.includes('low'));
  const fastEnabled = state.provider === 'openai' && state.fastMode && fastAvailable;
  const defaultEffort = efforts.includes(model?.defaultReasoningEffort) ? model.defaultReasoningEffort : efforts[0];
  const effectiveEffort = selectedEffort
    || (fastEnabled && efforts.includes('low') ? 'low' : defaultEffort);
  return { efforts, selectedEffort, fastTierAvailable, fastAvailable, fastEnabled, defaultEffort, effectiveEffort };
}

function renderReasoningSelect(settings, connected) {
  const visible = ['openai', 'anthropic'].includes(state.provider) && settings.efforts.length > 0;
  elements.composerReasoningControl.hidden = !visible;
  const automaticEffort = settings.fastEnabled && settings.efforts.includes('low') ? 'low' : settings.defaultEffort;
  const automaticLabel = automaticEffort ? `자동 · ${reasoningEffortLabel(automaticEffort)}` : '자동';
  const options = `<option value="">${escapeHtml(automaticLabel)}</option>`
    + settings.efforts.map((effort) => `<option value="${escapeHtml(effort)}">${escapeHtml(reasoningEffortLabel(effort))}</option>`).join('');
  elements.composerReasoningEffortSelect.innerHTML = options;
  elements.composerReasoningEffortSelect.value = settings.selectedEffort || '';
  elements.composerReasoningEffortSelect.disabled = !connected || !visible || state.busy;
  elements.composerReasoningEffortSelect.title = !settings.efforts.length
    ? '이 모델은 추론 강도 선택을 제공하지 않습니다.'
    : !settings.selectedEffort && settings.fastEnabled && settings.effectiveEffort === 'low'
        ? '자동 선택에서는 Fast 모드에 맞춰 Low가 적용됩니다.'
        : '선택한 강도는 다음 메시지부터 적용됩니다.';
}

function renderModelOptions() {
  const selectingProvider = modelMenuMode === 'providers';
  const provider = providerCatalog().find(isSelectedProvider);
  const title = selectingProvider ? '연결 선택' : `${provider?.label || '세부'} 모델 선택`;
  document.querySelector('#modelMenuTitle').textContent = title;
  elements.modelMenu.setAttribute('aria-label', title);
  elements.modelSearch.placeholder = selectingProvider ? '연결 검색…' : '모델 검색…';
  elements.modelSearch.setAttribute('aria-label', selectingProvider ? '연결 검색' : '모델 검색');
  elements.modelOptions.setAttribute('aria-label', selectingProvider ? '사용할 연결' : '사용 가능한 세부 모델');
  document.querySelector('#manageProviderConnections').hidden = !selectingProvider;
  document.querySelector('#manageModelVisibility').hidden = selectingProvider;
  const query = elements.modelSearch.value.trim().toLocaleLowerCase();
  if (selectingProvider) {
    const providers = providerCatalog().filter((item) => item.label.toLocaleLowerCase().includes(query));
    elements.modelOptions.innerHTML = providers.map((item) => {
      const selected = isSelectedProvider(item);
      return `<button class="model-option${selected ? ' selected' : ''}" type="button" role="option" aria-selected="${selected}" data-provider-key="${escapeHtml(providerKey(item))}"${state.busy ? ' disabled' : ''}><span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.detail)}</small></span><span class="model-check" aria-hidden="true">${selected ? icon('check') : icon('chevron-right')}</span></button>`;
    }).join('') || '<p class="model-empty">일치하는 연결이 없습니다. 아래에서 계정이나 API 에이전트를 연결하세요.</p>';
    if (!elements.modelMenu.hidden) positionModelMenu();
    return;
  }
  const scopedModels = modelCatalog().filter(isSelectedProvider);
  const visibleModels = scopedModels.filter(modelVisibilityUI.isVisible);
  const models = visibleModels.filter((model) => `${model.label} ${model.id} ${model.source}`.toLocaleLowerCase().includes(query));
  elements.modelOptions.innerHTML = models.slice(0, 200).map((model) => {
    const selected = modelKey(model) === selectedModelKey();
    return `<button class="model-option${selected ? ' selected' : ''}" type="button" role="option" aria-selected="${selected}" data-model-key="${escapeHtml(modelKey(model))}"${!model.connected || state.busy ? ' disabled' : ''}><span><strong>${escapeHtml(model.label)}</strong><small>${escapeHtml(model.source)}${!model.connected ? ' · 연결 필요' : ''}</small></span><span class="model-check" aria-hidden="true">${selected ? icon('check') : ''}</span></button>`;
  }).join('') || (visibleModels.length
    ? '<p class="model-empty">일치하는 모델이 없습니다.<br>검색어를 바꾸거나 아래 표시 설정을 확인하세요.</p>'
    : scopedModels.length
      ? '<p class="model-empty">표시할 모델이 없습니다.<br>아래 표시 설정에서 사용할 모델을 켜 주세요.</p>'
      : '<p class="model-empty">모델 목록이 없습니다. 연결 설정에서 연결 상태와 모델 목록을 새로고침해 주세요.</p>');
  if (models.length > 200) elements.modelOptions.insertAdjacentHTML('beforeend', '<p class="model-empty">더 많은 모델은 이름으로 검색하세요.</p>');
  if (!elements.modelMenu.hidden) positionModelMenu();
}

function positionModelMenu() {
  const anchor = (modelMenuMode === 'providers' ? elements.providerSelectButton : elements.modelSelectButton).getBoundingClientRect();
  const below = innerHeight - anchor.bottom - 16;
  const above = anchor.top - 16;
  const openBelow = below >= 320 || below > above;
  elements.modelMenu.style.maxHeight = `${Math.min(420, Math.max(160, openBelow ? below : above))}px`;
  elements.modelMenu.style.left = `${Math.max(16, Math.min(anchor.left, innerWidth - elements.modelMenu.offsetWidth - 16))}px`;
  elements.modelMenu.style.top = `${openBelow ? anchor.bottom + 8 : Math.max(16, anchor.top - elements.modelMenu.offsetHeight - 8)}px`;
}

function closeModelMenu(restoreFocus = false) {
  elements.modelMenu.hidden = true;
  elements.providerSelectButton.setAttribute('aria-expanded', 'false');
  elements.modelSelectButton.setAttribute('aria-expanded', 'false');
  if (restoreFocus) (modelMenuMode === 'providers' ? elements.providerSelectButton : elements.modelSelectButton).focus();
}

function openModelMenu(mode) {
  if (state.busy) return;
  accountMenuUI.close();
  modelMenuMode = mode === 'models' && state.provider ? 'models' : 'providers';
  elements.modelSearch.value = '';
  renderModelOptions();
  elements.modelMenu.hidden = false;
  positionModelMenu();
  elements.providerSelectButton.setAttribute('aria-expanded', String(modelMenuMode === 'providers'));
  elements.modelSelectButton.setAttribute('aria-expanded', String(modelMenuMode === 'models'));
  elements.modelSearch.focus();
}

function renderAgentList() {
  const codexCount = state.codexAccounts.filter((account) => account.linked && account.connected).length;
  const agents = [
    ...(state.codexAccounts.some((account) => account.linked) ? [{ name: 'Codex', mark: icon('terminal'), connected: codexCount > 0, detail: codexCount ? `${codexCount}개 계정` : '로그인 필요', tab: 'accounts' }] : []),
    ...(state.providers.anthropic?.linked ? [{ name: 'Claude Code', mark: icon('asterisk'), connected: state.providers.anthropic.connected, detail: state.providers.anthropic.connected ? '연결됨' : '로그인 필요', tab: 'accounts' }] : []),
    ...state.apiConnections.map((connection) => ({ name: connection.name, mark: icon('plug'), connected: connection.connected, detail: connection.connected ? `${connection.models.length}개 모델` : '키 필요', tab: 'agents' })),
  ];
  document.querySelector('#agentList').innerHTML = agents.length
    ? agents.map((agent) => `<button class="agent-sidebar-row" type="button" data-agent-tab="${agent.tab}" title="${escapeHtml(agent.name)} · ${escapeHtml(agent.detail)}"><span class="agent-mark" aria-hidden="true">${agent.mark}</span><span class="agent-name">${escapeHtml(agent.name)}</span><span class="agent-detail">${escapeHtml(agent.detail)}</span><span class="agent-status${agent.connected ? ' connected' : ''}" aria-label="${agent.connected ? '연결됨' : '연결 필요'}"></span></button>`).join('')
    : `<div class="agent-list-empty"><span>연결된 AI가 없습니다.</span><button type="button" data-open-ai-connections>AI 추가</button></div>`;
}

function renderSendButtonState(selectedConnected) {
  const hasDraft = elements.messageInput.value.trim().length > 0;
  const queueing = state.busy && hasDraft;
  const stopping = state.busy && !hasDraft;
  elements.sendButton.disabled = state.busy ? false : !selectedConnected;
  elements.sendButton.classList.toggle('busy', stopping);
  elements.sendButton.classList.toggle('queueing', queueing);
  elements.sendButton.setAttribute('aria-label', queueing ? '대기열에 추가' : stopping ? '응답 중지' : '메시지 보내기');
  elements.sendButton.title = queueing ? '대기열에 추가' : stopping ? '응답 중지' : selectedConnected ? '메시지 보내기' : '먼저 연결과 모델을 선택하세요.';
  elements.stopResponseButton.hidden = !queueing;
}

function renderModelSelect() {
  const selected = modelCatalog().find((model) => modelKey(model) === selectedModelKey());
  const provider = providerCatalog().find(isSelectedProvider);
  const reasoning = reasoningSettings();
  document.querySelector('#selectedProviderLabel').textContent = provider?.label || (state.provider === 'api' ? 'API 연결' : '모델 추가');
  elements.providerSelectButton.disabled = state.busy;
  elements.providerSelectButton.title = provider ? `${provider.label} · 연결 선택` : '사용할 연결과 모델을 추가하세요.';
  elements.providerSelectButton.setAttribute('aria-label', provider ? `연결 선택 · ${provider.label}` : '모델 추가');
  document.querySelector('#selectedModelLabel').textContent = selected?.label || state.model || '모델 선택';
  elements.modelSelectButton.hidden = !state.provider;
  elements.modelSelectButton.disabled = state.busy;
  elements.modelSelectButton.title = selected ? `${selected.label} · ${selected.source}` : '사용 가능한 모델을 선택하세요.';
  elements.modelSelectButton.setAttribute('aria-label', `세부 모델 선택${selected ? ` · ${selected.label}` : ''}`);
  const codexAccount = state.provider === 'openai' ? activeCodexAccount() : null;
  document.querySelector('#providerPillText').textContent = codexAccount ? codexAccountDisplayName(codexAccount) : provider?.label || '연결 관리';
  document.querySelector('#providerDot').classList.toggle('connected', provider?.connected === true);
  renderReasoningSelect(reasoning, selected?.connected === true);
  if (!elements.modelMenu.hidden) renderModelOptions();
  renderSendButtonState(selected?.connected === true);
  elements.fastModeToggle.hidden = state.provider !== 'openai' || !state.model;
  elements.fastModeToggle.disabled = !selected?.connected || !reasoning.fastAvailable || state.busy;
  elements.fastModeToggle.classList.toggle('active', reasoning.fastEnabled);
  elements.fastModeToggle.setAttribute('aria-pressed', String(reasoning.fastEnabled));
  elements.fastModeToggle.title = reasoning.fastAvailable
    ? reasoning.fastTierAvailable
      ? 'Fast 서비스 티어를 요청합니다. 직접 선택한 추론 강도를 유지하며, 자동 선택에서는 Low를 우선 적용합니다.'
      : 'Low 추론 강도로 빠르게 응답합니다. 별도 Fast 서비스 티어는 제공되지 않습니다.'
    : '이 모델에서 Fast를 사용하려면 지원하는 Low 또는 자동 추론 강도를 선택해 주세요.';
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
  renderAgentList();
  renderModelSelect();
  modelVisibilityUI.render();
  accountMenuUI.update({
    provider: state.provider || 'openai',
    accountId: state.activeCodexAccountId,
    accounts: state.codexAccounts.filter((account) => account.linked),
    claude: state.providers.anthropic || {},
    webServices: state.webServices,
    connectionId: state.activeConnectionId,
    connections: state.apiConnections,
    updatedAt: state.statusUpdatedAt,
    error: state.statusError,
  });
  usageActivityUI.update();
  document.querySelector('#connectionSummary').textContent = connectionSummary();
  const conversation = activeConversation();
  const activeProject = project(conversation?.projectId || state.activeProjectId);
  document.querySelector('#modeLabel').textContent = conversation?.messages.length
    ? conversation.title
    : activeProject ? `${activeProject.name} · 새 작업` : '새 작업';
  if (!elements.searchModal.hidden) renderSearchResults();
}

function connectionSummary() {
  const codexCount = state.codexAccounts.filter((account) => account.linked).length;
  const claudeConnected = state.providers.anthropic?.linked === true;
  const parts = [];
  if (codexCount) parts.push(`Codex ${codexCount}개`);
  if (claudeConnected) parts.push('Claude Code');
  if (state.webServices.chatgpt) parts.push('ChatGPT');
  if (state.webServices.gemini) parts.push('Gemini');
  const apiCount = state.apiConnections.length;
  if (apiCount) parts.push(`API ${apiCount}개`);
  return parts.length ? `${parts.join(' · ')} 추가됨` : '연결된 AI 없음';
}

let statusRequestInProgress = false;
let statusPollTimer = null;

function updateApiConnections(status) {
  state.apiConnections = Array.isArray(status.connections) ? status.connections : [];
  state.keyStorage = status.keyStorage || 'session';
  apiConnectionsUI.update({ connections: state.apiConnections, keyStorage: state.keyStorage });
}

async function refreshApiConnections() {
  const response = await fetch('/api/connections', { cache: 'no-store' });
  const status = await response.json();
  if (!response.ok) throw new Error(status.error || 'API 연결 목록을 불러오지 못했습니다.');
  updateApiConnections(status);
  render();
}

function renderClaudeConnection() {
  const list = document.querySelector('#claudeConnectionList');
  const anthropic = state.providers.anthropic || {};
  const claudeJob = state.loginJobs.anthropic;
  if (!anthropic.linked) {
    list.innerHTML = '';
    return;
  }

  const loginRunning = claudeJob?.state === 'running' || claudeJob?.state === 'starting';
  const statusLabel = anthropic.connected ? '연결됨' : anthropic.installed === false ? 'CLI 설치 필요' : loginRunning ? '인증 중' : '로그인 필요';
  const usage = anthropic.usageSummary?.message || (anthropic.connected
    ? 'Claude Code에서 /usage를 실행해 플랜 사용량을 확인하세요.'
    : 'Claude Code CLI에 로그인한 뒤 /usage에서 플랜 사용량을 확인하세요.');
  const install = anthropic.installed === false && anthropic.installCommand
    ? `<code class="install-command">${escapeHtml(anthropic.installCommand)}</code>` : '';
  const loginAction = anthropic.connected ? ''
    : `<button class="connect-button" type="button" data-claude-action="login"${anthropic.installed !== true || loginRunning || state.busyClaudeConnectionChange ? ' disabled' : ''}>${loginRunning ? '진행 중' : anthropic.installed === false ? '설치 필요' : '로그인'}</button>`;
  const deleteAction = `<button class="account-delete-button" type="button" data-claude-action="delete"${loginRunning || state.busyClaudeConnectionChange ? ' disabled' : ''}>${state.busyClaudeConnectionChange ? '삭제 중…' : '삭제'}</button>`;
  list.innerHTML = `<article class="connection-row">
    <span class="connection-logo claude-logo" aria-hidden="true">${icon('asterisk')}</span>
    <div class="connection-details"><strong>Claude · Claude Code</strong><small>${escapeHtml(usage)}</small>${install}</div>
    <div class="connection-actions"><span class="connection-status${anthropic.connected ? ' ready' : ''}">${escapeHtml(statusLabel)}</span><div class="account-button-group">${loginAction}${deleteAction}</div></div>
  </article>`;
}

function updateConnectionControls() {
  const feedback = document.querySelector('#loginFeedback');
  const messages = [];
  const anthropic = state.providers.anthropic || {};
  const claudeJob = state.loginJobs.anthropic;
  const linkedCodexAccounts = state.codexAccounts.filter((account) => account.linked === true);
  document.querySelector('#codexAccountSection').hidden = linkedCodexAccounts.length === 0;
  document.querySelector('#claudeConnectionSection').hidden = anthropic.linked !== true;
  document.querySelector('.chatgpt-connection').hidden = state.webServices.chatgpt !== true;
  document.querySelector('.gemini-connection').hidden = state.webServices.gemini !== true;
  document.querySelector('#aiConnectionEmptyState').hidden = linkedCodexAccounts.length > 0
    || anthropic.linked === true
    || state.webServices.chatgpt === true
    || state.webServices.gemini === true
    || state.apiConnections.length > 0;
  chatGptUI.setEnabled(state.webServices);
  renderClaudeConnection();
  if (anthropic.linked && !anthropic.connected && claudeJob?.output) messages.push(`Claude 로그인 안내:\n${claudeJob.output.trim()}`);
  else if (anthropic.linked && !anthropic.connected && (claudeJob?.state === 'running' || claudeJob?.state === 'starting')) messages.push('Claude 공식 로그인 창에서 인증을 완료해 주세요.');
  else if (anthropic.linked && !anthropic.connected && claudeJob?.state === 'failed') messages.push('Claude 로그인 절차가 종료되었습니다. CLI 상태를 새로고침해 주세요.');

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
    if (!response.ok) throw new Error(status.error || '연결 상태 조회에 실패했습니다.');
    state.providers = status.providers || state.providers;
    state.webServices = status.providers?.webServices || { chatgpt: false, gemini: false };
    state.loginJobs = status.loginJobs || {};
    state.codexAccounts = Array.isArray(status.codexAccounts) ? status.codexAccounts : [];
    updateApiConnections(status);
    const conversation = activeConversation();
    const selectedCodexAccountId = conversation?.provider === 'openai'
      ? conversation.codexAccountId || state.activeCodexAccountId
      : state.activeCodexAccountId;
    const selectedCodexAccount = state.codexAccounts.find((account) => account.id === selectedCodexAccountId);
    if (!state.busy && state.provider === 'anthropic' && !state.providers.anthropic?.linked) {
      state.provider = '';
      state.model = '';
      savePreferences();
    }
    if (!state.busy && state.provider === 'openai' && !selectedCodexAccount?.linked) {
      state.provider = '';
      state.model = '';
      savePreferences();
    }
    const linkedCodexAccounts = state.codexAccounts.filter((account) => account.linked);
    if (!linkedCodexAccounts.some((account) => account.id === state.activeCodexAccountId && account.connected)) {
      state.activeCodexAccountId = linkedCodexAccounts.find((account) => account.connected)?.id
        || linkedCodexAccounts[0]?.id || 'default';
    }
    const defaultModels = state.codexAccounts.find((account) => account.id === 'default' && account.linked)?.models;
    if (Array.isArray(defaultModels) && defaultModels.length) {
      PROVIDERS.openai.models = defaultModels.map((model) => ({ ...model }));
    }
    const codexModels = modelsForProvider('openai');
    if (!state.busy && state.provider === 'openai' && state.model && codexModels.length && !codexModels.some((model) => model.id === state.model)) {
      state.model = '';
      savePreferences();
    }
    savePreferences();
    state.statusUpdatedAt = Date.now();
    state.statusError = false;
  } catch {
    state.statusError = true;
    state.providers = {
      openai: { installed: false, connected: false, linked: false, label: '서버 연결 실패' },
      anthropic: { installed: false, connected: false, label: '서버 연결 실패' },
    };
    state.webServices = { chatgpt: false, gemini: false };
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
    feedback.textContent = '로그인 요청을 처리하지 못했습니다. Loopline 서버가 실행 중인지 확인해 주세요.';
  }
  await refreshStatus();
}

async function connectCodexAccount(accountId = null, accountName = '') {
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
      body: accountId ? undefined : JSON.stringify({ name: accountName }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      loginWindow?.close();
      feedback.textContent = [data.error, data.installCommand].filter(Boolean).join('\n');
      showToast(data.error || 'Codex 계정을 연결하지 못했습니다.');
      await refreshStatus();
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

function addCodexAccount() {
  document.querySelector('#codexAccountForm').hidden = false;
  document.querySelector('#codexAccountName').focus();
}

async function updateCodexAccountLink(accountId, action) {
  const account = state.codexAccounts.find((item) => item.id === accountId);
  if (!account) return;
  if (action === 'unlink') {
    if (!window.confirm(`${account.name}을 Loopline 연결 목록에서 삭제할까요?\n\n이 앱에서만 숨기며 Codex CLI 로그인과 ~/.codex 인증 정보는 유지됩니다.`)) return;
  } else if (action === 'disconnect') {
    const impact = account.isDefault
      ? '기본 계정은 ~/.codex를 Codex CLI와 공유합니다. 로그아웃하면 이 앱과 Codex CLI 양쪽에서 다시 로그인해야 합니다.'
      : 'Codex app-server에서 로그아웃합니다. 이 계정 항목과 Codex 대화 기록은 남기며, 다시 로그인해 사용할 수 있습니다.';
    if (!window.confirm(`${account.name}을 연결 해제할까요?\n\n${impact}`)) return;
  } else if (action === 'delete') {
    if (account.isDefault) return;
    const impact = '계정 인증 정보와 이 Loopline 계정 전용 Codex 프로필·세션 기록을 삭제합니다. Loopline 대화 본문은 남지만 Codex 세션 연결을 끊고, 다음 응답은 남은 계정에서 대화 내용으로 이어집니다.';
    if (!window.confirm(`${account.name}을 계정 목록에서 삭제할까요?\n\n${impact}`)) return;
  }
  if (state.busyCodexAccountIds.has(accountId)) return;
  state.busyCodexAccountIds.add(accountId);
  renderCodexAccounts();
  const label = action === 'cancel' ? '로그인 취소' : action === 'delete' ? '계정 삭제' : action === 'unlink' ? '앱 연결 삭제' : '로그아웃';
  try {
    const response = action === 'delete'
      ? await fetch(`/api/codex/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' })
      : action === 'unlink'
        ? await fetch('/api/provider-connections/openai', { method: 'DELETE' })
        : await fetch(`/api/codex/accounts/${encodeURIComponent(accountId)}/${action}`, { method: 'POST' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `${label}에 실패했습니다.`);
    if (action === 'unlink') {
      if (state.provider === 'openai') {
        state.provider = '';
        state.model = '';
        savePreferences();
      }
      showToast('Loopline에서 Codex 연결을 삭제했습니다. CLI 로그인은 유지됩니다.');
    } else if (action === 'delete') {
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
      showToast('Codex 계정을 삭제했습니다. Loopline 대화 본문은 남아 있습니다.');
    } else if (action === 'disconnect' && accountId === state.activeCodexAccountId) {
      state.activeCodexAccountId = state.codexAccounts.find((item) => item.id !== accountId && item.connected)?.id || 'default';
      savePreferences();
    }
    if (action === 'cancel') delete state.loginUrls[`openai:${accountId}`];
    if (!['delete', 'unlink'].includes(action)) showToast(action === 'cancel' ? 'Codex OAuth 로그인 요청을 취소했습니다.' : 'Codex에서 로그아웃했습니다. 계정 항목과 대화 기록은 보존됩니다.');
  } catch (error) {
    showToast(error.message || `${label}에 실패했습니다.`);
  } finally {
    state.busyCodexAccountIds.delete(accountId);
    await refreshStatus();
  }
}

async function removeClaudeConnection() {
  if (state.busyClaudeConnectionChange) return;
  if (!window.confirm('Claude Code 연결을 삭제할까요?\n\nLoopline의 연결 항목만 삭제합니다. 이 Mac의 Claude Code CLI와 터미널 로그인은 유지됩니다.')) return;
  state.busyClaudeConnectionChange = true;
  updateConnectionControls();
  try {
    const response = await fetch('/api/provider-connections/anthropic', { method: 'DELETE' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Claude 앱 연결을 삭제하지 못했습니다.');
    if (state.provider === 'anthropic') {
      state.provider = '';
      state.model = '';
      savePreferences();
    }
    showToast('Loopline에서 Claude Code 연결을 삭제했습니다. CLI 로그인은 유지됩니다.');
  } catch (error) {
    showToast(error.message || 'Claude 앱 연결을 삭제하지 못했습니다.');
  } finally {
    state.busyClaudeConnectionChange = false;
    await refreshStatus();
  }
}

function openProviderConnectionModal() {
  const modal = document.querySelector('#providerConnectionModal');
  const codex = state.providers.openai || {};
  const claude = state.providers.anthropic || {};
  document.querySelector('#codexConnectionChoice .connection-details small').textContent = codex.linked
    ? '추가 Codex 계정을 연결합니다.'
    : '이 Mac의 Codex CLI 계정 또는 새 로그인을 사용합니다.';
  document.querySelector('#connectCodexFromModal').textContent = codex.linked ? '계정 추가' : '연결';
  document.querySelector('#claudeConnectionChoice').hidden = claude.linked === true;
  document.querySelector('#chatgptConnectionChoice').hidden = state.webServices.chatgpt === true;
  document.querySelector('#geminiConnectionChoice').hidden = state.webServices.gemini === true;
  modal.hidden = false;
  document.querySelector('#closeProviderConnection').focus();
}

function closeProviderConnectionModal(restoreFocus = false) {
  const modal = document.querySelector('#providerConnectionModal');
  if (modal.hidden) return;
  modal.hidden = true;
  if (restoreFocus) document.querySelector('#addAiConnection').focus();
}

async function addWebService(provider) {
  closeProviderConnectionModal();
  try {
    const response = await fetch(`/api/provider-connections/${provider}`, { method: 'POST' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `${provider}를 추가하지 못했습니다.`);
    await refreshStatus();
    showToast(`${provider === 'chatgpt' ? 'ChatGPT' : 'Gemini'}를 작업 공간에 추가했습니다.`);
  } catch (error) {
    showToast(error.message || 'AI 연결을 추가하지 못했습니다.');
  }
}

async function removeWebService(provider) {
  const name = provider === 'chatgpt' ? 'ChatGPT' : 'Gemini';
  if (!window.confirm(`${name}을 Loopline에서 삭제할까요? 웹사이트 로그인은 유지됩니다.`)) return;
  try {
    const response = await fetch(`/api/provider-connections/${provider}`, { method: 'DELETE' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `${name} 연결을 삭제하지 못했습니다.`);
    await refreshStatus();
    showToast(`${name}을 Loopline 연결 목록에서 삭제했습니다. 웹사이트 로그인은 유지됩니다.`);
  } catch (error) {
    showToast(error.message || `${name} 연결을 삭제하지 못했습니다.`);
  }
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

function activeAgentInstructions() {
  const settings = state.agentInstructions;
  const sections = [];
  if (state.provider === 'openai') {
    if (settings.codexUsesShared && settings.shared.trim()) sections.push(`공통 작업 지침:\n${settings.shared.trim()}`);
    if (settings.codex.trim()) sections.push(`Codex 전용 지침 (AGENTS.md):\n${settings.codex.trim()}`);
  } else if (state.provider === 'anthropic') {
    if (settings.claudeUsesShared && settings.shared.trim()) sections.push(`공통 작업 지침:\n${settings.shared.trim()}`);
    if (settings.claude.trim()) sections.push(`Claude Code 전용 지침 (CLAUDE.md):\n${settings.claude.trim()}`);
  } else if (state.provider === 'api' && settings.shared.trim()) {
    sections.push(`공통 작업 지침:\n${settings.shared.trim()}`);
  }
  return sections.join('\n\n').slice(0, 24_000);
}

function renderAgentInstructionSettings() {
  elements.sharedAgentInstructions.value = state.agentInstructions.shared;
  elements.codexAgentInstructions.value = state.agentInstructions.codex;
  elements.claudeAgentInstructions.value = state.agentInstructions.claude;
  elements.codexUsesSharedInstructions.checked = state.agentInstructions.codexUsesShared;
  elements.claudeUsesSharedInstructions.checked = state.agentInstructions.claudeUsesShared;
}

function saveAgentInstructionSettings() {
  state.agentInstructions = {
    shared: elements.sharedAgentInstructions.value.slice(0, 12_000),
    codex: elements.codexAgentInstructions.value.slice(0, 8_000),
    claude: elements.claudeAgentInstructions.value.slice(0, 8_000),
    codexUsesShared: elements.codexUsesSharedInstructions.checked,
    claudeUsesShared: elements.claudeUsesSharedInstructions.checked,
  };
  try {
    savePreferences();
    elements.agentInstructionsSaveStatus.textContent = '저장됨 · 모든 변경 사항이 자동으로 저장됩니다.';
  } catch {
    elements.agentInstructionsSaveStatus.textContent = '저장하지 못했습니다. 기기의 저장 공간을 확인해 주세요.';
  }
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
  chatGptUI.showWorkspace();
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
  return provider === 'anthropic' ? 'Claude' : provider === 'ollama' ? 'Ollama' : 'ChatGPT';
}

async function selectProjectImportFile(file) {
  if (!file) return;
  const importButton = document.querySelector('#importProjectButton');
  importButton.disabled = true;
  importButton.innerHTML = icon('loader', 'spinning');
  try {
    const parsed = await parseProviderExport(file);
    state.pendingProjectImport = { ...parsed, fileName: file.name, selected: new Set() };
    document.querySelector('#exportConversationSearch').value = '';
    renderExportConversationPicker();
    elements.projectImportProvider.value = parsed.suggestedProvider;
    elements.projectImportName.value = `${importSourceName(parsed.suggestedProvider)} 가져오기`.slice(0, 60);
    const importedProjectCount = parsed.projects.length;
    const conversationCount = parsed.conversations.length;
    elements.projectImportSummary.textContent = `${file.name} · 프로젝트 ${importedProjectCount.toLocaleString()}개 · 대화 ${conversationCount.toLocaleString()}개 · JSON ${parsed.sourceFileCount.toLocaleString()}개`;
    elements.projectImportError.hidden = true;
    elements.projectImportError.textContent = '';
    projectImportReturnsToSettings = !elements.settingsModal.hidden;
    if (projectImportReturnsToSettings) hideSettings();
    elements.projectImportModal.hidden = false;
    elements.projectImportName.focus();
  } catch (error) {
    showToast(error.message || '내보내기 파일을 읽지 못했습니다.');
  } finally {
    importButton.disabled = false;
    importButton.innerHTML = icon('import');
    elements.projectImportFile.value = '';
  }
}

function closeProjectImport() {
  const returnToSettings = projectImportReturnsToSettings && !elements.projectImportModal.hidden;
  projectImportReturnsToSettings = false;
  elements.projectImportModal.hidden = true;
  elements.projectImportError.hidden = true;
  elements.projectImportError.textContent = '';
  state.pendingProjectImport = null;
  document.querySelector('#exportConversationList').replaceChildren();
  if (returnToSettings) {
    showSettings('history');
    document.querySelector('#settingsImportFile').focus();
  }
}

function visibleExportConversations() {
  const query = document.querySelector('#exportConversationSearch').value.trim().toLocaleLowerCase();
  return (state.pendingProjectImport?.conversations || []).map((item, index) => ({ item, index }))
    .filter(({ item }) => !query || item.title.toLocaleLowerCase().includes(query));
}

function renderExportConversationPicker() {
  const pending = state.pendingProjectImport;
  if (!pending) return;
  document.querySelector('#exportConversationPicker').hidden = !pending.conversations.length;
  const visible = visibleExportConversations();
  document.querySelector('#exportConversationList').innerHTML = visible.map(({ item, index }) =>
    `<label class="export-conversation-option"><input type="checkbox" data-export-index="${index}"${pending.selected.has(index) ? ' checked' : ''} /><span>${escapeHtml(item.title)}</span></label>`).join('') || '<p class="history-empty">검색 결과가 없습니다.</p>';
  document.querySelector('#exportSelectionCount').textContent = `${pending.selected.size} / ${pending.conversations.length}개 선택`;
  const selectAll = document.querySelector('#exportSelectAll');
  selectAll.checked = visible.length > 0 && visible.every(({ index }) => pending.selected.has(index));
  selectAll.indeterminate = visible.some(({ index }) => pending.selected.has(index)) && !selectAll.checked;
  document.querySelector('#commitProjectImport').disabled = pending.conversations.length > 0 && pending.selected.size === 0;
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
  const selectedConversations = pending.conversations.filter((item, index) => pending.selected.has(index));
  if (pending.conversations.length && !selectedConversations.length) return;
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
    if (pending.conversations.length && !selectedConversations.some((conversation) => conversation.sourceProjectId === item.sourceId)) continue;
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

  for (const item of selectedConversations) {
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

async function copyLastResponse() {
  const conversation = activeConversation();
  const message = [...(conversation?.messages || [])].reverse()
    .find((item) => item.role === 'assistant' && item.content && !item.pending);
  if (!message) return;
  try {
    await navigator.clipboard.writeText(message.content);
    showToast('마지막 답변을 복사했습니다.');
  } catch {
    showToast('클립보드에 복사하지 못했습니다. 앱 권한을 확인해 주세요.');
  }
  elements.conversationActions.open = false;
}

async function copyMessage(button) {
  const index = Number(button.dataset.copyMessageIndex);
  const message = Number.isInteger(index) ? activeConversation()?.messages[index] : null;
  if (!message || typeof message.content !== 'string' || message.pending) return;
  try {
    await navigator.clipboard.writeText(message.content);
    showToast(message.role === 'user' ? '질문을 복사했습니다.' : '답변을 복사했습니다.');
  } catch {
    showToast('클립보드에 복사하지 못했습니다. 앱 권한을 확인해 주세요.');
  }
}

async function copyCodeBlock(button) {
  const code = button.closest('.code-block')?.querySelector('pre code')?.textContent;
  if (typeof code !== 'string') return;
  try {
    await navigator.clipboard.writeText(code);
    button.textContent = '복사됨';
    showToast('코드 블록을 복사했습니다.');
    setTimeout(() => { if (button.isConnected) button.textContent = '복사'; }, 1400);
  } catch {
    showToast('코드를 복사하지 못했습니다. 클립보드 권한을 확인해 주세요.');
  }
}

function exportConversationMarkdown() {
  const conversation = activeConversation();
  if (!conversation?.messages.length || conversation.messages.some((message) => message.pending)) return;
  const title = (conversation.title || 'Loopline 대화').replace(/[\r\n]+/g, ' ').trim();
  const projectName = project(conversation.projectId)?.name;
  const metadata = [
    `- 연결: ${PROVIDERS[conversation.provider]?.label || conversation.provider || 'AI'}`,
    `- 모델: ${conversation.model || '알 수 없음'}`,
    ...(projectName ? [`- 프로젝트: ${projectName}`] : []),
    `- 업데이트: ${new Date(conversation.updatedAt || Date.now()).toLocaleString('ko-KR')}`,
  ];
  const transcript = conversation.messages
    .filter((message) => ['user', 'assistant'].includes(message.role) && message.content)
    .map((message) => `## ${message.role === 'user' ? '사용자' : 'AI'}\n\n${message.content}`)
    .join('\n\n---\n\n');
  const contents = `# ${title}\n\n${metadata.join('\n')}\n\n---\n\n${transcript}\n`;
  const filename = `${title.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').replace(/[. ]+$/g, '').slice(0, 80) || 'Loopline 대화'}.md`;
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  elements.conversationActions.open = false;
  showToast('대화를 Markdown 파일로 내보냈습니다.');
}

function setProvider(key) {
  if (state.busy) return;
  const provider = providerCatalog().find((item) => providerKey(item) === key);
  if (!provider) return;
  if (!provider.connected) { showSettings(provider.provider === 'api' ? 'agents' : 'accounts'); return; }
  if (!isSelectedProvider(provider)) {
    state.provider = provider.provider;
    state.activeConnectionId = provider.connectionId || null;
    state.model = '';
    state.fastMode = false;
    const conversation = activeConversation();
    if (conversation && !conversation.messages.length) {
      conversation.provider = state.provider;
      conversation.connectionId = state.activeConnectionId;
      conversation.model = '';
      conversation.codexAccountId = state.provider === 'openai' ? state.activeCodexAccountId : 'default';
      saveConversations();
    }
    savePreferences();
  }
  render();
  openModelMenu('models');
}

function setModel(key) {
  if (state.busy) return;
  const model = modelCatalog().find((item) => modelKey(item) === key && item.connected && isSelectedProvider(item));
  if (!model) return;
  state.provider = model.provider;
  state.activeConnectionId = model.connectionId || null;
  state.model = model.id;
  const conversation = activeConversation();
  if (conversation && conversation.messages.length === 0) {
    conversation.provider = model.provider;
    conversation.connectionId = state.activeConnectionId;
    conversation.model = model.id;
    conversation.codexAccountId = model.provider === 'openai' ? state.activeCodexAccountId : 'default';
  }
  if (state.provider === 'openai' && !reasoningSettings().fastAvailable) state.fastMode = false;
  savePreferences();
  saveConversations();
  render();
  closeModelMenu(true);
}

function toggleFastMode() {
  if (elements.fastModeToggle.disabled || state.provider !== 'openai') return;
  state.fastMode = !state.fastMode;
  savePreferences();
  renderModelSelect();
  if (state.fastMode) {
    const reasoning = reasoningSettings();
    showToast(reasoning.fastTierAvailable ? `Fast 서비스 티어를 요청합니다. 추론 강도: ${reasoningEffortLabel(reasoning.effectiveEffort)}` : 'Fast 응답을 켰습니다. Low 추론 강도가 적용됩니다.');
  }
}

function setReasoningEffort(value) {
  if (state.busy || !['openai', 'anthropic'].includes(state.provider)) return;
  const settings = reasoningSettings();
  if (value && !settings.efforts.includes(value)) return;
  const key = reasoningPreferenceKey();
  if (value) state.reasoningEfforts[key] = value;
  else delete state.reasoningEfforts[key];
  if (state.provider === 'openai' && !reasoningSettings().fastAvailable) state.fastMode = false;
  savePreferences();
  renderModelSelect();
}

function setCodexAccount(accountId) {
  const account = state.codexAccounts.find((item) => item.id === accountId && item.connected);
  if (!account) return;
  if (state.busy) {
    showToast('응답이 끝난 뒤 Codex 계정을 전환해 주세요.');
    return;
  }
  const previousId = state.activeCodexAccountId;
  state.activeCodexAccountId = account.id;
  if (state.provider === 'openai') {
    const models = account.models || [];
    if (!models.some((model) => model.id === state.model)) state.model = '';
    const conversation = activeConversation();
    if (conversation?.provider === 'openai' && conversation.codexAccountId !== account.id) {
      conversation.codexAccountId = account.id;
      conversation.codexThreadId = null;
      if (!models.some((model) => model.id === conversation.model)) conversation.model = state.model;
      if (conversation.messages.length) showToast('계정을 바꿨습니다. 이전 대화 내용을 새 계정에 이어 전달합니다.');
    }
  }
  if (state.provider === 'openai' && !reasoningSettings().fastAvailable) state.fastMode = false;
  savePreferences();
  saveConversations();
  render();
  if (previousId !== account.id && state.provider !== 'openai') showToast('새 Codex 대화에 사용할 계정을 바꿨습니다.');
}

function conversationTitleFromMessage(message) {
  return message.replace(/\s+/g, ' ').trim().slice(0, 42) || '새 대화';
}

function updateConversationTitle(conversation, firstMessage) {
  if (conversation.messages.some((message) => message.role === 'user')) return;
  conversation.title = conversationTitleFromMessage(firstMessage);
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
      if (parsed.event === 'activity') updateAssistantActivity(assistantMessage, parsed.data);
      if (parsed.event === 'progress') {
        const rollbackText = typeof parsed.data.rollbackText === 'string' ? parsed.data.rollbackText : '';
        if (rollbackText && assistantMessage.content.endsWith(rollbackText)) {
          assistantMessage.content = assistantMessage.content.slice(0, -rollbackText.length);
        }
        updateAssistantProgress(assistantMessage, parsed.data);
      }
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
      if (parsed.event === 'delta') {
        if (assistantMessage.activities?.find((item) => item.id === 'response')?.title === '응답 생성 중') {
          updateResponseActivity(assistantMessage, 'running', '응답 작성 중', '응답 내용을 실시간으로 받고 있습니다.');
        }
        assistantMessage.content += parsed.data.text || '';
      }
      if (parsed.event === 'error') {
        assistantMessage.content = `오류: ${parsed.data.error || '응답 생성에 실패했습니다.'}`;
        assistantMessage.error = true;
        updateResponseActivity(assistantMessage, 'failed', '응답 실패', parsed.data.error || '응답 생성에 실패했습니다.');
      }
      if (parsed.event === 'done') {
        sawDone = true;
        updateResponseActivity(assistantMessage, 'completed', '응답 완료', '최종 결과를 표시했습니다.');
      }
      renderMessages();
    }
    if (done) break;
  }
  if (!sawDone && !assistantMessage.error && !assistantMessage.content) {
    assistantMessage.content = '응답이 중단되었습니다.';
    assistantMessage.error = true;
  }
  finishAssistantWork(assistantMessage);
  assistantMessage.pending = false;
  conversation.updatedAt = Date.now();
  saveConversations();
  render();
}

function enqueueMessage(value) {
  const message = value.trim();
  if (!message) return;
  const conversation = activeConversation();
  if (!conversation) {
    showToast('대기열에 추가할 대화를 먼저 열어 주세요.');
    return;
  }
  if (!state.provider || !state.model) {
    showToast('대기열에 넣을 연결과 모델을 먼저 선택해 주세요.');
    openModelMenu(state.provider ? 'models' : 'providers');
    return;
  }
  if (!state.busy && !modelCatalog().find((model) => modelKey(model) === selectedModelKey())?.connected) {
    showToast('대기열에 넣을 연결을 확인해 주세요.');
    showSettings(state.provider === 'api' ? 'agents' : 'accounts');
    return;
  }

  const reasoning = reasoningSettings();
  conversation.messages.push({
    role: 'user',
    content: message,
    id: crypto.randomUUID(),
    queued: true,
    queueOptions: {
      provider: state.provider,
      model: state.model,
      connectionId: state.provider === 'api' ? state.activeConnectionId : null,
      codexAccountId: state.provider === 'openai' ? state.activeCodexAccountId : null,
      reasoningEffort: reasoning.selectedEffort || '',
      fastMode: reasoning.fastEnabled,
    },
  });
  conversation.updatedAt = Date.now();
  elements.messageInput.value = '';
  resizeInput();
  saveConversations();
  render();
  const queueLength = conversation.messages.filter((item) => item.role === 'user' && item.queued).length;
  showToast(`대기열 ${queueLength}번째에 추가했습니다.`);
}

function removeQueuedMessage(messageId) {
  const conversation = activeConversation();
  const index = conversation?.messages.findIndex((message) => message.id === messageId && message.role === 'user' && message.queued) ?? -1;
  if (index < 0) return;
  conversation.messages.splice(index, 1);
  conversation.updatedAt = Date.now();
  saveConversations();
  render();
  showToast('대기열에서 메시지를 제거했습니다.');
}

function startNextQueuedMessage(conversation = activeConversation()) {
  if (state.busy || !conversation) return;
  const queuedMessage = conversation.messages.find((message) => message.role === 'user' && message.queued);
  const options = queuedMessage?.queueOptions;
  if (!queuedMessage) return;
  if (!options || !Object.hasOwn(PROVIDERS, options.provider) || !options.model) {
    showToast('대기 중인 메시지의 연결 정보를 확인할 수 없습니다. 대기 항목을 확인해 주세요.');
    return;
  }

  state.activeId = conversation.id;
  state.activeProjectId = project(conversation.projectId) ? conversation.projectId : null;
  state.provider = options.provider;
  state.model = options.model;
  state.activeConnectionId = options.provider === 'api' ? options.connectionId : null;
  if (options.provider === 'openai') state.activeCodexAccountId = options.codexAccountId || 'default';
  state.fastMode = options.provider === 'openai' && options.fastMode === true;
  const effortKey = reasoningPreferenceKey();
  if (['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(options.reasoningEffort)) {
    state.reasoningEfforts[effortKey] = options.reasoningEffort;
  } else {
    delete state.reasoningEfforts[effortKey];
  }
  const selected = modelCatalog().find((model) => modelKey(model) === selectedModelKey());
  savePreferences();
  render();
  if (!selected?.connected) {
    showToast('대기 중인 메시지를 보내려면 저장된 모델 연결을 확인해 주세요.');
    return;
  }
  void sendMessage(queuedMessage.content, queuedMessage.id);
}

function resumeSavedQueue() {
  const conversation = state.conversations
    .filter((item) => item.messages.some((message) => message.role === 'user' && message.queued))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (conversation) startNextQueuedMessage(conversation);
}

async function sendMessage(value, queuedMessageId = null) {
  const message = value.trim();
  if (!message || state.busy) return;
  if (!queuedMessageId && activeConversation()?.messages.some((item) => item.role === 'user' && item.queued)) {
    enqueueMessage(message);
    return;
  }
  if (!state.provider || !state.model) {
    showToast('사용할 연결과 세부 모델을 선택해 주세요.');
    openModelMenu(state.provider ? 'models' : 'providers');
    return;
  }
  const selected = modelCatalog().find((model) => modelKey(model) === selectedModelKey());
  if (!selected?.connected) {
    showToast('연결된 모델을 선택하거나 에이전트를 연결해 주세요.');
    showSettings(state.provider === 'api' ? 'agents' : 'accounts');
    return;
  }
  const reasoning = reasoningSettings();
  let conversation = activeConversation();
  if (!conversation) {
    if (queuedMessageId) return;
    createConversation();
    conversation = activeConversation();
  }
  const queuedMessage = queuedMessageId
    ? conversation.messages.find((item) => item.id === queuedMessageId && item.role === 'user' && item.queued)
    : null;
  if (queuedMessageId && !queuedMessage) return;
  if (conversation.provider !== state.provider && state.provider === 'openai') conversation.codexThreadId = null;
  conversation.provider = state.provider;
  conversation.model = state.model;
  conversation.connectionId = state.provider === 'api' ? state.activeConnectionId : null;
  if (state.provider === 'openai') {
    if (conversation.codexAccountId !== state.activeCodexAccountId) conversation.codexThreadId = null;
    conversation.codexAccountId = state.activeCodexAccountId;
  }
  updateConversationTitle(conversation, message);
  if (queuedMessage) {
    queuedMessage.queued = false;
    delete queuedMessage.queueOptions;
  } else {
    conversation.messages.push({ role: 'user', content: message, id: crypto.randomUUID() });
  }
  const assistantMessage = {
    role: 'assistant', content: '', id: crypto.randomUUID(), pending: true, startedAt: Date.now(),
    activities: [
      { id: 'request', title: '요청 전송', detail: '선택한 모델로 요청을 보냈습니다.', status: 'completed' },
      { id: 'response', title: '응답 생성 중', detail: '모델의 첫 응답을 기다리고 있습니다.', status: 'running' },
    ],
  };
  conversation.messages.push(assistantMessage);
  conversation.updatedAt = Date.now();
  saveConversations();
  render();

  elements.messageInput.value = '';
  resizeInput();
  state.busy = true;
  state.controller = new AbortController();
  closeModelMenu();
  renderModelSelect();
  startWorkedForTimer(assistantMessage);

  const allMessages = conversation.messages.filter((item) => !item.pending && !item.queued);
  const messages = allMessages.slice(-60).map(({ role, content }) => ({ role, content: content.slice(0, 40_000) }));
  while (messages.length > 1 && new Blob([JSON.stringify(messages)]).size > 850_000) messages.shift();
  if (messages.length < allMessages.length || allMessages.some((item) => item.content.length > 40_000)) {
    showToast(`전체 기록은 보관하며, 이번 응답에는 최근 ${messages.length}개 메시지를 길이 한도 안에서 전달합니다.`);
  }
  const agentInstructions = activeAgentInstructions();
  const projectInstructions = activeProjectInstructions();
  let shouldContinueQueue = false;
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: state.provider,
        model: state.model,
        ...(state.provider === 'api' ? { connectionId: conversation.connectionId } : {}),
        ...(['openai', 'anthropic'].includes(state.provider) ? { reasoningEffort: reasoning.selectedEffort } : {}),
        ...(state.provider === 'openai' ? { fastMode: reasoning.fastEnabled } : {}),
        ...(state.provider === 'openai' ? { codexAccountId: conversation.codexAccountId || 'default' } : {}),
        ...(agentInstructions ? { agentInstructions } : {}),
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
    shouldContinueQueue = !assistantMessage.error;
  } catch (error) {
    shouldContinueQueue = false;
    finishAssistantWork(assistantMessage);
    assistantMessage.pending = false;
    assistantMessage.error = error.name !== 'AbortError';
    updateResponseActivity(assistantMessage, error.name === 'AbortError' ? 'stopped' : 'failed', error.name === 'AbortError' ? '응답 중지' : '응답 실패', error.name === 'AbortError' ? '' : error.message || '서버에 연결할 수 없습니다.');
    assistantMessage.activityExpanded = true;
    assistantMessage.content = error.name === 'AbortError'
      ? (assistantMessage.content || '응답을 중지했습니다.')
      : `오류: ${error.message || '서버에 연결할 수 없습니다.'}`;
    conversation.updatedAt = Date.now();
    saveConversations();
    render();
  } finally {
    state.busy = false;
    state.controller = null;
    render();
    if (shouldContinueQueue && conversation.messages.some((item) => item.role === 'user' && item.queued)) {
      queueMicrotask(() => startNextQueuedMessage(conversation));
    }
  }
}

function resizeInput() {
  elements.messageInput.style.height = 'auto';
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 170)}px`;
}

function selectSettingsTab(tab) {
  const name = ['usage', 'accounts', 'agents', 'models', 'history', 'instructions', 'appearance'].includes(tab) ? tab : 'accounts';
  document.querySelectorAll('[data-settings-tab]').forEach((button) => {
    const selected = button.dataset.settingsTab === name;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll('[data-settings-panel]').forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== name; });
  document.querySelector('#refreshStatus').hidden = ['history', 'instructions', 'appearance'].includes(name);
  document.querySelector('#refreshStatus').textContent = name === 'usage' ? '사용량 새로고침' : '연결 상태 새로고침';
  if (name === 'models') modelVisibilityUI.render();
  if (name === 'usage') { accountMenuUI.renderUsage(); usageActivityUI.show(); }
  else usageActivityUI.hide();
}

let settingsReturnFocus = null;
function showSettings(tab = 'accounts') {
  if (elements.settingsModal.hidden) settingsReturnFocus = document.activeElement;
  accountMenuUI.close();
  closeModelMenu();
  selectSettingsTab(tab);
  elements.settingsModal.hidden = false;
  refreshStatus();
  if (!statusPollTimer) statusPollTimer = setInterval(refreshStatus, 2500);
  document.querySelector('#closeSettings').focus();
}

function showSearch() {
  accountMenuUI.close();
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
  chatGptUI.showWorkspace();
  if (state.busy) {
    showToast('응답이 끝난 뒤 대화를 전환해 주세요.');
    return false;
  }
  state.activeId = conversation.id;
  state.activeProjectId = project(conversation.projectId) ? conversation.projectId : null;
  state.provider = conversation.provider;
  state.activeConnectionId = conversation.connectionId || null;
  if (state.provider === 'openai') {
    state.activeCodexAccountId = state.codexAccounts.some((account) => account.id === conversation.codexAccountId)
      ? conversation.codexAccountId
      : 'default';
  }
  state.model = conversation.model || '';
  savePreferences();
  render();
  closeMobileSidebar();
  return true;
}

function hideSettings() {
  const wasOpen = !elements.settingsModal.hidden;
  elements.settingsModal.hidden = true;
  usageActivityUI.hide();
  clearInterval(statusPollTimer);
  statusPollTimer = null;
  if (wasOpen && settingsReturnFocus?.isConnected && settingsReturnFocus.getClientRects().length) settingsReturnFocus.focus();
}

function updateSidebarControls() {
  const mobile = innerWidth <= 760;
  const expanded = mobile ? elements.sidebar.classList.contains('mobile-open') : !elements.sidebar.classList.contains('collapsed');
  const label = mobile ? '사이드바 닫기' : expanded ? '사이드바 접기' : '사이드바 펼치기';
  elements.sidebarToggle.title = label;
  elements.sidebarToggle.setAttribute('aria-label', label);
  elements.sidebarToggle.setAttribute('aria-expanded', String(expanded));
  elements.mobileMenu.setAttribute('aria-expanded', String(expanded));
  elements.mobileMenu.title = expanded ? '사이드바 닫기' : '사이드바 열기';
  elements.mobileMenu.setAttribute('aria-label', elements.mobileMenu.title);
  elements.sidebar.inert = mobile && !expanded;
}

function sidebarWidthBounds() {
  return {
    min: SIDEBAR_WIDTH_MIN,
    max: Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.floor(innerWidth * 0.44), innerWidth - 420)),
  };
}

function applySidebarWidth() {
  const { min, max } = sidebarWidthBounds();
  const width = Math.max(min, Math.min(max, state.sidebarWidth));
  document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
  elements.sidebarResizeHandle.setAttribute('aria-valuemin', String(min));
  elements.sidebarResizeHandle.setAttribute('aria-valuemax', String(max));
  elements.sidebarResizeHandle.setAttribute('aria-valuenow', String(width));
  elements.sidebarResizeHandle.setAttribute('aria-valuetext', `${width} 픽셀`);
}

function setSidebarWidth(width, persist = false) {
  state.sidebarWidth = Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.round(width)));
  applySidebarWidth();
  if (persist) {
    try { savePreferences(); }
    catch { showToast('사이드바 크기를 저장하지 못했습니다.'); }
  }
}

let sidebarResizePointerId = null;
let sidebarResizeStartX = 0;
let sidebarResizeStartWidth = 0;
elements.sidebarResizeHandle.addEventListener('pointerdown', (event) => {
  if (innerWidth <= 760 || elements.sidebar.classList.contains('collapsed') || event.button !== 0) return;
  event.preventDefault();
  sidebarResizePointerId = event.pointerId;
  sidebarResizeStartX = event.clientX;
  sidebarResizeStartWidth = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')) || SIDEBAR_WIDTH_DEFAULT;
  elements.sidebarResizeHandle.setPointerCapture(event.pointerId);
  document.body.classList.add('sidebar-resizing');
});
elements.sidebarResizeHandle.addEventListener('pointermove', (event) => {
  if (event.pointerId !== sidebarResizePointerId) return;
  setSidebarWidth(sidebarResizeStartWidth + event.clientX - sidebarResizeStartX);
});
function finishSidebarResize(event) {
  if (event.pointerId !== sidebarResizePointerId) return;
  sidebarResizePointerId = null;
  document.body.classList.remove('sidebar-resizing');
  try { savePreferences(); }
  catch { showToast('사이드바 크기를 저장하지 못했습니다.'); }
  if (elements.sidebarResizeHandle.hasPointerCapture(event.pointerId)) {
    elements.sidebarResizeHandle.releasePointerCapture(event.pointerId);
  }
}
elements.sidebarResizeHandle.addEventListener('pointerup', finishSidebarResize);
elements.sidebarResizeHandle.addEventListener('pointercancel', finishSidebarResize);
elements.sidebarResizeHandle.addEventListener('dblclick', () => setSidebarWidth(SIDEBAR_WIDTH_DEFAULT, true));
elements.sidebarResizeHandle.addEventListener('keydown', (event) => {
  const { min, max } = sidebarWidthBounds();
  const current = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')) || SIDEBAR_WIDTH_DEFAULT;
  const step = event.shiftKey ? 32 : 16;
  const next = event.key === 'ArrowLeft' ? current - step
    : event.key === 'ArrowRight' ? current + step
      : event.key === 'Home' ? min
        : event.key === 'End' ? max : null;
  if (next === null) return;
  event.preventDefault();
  setSidebarWidth(next, true);
});

function toggleSidebar() {
  accountMenuUI.close();
  const mobile = innerWidth <= 760;
  elements.sidebar.classList.toggle(mobile ? 'mobile-open' : 'collapsed');
  updateSidebarControls();
  if (mobile) (elements.sidebar.classList.contains('mobile-open') ? elements.sidebarToggle : elements.mobileMenu).focus();
}

function closeMobileSidebar() {
  accountMenuUI.close();
  const restoreFocus = innerWidth <= 760 && elements.sidebar.contains(document.activeElement);
  elements.sidebar.classList.remove('mobile-open');
  updateSidebarControls();
  if (restoreFocus) elements.mobileMenu.focus();
}

document.querySelector('#newChatButton').addEventListener('click', createConversation);
document.querySelector('#addProjectButton').addEventListener('click', () => openProjectEditor());
document.querySelector('#importProjectButton').addEventListener('click', () => elements.projectImportFile.click());
elements.projectImportFile.addEventListener('change', (event) => selectProjectImportFile(event.target.files?.[0]));
document.querySelector('#commitProjectImport').addEventListener('click', commitProjectImport);
document.querySelector('#exportConversationSearch').addEventListener('input', renderExportConversationPicker);
document.querySelector('#exportConversationList').addEventListener('change', (event) => {
  const pending = state.pendingProjectImport;
  if (!pending || !event.target.matches('[data-export-index]')) return;
  const index = Number(event.target.dataset.exportIndex);
  if (event.target.checked) pending.selected.add(index); else pending.selected.delete(index);
  renderExportConversationPicker();
});
document.querySelector('#exportSelectAll').addEventListener('change', (event) => {
  const pending = state.pendingProjectImport;
  if (!pending) return;
  for (const { index } of visibleExportConversations()) {
    if (event.target.checked) pending.selected.add(index); else pending.selected.delete(index);
  }
  renderExportConversationPicker();
});
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
elements.sidebarToggle.addEventListener('click', toggleSidebar);
elements.mobileMenu.addEventListener('click', toggleSidebar);
document.querySelector('#settingsButtonTop').addEventListener('click', showSettings);
document.querySelector('#composerConnections').addEventListener('click', () => showSettings(state.provider === 'api' ? 'agents' : 'accounts'));
document.querySelector('#closeSettings').addEventListener('click', hideSettings);
document.querySelector('#doneSettings').addEventListener('click', hideSettings);
document.querySelector('#refreshStatus').addEventListener('click', () => {
  void refreshStatus();
  if (!document.querySelector('#usagePanel').hidden) usageActivityUI.refresh();
});
document.querySelector('#addAiConnection').addEventListener('click', openProviderConnectionModal);
document.querySelector('#closeProviderConnection').addEventListener('click', () => closeProviderConnectionModal(true));
document.querySelector('#cancelProviderConnection').addEventListener('click', () => closeProviderConnectionModal(true));
document.querySelector('#providerConnectionModal').addEventListener('click', (event) => {
  if (event.target.id === 'providerConnectionModal') closeProviderConnectionModal(true);
});
document.querySelector('#providerConnectionModal').addEventListener('keydown', (event) => {
  const modal = document.querySelector('#providerConnectionModal');
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeProviderConnectionModal(true);
    return;
  }
  if (event.key !== 'Tab') return;
  const controls = [...modal.querySelectorAll('button:not(:disabled)')].filter((node) => node.getClientRects().length);
  const first = controls[0]; const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});
document.querySelector('#connectCodexFromModal').addEventListener('click', () => {
  const addingAnotherAccount = state.providers.openai?.linked === true;
  closeProviderConnectionModal();
  void connectCodexAccount(addingAnotherAccount ? null : 'default');
});
document.querySelector('#connectClaudeFromModal').addEventListener('click', () => {
  closeProviderConnectionModal();
  void connectProvider('anthropic');
});
document.querySelector('#addChatGptFromModal').addEventListener('click', () => void addWebService('chatgpt'));
document.querySelector('#addGeminiFromModal').addEventListener('click', () => void addWebService('gemini'));
document.querySelector('#addApiFromModal').addEventListener('click', () => {
  closeProviderConnectionModal();
  openNewApiConnection();
});
document.querySelector('#accountsPanel').addEventListener('click', (event) => {
  const button = event.target.closest('[data-delete-web-service]');
  if (button) void removeWebService(button.dataset.deleteWebService);
});
document.querySelector('#claudeConnectionList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-claude-action]');
  if (!button || button.disabled) return;
  if (button.dataset.claudeAction === 'login') void connectProvider('anthropic');
  if (button.dataset.claudeAction === 'delete') void removeClaudeConnection();
});
document.querySelector('#connectionDetails').addEventListener('click', () => showSettings(state.provider === 'api' ? 'agents' : 'accounts'));
document.querySelector('#openHistoryImport').addEventListener('click', () => {
  if (historyImportUI.open()) hideSettings();
});
document.querySelector('#settingsImportFile').addEventListener('click', () => elements.projectImportFile.click());
const compactSettings = window.matchMedia('(max-width: 680px)');
function updateSettingsTabOrientation() {
  document.querySelector('.settings-tabs').setAttribute('aria-orientation', compactSettings.matches ? 'horizontal' : 'vertical');
}
compactSettings.addEventListener('change', updateSettingsTabOrientation);
updateSettingsTabOrientation();
document.querySelectorAll('[data-settings-tab]').forEach((button) => {
  button.addEventListener('click', () => selectSettingsTab(button.dataset.settingsTab));
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll('[data-settings-tab]')];
    const direction = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(button) + direction + tabs.length) % tabs.length;
    const next = tabs[index];
    next.click();
    next.focus();
  });
});
[
  elements.sharedAgentInstructions,
  elements.codexAgentInstructions,
  elements.claudeAgentInstructions,
].forEach((field) => field.addEventListener('input', saveAgentInstructionSettings));
[
  elements.codexUsesSharedInstructions,
  elements.claudeUsesSharedInstructions,
].forEach((field) => field.addEventListener('change', saveAgentInstructionSettings));
function openNewApiConnection() {
  showSettings('agents');
  apiConnectionsUI.openEditor();
}
document.querySelector('#addAgentSidebar').addEventListener('click', (event) => {
  event.preventDefault();
  openNewApiConnection();
});
document.querySelector('#addAgentFromModels').addEventListener('click', openNewApiConnection);
document.querySelector('#manageModelVisibility').addEventListener('click', () => showSettings('models'));
document.querySelector('#manageProviderConnections').addEventListener('click', () => showSettings('accounts'));
document.querySelector('#agentList').addEventListener('click', (event) => {
  if (event.target.closest('[data-open-ai-connections]')) {
    showSettings('accounts');
    openProviderConnectionModal();
    return;
  }
  const button = event.target.closest('[data-agent-tab]');
  if (button) showSettings(button.dataset.agentTab);
});
document.querySelector('#aiConnectionEmptyState').addEventListener('click', (event) => {
  if (event.target.closest('[data-open-ai-connections]')) openProviderConnectionModal();
});
document.querySelector('#codexAccountForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if (state.addingCodexAccount) return;
  const input = document.querySelector('#codexAccountName');
  document.querySelector('#codexAccountForm').hidden = true;
  void connectCodexAccount(null, input.value.trim().slice(0, 48));
  input.value = '';
});
document.querySelector('#cancelCodexAccountForm').addEventListener('click', () => { document.querySelector('#codexAccountForm').hidden = true; });
elements.addCodexAccountButton.addEventListener('click', addCodexAccount);
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
  const unlinkButton = event.target.closest('[data-unlink-codex-connection]');
  if (deleteButton) updateCodexAccountLink(deleteButton.dataset.deleteCodexAccount, 'delete');
  if (unlinkButton) updateCodexAccountLink(unlinkButton.dataset.unlinkCodexConnection, 'unlink');
});
elements.settingsModal.addEventListener('click', (event) => { if (event.target === elements.settingsModal) hideSettings(); });
elements.settingsModal.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const controls = [...elements.settingsModal.querySelectorAll('button, input, select, a[href]')].filter((node) => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
  const first = controls[0]; const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});
elements.projectModal.addEventListener('click', (event) => { if (event.target === elements.projectModal) closeProjectEditor(); });
elements.projectMoveModal.addEventListener('click', (event) => { if (event.target === elements.projectMoveModal) closeProjectMove(); });
elements.projectImportModal.addEventListener('click', (event) => { if (event.target === elements.projectImportModal) closeProjectImport(); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && elements.conversationActions.open) {
    elements.conversationActions.open = false;
    elements.conversationActions.querySelector('summary').focus();
    return;
  }
  if (!document.querySelector('#historyImportModal').hidden) return;
  if (!document.querySelector('#apiConnectionModal').hidden) return;
  if (event.key === 'Escape') {
    if (!document.querySelector('#apiConnectionModal').hidden) return;
    if (!elements.modelMenu.hidden) { closeModelMenu(true); return; }
    if (!elements.searchModal.hidden) hideSearch();
    hideSettings();
    closeProjectEditor();
    closeProjectMove();
    closeProjectImport();
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

for (const [button, mode] of [[elements.providerSelectButton, 'providers'], [elements.modelSelectButton, 'models']]) {
  button.addEventListener('click', () => {
    if (!elements.modelMenu.hidden && modelMenuMode === mode) { closeModelMenu(true); return; }
    openModelMenu(mode);
  });
}
elements.modelSearch.addEventListener('input', renderModelOptions);
elements.modelOptions.addEventListener('click', (event) => {
  const providerButton = event.target.closest('[data-provider-key]');
  if (providerButton) {
    // Keep the next menu open after replacing the clicked connection row.
    event.stopPropagation();
    setProvider(providerButton.dataset.providerKey);
    return;
  }
  const button = event.target.closest('[data-model-key]');
  if (button) setModel(button.dataset.modelKey);
});
document.querySelector('#closeModelMenu').addEventListener('click', () => closeModelMenu(true));
elements.modelMenu.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target === elements.modelSearch) {
    event.preventDefault();
    const first = elements.modelOptions.querySelector('button:not(:disabled)');
    if (first) first.click();
    return;
  }
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  const items = [elements.modelSearch, ...elements.modelOptions.querySelectorAll('button:not(:disabled)')];
  const index = items.indexOf(document.activeElement);
  const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[next].focus();
});
elements.modelMenu.addEventListener('focusout', () => {
  requestAnimationFrame(() => { if (!elements.modelMenu.contains(document.activeElement) && ![elements.providerSelectButton, elements.modelSelectButton].includes(document.activeElement)) closeModelMenu(); });
});
document.addEventListener('click', (event) => {
  if (!elements.conversationActions.contains(event.target)) elements.conversationActions.open = false;
  if (!elements.modelMenu.hidden && !elements.modelMenu.contains(event.target) && !elements.providerSelectButton.contains(event.target) && !elements.modelSelectButton.contains(event.target)) {
    closeModelMenu();
  }
});
elements.copyLastResponseButton.addEventListener('click', () => { void copyLastResponse(); });
elements.messages.addEventListener('toggle', (event) => {
  const details = event.target.closest('.worked-for-details');
  if (!details) return;
  const message = activeConversation()?.messages.find((item) => item.id === details.dataset.activityMessageId);
  if (!message || message.activityExpanded === details.open) return;
  message.activityExpanded = details.open;
  saveConversations();
}, true);
elements.messages.addEventListener('click', (event) => {
  const cancelQueued = event.target.closest('[data-cancel-queued]');
  if (cancelQueued) {
    removeQueuedMessage(cancelQueued.dataset.cancelQueued);
    return;
  }
  if (event.target.closest('[data-retry-queue]')) {
    startNextQueuedMessage(activeConversation());
    return;
  }
  const button = event.target.closest('.copy-code-button, .message-copy-button');
  if (!button) return;
  if (button.matches('.copy-code-button')) void copyCodeBlock(button);
  else void copyMessage(button);
});
elements.exportConversationButton.addEventListener('click', exportConversationMarkdown);
elements.fastModeToggle.addEventListener('click', toggleFastMode);
elements.composerReasoningEffortSelect.addEventListener('change', (event) => setReasoningEffort(event.target.value));
elements.stopResponseButton.addEventListener('click', () => state.controller?.abort());
window.addEventListener('resize', () => { closeModelMenu(); updateSidebarControls(); applySidebarWidth(); });
elements.composerForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (state.busy) {
    if (elements.messageInput.value.trim()) enqueueMessage(elements.messageInput.value);
    else state.controller?.abort();
    return;
  }
  sendMessage(elements.messageInput.value);
});
elements.messageInput.addEventListener('input', () => {
  resizeInput();
  renderSendButtonState(modelCatalog().find((model) => modelKey(model) === selectedModelKey())?.connected === true);
});
elements.messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (state.busy || activeConversation()?.messages.some((item) => item.role === 'user' && item.queued)) {
      enqueueMessage(elements.messageInput.value);
    } else {
      sendMessage(elements.messageInput.value);
    }
  }
});
document.querySelectorAll('.suggestion').forEach((button) => {
  button.addEventListener('click', () => {
    elements.messageInput.value = button.dataset.prompt;
    resizeInput();
    renderSendButtonState(modelCatalog().find((model) => modelKey(model) === selectedModelKey())?.connected === true);
    elements.messageInput.focus();
  });
});

loadPreferences();
applySidebarWidth();
renderAgentInstructionSettings();
if (!state.provider && activeConversation()?.provider) {
  const conversation = activeConversation();
  state.provider = conversation.provider;
  state.model = conversation.model;
  state.activeConnectionId = conversation.connectionId;
  if (state.provider === 'openai') state.activeCodexAccountId = conversation.codexAccountId;
}
updateSidebarControls();
render();
void refreshStatus().then(resumeSavedQueue);

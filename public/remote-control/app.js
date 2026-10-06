const mode = document.body.dataset.mode;
const $ = (selector) => document.querySelector(selector);
const TERMINAL_RUN_STATES = new Set(['completed', 'reviewed', 'stopped', 'failed', 'limit', 'blocked', 'interrupted']);
const STATUS_LABELS = {
  running: '진행 중', stopping: '중지 중', completed: '완료', reviewed: '검토 필요', stopped: '중지됨',
  failed: '실패', limit: '회차 한도', blocked: '확인 필요', interrupted: '중단됨',
};
const STAGE_LABELS = {
  prepare: '작업 공간 준비', configuring: '프로젝트 설정', selecting: '모델 배정', planning: '계획', planner: '계획',
  working: '구현', implement: '구현', worker: '구현', 'milestone-qa': '부분 작업 검증',
  verifying: '검증', verify: '검증', judging: '판정', judge: '판정', applying: '변경 반영', apply: '변경 반영',
  'browser-qa': '브라우저 QA', 'readme-launch-qa': '실행 안내 확인', finished: '마무리', finish: '마무리', done: '완료',
};
const state = {
  models: [],
  runId: localStorage.getItem('loopline.remote.runId') || '',
  pollTimer: 0,
  busy: false,
  currentChatController: null,
  toastTimer: 0,
};

function setHeader(text, status = 'waiting') {
  const header = $('#headerStatus');
  header.dataset.state = status;
  header.lastElementChild.textContent = text;
}

function showToast(selector, message, isError = false) {
  const toast = $(selector);
  if (!toast) return;
  clearTimeout(state.toastTimer);
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('visible');
  state.toastTimer = setTimeout(() => toast.classList.remove('visible'), 3600);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : {};
  if (!response.ok) {
    const error = new Error(body.error || `요청을 처리하지 못했습니다 (${response.status}).`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function postJson(url, body, signal) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

function savedModel(name, fallback = '') {
  try { return localStorage.getItem(`loopline.remote.model.${name}`) || fallback; } catch { return fallback; }
}

function storeModel(name, value) {
  try { localStorage.setItem(`loopline.remote.model.${name}`, value); } catch { /* Private browsing may disable local storage. */ }
}

function modelLabel(model) {
  const source = model.accountName || model.connectionName;
  return `${model.providerLabel} · ${model.label}${source ? ` (${source})` : ''}`;
}

function fillModelSelect(select, { role = 'chat', preferred = '' } = {}) {
  if (!select) return;
  const allowed = role === 'judge' ? state.models : state.models.filter(model => !model.decisionOnly);
  const prior = preferred || savedModel(role);
  select.replaceChildren();
  if (!allowed.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = role === 'judge' ? '연결된 판정 모델 없음' : '사용 가능한 모델 없음';
    select.append(option);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  const optgroups = new Map();
  for (const model of allowed) {
    const groupName = model.providerLabel || '모델';
    let group = optgroups.get(groupName);
    if (!group) {
      group = document.createElement('optgroup');
      group.label = groupName;
      optgroups.set(groupName, group);
      select.append(group);
    }
    const option = document.createElement('option');
    option.value = model.key;
    option.textContent = `${model.label}${model.accountName || model.connectionName ? ` · ${model.accountName || model.connectionName}` : ''}${model.decisionOnly ? ' · 판정 전용' : ''}`;
    group.append(option);
  }
  select.value = allowed.some(model => model.key === prior)
    ? prior
    : (role === 'judge' ? (allowed.find(model => model.decisionOnly) || allowed[0]) : allowed[0]).key;
}

function renderModelSelects() {
  fillModelSelect($('#chatModel'), { role: 'chat' });
  fillModelSelect($('#plannerModel'), { role: 'planner' });
  fillModelSelect($('#workerModel'), { role: 'worker' });
  fillModelSelect($('#judgeModel'), { role: 'judge' });
  for (const [id, role] of [['chatModel', 'chat'], ['plannerModel', 'planner'], ['workerModel', 'worker'], ['judgeModel', 'judge']]) {
    const select = $(`#${id}`);
    select.onchange = () => storeModel(role, select.value);
  }
  const hasWorkingModels = state.models.some(model => !model.decisionOnly);
  const canLoop = hasWorkingModels && state.models.length > 0;
  $('#chatInput').disabled = !hasWorkingModels;
  $('#chatSend').disabled = !hasWorkingModels;
  $('#loopTask').disabled = !canLoop;
  $('#loopStart').disabled = !canLoop;
  $('.field-hint').textContent = hasWorkingModels
    ? '대화와 작업 기록은 이 브라우저에 저장됩니다.'
    : 'Mac Loopline에서 AI 계정을 먼저 연결해 주세요.';
}

function renderAdminStatus(data) {
  const { tailscale, backendConnected } = data;
  $('#adminTailStatus').textContent = tailscale.installed ? (tailscale.online ? '연결됨' : '오프라인') : '설치되지 않음';
  $('#adminTailLogin').textContent = tailscale.login || (tailscale.online ? '로그인 확인 불가' : 'Mac에서 Tailscale에 연결하세요');
  $('#adminBackendStatus').textContent = backendConnected ? '실행 중' : '꺼짐';
  $('#adminServeStatus').textContent = tailscale.serveEnabled ? '켜짐' : tailscale.routeConflict ? '경로 사용 중' : '꺼짐';
  $('#adminServeUrl').textContent = tailscale.serveEnabled && tailscale.url ? tailscale.url : tailscale.routeConflict ? '/loopline 경로는 다른 서비스에서 사용 중' : '설정된 경로 없음';
  $('#adminMessage').textContent = tailscale.routeConflict
    ? '기존 /loopline 경로가 다른 서비스에 연결되어 있어 설정을 바꾸지 않았습니다.'
    : !tailscale.installed
      ? 'Mac에 Tailscale을 설치하고 로그인한 뒤 새로고침하세요.'
      : !tailscale.online
        ? 'Mac의 Tailscale을 연결하면 여기서 원격 접속을 켤 수 있습니다.'
        : tailscale.serveEnabled
          ? backendConnected
            ? '폰과 Mac이 같은 Tailnet에 연결되어 있으면 아래 주소로 접속할 수 있습니다.'
            : 'Loopline 서버가 꺼져 있어 폰에서 사용할 수 없습니다. 원격 경로를 끄거나 서버를 다시 시작할 수 있습니다.'
          : !backendConnected
            ? 'Loopline 서버를 먼저 실행해 주세요. 현재 Tailscale Serve 설정은 변경하지 않았습니다.'
            : '켜기를 누르면 기존 사이트의 / 경로는 유지하고 /loopline만 추가합니다.';
  const button = $('#serveToggle');
  button.textContent = tailscale.serveEnabled ? '원격 접속 끄기' : '원격 접속 켜기';
  button.classList.toggle('button-stop', tailscale.serveEnabled);
  button.classList.toggle('button-primary', !tailscale.serveEnabled);
  button.disabled = !tailscale.installed || !tailscale.online || (!tailscale.serveEnabled && !backendConnected) || tailscale.routeConflict;
}

async function refreshAdmin() {
  try {
    const data = await fetchJson('/local-api/status');
    renderAdminStatus(data);
    setHeader(data.tailscale.online ? 'Mac에서 관리' : 'Mac에서 연결 대기', data.tailscale.online && data.backendConnected ? 'ready' : 'waiting');
  } catch (error) {
    $('#adminMessage').textContent = error.message;
    setHeader('상태를 확인할 수 없음', 'error');
  }
}

async function toggleServe() {
  const button = $('#serveToggle');
  const enabling = button.textContent.includes('켜기');
  button.disabled = true;
  try {
    const result = await postJson(`/local-api/serve/${enabling ? 'enable' : 'disable'}`, {});
    renderAdminStatus(result);
    showToast('#adminToast', enabling ? '폰 원격 접속을 켰습니다.' : '폰 원격 접속을 껐습니다.');
  } catch (error) {
    showToast('#adminToast', error.message, true);
  } finally {
    await refreshAdmin();
  }
}

function loadChatHistory() {
  try {
    const value = JSON.parse(localStorage.getItem('loopline.remote.chat') || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(item => ['user', 'assistant'].includes(item.role) && typeof item.content === 'string')
      .slice(-30).map(item => ({ role: item.role, content: item.content.slice(0, 40_000), error: item.error === true }));
  } catch { return []; }
}

let chatMessages = loadChatHistory();

function saveChatHistory() {
  try { localStorage.setItem('loopline.remote.chat', JSON.stringify(chatMessages.slice(-30))); } catch { /* Storage can be disabled or full. */ }
}

function renderChat() {
  const container = $('#chatMessages');
  container.replaceChildren();
  if (!chatMessages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-chat';
    empty.textContent = '여기서 보낸 요청은 Mac의 Loopline으로 전달됩니다.\n대화와 결과는 이 폰의 브라우저에 보관됩니다.';
    container.append(empty);
    return;
  }
  for (const message of chatMessages) {
    const item = document.createElement('article');
    item.className = `chat-message ${message.role}${message.error ? ' error' : ''}`;
    item.textContent = message.content || '응답을 기다리는 중…';
    container.append(item);
  }
  container.scrollTop = container.scrollHeight;
}

function parseSseBlock(block) {
  const lines = block.split(/\r?\n/);
  const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
  const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  if (!data) return null;
  try { return { event, data: JSON.parse(data) }; } catch { return null; }
}

async function streamChat(response, assistant) {
  if (!response.body) throw new Error('모델 응답 스트림을 사용할 수 없습니다.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let gotDone = false;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    buffer = buffer.replace(/\r\n/g, '\n');
    let separator;
    while ((separator = buffer.indexOf('\n\n')) !== -1) {
      const parsed = parseSseBlock(buffer.slice(0, separator));
      buffer = buffer.slice(separator + 2);
      if (!parsed) continue;
      if (parsed.event === 'delta') assistant.content += parsed.data.text || '';
      if (parsed.event === 'error') {
        assistant.content += `${assistant.content ? '\n\n' : ''}오류: ${parsed.data.error || '응답을 만들지 못했습니다.'}`;
        assistant.error = true;
      }
      if (parsed.event === 'done') gotDone = true;
      renderChat();
    }
    if (done) break;
  }
  if (!gotDone && !assistant.error && !assistant.content) {
    assistant.content = '응답 연결이 끝났습니다. 다시 요청해 주세요.';
    assistant.error = true;
  }
}

async function sendChat(event) {
  event.preventDefault();
  if (state.busy) return;
  const input = $('#chatInput');
  const text = input.value.trim();
  const modelKey = $('#chatModel').value;
  if (!text || !modelKey) return;
  chatMessages.push({ role: 'user', content: text });
  const assistant = { role: 'assistant', content: '' };
  chatMessages.push(assistant);
  chatMessages = chatMessages.slice(-30);
  input.value = '';
  setChatBusy(true);
  renderChat();
  saveChatHistory();
  const controller = new AbortController();
  state.currentChatController = controller;
  try {
    const response = await fetch('remote-api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ modelKey, messages: chatMessages.slice(0, -1).map(({ role, content }) => ({ role, content })) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `요청에 실패했습니다 (${response.status}).`);
    }
    await streamChat(response, assistant);
  } catch (error) {
    if (error.name === 'AbortError') {
      if (!assistant.content) assistant.content = '응답을 중지했습니다.';
    } else {
      assistant.content = `${assistant.content ? `${assistant.content}\n\n` : ''}오류: ${error.message}`;
      assistant.error = true;
    }
  } finally {
    state.currentChatController = null;
    setChatBusy(false);
    saveChatHistory();
    renderChat();
    input.focus();
  }
}

function setChatBusy(busy) {
  state.busy = busy;
  $('#chatSend').hidden = busy;
  $('#chatStop').hidden = !busy;
  $('#chatInput').disabled = busy;
}

function selectMode(name) {
  const chat = name === 'chat';
  $('#chatTab').classList.toggle('active', chat);
  $('#loopTab').classList.toggle('active', !chat);
  $('#chatTab').setAttribute('aria-selected', String(chat));
  $('#loopTab').setAttribute('aria-selected', String(!chat));
  $('#chatPanel').hidden = !chat;
  $('#loopPanel').hidden = chat;
}

function renderRun(run) {
  state.runId = run.id;
  try { localStorage.setItem('loopline.remote.runId', run.id); } catch { /* Optional resume shortcut. */ }
  const card = $('#runCard');
  card.hidden = false;
  const stage = STAGE_LABELS[run.stage] || '작업';
  $('#runTitle').textContent = run.round ? `${stage} · ${run.round}/${run.rounds || '자동'}회차` : stage;
  const badge = $('#runBadge');
  badge.textContent = STATUS_LABELS[run.status] || '상태 확인 중';
  badge.dataset.state = ['completed', 'reviewed'].includes(run.status) ? 'success'
    : ['failed', 'blocked', 'interrupted', 'limit'].includes(run.status) ? 'error' : 'running';
  $('#runTask').textContent = run.task || '';
  $('#runSummary').textContent = run.summary || (TERMINAL_RUN_STATES.has(run.status) ? '실행이 끝났습니다. 단계별 결과를 확인하세요.' : '계획부터 구현·검증까지 진행 중입니다.');
  const timeline = $('#runTimeline');
  timeline.replaceChildren();
  const events = Array.isArray(run.events) ? run.events.slice(-50) : [];
  if (!events.length) {
    const empty = document.createElement('p');
    empty.className = 'timeline-meta';
    empty.textContent = '첫 단계가 시작되면 진행 내용과 사용 모델이 여기에 표시됩니다.';
    timeline.append(empty);
  }
  for (const event of events) {
    const row = document.createElement('article');
    row.className = 'timeline-item';
    row.dataset.status = event.status || 'running';
    const marker = document.createElement('span');
    marker.className = 'timeline-marker';
    marker.setAttribute('aria-hidden', 'true');
    const body = document.createElement('div');
    body.className = 'timeline-content';
    const title = document.createElement('h3');
    title.className = 'timeline-title';
    title.textContent = event.title || 'Loop 단계';
    body.append(title);
    const model = event.model?.label || event.model?.model;
    if (model) {
      const meta = document.createElement('p');
      meta.className = 'timeline-meta';
      meta.textContent = [event.model.provider, model].filter(Boolean).join(' · ');
      body.append(meta);
    }
    if (event.detail) {
      const detail = document.createElement('p');
      detail.className = 'timeline-detail';
      detail.textContent = event.detail;
      body.append(detail);
    }
    row.append(marker, body);
    timeline.append(row);
  }
  $('#runStop').hidden = TERMINAL_RUN_STATES.has(run.status);
  $('#runResume').hidden = !run.canResume;
}

function renderRemoteStatus(data) {
  state.models = Array.isArray(data.models) ? data.models : [];
  renderModelSelects();
  renderChat();
  if (data.backendConnected && data.tailscale.online) {
    setHeader('Mac에 안전하게 연결됨', 'ready');
  } else {
    setHeader(data.backendConnected ? 'Tailscale 연결 확인 필요' : 'Mac 서버 연결 끊김', 'error');
  }
  $('#blockedView').hidden = true;
  $('#remoteView').hidden = false;
  if (!data.backendConnected) showToast('#remoteToast', 'Mac에서 Loopline 서버가 실행 중인지 확인해 주세요.', true);
  if (!state.models.length) showToast('#remoteToast', '사용 가능한 모델이 없습니다. Mac의 계정 연결 상태를 확인해 주세요.', true);
}

async function refreshRemoteStatus() {
  try {
    renderRemoteStatus(await fetchJson('remote-api/status'));
    if (state.runId) await refreshRun();
  } catch (error) {
    $('#remoteView').hidden = true;
    $('#blockedView').hidden = false;
    $('#blockedText').textContent = error.message;
    setHeader('원격 연결을 확인할 수 없음', 'error');
  }
}

function setLoopBusy(busy) {
  $('#loopStart').disabled = busy || !state.models.some(model => !model.decisionOnly);
  $('#loopTask').disabled = busy;
  for (const selector of ['#plannerModel', '#workerModel', '#judgeModel', '#rounds']) $(selector).disabled = busy;
}

async function startLoop(event) {
  event.preventDefault();
  const task = $('#loopTask').value.trim();
  if (!task) return;
  setLoopBusy(true);
  try {
    const run = await postJson('remote-api/runs', {
      task,
      roles: {
        planner: $('#plannerModel').value,
        worker: $('#workerModel').value,
        judge: $('#judgeModel').value,
      },
      rounds: Number($('#rounds').value),
    });
    $('#loopTask').value = '';
    renderRun(run);
    $('#runCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast('#remoteToast', '새 격리 프로젝트에서 Loop 작업을 시작했습니다.');
    scheduleRunPoll();
  } catch (error) {
    showToast('#remoteToast', error.message, true);
    if (error.body?.run) renderRun(error.body.run);
    else if (state.runId) await refreshRun().catch(() => {});
  } finally {
    setLoopBusy(false);
  }
}

async function refreshRun() {
  if (!state.runId) return;
  try {
    const run = await fetchJson(`remote-api/runs/${encodeURIComponent(state.runId)}`);
    renderRun(run);
    if (TERMINAL_RUN_STATES.has(run.status)) {
      clearTimeout(state.pollTimer);
      state.pollTimer = 0;
      setLoopBusy(false);
    } else {
      scheduleRunPoll();
    }
  } catch (error) {
    if (error.message.includes('찾을 수 없습니다')) {
      clearTimeout(state.pollTimer);
      state.pollTimer = 0;
      showToast('#remoteToast', '저장한 실행을 찾을 수 없습니다. 화면에서 지운 뒤 새 작업을 시작해 주세요.', true);
    }
  }
}

function scheduleRunPoll() {
  clearTimeout(state.pollTimer);
  if (!state.runId) return;
  state.pollTimer = setTimeout(refreshRun, 1500);
}

async function stopRun() {
  if (!state.runId) return;
  $('#runStop').disabled = true;
  try {
    const run = await postJson(`remote-api/runs/${encodeURIComponent(state.runId)}/stop`, {});
    renderRun(run);
    scheduleRunPoll();
    showToast('#remoteToast', '중지 요청을 보냈습니다.');
  } catch (error) {
    showToast('#remoteToast', error.message, true);
  } finally {
    $('#runStop').disabled = false;
  }
}

async function resumeRun() {
  if (!state.runId) return;
  $('#runResume').disabled = true;
  try {
    const run = await postJson(`remote-api/runs/${encodeURIComponent(state.runId)}/resume`, {});
    renderRun(run);
    scheduleRunPoll();
    showToast('#remoteToast', '저장된 단계부터 이어갑니다.');
  } catch (error) {
    showToast('#remoteToast', error.message, true);
  } finally {
    $('#runResume').disabled = false;
  }
}

function clearRun() {
  clearTimeout(state.pollTimer);
  state.pollTimer = 0;
  state.runId = '';
  try { localStorage.removeItem('loopline.remote.runId'); } catch { /* Optional resume shortcut. */ }
  $('#runCard').hidden = true;
  $('#runTimeline').replaceChildren();
  setLoopBusy(false);
}

function init() {
  if (mode === 'admin') {
    $('#adminView').hidden = false;
    $('#serveToggle').addEventListener('click', toggleServe);
    void refreshAdmin();
    setInterval(refreshAdmin, 20_000);
    return;
  }
  if (mode !== 'remote') {
    $('#blockedView').hidden = false;
    $('#blockedText').textContent = '화면 설정을 읽지 못했습니다. 새로고침해 주세요.';
    return;
  }
  $('#chatTab').addEventListener('click', () => selectMode('chat'));
  $('#loopTab').addEventListener('click', () => selectMode('loop'));
  $('#chatForm').addEventListener('submit', sendChat);
  $('#chatStop').addEventListener('click', () => state.currentChatController?.abort());
  $('#loopForm').addEventListener('submit', startLoop);
  $('#runStop').addEventListener('click', stopRun);
  $('#runResume').addEventListener('click', resumeRun);
  $('#runClear').addEventListener('click', clearRun);
  $('#remoteView').hidden = false;
  $('#chatPanel').hidden = false;
  $('#loopPanel').hidden = true;
  renderChat();
  void refreshRemoteStatus();
  setInterval(() => {
    if (!document.hidden) void refreshRemoteStatus();
  }, 45_000);
}

init();

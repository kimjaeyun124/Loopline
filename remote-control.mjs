import { createServer } from 'node:http';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const root = dirname(fileURLToPath(import.meta.url));
const staticRoot = join(root, 'public', 'remote-control');
const remoteHost = '127.0.0.1';
const remotePort = Number(process.env.REMOTE_CONTROL_PORT || 41873);
const adminPort = Number(process.env.REMOTE_CONTROL_ADMIN_PORT || 41874);
const backendPort = Number(process.env.REMOTE_CONTROL_BACKEND_PORT || process.env.PORT || 4173);
const userDataDir = resolve(process.env.MOSAIC_USER_DATA_DIR || join(homedir(), '.mosaic-desk'));
const activeRunFile = join(userDataDir, 'remote-control-active-run.json');
const servePath = '/loopline/';
const servePathKey = servePath.replace(/\/$/, '');
const servePort = 443;
const backendBase = `http://127.0.0.1:${backendPort}`;
const remoteFiles = new Map([
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/icon-192.png', ['icon-192.png', 'image/png']],
  ['/icon-512.png', ['icon-512.png', 'image/png']],
]);
const claudeModels = [
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
];
const writeLimits = new Map();
let tailscaleCache;
let tailscaleCacheAt = 0;
let activeRemoteRunId = null;
let activeRemoteRunOwner = '';
let activeRunLockReadError = false;

const activeRunLockReady = readFile(activeRunFile, 'utf8').then(text => {
  const record = JSON.parse(text);
  if (typeof record.id === 'string' && /^[a-f0-9-]{36}$/i.test(record.id)
    && typeof record.owner === 'string' && record.owner.trim()) {
    activeRemoteRunId = record.id;
    activeRemoteRunOwner = record.owner.trim().toLowerCase();
  } else {
    activeRunLockReadError = true;
  }
}).catch(error => {
  if (error.code !== 'ENOENT') activeRunLockReadError = true;
});

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} must be a valid TCP port.`);
  return port;
}

parsePort(remotePort, 'REMOTE_CONTROL_PORT');
parsePort(adminPort, 'REMOTE_CONTROL_ADMIN_PORT');
parsePort(backendPort, 'REMOTE_CONTROL_BACKEND_PORT');
if (new Set([remotePort, adminPort, backendPort]).size !== 3) throw new Error('Remote control, local setup, and Loopline server ports must be different.');

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(JSON.stringify(data));
}

function loopback(address = '') {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function localOriginAllowed(req) {
  const origin = req.headers.origin;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!origin) return req.method === 'GET' || req.method === 'HEAD';
  try {
    const parsed = new URL(origin);
    return ['localhost', '127.0.0.1'].includes(parsed.hostname)
      && Number(parsed.port || 80) === adminPort
      && parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function safeDnsName(value) {
  if (typeof value !== 'string') return '';
  const name = value.replace(/\.$/, '').toLowerCase();
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.ts\.net$/.test(name) ? name : '';
}

async function runTailscale(args) {
  return execFile('tailscale', args, { timeout: 5_000, maxBuffer: 1_000_000, windowsHide: true });
}

function profileForSelf(status) {
  const self = status?.Self;
  const users = status?.User || status?.Users || {};
  const profile = self?.UserID == null ? null : users[String(self.UserID)];
  return {
    online: self?.Online === true,
    login: typeof profile?.LoginName === 'string' ? profile.LoginName.trim().toLowerCase() : '',
    dnsName: safeDnsName(self?.DNSName),
  };
}

function handlerTarget(handler) {
  if (typeof handler === 'string') return handler;
  if (handler && typeof handler === 'object') return JSON.stringify(handler);
  return '';
}

function findRemoteHandler(serveStatus, dnsName) {
  const web = serveStatus?.Web;
  if (!web || typeof web !== 'object') return null;
  for (const [host, config] of Object.entries(web)) {
    if (!host.endsWith(`:${servePort}`)) continue;
    if (dnsName && !host.startsWith(`${dnsName}:`)) continue;
    const handlers = config?.Handlers || {};
    for (const [path, handler] of Object.entries(handlers)) {
      if (path.replace(/\/$/, '') !== servePathKey) continue;
      return { path, target: handlerTarget(handler) };
    }
  }
  return null;
}

async function getTailscaleState(force = false) {
  if (!force && tailscaleCache && Date.now() - tailscaleCacheAt < 8_000) return tailscaleCache;
  const state = {
    installed: true,
    online: false,
    login: '',
    dnsName: '',
    url: '',
    serveEnabled: false,
    routeConflict: false,
    command: `tailscale serve --set-path=${servePath} --bg ${remotePort}`,
  };
  try {
    const [{ stdout: statusText }, { stdout: serveText }] = await Promise.all([
      runTailscale(['status', '--json']),
      runTailscale(['serve', 'status', '--json']).catch(() => ({ stdout: '{}' })),
    ]);
    const status = JSON.parse(statusText);
    const serveStatus = JSON.parse(serveText || '{}');
    Object.assign(state, profileForSelf(status));
    state.url = state.dnsName ? `https://${state.dnsName}${servePath}` : '';
    const handler = findRemoteHandler(serveStatus, state.dnsName);
    if (handler) {
      state.serveEnabled = handler.target.includes(`:${remotePort}`);
      state.routeConflict = !state.serveEnabled;
    }
  } catch {
    try {
      await runTailscale(['version']);
    } catch {
      state.installed = false;
    }
  }
  tailscaleCache = state;
  tailscaleCacheAt = Date.now();
  return state;
}

function allowedLogins(status) {
  const configured = (process.env.REMOTE_ALLOWED_TAILSCALE_USERS || '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  return configured.length ? configured : status.login ? [status.login] : [];
}

async function authorizedTailscaleRequest(req) {
  const status = await getTailscaleState();
  const login = String(req.headers['tailscale-user-login'] || '').trim().toLowerCase();
  if (!status.online || !login || !allowedLogins(status).includes(login)) return null;
  const origin = req.headers.origin;
  if (origin && status.dnsName) {
    try {
      if (new URL(origin).origin !== `https://${status.dnsName}`) return null;
    } catch {
      return null;
    }
  }
  if (!['GET', 'HEAD'].includes(req.method)) {
    if (!status.dnsName || origin !== `https://${status.dnsName}` || req.headers['sec-fetch-site'] === 'cross-site') return null;
  }
  return { login, status };
}

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('JSON 요청이 필요합니다.'), { status: 415 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw Object.assign(new Error('요청이 너무 큽니다.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('요청 형식을 읽을 수 없습니다.'), { status: 400 });
  }
}

async function backend(path, init = {}) {
  const response = await fetch(`${backendBase}${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...(init.headers || {}) },
    signal: init.signal || AbortSignal.timeout(12_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || `Loopline 서버 응답 오류 (${response.status})`), { status: response.status });
  return body;
}

async function probeBackend() {
  const response = await fetch(`${backendBase}/`, { signal: AbortSignal.timeout(2_500) });
  await response.body?.cancel().catch(() => {});
  return response.ok;
}

function stringValue(value, limit = 200) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function remoteText(value, limit) {
  return stringValue(value, limit).replace(/(?:\/Users\/[^\s"'`<>]+|\/private\/var\/folders\/[^\s"'`<>]+|\/Volumes\/[^\s"'`<>]+|\/home\/[^\s"'`<>]+)/g, '[이 Mac의 프로젝트 경로]');
}

async function saveActiveRunLock(id, owner) {
  await mkdir(userDataDir, { recursive: true, mode: 0o700 });
  const temporary = `${activeRunFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ id, owner }), { mode: 0o600 });
  await rename(temporary, activeRunFile);
}

async function clearActiveRunLock() {
  activeRemoteRunId = null;
  activeRemoteRunOwner = '';
  await rm(activeRunFile, { force: true }).catch(() => {});
}

async function activeRunConflict(login, requestedRunId = '') {
  await activeRunLockReady;
  if (activeRunLockReadError) return { status: 503, message: '저장된 원격 실행 잠금을 읽지 못해 중복 실행을 막고 있습니다. Mac에서 원격 제어 게이트웨이 상태를 확인해 주세요.' };
  if (!activeRemoteRunId || activeRemoteRunId === requestedRunId) return null;
  let current;
  try {
    current = await backend(`/api/harness/runs/${activeRemoteRunId}`);
  } catch {
    return { status: 503, message: '기존 원격 Loop 상태를 확인하지 못해 새 실행을 막고 있습니다.' };
  }
  if (!['completed', 'reviewed', 'stopped', 'failed', 'limit', 'blocked', 'interrupted'].includes(current.status)) {
    if (activeRemoteRunOwner && activeRemoteRunOwner !== login) return { status: 409, message: '다른 Tailnet 사용자의 Loop 작업이 진행 중입니다.' };
    return { status: 409, message: '이미 원격 Loop 작업이 진행 중입니다.', run: publicRun(current) };
  }
  await clearActiveRunLock();
  return null;
}

async function requireRemoteRunOwner(login, runId) {
  await activeRunLockReady;
  if (activeRunLockReadError) throw Object.assign(new Error('저장된 원격 실행 잠금을 읽지 못했습니다.'), { status: 503 });
  if (activeRemoteRunId !== runId || !activeRemoteRunOwner || activeRemoteRunOwner !== login) {
    throw Object.assign(new Error('원격으로 시작한 작업을 찾을 수 없습니다.'), { status: 404 });
  }
}

function modelChoice(provider, providerLabel, item, extra = {}) {
  const id = stringValue(item?.id || item?.model || item?.displayId, 300);
  if (!id) return null;
  const accountId = extra.accountId || '';
  const connectionId = extra.connectionId || '';
  const key = [provider, accountId, connectionId, id].join(':');
  return {
    key,
    provider,
    providerLabel,
    id,
    label: stringValue(item?.label || item?.displayName || item?.name, 160) || id.replace(/^models\//, ''),
    ...(accountId ? { accountId } : {}),
    ...(extra.accountName ? { accountName: stringValue(extra.accountName, 120) } : {}),
    ...(connectionId ? { connectionId } : {}),
    ...(extra.connectionName ? { connectionName: stringValue(extra.connectionName, 120) } : {}),
    decisionOnly: extra.decisionOnly === true,
    supportedReasoningEfforts: Array.isArray(item?.supportedReasoningEfforts)
      ? item.supportedReasoningEfforts.filter(value => typeof value === 'string').slice(0, 12)
      : [],
  };
}

function availableModels(status) {
  const models = [];
  const accounts = Array.isArray(status.codexAccounts) ? status.codexAccounts : [];
  for (const account of accounts) {
    if (!account.connected || account.linked === false) continue;
    for (const item of account.models || []) {
      const choice = modelChoice('openai', 'Codex', item, { accountId: account.id, accountName: account.name });
      if (choice) models.push(choice);
    }
  }
  if (!models.some(model => model.provider === 'openai') && status.providers?.openai?.connected) {
    for (const item of status.providers.openai.models || []) {
      const choice = modelChoice('openai', 'Codex', item, { accountId: 'default' });
      if (choice) models.push(choice);
    }
  }
  if (status.providers?.anthropic?.connected && status.providers.anthropic.linked !== false) {
    for (const item of claudeModels) {
      const choice = modelChoice('anthropic', 'Claude Code', item);
      if (choice) models.push(choice);
    }
  }
  for (const connection of status.connections || []) {
    if (!connection.connected) continue;
    for (const item of connection.models || []) {
      const choice = modelChoice('api', 'API 연결', item, {
        connectionId: connection.id,
        connectionName: connection.name,
        decisionOnly: connection.decisionOnly,
      });
      if (choice) models.push(choice);
    }
  }
  return [...new Map(models.map(model => [model.key, model])).values()];
}

async function requireModels(res) {
  try {
    const status = await backend('/api/status');
    return { status, models: availableModels(status) };
  } catch (error) {
    json(res, error.status || 503, { error: error.message || 'Loopline 서버에 연결할 수 없습니다.' });
    return null;
  }
}

function rateLimit(login, action, intervalMs) {
  const key = `${login}:${action}`;
  const now = Date.now();
  const previous = writeLimits.get(key) || 0;
  if (now - previous < intervalMs) return false;
  writeLimits.set(key, now);
  return true;
}

function publicRun(run) {
  return {
    id: run.id,
    status: run.status,
    stage: run.stage,
    round: run.round,
    rounds: run.rounds,
    autoRounds: run.autoRounds === true,
    task: stringValue(run.task, 30_000),
    summary: remoteText(run.summary, 8_000),
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    canResume: run.canResume === true,
    stageModels: Object.fromEntries(['planner', 'worker', 'judge'].map(role => {
      const model = run.stageModels?.[role];
      return [role, model ? {
        role,
        provider: stringValue(model.provider, 40),
        label: stringValue(model.label, 160),
        id: stringValue(model.id, 160),
        effort: stringValue(model.effort || model.reasoningEffort, 24),
      } : null];
    }).filter(([, model]) => model)),
    events: (Array.isArray(run.events) ? run.events : []).slice(-50).map(event => ({
      id: event.id,
      title: stringValue(event.title, 160),
      detail: remoteText(event.detail, 1_500),
      status: event.status,
      model: event.model ? {
        provider: stringValue(event.model.provider, 40),
        label: stringValue(event.model.label, 160),
        model: stringValue(event.model.id || event.model.model, 160),
      } : undefined,
      createdAt: event.timestamp || event.createdAt,
    })),
  };
}

async function sendStatic(res, pathname, mode) {
  if (pathname === '/' || pathname === '/index.html') {
    let html = await readFile(join(staticRoot, 'index.html'), 'utf8');
    html = html.replace('__APP_MODE__', mode).replace('__APP_BASE__', mode === 'remote' ? servePath : '/');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    });
    res.end(html);
    return;
  }
  const file = remoteFiles.get(pathname);
  if (!file) return json(res, 404, { error: '페이지를 찾을 수 없습니다.' });
  const body = await readFile(join(staticRoot, file[0]));
  res.writeHead(200, {
    'Content-Type': file[1],
    'Cache-Control': pathname.startsWith('/icon-') ? 'public, max-age=3600' : 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

function remotePathname(req) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return null;
  }
  if (pathname.replace(/\/$/, '') === servePathKey) return '/';
  if (pathname.startsWith(servePath)) return pathname.slice(servePathKey.length) || '/';
  // Serve mount points may forward either the full mount path or the path relative to it.
  if (req.headers['tailscale-user-login'] && (pathname === '/' || remoteFiles.has(pathname) || pathname.startsWith('/remote-api/'))) return pathname;
  return null;
}

function localPathname(req) {
  try {
    return decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return null;
  }
}

async function serveState(res, includeModels) {
  const tailscale = await getTailscaleState();
  let models = [];
  let backendConnected = false;
  if (includeModels) {
    try {
      const status = await backend('/api/status');
      models = availableModels(status);
      backendConnected = true;
    } catch {
      backendConnected = false;
    }
  } else {
    try {
      backendConnected = await probeBackend();
    } catch {
      backendConnected = false;
    }
  }
  json(res, 200, {
    tailscale: {
      installed: tailscale.installed,
      online: tailscale.online,
      login: tailscale.login,
      url: tailscale.url,
      serveEnabled: tailscale.serveEnabled,
      routeConflict: tailscale.routeConflict,
      command: tailscale.command,
      ...(includeModels ? {} : { localSetup: true }),
    },
    backendConnected,
    models,
  });
}

async function relayChat(req, res, context) {
  if (!rateLimit(context.login, 'chat', 1_500)) return json(res, 429, { error: '요청을 잠시 쉬었다 다시 보내세요.' });
  const input = await readJson(req);
  if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 30) throw Object.assign(new Error('대화 문맥을 확인해 주세요.'), { status: 400 });
  const total = input.messages.reduce((sum, message) => sum + (typeof message?.content === 'string' ? message.content.length : 0), 0);
  if (total > 120_000) throw Object.assign(new Error('대화 문맥이 너무 깁니다.'), { status: 413 });
  for (const message of input.messages) {
    if (!['user', 'assistant'].includes(message?.role) || typeof message.content !== 'string' || message.content.length > 40_000) {
      throw Object.assign(new Error('메시지 형식이 올바르지 않습니다.'), { status: 400 });
    }
  }
  const resolved = await requireModels(res);
  if (!resolved) return;
  const model = resolved.models.find(item => item.key === input.modelKey);
  if (!model) return json(res, 400, { error: '사용할 모델을 새로 선택해 주세요.' });
  const payload = {
    provider: model.provider,
    model: model.id,
    ...(model.connectionId ? { connectionId: model.connectionId } : {}),
    ...(model.provider === 'openai' ? { codexAccountId: model.accountId || 'default' } : {}),
    messages: input.messages.map(message => ({ role: message.role, content: message.content })),
  };
  const controller = new AbortController();
  req.on('aborted', () => controller.abort());
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  const upstream = await fetch(`${backendBase}/api/chat`, {
    method: 'POST',
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'X-Content-Type-Options': 'nosniff',
    ...(upstream.ok ? { 'X-Accel-Buffering': 'no', Connection: 'keep-alive' } : {}),
  });
  if (!upstream.body) return res.end();
  try {
    for await (const chunk of upstream.body) {
      if (res.destroyed || res.writableEnded) break;
      if (!res.write(Buffer.from(chunk))) await new Promise(resolve => res.once('drain', resolve));
    }
  } catch (error) {
    if (!res.destroyed && !res.writableEnded) {
      const message = JSON.stringify({ error: error.message || '응답 연결이 끊겼습니다.' });
      res.write(`event: error\ndata: ${message}\n\n`);
    }
  }
  if (!res.writableEnded) res.end();
}

function roleSelection(model) {
  const effort = model.supportedReasoningEfforts.includes('high') ? 'high'
    : model.supportedReasoningEfforts.includes('medium') ? 'medium' : '';
  return {
    provider: model.provider,
    model: model.id,
    label: model.label,
    supportedReasoningEfforts: model.supportedReasoningEfforts,
    ...(model.connectionId ? { connectionId: model.connectionId } : {}),
    ...(model.provider === 'openai' ? { codexAccountId: model.accountId || 'default' } : {}),
    ...(model.decisionOnly ? { decisionOnly: true } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
    loopMcp: false,
    nativePlugins: [],
    automatic: false,
  };
}

async function createRemoteRun(req, res, context) {
  if (!rateLimit(context.login, 'run', 10_000)) return json(res, 429, { error: '새 Loop 실행 전 잠시 기다려 주세요.' });
  const conflict = await activeRunConflict(context.login);
  if (conflict) return json(res, conflict.status, { error: conflict.message, ...(conflict.run ? { run: conflict.run } : {}) });
  const input = await readJson(req);
  const task = stringValue(input.task, 30_000);
  if (!task) return json(res, 400, { error: '작업 요청을 입력해 주세요.' });
  if (typeof input.roles !== 'object' || !input.roles) return json(res, 400, { error: '계획·구현·판정 모델을 선택해 주세요.' });
  const resolved = await requireModels(res);
  if (!resolved) return;
  const selected = {};
  for (const role of ['planner', 'worker', 'judge']) {
    const model = resolved.models.find(item => item.key === input.roles[role]);
    if (!model) return json(res, 400, `${role} 역할의 모델을 다시 선택해 주세요.`);
    if (role !== 'judge' && model.decisionOnly) return json(res, 400, '판정 전용 모델은 판정 역할에만 사용할 수 있습니다.');
    selected[role] = roleSelection(model);
  }
  const rounds = input.rounds === 0 ? 0 : Number(input.rounds);
  if (!Number.isInteger(rounds) || rounds < 0 || rounds > 10) return json(res, 400, '회차는 자동 또는 1~10 사이에서 선택해 주세요.');
  const run = await backend('/api/harness/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      task,
      roles: selected,
      rounds,
      autoApply: true,
      mcpTools: [],
      // Remote work starts in a new managed project; it cannot target an arbitrary Mac folder.
    }),
  });
  activeRemoteRunId = run.id;
  activeRemoteRunOwner = context.login;
  try {
    await saveActiveRunLock(run.id, context.login);
  } catch {
    await backend(`/api/harness/runs/${run.id}/stop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).catch(() => {});
    await clearActiveRunLock();
    return json(res, 503, { error: '원격 실행 상태를 안전하게 저장하지 못해 작업을 중지했습니다. 다시 시도해 주세요.' });
  }
  json(res, 202, publicRun(run));
}

async function handleRemote(req, res) {
  const path = remotePathname(req);
  if (path === null) return json(res, 404, { error: '페이지를 찾을 수 없습니다.' });
  const context = await authorizedTailscaleRequest(req);
  if (!context) return json(res, 403, { error: '이 Tailnet 계정에는 원격 접근 권한이 없습니다.' });

  if (req.method === 'GET' && (path === '/' || path === '/index.html')) return sendStatic(res, path, 'remote');
  if (req.method === 'GET' && !path.startsWith('/remote-api/')) return sendStatic(res, path, 'remote');
  if (req.method === 'GET' && path === '/remote-api/status') return serveState(res, true);
  if (req.method === 'POST' && path === '/remote-api/chat') return relayChat(req, res, context);
  if (req.method === 'POST' && path === '/remote-api/runs') return createRemoteRun(req, res, context);

  const runMatch = path.match(/^\/remote-api\/runs\/([a-f0-9-]{36})(?:\/(stop|resume))?$/i);
  if (runMatch && req.method === 'GET' && !runMatch[2]) {
    await requireRemoteRunOwner(context.login, runMatch[1]);
    const run = await backend(`/api/harness/runs/${runMatch[1]}`);
    return json(res, 200, publicRun(run));
  }
  if (runMatch && req.method === 'POST' && runMatch[2] === 'stop') {
    await requireRemoteRunOwner(context.login, runMatch[1]);
    const run = await backend(`/api/harness/runs/${runMatch[1]}/stop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    return json(res, 200, publicRun(run));
  }
  if (runMatch && req.method === 'POST' && runMatch[2] === 'resume') {
    await requireRemoteRunOwner(context.login, runMatch[1]);
    const conflict = await activeRunConflict(context.login, runMatch[1]);
    if (conflict) return json(res, conflict.status, { error: conflict.message });
    if (activeRemoteRunId === runMatch[1] && activeRemoteRunOwner && activeRemoteRunOwner !== context.login) return json(res, 403, { error: '이 원격 실행은 다른 Tailnet 사용자가 시작했습니다.' });
    const current = await backend(`/api/harness/runs/${runMatch[1]}`);
    if (current.canResume !== true) return json(res, 409, { error: '이 실행은 안전하게 이어갈 수 없습니다.' });
    const run = await backend(`/api/harness/runs/${runMatch[1]}/resume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    activeRemoteRunId = run.id;
    activeRemoteRunOwner = context.login;
    try {
      await saveActiveRunLock(run.id, context.login);
    } catch {
      await backend(`/api/harness/runs/${run.id}/stop`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      }).catch(() => {});
      await clearActiveRunLock();
      return json(res, 503, { error: '이어하기 상태를 안전하게 저장하지 못해 작업을 중지했습니다. 다시 시도해 주세요.' });
    }
    return json(res, 202, publicRun(run));
  }
  return json(res, 404, { error: '요청을 찾을 수 없습니다.' });
}

async function enableServe(res) {
  const state = await getTailscaleState(true);
  if (!state.installed) return json(res, 503, { error: 'Mac에 Tailscale CLI가 설치되어 있지 않습니다.' });
  if (!state.online || !state.dnsName) return json(res, 409, { error: '먼저 Mac의 Tailscale을 연결해 주세요.' });
  const { stdout } = await runTailscale(['serve', 'status', '--json']);
  const serveStatus = JSON.parse(stdout || '{}');
  const existing = findRemoteHandler(serveStatus, state.dnsName);
  if (existing?.target.includes(`:${remotePort}`)) return serveState(res, false);
  if (existing) return json(res, 409, { error: '기존 /loopline Serve 경로가 다른 서비스에 사용 중입니다. 기존 설정을 변경하지 않았습니다.' });
  await runTailscale(['serve', `--set-path=${servePath}`, '--bg', String(remotePort)]);
  tailscaleCacheAt = 0;
  const after = await getTailscaleState(true);
  if (!after.serveEnabled) return json(res, 502, { error: 'Tailscale Serve 경로가 확인되지 않습니다. 기존 Serve 설정은 유지했습니다.' });
  return serveState(res, false);
}

async function disableServe(res) {
  const state = await getTailscaleState(true);
  if (!state.installed) return json(res, 503, { error: 'Mac에 Tailscale CLI가 설치되어 있지 않습니다.' });
  const { stdout } = await runTailscale(['serve', 'status', '--json']);
  const serveStatus = JSON.parse(stdout || '{}');
  const existing = findRemoteHandler(serveStatus, state.dnsName);
  if (!existing) return serveState(res, false);
  if (!existing.target.includes(`:${remotePort}`)) return json(res, 409, { error: '현재 /loopline 경로가 이 게이트웨이를 가리키지 않습니다. 다른 Serve 설정은 변경하지 않았습니다.' });
  await runTailscale(['serve', `--set-path=${servePath}`, String(remotePort), 'off']);
  tailscaleCacheAt = 0;
  const after = await getTailscaleState(true);
  if (after.serveEnabled) return json(res, 502, { error: '원격 경로를 끄지 못했습니다.' });
  return serveState(res, false);
}

async function handleLocalAdmin(req, res) {
  if (!loopback(req.socket.remoteAddress) || !localOriginAllowed(req)) return json(res, 403, { error: '이 Mac에서만 설정할 수 있습니다.' });
  const path = localPathname(req);
  if (!path) return json(res, 400, { error: '요청 경로가 올바르지 않습니다.' });
  if (req.method === 'GET' && (path === '/' || path === '/index.html')) return sendStatic(res, path, 'admin');
  if (req.method === 'GET' && path === '/local-api/status') return serveState(res, false);
  if (req.method === 'POST' && path === '/local-api/serve/enable') {
    await readJson(req);
    return enableServe(res);
  }
  if (req.method === 'POST' && path === '/local-api/serve/disable') {
    await readJson(req);
    return disableServe(res);
  }
  if (req.method === 'GET') return sendStatic(res, path, 'admin');
  return json(res, 404, { error: '요청을 찾을 수 없습니다.' });
}

function routeError(res, error) {
  if (res.headersSent) {
    if (!res.destroyed && !res.writableEnded) res.end();
    return;
  }
  json(res, error.status || 500, { error: error.status ? error.message : '원격 요청을 처리하지 못했습니다.' });
}

const remoteServer = createServer((req, res) => {
  void handleRemote(req, res).catch(error => routeError(res, error));
});
const adminServer = createServer((req, res) => {
  void handleLocalAdmin(req, res).catch(error => routeError(res, error));
});

remoteServer.listen(remotePort, remoteHost, () => {
  console.log(`LOOPLINE_REMOTE_GATEWAY=http://${remoteHost}:${remotePort}${servePath}`);
});
adminServer.listen(adminPort, remoteHost, async () => {
  const state = await getTailscaleState(true);
  console.log(`LOOPLINE_REMOTE_SETUP=http://${remoteHost}:${adminPort}/`);
  console.log(`LOOPLINE_TAILSCALE=${state.online ? 'online' : state.installed ? 'offline' : 'missing'}`);
  console.log(state.serveEnabled ? `LOOPLINE_PHONE_URL=${state.url}` : `LOOPLINE_SERVE_ENABLE=${state.command}`);
  console.log(`Loopline 원격 게이트웨이는 localhost에만 바인딩됩니다. 기존 API 서버 ${backendBase}가 실행 중이어야 합니다.`);
});

function shutdown() {
  remoteServer.close();
  adminServer.close();
  remoteServer.closeAllConnections();
  adminServer.closeAllConnections();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

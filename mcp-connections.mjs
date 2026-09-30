import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

const fail = (message, status = 400, code = '') => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
const MAX_SERVERS = 32;
const MAX_TOOLS = 128;
const MAX_LOOP_TOOLS = 64;
const MAX_LOOP_TOOL_DEFINITIONS = 96_000;
const MAX_TOOL_SCHEMA = 8_000;
const MAX_TOOL_OUTPUT = 24_000;
const MAX_CALLS = 8;
const FIGMA_DESKTOP_MCP_URL = 'http://127.0.0.1:3845/mcp';

async function findExecutable(command, searchPath = process.env.PATH || '') {
  if (isAbsolute(command)) {
    try { await access(command, constants.X_OK); return command; } catch { return ''; }
  }
  for (const directory of searchPath.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command);
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  return '';
}

async function findPaperExecutable(searchPath = process.env.PATH || '') {
  const onPath = await findExecutable('paper', searchPath);
  if (onPath) return onPath;
  if (process.platform !== 'darwin') return '';
  const appBinary = join('Contents', 'Resources', 'app.asar.unpacked', 'dist', 'cli-bin', `darwin-${process.arch}`, 'paper');
  for (const root of [join(homedir(), 'Applications'), '/Applications']) {
    const candidate = await findExecutable(join(root, 'Paper.app', appBinary), '');
    if (candidate) return candidate;
  }
  return '';
}

function desktopSecrets() {
  if (process.env.MOSAIC_DESKTOP !== '1' || !process.parentPort) return null;
  const pending = new Map();
  process.parentPort.on('message', ({ data }) => {
    if (data?.scope !== 'mosaic-secrets' || !pending.has(data.id)) return;
    const request = pending.get(data.id);
    pending.delete(data.id);
    clearTimeout(request.timer);
    if (data.error) request.reject(fail('macOS 보안 저장소에 접근하지 못했습니다. 앱을 다시 열거나 키체인 접근을 허용해 주세요.', 503));
    else request.resolve(data.value);
  });
  return (action, value) => new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(fail('macOS 보안 저장소의 응답 시간이 초과되었습니다.', 503));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
    process.parentPort.postMessage({ scope: 'mosaic-secrets', id, action, value });
  });
}

function normalizeServer(input) {
  if (!input || !['stdio', 'http'].includes(input.transport)) throw fail('MCP 연결 방식을 선택해 주세요.');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 80 || /[\x00-\x1f]/.test(name)) throw fail('연결 이름은 1~80자로 입력해 주세요.');
  if (input.transport === 'stdio') {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (!command || command.length > 512 || /[\x00-\x1f]/.test(command)) throw fail('MCP 서버 실행 명령을 입력해 주세요.');
    const args = input.args == null ? [] : input.args;
    if (!Array.isArray(args) || args.length > 40 || args.some((arg) => typeof arg !== 'string' || arg.length > 1024 || /\0/.test(arg))) throw fail('MCP 실행 인자는 최대 40개까지 지정할 수 있습니다.');
    const cwd = input.cwd == null || input.cwd === '' ? '' : input.cwd;
    if (typeof cwd !== 'string' || cwd.length > 2000 || (cwd && !isAbsolute(cwd))) throw fail('작업 폴더는 전체 경로로 입력해 주세요.');
    return { name, transport: 'stdio', command, cwd, autoRun: input.autoRun === true, secrets: { args, env: normalizeEnv(input.env) } };
  }
  let url;
  if (typeof input.url !== 'string' || input.url.length > 2000) throw fail('MCP 서버 주소는 2,000자 이내로 입력해 주세요.');
  try { url = new URL(input.url); } catch { throw fail('MCP 서버 주소를 확인해 주세요.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw fail('원격 MCP 연결에는 HTTPS를 사용해 주세요.');
  if (url.username || url.password || url.search || url.hash) throw fail('MCP 주소에 로그인 정보, 쿼리 또는 #을 포함할 수 없습니다.');
  const token = input.token == null ? '' : input.token;
  if (typeof token !== 'string' || token.length > 8192 || /[\r\n\0]/.test(token)) throw fail('Bearer 토큰을 확인해 주세요.');
  return { name, transport: 'http', url: url.href, autoRun: input.autoRun === true, secrets: { token: token.trim() } };
}

function normalizeEnv(value) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('환경 변수 형식이 올바르지 않습니다.');
  const entries = Object.entries(value);
  if (entries.length > 32 || entries.reduce((total, [key, item]) => total + key.length + String(item).length, 0) > 16_000
    || entries.some(([key, item]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      || typeof item !== 'string' || item.length > 8192 || /\0/.test(item))) throw fail('환경 변수는 올바른 이름과 8,192자 이내 값으로 최대 32개까지 입력해 주세요.');
  return Object.fromEntries(entries);
}

function safeTool(tool, server) {
  if (!tool || typeof tool.name !== 'string' || !tool.name || tool.name.length > 160) return null;
  let schema = tool.inputSchema;
  try {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema) || JSON.stringify(schema).length > MAX_TOOL_SCHEMA) schema = { type: 'object', properties: {} };
  } catch { schema = { type: 'object', properties: {} }; }
  return {
    serverId: server.id,
    serverName: server.name,
    name: tool.name,
    description: typeof tool.description === 'string' ? tool.description.slice(0, 4000) : '',
    inputSchema: schema,
    annotations: tool.annotations && typeof tool.annotations === 'object' && !Array.isArray(tool.annotations)
      ? Object.fromEntries(['readOnlyHint', 'destructiveHint', 'idempotentHint']
        .filter((key) => typeof tool.annotations[key] === 'boolean')
        .map((key) => [key, tool.annotations[key]]))
      : {},
  };
}

function connectionError(server, error) {
  const message = String(error?.message || 'MCP 서버에 연결하지 못했습니다.');
  if (server.preset === 'figma-desktop' && /ECONNREFUSED|fetch failed|timed out|timeout|\b(401|403|404)\b/i.test(message)) {
    return 'Figma Desktop MCP 서버에 연결할 수 없습니다. Figma에서 디자인 파일을 열고 Dev Mode의 MCP 패널에서 Desktop MCP server를 켠 뒤 다시 연결해 주세요.';
  }
  if (server.preset === 'paper-desktop' && /ENOENT|EACCES|not found|permission denied/i.test(message)) {
    return 'Paper CLI를 실행하지 못했습니다. Paper Desktop을 열고 MCP 패널에서 실행 파일 경로를 다시 선택해 주세요.';
  }
  return message.slice(0, 500);
}

export class McpConnections {
  #directory;
  #file;
  #servers = [];
  #configs = new Map();
  #active = new Map();
  #connecting = new Map();
  #inUse = new Map();
  #writes = Promise.resolve();
  #ready;
  #secrets = desktopSecrets();
  #runtime;
  #figmaDesktopUrl;
  #searchPath;
  #closing = false;

  constructor(directory, { runtime, figmaDesktopUrl = FIGMA_DESKTOP_MCP_URL, searchPath } = {}) {
    this.#directory = directory;
    this.#file = join(directory, 'mcp-connections.json');
    this.#runtime = runtime;
    this.#figmaDesktopUrl = figmaDesktopUrl;
    this.#searchPath = searchPath;
    this.#ready = this.#load();
    this.#ready.catch(() => {});
  }

  async #load() {
    try {
      const data = JSON.parse(await readFile(this.#file, 'utf8'));
      if (!Array.isArray(data.connections)) throw new Error('Invalid MCP connections');
      this.#servers = data.connections.slice(0, MAX_SERVERS).filter((item) => item && typeof item.id === 'string');
    } catch (error) {
      if (error.code !== 'ENOENT') throw fail('MCP 연결 설정을 읽지 못했습니다. 기존 설정 파일을 확인해 주세요.', 500);
    }
  }

  #mutate(callback) {
    const operation = this.#writes.then(async () => { await this.#ready; return callback(); });
    this.#writes = operation.catch(() => {});
    return operation;
  }

  async #save(servers) {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, connections: servers }, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.#file);
      this.#servers = servers;
    } finally { await rm(temporary, { force: true }); }
  }

  async #runtimeConfig(server) {
    if (this.#configs.has(server.id)) return this.#configs.get(server.id);
    if (!this.#secrets || !server.encryptedConfig) throw fail('저장된 MCP 비밀 정보가 없습니다. 연결을 편집하고 값을 다시 입력해 주세요.', 409);
    let config;
    try { config = JSON.parse(await this.#secrets('decrypt', server.encryptedConfig)); }
    catch (error) { throw error.status ? error : fail('저장된 MCP 비밀 정보를 복호화하지 못했습니다.', 503); }
    this.#configs.set(server.id, config);
    return config;
  }

  async #runtimeSdk() {
    if (this.#runtime) return this.#runtime;
    try { this.#runtime = await import(new URL('./mcp-runtime.bundle.mjs', import.meta.url)); }
    catch { this.#runtime = await import('@modelcontextprotocol/client'); }
    return this.#runtime;
  }

  #find(id) {
    const server = this.#servers.find((item) => item.id === id);
    if (!server) throw fail('MCP 연결을 찾을 수 없습니다.', 404);
    return server;
  }

  #public(server) {
    const active = this.#active.get(server.id);
    return {
      id: server.id,
      name: server.name,
      transport: server.transport,
      preset: server.preset || '',
      autoRun: server.autoRun === true,
      connecting: this.#connecting.has(server.id),
      ...(server.transport === 'stdio' ? { command: server.command, cwd: server.cwd || '' } : { url: server.url }),
      connected: Boolean(active),
      needsConfiguration: !this.#configs.has(server.id) && (!this.#secrets || !server.encryptedConfig),
      ...(active ? { tools: active.tools } : { tools: [] }),
      error: server.lastError || '',
    };
  }

  async list() {
    await this.#ready;
    return { servers: this.#servers.map((server) => this.#public(server)), keyStorage: this.#secrets ? 'keychain' : 'session' };
  }

  async save(input, id = '') {
    return this.#mutate(async () => {
      const normalized = normalizeServer(input);
      const current = id ? this.#find(id) : null;
      if (current) this.#assertIdle(id);
      if (!current && this.#servers.length >= MAX_SERVERS) throw fail(`MCP 연결은 최대 ${MAX_SERVERS}개까지 등록할 수 있습니다.`, 409);
      if (current) await this.#close(current.id);
      const nextId = current?.id || randomUUID();
      let secrets = normalized.secrets;
      if (current && current.transport === normalized.transport) {
        let previous;
        try { previous = await this.#runtimeConfig(current); } catch { previous = null; }
        if (previous?.transport === 'stdio' && normalized.transport === 'stdio') {
          secrets = {
            args: secrets.args.length ? secrets.args : previous.secrets.args || [],
            env: Object.keys(secrets.env).length ? secrets.env : previous.secrets.env || {},
          };
        } else if (previous?.transport === 'http' && normalized.transport === 'http' && !secrets.token) {
          secrets = { token: previous.secrets.token || '' };
        }
      }
      const config = { transport: normalized.transport, secrets };
      const serializedConfig = JSON.stringify(config);
      if (Buffer.byteLength(serializedConfig) > 44_000) throw fail('MCP 인자와 비밀 설정을 합쳐 44KB 이하로 입력해 주세요.');
      let encryptedConfig = null;
      if (this.#secrets) encryptedConfig = await this.#secrets('encrypt', serializedConfig);
      const server = {
        id: nextId,
        name: normalized.name,
        transport: normalized.transport,
        preset: ['paper-desktop', 'figma-desktop'].includes(input.preset) ? input.preset : (current?.preset || ''),
        autoRun: normalized.autoRun || Boolean(current && input.autoRun !== false && current.autoRun === true),
        ...(normalized.transport === 'stdio' ? { command: normalized.command, cwd: normalized.cwd } : { url: normalized.url }),
        encryptedConfig,
        updatedAt: Date.now(),
      };
      this.#configs.set(nextId, config);
      const servers = current ? this.#servers.map((item) => item.id === nextId ? server : item) : [...this.#servers, server];
      await this.#save(servers);
      return this.#public(server);
    });
  }

  async connect(id) {
    await this.#ready;
    if (this.#closing) throw fail('MCP 연결 관리자가 종료 중입니다.', 503);
    if (this.#connecting.has(id)) return this.#connecting.get(id);
    const operation = this.#connect(id);
    this.#connecting.set(id, operation);
    try { return await operation; }
    finally { if (this.#connecting.get(id) === operation) this.#connecting.delete(id); }
  }

  async #connect(id) {
    await this.#ready;
    const server = this.#find(id);
    await this.#close(id);
    let transport;
    let client;
    try {
      const config = await this.#runtimeConfig(server);
      const sdk = await this.#runtimeSdk();
      if (server.transport === 'stdio') {
        const { StdioClientTransport } = await import(new URL('./mcp-runtime.bundle.mjs', import.meta.url)).catch(() => import('@modelcontextprotocol/client/stdio'));
        const env = config.secrets.env || {};
        transport = new StdioClientTransport({
          command: server.command,
          args: config.secrets.args || [],
          ...(server.cwd ? { cwd: server.cwd } : {}),
          env: { ...env },
          stderr: 'pipe',
          maxBufferSize: 1_000_000,
        });
        transport.stderr?.on('data', () => {});
      } else {
        transport = new sdk.StreamableHTTPClientTransport(new URL(server.url), config.secrets.token ? {
          authProvider: { token: async () => config.secrets.token },
        } : {});
      }
      client = new sdk.Client({ name: 'loopline', version: '0.1.0' });
      await client.connect(transport, { timeout: 15_000 });
      const result = await client.listTools(undefined, { timeout: 15_000, cacheMode: 'refresh' });
      if (!Array.isArray(result.tools) || result.tools.length > MAX_TOOLS) throw fail(`MCP 서버는 도구를 ${MAX_TOOLS}개 이하로 제공해야 합니다.`);
      const tools = result.tools.map((tool) => safeTool(tool, server)).filter(Boolean);
      if (this.#closing) throw fail('MCP 연결 관리자가 종료 중입니다.', 503);
      this.#active.set(id, { client, transport, tools });
      transport.onclose = () => {
        if (this.#active.get(id)?.transport !== transport) return;
        this.#active.delete(id);
        server.lastError = 'MCP 연결이 끊겼습니다. 연결을 다시 시도해 주세요.';
        void this.#persistMetadata().catch(() => {});
      };
      server.lastError = '';
      await this.#persistMetadata();
      return this.#public(server);
    } catch (error) {
      if (client) await client.close().catch(() => {});
      else await transport?.close?.().catch(() => {});
      server.lastError = connectionError(server, error);
      await this.#persistMetadata().catch(() => {});
      const code = server.preset === 'paper-desktop' && ['ENOENT', 'EACCES'].includes(error?.code) ? 'PAPER_CLI_REQUIRED' : error?.code || '';
      throw fail(`MCP 연결 실패: ${server.lastError}`, 502, code);
    }
  }

  async #persistMetadata() {
    await this.#save(this.#servers);
  }

  async quickConnect(kind, { command = '' } = {}) {
    await this.#ready;
    if (!['paper-desktop', 'figma-desktop'].includes(kind)) throw fail('지원하지 않는 빠른 연결입니다.');
    let input;
    if (kind === 'figma-desktop') {
      input = { name: 'Figma Desktop', transport: 'http', url: this.#figmaDesktopUrl, autoRun: true, preset: kind };
    } else {
      const savedPaper = this.#servers.find((server) => server.preset === kind);
      const executable = typeof command === 'string' && command.trim()
        ? await findExecutable(command.trim(), this.#searchPath)
        : savedPaper?.command && await findExecutable(savedPaper.command, this.#searchPath)
          || await findPaperExecutable(this.#searchPath);
      if (!executable) throw fail('Paper CLI를 찾지 못했습니다. Paper Desktop의 MCP 패널에서 CLI 경로를 선택해 주세요.', 409, 'PAPER_CLI_REQUIRED');
      input = { name: 'Paper Desktop', transport: 'stdio', command: executable, args: ['mcp'], autoRun: true, preset: kind };
    }
    let existing = this.#servers.find((server) => server.preset === kind)
      || (kind === 'figma-desktop' && this.#servers.find((server) => server.transport === 'http' && server.url === input.url));
    if (!existing && kind === 'paper-desktop') {
      for (const server of this.#servers) {
        if (server.transport !== 'stdio' || server.command !== input.command || server.name !== input.name) continue;
        const config = await this.#runtimeConfig(server).catch(() => null);
        if (config?.secrets?.args?.includes('mcp')) { existing = server; break; }
      }
    }
    const saved = await this.save(input, existing?.id || '');
    return this.connect(saved.id);
  }

  async setAutoRun(id, enabled) {
    if (typeof enabled !== 'boolean') throw fail('Loop 자동 사용 설정이 올바르지 않습니다.');
    const server = await this.#mutate(async () => {
      const server = this.#find(id);
      this.#assertIdle(id);
      server.autoRun = enabled;
      await this.#persistMetadata();
      return this.#public(server);
    });
    if (!enabled || server.connected) return server;
    try { return await this.connect(id); }
    catch { return this.#public(this.#find(id)); }
  }

  async connectOnStartup() {
    await this.#ready;
    const results = [];
    for (const server of this.#servers.filter((item) => item.autoRun === true)) {
      if (this.#closing) break;
      let connected = false;
      for (let attempt = 0; attempt < 3 && !connected && !this.#closing; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
        try { await this.connect(server.id); connected = true; }
        catch { /* Keep the last connection error visible and retry on the next app launch. */ }
      }
      results.push({ id: server.id, connected });
    }
    return results;
  }

  async delete(id) {
    return this.#mutate(async () => {
      this.#find(id);
      this.#assertIdle(id);
      await this.#close(id);
      this.#configs.delete(id);
      await this.#save(this.#servers.filter((server) => server.id !== id));
      return { deleted: true };
    });
  }

  async disconnect(id) {
    await this.#ready;
    const server = this.#find(id);
    this.#assertIdle(id);
    await this.#close(id);
    return this.#public(server);
  }

  #assertIdle(id) {
    if ((this.#inUse.get(id) || 0) > 0) throw fail('Loop에서 MCP 도구를 실행 중입니다. 단계가 끝난 뒤 연결을 변경해 주세요.', 409);
    if (this.#connecting.has(id)) throw fail('MCP 서버에 연결 중입니다. 연결이 끝난 뒤 다시 시도해 주세요.', 409);
  }

  async #close(id) {
    const active = this.#active.get(id);
    if (!active) return;
    this.#active.delete(id);
    await active.client.close().catch(() => {});
    await active.transport.close().catch(() => {});
  }

  async close() {
    this.#closing = true;
    await Promise.allSettled([...this.#connecting.values()]);
    await Promise.all([...this.#active.keys()].map((id) => this.#close(id)));
  }

  async selectedTools(selection) {
    await this.#ready;
    if (selection == null) return [];
    if (!Array.isArray(selection) || selection.length > MAX_LOOP_TOOLS) throw fail(`Loop에서 사용할 MCP 도구는 최대 ${MAX_LOOP_TOOLS}개까지 선택할 수 있습니다.`);
    const chosen = [];
    const seen = new Set();
    for (const item of selection) {
      if (!item || typeof item.serverId !== 'string' || typeof item.name !== 'string') throw fail('Loop MCP 도구 선택이 올바르지 않습니다.');
      const key = `${item.serverId}\0${item.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const active = this.#active.get(item.serverId);
      const tool = active?.tools.find((candidate) => candidate.name === item.name);
      if (!tool) throw fail(`선택한 MCP 도구가 연결되지 않았습니다: ${item.name}`, 409);
      chosen.push(tool);
    }
    if (JSON.stringify(chosen).length > MAX_LOOP_TOOL_DEFINITIONS) throw fail('선택한 MCP 도구의 설명과 입력 규격이 너무 큽니다. Loop 설정에서 자동 사용 연결을 줄여 주세요.');
    return chosen;
  }

  async toolsForLoop(selection = []) {
    const autoServers = this.#servers.filter((server) => server.autoRun === true);
    for (const server of autoServers) if (!this.#active.has(server.id)) await this.connect(server.id);
    const explicit = await this.selectedTools(selection);
    const automatic = [];
    for (const server of this.#servers) {
      if (server.autoRun !== true) continue;
      const active = this.#active.get(server.id);
      if (active) automatic.push(...active.tools);
    }
    const chosen = [...new Map([...automatic, ...explicit].map((tool) => [`${tool.serverId}\0${tool.name}`, tool])).values()];
    if (chosen.length > MAX_LOOP_TOOLS) throw fail(`자동 사용 도구가 ${MAX_LOOP_TOOLS}개를 넘었습니다. MCP 연결 설정에서 자동 사용 연결을 줄여 주세요.`, 409);
    if (JSON.stringify(chosen).length > MAX_LOOP_TOOL_DEFINITIONS) throw fail('자동 사용 MCP 도구의 입력 규격이 너무 큽니다. 연결별 자동 사용을 조정해 주세요.', 409);
    return chosen;
  }

  async callTool(serverId, name, args, signal) {
    const active = this.#active.get(serverId);
    if (!active) throw fail('MCP 서버 연결이 끊겼습니다. 연결을 확인해 주세요.', 409);
    if (!active.tools.some((tool) => tool.name === name)) throw fail('연결에서 제공하지 않는 MCP 도구입니다.', 403);
    if (!args || typeof args !== 'object' || Array.isArray(args) || JSON.stringify(args).length > 16_000) throw fail('MCP 도구 입력은 16KB 이하의 JSON 객체여야 합니다.');
    if (signal?.aborted) throw signal.reason || new Error('실행을 중지했습니다.');
    this.#inUse.set(serverId, (this.#inUse.get(serverId) || 0) + 1);
    try {
      const result = await active.client.callTool({ name, arguments: args }, { signal });
      let output = '';
      try { output = JSON.stringify(result); } catch { output = String(result); }
      if (output.length > MAX_TOOL_OUTPUT) output = `${output.slice(0, MAX_TOOL_OUTPUT)}\n…[응답 생략: 최대 크기 ${MAX_TOOL_OUTPUT}자]`;
      return { output, isError: result?.isError === true };
    } finally {
      const count = (this.#inUse.get(serverId) || 1) - 1;
      if (count > 0) this.#inUse.set(serverId, count); else this.#inUse.delete(serverId);
    }
  }
}

export { MAX_CALLS as MAX_MCP_CALLS };

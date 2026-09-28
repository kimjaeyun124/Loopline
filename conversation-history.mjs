import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, open, readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_IMPORT_CHARS = 1_600_000;
const MAX_DISCOVERED_FILES = 5000;
const CODEX_HEADER_BYTES = 64 * 1024;
const MAX_OLLAMA_CHATS = 5000;
const MAX_LOCAL_SESSIONS = 5000;
const AI_APP_NAME = /(chatgpt|claude|codex|gemini|ollama|cline|opencode|lm[ -]?studio|jan|anythingllm|perplexity|deepseek|msty|chatbox|copilot|llama)/i;
const SOURCE_LABELS = { app: '앱', ide: 'IDE', cli: 'CLI', unknown: '출처 불명' };
const execFileAsync = promisify(execFile);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const text = (value, length = 240) => typeof value === 'string' ? value.slice(0, length) : '';
const date = (value) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const allowed = (kind, options) => kind === 'cli' ? options.includeCli : kind === 'unknown' ? options.includeUnknown : true;

function codexSource(metadata) {
  const originator = text(metadata.originator, 120);
  if (['cli', 'exec'].includes(metadata.source) || /codex-tui/i.test(originator)) return 'cli';
  if (/desktop|mosaic_desk/i.test(originator)) return 'app';
  if (metadata.source === 'vscode' || /vscode|jetbrains/i.test(originator)) return 'ide';
  return 'unknown';
}

function codexPlainContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => ['input_text', 'output_text', 'text'].includes(part?.type) && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function codexInjectedContext(content) {
  return /^<(?:recommended_plugins|app-context|environment_context|permissions instructions|skills_instructions|multi_agent_role|multi_agent_mode|collaboration_mode|in-app-browser-context|image_resize_notice|send_user_message_question_reply)(?:\s|>)/i
    .test(content.trimStart());
}

function codexSummary(metadata, path, stat, preview, threadName = '') {
  const sourceKind = codexSource(metadata);
  const localId = createHash('sha256').update(path).digest('hex');
  const sessionId = text(metadata.session_id || metadata.id, 120);
  const recordedTitle = [threadName, metadata.title, metadata.summary].map((candidate) => text(candidate, 160).trim())
    .find((candidate) => candidate && !codexInjectedContext(candidate));
  const fallbackTitle = stat.mtimeMs
    ? `Codex 대화 · ${new Date(stat.mtimeMs).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })}`
    : 'Codex 대화';
  const title = text(recordedTitle || fallbackTitle, 160).trim();
  return {
    id: localId, provider: 'openai', accountId: 'default', sourceKind,
    sourceLabel: `Codex · ${SOURCE_LABELS[sourceKind]}`,
    sourceKey: `codex-local:${sessionId || localId}`,
    title, preview: text(preview, 240), cwd: text(metadata.cwd, 500),
    updatedAt: stat.mtimeMs || date(metadata.timestamp), model: text(metadata.model),
  };
}

async function codexSessionNames(codexHome) {
  try {
    const rows = (await readFile(join(codexHome, 'session_index.jsonl'), 'utf8')).split('\n');
    const names = new Map();
    for (const line of rows) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (typeof row.id === 'string' && typeof row.thread_name === 'string' && row.thread_name.trim()) {
          names.set(row.id, row.thread_name.trim());
        }
      } catch { /* A partial final index row should not block importing sessions. */ }
    }
    return names;
  } catch { return new Map(); }
}

function plainContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
}

function importResult(summary, messages, warnings = []) {
  if (!messages.length) throw fail('가져올 수 있는 사용자·AI 텍스트 메시지가 없습니다.');
  if (JSON.stringify(messages).length > MAX_IMPORT_CHARS) {
    throw fail('대화가 현재 앱의 저장 한도보다 큽니다. 더 짧은 대화를 선택해 주세요.', 413);
  }
  return { ...summary, messages, warnings };
}

async function directoryEntries(path) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function transcriptFiles(root, { maxDepth = 7, maxFiles = MAX_DISCOVERED_FILES, match = () => true } = {}) {
  const found = [];
  const pending = [{ path: root, depth: 0 }];
  while (pending.length && found.length < maxFiles) {
    const current = pending.pop();
    for (const entry of await directoryEntries(current.path)) {
      const path = join(current.path, entry.name);
      if (entry.isDirectory() && current.depth < maxDepth) pending.push({ path, depth: current.depth + 1 });
      else if (entry.isFile() && match(entry.name)) {
        found.push(path);
        if (found.length >= maxFiles) break;
      }
    }
  }
  return found;
}

async function codexMetadata(root, path, sessionNames = new Map()) {
  const { file, stat } = await openTranscript(root, path);
  try {
    const prefix = Buffer.alloc(Math.min(stat.size, CODEX_HEADER_BYTES));
    await file.read(prefix, 0, prefix.length, 0);
    let metadata = null;
    let preview = '';
    for (const line of prefix.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.type === 'session_meta' && row.payload && typeof row.payload === 'object') metadata = row.payload;
      if (!preview && row.type === 'response_item' && row.payload?.type === 'message' && row.payload.role === 'user') {
        const content = codexPlainContent(row.payload.content).trim();
        if (content && !codexInjectedContext(content)) preview = content;
      }
      if (metadata && preview) break;
    }
    if (!metadata) return null;
    const sessionId = text(metadata.session_id || metadata.id, 120);
    return codexSummary(metadata, path, stat, preview, sessionNames.get(sessionId));
  } finally { await file.close(); }
}

async function hasTranscript(root, match, maxDepth) {
  const files = await transcriptFiles(root, { match, maxDepth, maxFiles: 1 });
  return files.length > 0;
}

async function pathExists(path) {
  try { await access(path); return true; } catch { return false; }
}

function appPaths(name) {
  return ['/Applications', join(homedir(), 'Applications')].map((directory) => join(directory, name));
}

async function installedApp(name) {
  for (const path of appPaths(name)) if (await pathExists(path)) return path;
  return null;
}

async function installedCli(command) {
  const directories = new Set([
    ...(process.env.PATH || '').split(delimiter),
    join(homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].filter(Boolean));
  for (const directory of directories) {
    try {
      await access(join(directory, command), fsConstants.X_OK);
      return true;
    } catch { /* Continue through the known executable search paths. */ }
  }
  return false;
}

async function installedAiApps() {
  const apps = [];
  for (const directory of ['/Applications', join(homedir(), 'Applications')]) {
    for (const entry of await directoryEntries(directory)) {
      if (entry.isDirectory() && entry.name.endsWith('.app') && AI_APP_NAME.test(entry.name)) apps.push(join(directory, entry.name));
    }
  }
  return apps;
}

async function appBundleId(path) {
  if (!path) return '';
  try {
    const { stdout } = await execFileAsync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(path, 'Contents', 'Info.plist')], { timeout: 2000, maxBuffer: 4096 });
    return stdout.trim();
  } catch { return ''; }
}

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function ollamaDatabasePath() {
  if (process.platform !== 'darwin') return null;
  const root = join(homedir(), 'Library', 'Application Support', 'Ollama');
  const database = join(root, 'db.sqlite');
  if (!await pathExists(database)) return null;
  try {
    const [safeRoot, safeDatabase] = await Promise.all([realpath(root), realpath(database)]);
    const rel = relative(safeRoot, safeDatabase);
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..') return null;
    return safeDatabase;
  } catch { return null; }
}

async function opencodeDatabasePath() {
  if (process.platform !== 'darwin') return null;
  const root = join(homedir(), '.local', 'share', 'opencode');
  const database = join(root, 'opencode.db');
  if (!await pathExists(database)) return null;
  try {
    const [safeRoot, safeDatabase] = await Promise.all([realpath(root), realpath(database)]);
    const rel = relative(safeRoot, safeDatabase);
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..') return null;
    return safeDatabase;
  } catch { return null; }
}

async function readOnlySqliteQuery(database, sql) {
  const { stdout } = await execFileAsync('/usr/bin/sqlite3', ['-readonly', '-json', database, sql], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  try {
    const rows = JSON.parse(stdout || '[]');
    if (!Array.isArray(rows)) throw new Error('invalid response');
    return rows;
  } catch { throw fail('로컬 대화 DB를 읽을 수 없습니다. 해당 AI 앱을 종료한 뒤 다시 시도해 주세요.'); }
}

async function ollamaStatus() {
  const database = await ollamaDatabasePath();
  if (!database) return { installed: Boolean(await installedApp('Ollama.app')), available: false, detail: 'Ollama 로컬 대화 DB를 찾지 못했습니다.' };
  try {
    const rows = await readOnlySqliteQuery(database, "SELECT COUNT(*) AS total FROM sqlite_master WHERE type='table' AND name IN ('chats', 'messages')");
    if (Number(rows[0]?.total) !== 2) return { installed: true, available: false, detail: 'Ollama 앱은 찾았지만 지원하는 로컬 대화 형식이 아닙니다.' };
    const counts = await readOnlySqliteQuery(database, "SELECT COUNT(*) AS total FROM chats WHERE EXISTS (SELECT 1 FROM messages WHERE messages.chat_id = chats.id AND messages.role IN ('user', 'assistant'))");
    const count = Number(counts[0]?.total) || 0;
    return { installed: true, available: count > 0, detail: count ? `Ollama 로컬 대화 ${count.toLocaleString()}개를 찾았습니다.` : 'Ollama 앱은 설치되어 있지만 저장된 대화가 없습니다.' };
  } catch {
    return { installed: true, available: false, detail: 'Ollama 대화 DB를 읽을 수 없습니다. 파일 접근 권한을 확인해 주세요.' };
  }
}

async function opencodeStatus() {
  const database = await opencodeDatabasePath();
  if (!database) return { installed: Boolean(await installedApp('OpenCode.app')), available: false, detail: 'OpenCode 로컬 세션 DB를 찾지 못했습니다.' };
  try {
    const schema = await readOnlySqliteQuery(database, "SELECT COUNT(*) AS total FROM sqlite_master WHERE type='table' AND name IN ('session', 'message', 'part')");
    if (Number(schema[0]?.total) !== 3) return { installed: true, available: false, detail: 'OpenCode 앱은 찾았지만 지원하는 로컬 대화 형식이 아닙니다.' };
    const rows = await readOnlySqliteQuery(database, "SELECT COUNT(*) AS total FROM session WHERE parent_id IS NULL");
    const count = Number(rows[0]?.total) || 0;
    return {
      installed: true, available: count > 0,
      detail: count ? `OpenCode 로컬 대화 ${count.toLocaleString()}개를 찾았습니다. CLI와 데스크톱 출처를 자동으로 구분하지 못하는 기록은 ‘출처 불명 포함’을 선택해 표시합니다.` : 'OpenCode 앱은 설치되어 있지만 저장된 대화가 없습니다.',
    };
  } catch {
    return { installed: true, available: false, detail: 'OpenCode 대화 DB를 읽을 수 없습니다. 파일 접근 권한을 확인해 주세요.' };
  }
}

function ollamaSummary(row) {
  const id = createHash('sha256').update(`ollama:${row.id}`).digest('hex');
  const preview = text(row.preview, 240).trim();
  return {
    id, provider: 'ollama', accountId: 'local', sourceKind: 'app',
    sourceLabel: 'Ollama · 앱', sourceKey: `ollama-local:${text(row.id, 160)}`,
    title: text(row.title, 160).trim() || preview || '제목 없는 Ollama 대화',
    preview, updatedAt: date(row.updated_at) || date(row.created_at), model: text(row.model_name, 120),
  };
}

function geminiPlainContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => typeof part?.text === 'string').map((part) => part.text).join('\n');
}

function geminiSummary(metadata, path, stat, messages) {
  const localId = createHash('sha256').update('gemini:' + path).digest('hex');
  const firstUser = messages.find((message) => message.role === 'user');
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  const preview = text(firstUser?.content, 240).trim();
  const sessionId = text(metadata.sessionId, 160);
  const title = text(metadata.summary || metadata.title || preview, 160).trim();
  const lastTimestamp = [...messages].reverse().find((message) => message.timestamp)?.timestamp;
  return {
    id: localId, provider: 'gemini', accountId: 'local', sourceKind: 'cli',
    sourceLabel: 'Gemini CLI · CLI',
    sourceKey: 'gemini-cli:' + (sessionId || localId),
    title: title || '제목 없는 Gemini CLI 대화', preview,
    cwd: text(metadata.cwd, 500),
    updatedAt: date(metadata.lastUpdated) || date(lastTimestamp) || stat.mtimeMs || 0,
    model: text(lastAssistant?.model || metadata.model, 120),
  };
}

function opencodeSummary(row) {
  const id = createHash('sha256').update(`opencode:${row.id}`).digest('hex');
  let model = '';
  try { model = text(JSON.parse(row.model || '{}').id, 120); } catch { /* Older sessions may not have model metadata. */ }
  const preview = text(row.preview, 240).trim();
  return {
    id, provider: 'opencode', accountId: 'local', sourceKind: 'unknown',
    sourceLabel: 'OpenCode · 출처 불명', sourceKey: `opencode-local:${text(row.id, 160)}`,
    title: text(row.title, 160).trim() || preview || '제목 없는 OpenCode 대화',
    preview, updatedAt: Number(row.time_updated) || Number(row.time_created) || 0, model,
  };
}

function clineTextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
}

function clineSummary(metadata, path) {
  const source = text(metadata.source, 80).toLowerCase();
  const sourceKind = ['cli', 'exec'].includes(source) ? 'cli'
    : /vscode|ide/.test(source) ? 'ide'
      : source === 'desktop' ? 'app' : 'unknown';
  const prompt = text(metadata.prompt, 600).trim();
  const sessionId = text(metadata.session_id, 160) || basename(path, '.json');
  const id = createHash('sha256').update(path).digest('hex');
  const title = text(metadata.title || prompt.split('\n')[0], 160).trim();
  return {
    id, provider: 'cline', accountId: 'local', sourceKind,
    sourceLabel: `Cline · ${SOURCE_LABELS[sourceKind]}`,
    sourceKey: `cline-local:${sessionId}`,
    title: title || '제목 없는 Cline 대화', preview: prompt,
    cwd: text(metadata.cwd || metadata.workspace_root, 500),
    updatedAt: date(metadata.ended_at) || date(metadata.started_at), model: text(metadata.model, 120),
  };
}

async function clineMetadata(root, path) {
  const { file } = await openTranscript(root, path);
  try {
    const metadata = JSON.parse(await file.readFile('utf8'));
    if (!metadata || typeof metadata !== 'object' || typeof metadata.session_id !== 'string' || typeof metadata.messages_path !== 'string') return null;
    return clineSummary(metadata, path);
  } finally { await file.close(); }
}

function parseLines(input, strict = false) {
  const rows = [];
  const lines = input.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    try { const row = JSON.parse(line); if (row && typeof row === 'object') rows.push(row); }
    catch {
      // A live session may end with a partially written record; malformed complete records must not silently disappear.
      if (strict && index !== lines.length - 1) throw fail('대화 기록의 일부가 손상되어 가져올 수 없습니다.');
    }
  }
  return rows;
}

function geminiSnapshot(records) {
  const metadata = {};
  const order = [];
  const messages = new Map();
  const addMessage = (record) => {
    if (!record || !['user', 'gemini'].includes(record.type)) return;
    const content = geminiPlainContent(record.content).trim();
    if (!content) return;
    const id = text(record.id, 160) || createHash('sha256')
      .update(JSON.stringify([record.type, record.timestamp, content])).digest('hex');
    if (!messages.has(id)) order.push(id);
    messages.set(id, {
      id, role: record.type === 'user' ? 'user' : 'assistant',
      content, timestamp: text(record.timestamp, 80), model: text(record.model, 120),
    });
  };
  const replaceMessages = (items) => {
    order.length = 0;
    messages.clear();
    for (const item of items) addMessage(item);
  };

  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    if (record.$set && typeof record.$set === 'object') {
      const { messages: replacement, ...fields } = record.$set;
      Object.assign(metadata, fields);
      if (Array.isArray(replacement)) replaceMessages(replacement);
      continue;
    }
    if (typeof record.$rewindTo === 'string') {
      const targetIndex = order.indexOf(record.$rewindTo);
      if (targetIndex >= 0) {
        for (const id of order.splice(targetIndex + 1)) messages.delete(id);
      }
      continue;
    }
    if (Array.isArray(record.messages) && !['user', 'gemini'].includes(record.type)) {
      const { messages: replacement, ...fields } = record;
      Object.assign(metadata, fields);
      replaceMessages(replacement);
      continue;
    }
    if (['user', 'gemini'].includes(record.type)) {
      addMessage(record);
      continue;
    }
    if (record.sessionId || record.projectHash || record.startTime || record.lastUpdated || record.summary) {
      Object.assign(metadata, record);
      delete metadata.messages;
    }
  }
  return { metadata, messages: order.map((id) => messages.get(id)).filter(Boolean) };
}

async function geminiConversation(root, path, { metadataOnly = false } = {}) {
  const { file, stat } = await openTranscript(root, path);
  try {
    let records;
    if (path.toLowerCase().endsWith('.json')) {
      const parsed = JSON.parse(await file.readFile('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      records = [parsed];
    } else if (metadataOnly) {
      const prefixLength = Math.min(stat.size, CODEX_HEADER_BYTES);
      const prefix = Buffer.alloc(prefixLength);
      await file.read(prefix, 0, prefix.length, 0);
      records = parseLines(prefix.toString('utf8'));
      const suffixLength = Math.min(Math.max(0, stat.size - prefixLength), CODEX_HEADER_BYTES);
      if (suffixLength) {
        const suffix = Buffer.alloc(suffixLength);
        await file.read(suffix, 0, suffix.length, stat.size - suffix.length);
        records.push(...parseLines(suffix.toString('utf8')));
      }
    } else {
      records = parseLines(await file.readFile('utf8'));
    }

    const snapshot = geminiSnapshot(records);
    if (!snapshot.messages.length && !metadataOnly) return null;
    return {
      summary: geminiSummary(snapshot.metadata, path, stat, snapshot.messages),
      messages: snapshot.messages.map(({ role, content }) => ({ role, content })),
    };
  } finally { await file.close(); }
}

// Resolve only files discovered under the transcript directory; clients never supply paths.
async function openTranscript(root, path) {
  const [safeRoot, safePath] = await Promise.all([realpath(root), realpath(path)]);
  const rel = relative(safeRoot, safePath);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || resolve(safeRoot, rel) !== safePath) throw fail('허용되지 않은 대화 파일입니다.', 403);
  const file = await open(safePath, 'r');
  const stat = await file.stat();
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
    await file.close();
    throw fail('64MB를 넘는 대화 파일은 가져올 수 없습니다.', 413);
  }
  return { file, stat };
}

async function claudeMetadata(root, path) {
  const { file, stat } = await openTranscript(root, path);
  try {
    const prefix = Buffer.alloc(Math.min(stat.size, 64 * 1024));
    await file.read(prefix, 0, prefix.length, 0);
    const suffix = stat.size > prefix.length ? Buffer.alloc(Math.min(stat.size - prefix.length, 64 * 1024)) : null;
    if (suffix) await file.read(suffix, 0, suffix.length, stat.size - suffix.length);
    const rows = [...parseLines(prefix.toString('utf8')), ...(suffix ? parseLines(suffix.toString('utf8')) : [])];
    const first = rows.find((row) => row.type === 'user' && !row.isSidechain && plainContent(row.message?.content).trim());
    if (!first) return null;
    const sessionId = basename(path, '.jsonl');
    const entrypoint = rows.find((row) => typeof row.entrypoint === 'string')?.entrypoint || '';
    const sourceKind = /desktop/i.test(entrypoint) ? 'app'
      : /vscode|jetbrains/i.test(entrypoint) ? 'ide'
        : ['cli', 'sdk-cli'].includes(entrypoint) ? 'cli' : 'unknown';
    const titleRow = [...rows].reverse().find((row) => typeof row.customTitle === 'string');
    const preview = plainContent(first.message.content).trim();
    const id = createHash('sha256').update(path).digest('hex');
    return {
      id, provider: 'anthropic', sourceKey: `claude-code:${sessionId}`,
      sourceKind, sourceLabel: `Claude Code · ${SOURCE_LABELS[sourceKind]}`,
      title: text(titleRow?.customTitle || preview, 160), preview: text(preview),
      cwd: text(first.cwd, 500), updatedAt: stat.mtimeMs || date(first.timestamp),
      model: text(rows.find((row) => row.type === 'assistant')?.message?.model),
    };
  } finally { await file.close(); }
}

export class ConversationHistory {
  constructor({ codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude') } = {}) {
    this.codexHome = resolve(codexHome);
    this.codexRoot = join(this.codexHome, 'sessions');
    this.codexArchivedRoot = join(this.codexHome, 'archived_sessions');
    this.claudeRoot = join(resolve(claudeHome), 'projects');
    this.clineRoot = join(homedir(), '.cline', 'data', 'sessions');
    this.geminiRoot = join(homedir(), '.gemini', 'tmp');
    this.codexFiles = new Map();
    this.codexSessionNames = new Map();
    this.claudeFiles = new Map();
    this.clineFiles = new Map();
    this.geminiFiles = new Map();
    this.openCodeSessions = new Map();
    this.ollamaChats = new Map();
  }

  options(input = {}) {
    if (!['openai', 'anthropic', 'cline', 'gemini', 'opencode', 'ollama'].includes(input.provider)) throw fail('대화 출처를 선택해 주세요.');
    return {
      provider: input.provider,
      includeCli: input.includeCli === true, includeUnknown: input.includeUnknown === true,
      archived: input.archived === true, query: text(input.query, 120).trim(),
      cursor: typeof input.cursor === 'string' ? input.cursor.slice(0, 4096) : null,
    };
  }

  async sources() {
    const [codexAvailable, claudeAvailable, clineAvailable, ollama, opencode, codexApps, chatGptApp, clineApp, aiApps, geminiAvailable, cliCommands] = await Promise.all([
      hasTranscript(this.codexRoot, (name) => /^rollout-.*\.jsonl$/i.test(name), 7),
      hasTranscript(this.claudeRoot, (name) => UUID.test(basename(name, '.jsonl')) && name.endsWith('.jsonl'), 5),
      hasTranscript(this.clineRoot, (name) => /^(?:session_)?\d{13}_[A-Za-z0-9_-]+\.json$/i.test(name), 4),
      ollamaStatus(),
      opencodeStatus(),
      Promise.all(['Codex.app', 'ChatGPT.app'].map(installedApp)),
      installedApp('ChatGPT.app'),
      installedApp('Cline.app'),
      installedAiApps(),
      hasTranscript(this.geminiRoot, (name) => /^session-.*\.jsonl?$/i.test(name), 2),
      Promise.all(['codex', 'claude', 'cline', 'gemini', 'opencode', 'ollama'].map(installedCli)),
    ]);
    const cliInstalled = Object.fromEntries(['codex', 'claude', 'cline', 'gemini', 'opencode', 'ollama'].map((name, index) => [name, cliCommands[index]]));
    const bundleIds = await Promise.all(codexApps.map(appBundleId));
    const codexInstalled = bundleIds.includes('com.openai.codex');
    const chatGptBundleId = await appBundleId(chatGptApp);
    const chatGptInstalled = ['com.openai.chat', 'com.openai.chatgpt'].includes(chatGptBundleId);
    const sources = [
      {
        provider: 'openai', name: 'Codex', installed: codexInstalled || codexAvailable || cliInstalled.codex, available: codexAvailable,
        detail: codexAvailable ? '이 Mac의 Codex 로컬 세션 기록을 찾았습니다.'
          : cliInstalled.codex ? 'Codex CLI는 설치되어 있지만 가져올 로컬 대화 기록을 찾지 못했습니다.'
            : codexInstalled ? 'Codex 앱은 설치되어 있지만 가져올 로컬 대화 기록을 찾지 못했습니다.'
              : 'Codex 앱 또는 CLI와 로컬 대화 기록을 찾지 못했습니다.',
      },
      {
        provider: 'anthropic', name: 'Claude Code', installed: claudeAvailable || cliInstalled.claude, available: claudeAvailable,
        detail: claudeAvailable ? '이 Mac의 Claude Code 로컬 프로젝트 기록을 찾았습니다.'
          : cliInstalled.claude ? 'Claude Code CLI는 설치되어 있지만 가져올 로컬 대화 기록을 찾지 못했습니다.'
            : 'Claude Code CLI 또는 로컬 대화 기록을 찾지 못했습니다.',
      },
      {
        provider: 'ollama', name: 'Ollama', ...ollama,
        installed: ollama.installed || cliInstalled.ollama,
        detail: ollama.available ? ollama.detail
          : cliInstalled.ollama ? 'Ollama CLI는 설치되어 있지만 가져올 로컬 대화 기록을 찾지 못했습니다.' : ollama.detail,
      },
      {
        provider: 'cline', name: 'Cline', installed: Boolean(clineApp) || clineAvailable || cliInstalled.cline, available: clineAvailable,
        detail: clineAvailable ? '이 Mac의 Cline 로컬 세션 기록을 찾았습니다.'
          : clineApp || cliInstalled.cline ? 'Cline은 설치되어 있지만 가져올 로컬 대화 기록을 찾지 못했습니다.'
            : 'Cline 앱·CLI 또는 로컬 대화 기록을 찾지 못했습니다.',
      },
      {
        provider: 'opencode', name: 'OpenCode', ...opencode,
        installed: opencode.installed || cliInstalled.opencode,
        detail: opencode.available ? opencode.detail
          : cliInstalled.opencode ? 'OpenCode CLI는 설치되어 있지만 가져올 로컬 대화 DB를 찾지 못했습니다.' : opencode.detail,
      },
      {
        provider: 'gemini', name: 'Gemini CLI', installed: geminiAvailable || cliInstalled.gemini, available: geminiAvailable,
        detail: geminiAvailable ? '이 Mac의 Gemini CLI 로컬 세션 기록을 찾았습니다.'
          : cliInstalled.gemini ? 'Gemini CLI는 설치되어 있지만 가져올 로컬 대화 기록을 찾지 못했습니다.'
            : 'Gemini CLI 또는 로컬 대화 기록을 찾지 못했습니다.',
      },
    ];
    if (chatGptInstalled) sources.push({ name: 'ChatGPT', installed: true, available: false, detail: '앱은 설치되어 있지만 로컬 대화 형식은 가져올 수 없습니다. 공식 내보내기 파일을 사용해 주세요.' });
    const known = new Set(sources.map((source) => source.name.toLocaleLowerCase()));
    const discovered = new Set();
    const appRecords = await Promise.all(aiApps.map(async (appPath) => ({ appPath, bundleId: await appBundleId(appPath) })));
    for (const { appPath, bundleId } of appRecords) {
      let name = basename(appPath, '.app');
      if (bundleId === 'com.openai.codex') name = 'Codex';
      else if (name.toLowerCase() === 'claude') name = 'Claude Desktop';
      const key = name.toLocaleLowerCase();
      if (known.has(key) || discovered.has(key)) continue;
      discovered.add(key);
      sources.push({ name, installed: true, available: false, detail: `${name} 앱은 설치되어 있지만 지원하는 로컬 대화 형식은 아직 없습니다.` });
    }
    return { sources };
  }

  async list(input) {
    const options = this.options(input);
    if (options.provider === 'cline') {
      const paths = await transcriptFiles(this.clineRoot, {
        maxDepth: 4, maxFiles: MAX_LOCAL_SESSIONS + 1,
        match: (name) => /^(?:session_)?\d{13}_[A-Za-z0-9_-]+\.json$/i.test(name),
      });
      const catalog = [];
      const files = new Map();
      let skipped = 0;
      for (const path of paths.slice(0, MAX_LOCAL_SESSIONS)) {
        try {
          const item = await clineMetadata(this.clineRoot, path);
          if (!item) continue;
          files.set(item.id, path);
          if (allowed(item.sourceKind, options) && (!options.query || `${item.title} ${item.preview} ${item.cwd}`.toLocaleLowerCase().includes(options.query.toLocaleLowerCase()))) catalog.push(item);
        } catch { skipped++; }
      }
      this.clineFiles = files;
      catalog.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      const offset = options.cursor && /^\d{1,6}$/.test(options.cursor) ? Number(options.cursor) : 0;
      return {
        data: catalog.slice(offset, offset + 50), nextCursor: offset + 50 < catalog.length ? String(offset + 50) : null,
        warnings: [
          'Cline 로컬 세션에서 사용자와 AI가 화면에 표시한 텍스트만 가져옵니다. thinking·도구 실행·첨부 데이터는 제외합니다.',
          ...(paths.length > MAX_LOCAL_SESSIONS ? ['Cline 대화가 5,000개를 넘어 일부만 표시합니다.'] : []),
          ...(skipped ? [`읽을 수 없는 Cline 대화 ${skipped}개를 제외했습니다.`] : []),
        ],
      };
    }
    if (options.provider === 'gemini') {
      const paths = await transcriptFiles(this.geminiRoot, {
        maxDepth: 2, maxFiles: MAX_LOCAL_SESSIONS + 1,
        match: (name) => /^session-.*\.jsonl?$/i.test(name),
      });
      const catalog = [];
      const files = new Map();
      let skipped = 0;
      for (const path of paths.slice(0, MAX_LOCAL_SESSIONS)) {
        try {
          const result = await geminiConversation(this.geminiRoot, path, { metadataOnly: true });
          if (!result) continue;
          files.set(result.summary.id, path);
          if (allowed(result.summary.sourceKind, options)
            && (!options.query || (result.summary.title + ' ' + result.summary.preview).toLocaleLowerCase().includes(options.query.toLocaleLowerCase()))) {
            catalog.push(result.summary);
          }
        } catch { skipped++; }
      }
      this.geminiFiles = files;
      catalog.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      const offset = options.cursor && /^\d{1,6}$/.test(options.cursor) ? Number(options.cursor) : 0;
      return {
        data: catalog.slice(offset, offset + 50), nextCursor: offset + 50 < catalog.length ? String(offset + 50) : null,
        warnings: [
          'Gemini CLI 기록은 읽기 전용으로 살펴보고 사용자·모델의 텍스트만 가져옵니다. 도구 호출, 생각 요약, 첨부 데이터는 제외합니다.',
          ...(paths.length > MAX_LOCAL_SESSIONS ? ['Gemini CLI 대화가 5,000개를 넘어 일부만 표시합니다.'] : []),
          ...(skipped ? ['읽을 수 없거나 64MB를 넘는 Gemini CLI 대화 ' + skipped.toLocaleString() + '개를 제외했습니다.'] : []),
        ],
      };
    }
    if (options.provider === 'opencode') {
      const database = await opencodeDatabasePath();
      if (!database) throw fail('OpenCode 로컬 대화 DB를 찾지 못했습니다. OpenCode 앱을 실행한 뒤 다시 시도해 주세요.', 404);
      const rows = await readOnlySqliteQuery(database, `
        SELECT s.id, substr(s.title, 1, 160) AS title, s.model, s.time_created, s.time_updated,
          (SELECT substr(json_extract(p.data, '$.text'), 1, 600)
           FROM message m JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
           WHERE m.session_id = s.id AND json_extract(m.data, '$.role') = 'user'
             AND json_extract(p.data, '$.type') = 'text'
           ORDER BY m.time_created, p.time_created LIMIT 1) AS preview
        FROM session s WHERE s.parent_id IS NULL
        ORDER BY s.time_updated DESC LIMIT ${MAX_LOCAL_SESSIONS + 1}`);
      const catalog = [];
      const sessions = new Map();
      for (const row of rows.slice(0, MAX_LOCAL_SESSIONS)) {
        if (typeof row.id !== 'string') continue;
        const item = opencodeSummary(row);
        if (!allowed(item.sourceKind, options) || options.query && !`${item.title} ${item.preview}`.toLocaleLowerCase().includes(options.query.toLocaleLowerCase())) continue;
        catalog.push(item);
        sessions.set(item.id, row.id);
      }
      this.openCodeSessions = sessions;
      const offset = options.cursor && /^\d{1,6}$/.test(options.cursor) ? Number(options.cursor) : 0;
      return {
        data: catalog.slice(offset, offset + 50), nextCursor: offset + 50 < catalog.length ? String(offset + 50) : null,
        warnings: [
          'OpenCode CLI와 데스크톱은 로컬 기록을 공유하고 출처 구분 정보가 없습니다. 출처 불명 포함을 선택하면 두 출처의 대화를 함께 표시합니다.',
          ...(rows.length > MAX_LOCAL_SESSIONS ? ['OpenCode 대화가 5,000개를 넘어 일부만 표시합니다.'] : []),
        ],
      };
    }
    if (options.provider === 'ollama') {
      const database = await ollamaDatabasePath();
      if (!database) throw fail('Ollama 로컬 대화 DB를 찾지 못했습니다. Ollama 앱을 실행한 뒤 다시 시도해 주세요.', 404);
      const rows = await readOnlySqliteQuery(database, `
        SELECT chats.id, substr(chats.title, 1, 160) AS title, chats.created_at,
          COALESCE((SELECT MAX(updated_at) FROM messages WHERE chat_id = chats.id), chats.created_at) AS updated_at,
          (SELECT substr(content, 1, 600) FROM messages WHERE chat_id = chats.id AND role = 'user' ORDER BY id LIMIT 1) AS preview,
          (SELECT model_name FROM messages WHERE chat_id = chats.id AND role = 'assistant' ORDER BY id DESC LIMIT 1) AS model_name
        FROM chats
        WHERE EXISTS (SELECT 1 FROM messages WHERE chat_id = chats.id AND role IN ('user', 'assistant'))
        ORDER BY updated_at DESC LIMIT ${MAX_OLLAMA_CHATS + 1}`);
      const catalog = [];
      const chats = new Map();
      for (const row of rows.slice(0, MAX_OLLAMA_CHATS)) {
        if (typeof row.id !== 'string') continue;
        const item = ollamaSummary(row);
        if (options.query && !`${item.title} ${item.preview}`.toLocaleLowerCase().includes(options.query.toLocaleLowerCase())) continue;
        catalog.push(item);
        chats.set(item.id, row.id);
      }
      this.ollamaChats = chats;
      const offset = options.cursor && /^\d{1,6}$/.test(options.cursor) ? Number(options.cursor) : 0;
      return {
        data: catalog.slice(offset, offset + 50), nextCursor: offset + 50 < catalog.length ? String(offset + 50) : null,
        warnings: [
          '이 Mac의 Ollama 로컬 DB를 읽기 전용으로 확인합니다. 모델의 내부 thinking 정보와 도구 기록은 가져오지 않습니다.',
          ...(rows.length > MAX_OLLAMA_CHATS ? ['Ollama 대화가 5,000개를 넘어 오래된 일부 대화는 표시하지 않습니다.'] : []),
        ],
      };
    }
    if (options.provider === 'openai') {
      const root = options.archived ? this.codexArchivedRoot : this.codexRoot;
      const sessionNames = await codexSessionNames(this.codexHome);
      this.codexSessionNames = sessionNames;
      const paths = await transcriptFiles(root, { match: (name) => /^rollout-.*\.jsonl$/i.test(name) });
      const catalog = [];
      const files = new Map();
      let skipped = 0;
      for (const path of paths) {
        try {
          const item = await codexMetadata(root, path, sessionNames);
          if (!item) continue;
          files.set(item.id, { root, path });
          if (allowed(item.sourceKind, options) && (!options.query || `${item.title} ${item.preview} ${item.cwd}`.toLocaleLowerCase().includes(options.query.toLocaleLowerCase()))) {
            catalog.push(item);
          }
        } catch { skipped++; }
      }
      this.codexFiles = files;
      catalog.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      const offset = options.cursor && /^\d{1,6}$/.test(options.cursor) ? Number(options.cursor) : 0;
      return {
        data: catalog.slice(offset, offset + 50), nextCursor: offset + 50 < catalog.length ? String(offset + 50) : null,
        warnings: [
          '이 Mac의 Codex 로컬 세션 파일에서 찾은 기록입니다. 원본 파일은 변경하지 않습니다.',
          ...(paths.length >= MAX_DISCOVERED_FILES ? ['로컬 Codex 기록이 5,000개를 넘어 일부만 표시합니다.'] : []),
          ...(skipped ? [`읽을 수 없거나 64MB를 넘는 대화 ${skipped}개를 제외했습니다.`] : []),
        ],
      };
    }
    const catalog = [];
    let skipped = 0;
    let scanned = 0;
    let limited = false;
    const files = new Map();
    const paths = await transcriptFiles(this.claudeRoot, {
      maxDepth: 5,
      maxFiles: MAX_DISCOVERED_FILES + 1,
      match: (name) => name.endsWith('.jsonl') && UUID.test(basename(name, '.jsonl')),
    });
    for (const path of paths) {
      if (++scanned > MAX_DISCOVERED_FILES) { limited = true; break; }
      try {
        const item = await claudeMetadata(this.claudeRoot, path);
        if (!item) continue;
        files.set(item.id, path);
        if (allowed(item.sourceKind, options) && (!options.query || `${item.title} ${item.cwd}`.toLocaleLowerCase().includes(options.query.toLocaleLowerCase()))) catalog.push(item);
      } catch { skipped++; }
    }
    this.claudeFiles = files;
    catalog.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const offset = options.cursor && /^\d{1,6}$/.test(options.cursor) ? Number(options.cursor) : 0;
    return {
      data: catalog.slice(offset, offset + 50), nextCursor: offset + 50 < catalog.length ? String(offset + 50) : null,
      warnings: [
        '이 Mac의 Claude Code 기록만 표시합니다. 클라우드에만 있는 대화는 내보내기 파일에서 가져오세요.',
        ...(skipped ? [`읽을 수 없거나 64MB를 넘는 대화 ${skipped}개를 제외했습니다.`] : []),
        ...(limited ? ['로컬 기록이 5,000개를 넘어 일부만 표시합니다.'] : []),
      ],
    };
  }

  async read(input) {
    const options = this.options(input);
    if (options.provider === 'cline') {
      if (typeof input.id !== 'string' || !/^[a-f0-9]{64}$/.test(input.id)) throw fail('올바르지 않은 Cline 대화입니다.');
      const path = this.clineFiles.get(input.id);
      if (!path) throw fail('대화 목록을 새로고침한 뒤 다시 선택해 주세요.', 404);
      const summary = await clineMetadata(this.clineRoot, path);
      if (!summary || !allowed(summary.sourceKind, options)) throw fail('이 대화의 출처를 가져오기 필터에서 먼저 선택해 주세요.');
      const messagesPath = join(dirname(path), `${basename(path, '.json')}.messages.json`);
      const { file } = await openTranscript(this.clineRoot, messagesPath);
      let data;
      try { data = JSON.parse(await file.readFile('utf8')); } finally { await file.close(); }
      const rows = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : [];
      const messages = rows
        .filter((row) => ['user', 'assistant'].includes(row?.role))
        .map((row) => ({ role: row.role, content: clineTextContent(row.content).trim() }))
        .filter((row) => row.content);
      return importResult(summary, messages);
    }
    if (options.provider === 'gemini') {
      if (typeof input.id !== 'string' || !/^[a-f0-9]{64}$/.test(input.id)) throw fail('올바르지 않은 Gemini CLI 대화입니다.');
      const path = this.geminiFiles.get(input.id);
      if (!path) throw fail('대화 목록을 새로고침한 뒤 다시 선택해 주세요.', 404);
      if (!allowed('cli', options)) throw fail('CLI 대화를 포함하도록 선택한 뒤 다시 시도해 주세요.');
      const result = await geminiConversation(this.geminiRoot, path);
      if (!result) throw fail('가져올 수 있는 Gemini CLI 메시지가 없습니다.');
      return importResult(result.summary, result.messages);
    }
    if (options.provider === 'opencode') {
      if (typeof input.id !== 'string' || !/^[a-f0-9]{64}$/.test(input.id)) throw fail('올바르지 않은 OpenCode 대화입니다.');
      const sessionId = this.openCodeSessions.get(input.id);
      const database = await opencodeDatabasePath();
      if (!sessionId || !database) throw fail('대화 목록을 새로고침한 뒤 다시 선택해 주세요.', 404);
      const rows = await readOnlySqliteQuery(database, `SELECT id, title, model, time_created, time_updated,
        (SELECT substr(json_extract(p.data, '$.text'), 1, 600)
         FROM message m JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
         WHERE m.session_id = session.id AND json_extract(m.data, '$.role') = 'user'
           AND json_extract(p.data, '$.type') = 'text'
         ORDER BY m.time_created, p.time_created LIMIT 1) AS preview
        FROM session WHERE id = ${sqlText(sessionId)} AND parent_id IS NULL LIMIT 1`);
      const row = rows[0];
      if (!row) throw fail('OpenCode 대화를 찾을 수 없습니다.', 404);
      const size = await readOnlySqliteQuery(database, `SELECT COALESCE(SUM(length(json_extract(p.data, '$.text'))), 0) AS total
        FROM message m JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
        WHERE m.session_id = ${sqlText(sessionId)} AND json_extract(m.data, '$.role') IN ('user', 'assistant')
          AND json_extract(p.data, '$.type') = 'text'`);
      if (Number(size[0]?.total) > MAX_IMPORT_CHARS) throw fail('대화가 현재 앱의 저장 한도보다 큽니다. 더 짧은 대화를 선택해 주세요.', 413);
      const parts = await readOnlySqliteQuery(database, `SELECT m.id AS message_id, json_extract(m.data, '$.role') AS role,
          json_extract(p.data, '$.text') AS content
        FROM message m JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
        WHERE m.session_id = ${sqlText(sessionId)} AND json_extract(m.data, '$.role') IN ('user', 'assistant')
          AND json_extract(p.data, '$.type') = 'text'
        ORDER BY m.time_created, p.time_created, p.id`);
      const messages = [];
      for (const part of parts) {
        if (typeof part.content !== 'string' || !part.content) continue;
        const previous = messages.at(-1);
        if (previous?._id === part.message_id) previous.content += part.content;
        else messages.push({ _id: part.message_id, role: part.role, content: part.content });
      }
      return importResult(opencodeSummary({ ...row, id: sessionId }), messages.map(({ role, content }) => ({ role, content: content.trim() })).filter((message) => message.content));
    }
    if (options.provider === 'ollama') {
      if (typeof input.id !== 'string' || !/^[a-f0-9]{64}$/.test(input.id)) throw fail('올바르지 않은 Ollama 대화입니다.');
      const chatId = this.ollamaChats.get(input.id);
      const database = await ollamaDatabasePath();
      if (!chatId || !database) throw fail('대화 목록을 새로고침한 뒤 다시 선택해 주세요.', 404);
      const rows = await readOnlySqliteQuery(database, `SELECT substr(title, 1, 160) AS title, created_at,
        (SELECT MAX(updated_at) FROM messages WHERE chat_id = chats.id) AS updated_at,
        (SELECT substr(content, 1, 600) FROM messages WHERE chat_id = chats.id AND role = 'user' ORDER BY id LIMIT 1) AS preview,
        (SELECT model_name FROM messages WHERE chat_id = chats.id AND role = 'assistant' ORDER BY id DESC LIMIT 1) AS model_name
        FROM chats WHERE id = ${sqlText(chatId)} LIMIT 1`);
      const row = rows[0];
      if (!row) throw fail('Ollama 대화를 찾을 수 없습니다.', 404);
      const size = await readOnlySqliteQuery(database, `SELECT COALESCE(SUM(length(content)), 0) AS total FROM messages WHERE chat_id = ${sqlText(chatId)} AND role IN ('user', 'assistant')`);
      if (Number(size[0]?.total) > MAX_IMPORT_CHARS) throw fail('대화가 현재 앱의 저장 한도보다 큽니다. 더 짧은 대화를 선택해 주세요.', 413);
      const messages = (await readOnlySqliteQuery(database, `SELECT role, content FROM messages WHERE chat_id = ${sqlText(chatId)} AND role IN ('user', 'assistant') ORDER BY id`))
        .filter((message) => typeof message.content === 'string' && message.content.trim())
        .map((message) => ({ role: message.role, content: message.content }));
      return importResult(ollamaSummary({ ...row, id: chatId }), messages);
    }
    if (options.provider === 'openai') {
      if (typeof input.id !== 'string' || !/^[a-f0-9]{64}$/.test(input.id)) throw fail('올바르지 않은 Codex 대화입니다.');
      const selected = this.codexFiles.get(input.id);
      if (!selected) throw fail('대화 목록을 새로고침한 뒤 다시 선택해 주세요.', 404);
      const summary = await codexMetadata(selected.root, selected.path, this.codexSessionNames);
      if (!summary) throw fail('Codex 대화의 기본 정보를 읽지 못했습니다.');
      if (!allowed(summary.sourceKind, options)) throw fail('이 대화의 출처를 가져오기 필터에서 먼저 선택해 주세요.');
      const { file } = await openTranscript(selected.root, selected.path);
      let rows;
      try { rows = parseLines(await file.readFile('utf8'), true); } finally { await file.close(); }
      const messages = [];
      for (const row of rows) {
        if (row.type !== 'response_item' || row.payload?.type !== 'message') continue;
        const role = row.payload.role;
        if (role !== 'user' && role !== 'assistant') continue;
        if (role === 'assistant' && row.payload.phase && !['final_answer', 'commentary'].includes(row.payload.phase)) continue;
        const content = codexPlainContent(row.payload.content).trim();
        if (role === 'user' && codexInjectedContext(content)) continue;
        if (content) messages.push({ role, content });
      }
      return importResult(summary, messages);
    }
    const path = this.claudeFiles.get(input.id);
    if (!path) throw fail('대화 목록을 새로고침한 뒤 다시 선택해 주세요.', 404);
    const summary = await claudeMetadata(this.claudeRoot, path);
    if (!summary || !allowed(summary.sourceKind, options)) throw fail('이 대화의 출처를 가져오기 필터에서 먼저 선택해 주세요.');
    const { file } = await openTranscript(this.claudeRoot, path);
    let rows;
    try { rows = parseLines(await file.readFile('utf8'), true); } finally { await file.close(); }
    // Follow the current branch instead of mixing rewound messages and side agents.
    const chatRows = rows.filter((row) => !row.isSidechain && ['user', 'assistant'].includes(row.type) && row.message);
    const byId = new Map(rows.filter((row) => row.uuid).map((row) => [row.uuid, row]));
    const tip = chatRows.at(-1);
    let branch = chatRows;
    if (tip?.uuid && Object.hasOwn(tip, 'parentUuid')) {
      const visited = new Set();
      branch = [];
      let node = tip;
      while (node && !visited.has(node.uuid)) {
        visited.add(node.uuid);
        if (!node.isSidechain && ['user', 'assistant'].includes(node.type) && node.message) branch.push(node);
        node = byId.get(node.parentUuid);
      }
      branch.reverse();
    }
    const messages = [];
    const seen = new Set();
    for (const row of branch) {
      if (row.uuid && seen.has(row.uuid)) continue;
      seen.add(row.uuid);
      if (row.isMeta || row.isCompactSummary) continue;
      const content = plainContent(row.message.content);
      if (content.trim()) messages.push({ role: row.type, content });
    }
    return importResult(summary, messages);
  }
}

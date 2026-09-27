import { createHash } from 'node:crypto';
import { open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_IMPORT_CHARS = 1_600_000;
const SOURCE_LABELS = { app: '앱', ide: 'IDE', cli: 'CLI', unknown: '출처 불명' };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const text = (value, length = 240) => typeof value === 'string' ? value.slice(0, length) : '';
const date = (value) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const allowed = (kind, options) => kind === 'cli' ? options.includeCli : kind === 'unknown' ? options.includeUnknown : true;

function codexSource(thread) {
  if (['cli', 'exec'].includes(thread.source)) return 'cli';
  if (/desktop|mosaic_desk/i.test(thread.originator || '')) return 'app';
  if (thread.source === 'vscode') return 'ide';
  return 'unknown';
}

function codexSummary(thread, accountId) {
  const sourceKind = codexSource(thread);
  return {
    id: thread.id, provider: 'openai', accountId, sourceKind,
    sourceLabel: `Codex · ${SOURCE_LABELS[sourceKind]}`,
    sourceKey: `codex-local:${accountId}:${thread.id}`,
    title: text(thread.name || thread.preview || '제목 없는 대화', 160),
    preview: text(thread.preview, 240), cwd: text(thread.cwd, 500),
    updatedAt: Number(thread.updatedAt) * 1000 || 0,
    model: text(thread.model),
  };
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
  constructor({ getCodexClient, claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude') }) {
    this.getCodexClient = getCodexClient;
    this.claudeRoot = join(resolve(claudeHome), 'projects');
    this.claudeFiles = new Map();
  }

  options(input = {}) {
    if (!['openai', 'anthropic'].includes(input.provider)) throw fail('대화 출처를 선택해 주세요.');
    const accountId = input.accountId || 'default';
    if (accountId !== 'default' && !UUID.test(accountId)) throw fail('올바르지 않은 Codex 계정입니다.');
    return {
      provider: input.provider, accountId,
      includeCli: input.includeCli === true, includeUnknown: input.includeUnknown === true,
      archived: input.archived === true, query: text(input.query, 120).trim(),
      cursor: typeof input.cursor === 'string' ? input.cursor.slice(0, 4096) : null,
    };
  }

  async list(input) {
    const options = this.options(input);
    if (options.provider === 'openai') {
      const client = await this.getCodexClient(options.accountId);
      const result = await client.request('thread/list', {
        limit: 50, cursor: options.cursor, sortKey: 'updated_at', sortDirection: 'desc',
        sourceKinds: ['vscode', 'appServer', ...(options.includeCli ? ['cli', 'exec'] : []), ...(options.includeUnknown ? ['unknown'] : [])],
        modelProviders: [], archived: options.archived,
        ...(options.query ? { searchTerm: options.query } : {}),
      });
      const data = (result.data || []).filter((thread) => !thread.parentThreadId && !thread.ephemeral)
        .map((thread) => codexSummary(thread, options.accountId)).filter((item) => allowed(item.sourceKind, options));
      return { data, nextCursor: result.nextCursor || null, warnings: [] };
    }
    const catalog = [];
    let skipped = 0;
    let scanned = 0;
    let limited = false;
    const files = new Map();
    outer: for (const directory of await directoryEntries(this.claudeRoot)) {
      if (!directory.isDirectory()) continue;
      for (const entry of await directoryEntries(join(this.claudeRoot, directory.name))) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl') || !UUID.test(basename(entry.name, '.jsonl'))) continue;
        if (++scanned > 5000) { limited = true; break outer; }
        const path = join(this.claudeRoot, directory.name, entry.name);
        try {
          const item = await claudeMetadata(this.claudeRoot, path);
          if (!item) continue;
          files.set(item.id, path);
          if (allowed(item.sourceKind, options) && (!options.query || `${item.title} ${item.cwd}`.toLocaleLowerCase().includes(options.query.toLocaleLowerCase()))) catalog.push(item);
        } catch { skipped++; }
      }
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
    if (options.provider === 'openai') {
      if (!UUID.test(input.id)) throw fail('올바르지 않은 Codex 대화입니다.');
      const client = await this.getCodexClient(options.accountId);
      const { thread } = await client.request('thread/read', { threadId: input.id, includeTurns: false });
      if (!thread || thread.parentThreadId || typeof thread.source === 'object') throw fail('일반 사용자 대화만 가져올 수 있습니다.');
      const summary = codexSummary(thread, options.accountId);
      if (!allowed(summary.sourceKind, options)) throw fail('이 대화의 출처를 가져오기 필터에서 먼저 선택해 주세요.');
      const { thread: full } = await client.request('thread/read', { threadId: input.id, includeTurns: true });
      const messages = [];
      for (const turn of full.turns || []) {
        if (turn.itemsView && turn.itemsView !== 'full') throw fail('이 Codex 버전에서 전체 대화를 읽을 수 없습니다. Codex를 업데이트한 뒤 다시 시도해 주세요.');
        for (const item of turn.items || []) {
          const content = item.type === 'userMessage' ? plainContent(item.content) : item.type === 'agentMessage' ? item.text : '';
          if (typeof content === 'string' && content.trim()) messages.push({ role: item.type === 'userMessage' ? 'user' : 'assistant', content });
        }
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

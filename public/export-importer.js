const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_JSON_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_JSON_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_IMPORT_CONVERSATIONS = 5_000;

const conversationFilePattern = /(?:conversation|chat|thread|history|project|export|data).*\.json$/i;

function readUint32(view, offset) {
  if (offset < 0 || offset + 4 > view.byteLength) throw new Error('내보내기 ZIP 구조가 올바르지 않습니다.');
  return view.getUint32(offset, true);
}

function findEndOfCentralDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = Math.max(0, bytes.byteLength - 22 - 65_535);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (readUint32(view, offset) !== 0x06054b50) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === bytes.byteLength) return offset;
  }
  throw new Error('ZIP 내보내기에서 파일 목록을 찾을 수 없습니다.');
}

async function readZipEntries(file) {
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error('ZIP 파일이 너무 큽니다. 256MB 이하의 내보내기를 선택해 주세요.');
  const tailStart = Math.max(0, file.size - 22 - 65_535);
  const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer());
  const endOffset = findEndOfCentralDirectory(tail);
  const endView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  if (endView.getUint16(endOffset + 4, true) !== 0 || endView.getUint16(endOffset + 6, true) !== 0) {
    throw new Error('여러 디스크로 분할된 ZIP 내보내기는 지원하지 않습니다.');
  }
  const entryCount = endView.getUint16(endOffset + 10, true);
  const centralSize = endView.getUint32(endOffset + 12, true);
  const centralOffset = endView.getUint32(endOffset + 16, true);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('ZIP64 형식은 지원하지 않습니다. 더 작은 내보내기 파일을 선택해 주세요.');
  }
  if (entryCount > MAX_ARCHIVE_ENTRIES || centralOffset + centralSize > file.size) {
    throw new Error('ZIP 내보내기의 파일 목록이 너무 크거나 손상되었습니다.');
  }

  const directory = new DataView(await file.slice(centralOffset, centralOffset + centralSize).arrayBuffer());
  const entries = [];
  let offset = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (readUint32(directory, offset) !== 0x02014b50) throw new Error('ZIP 내보내기의 파일 목록이 손상되었습니다.');
    const flags = directory.getUint16(offset + 8, true);
    const method = directory.getUint16(offset + 10, true);
    const compressedSize = directory.getUint32(offset + 20, true);
    const uncompressedSize = directory.getUint32(offset + 24, true);
    const nameLength = directory.getUint16(offset + 28, true);
    const extraLength = directory.getUint16(offset + 30, true);
    const commentLength = directory.getUint16(offset + 32, true);
    const localOffset = directory.getUint32(offset + 42, true);
    const recordEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > directory.byteLength) throw new Error('ZIP 내보내기의 파일 이름이 손상되었습니다.');
    const nameBytes = new Uint8Array(directory.buffer, directory.byteOffset + offset + 46, nameLength);
    const name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'latin1').decode(nameBytes);
    if (name.toLowerCase().endsWith('.json') && !name.endsWith('/')) {
      entries.push({ name, flags, method, compressedSize, uncompressedSize, localOffset });
    }
    offset = recordEnd;
  }
  if (offset !== directory.byteLength) throw new Error('ZIP 내보내기의 파일 목록이 올바르지 않습니다.');
  const selectedEntries = entries
    .filter((entry) => conversationFilePattern.test(entry.name) || entries.length <= 40)
    .sort((left, right) => {
      const rank = (name) => /projects?\.json$/i.test(name) ? 0 : /conversations?\.json$/i.test(name) ? 1 : 2;
      return rank(left.name) - rank(right.name);
    });
  for (const entry of selectedEntries) {
    if (entry.flags & 1) throw new Error('암호로 잠긴 ZIP은 가져올 수 없습니다.');
    if (![0, 8].includes(entry.method)) throw new Error(`지원하지 않는 ZIP 압축 방식입니다: ${entry.name}`);
    if (entry.uncompressedSize > MAX_JSON_ENTRY_BYTES || entry.compressedSize === 0xffffffff) {
      throw new Error(`JSON 파일이 너무 크거나 ZIP64 형식입니다: ${entry.name}`);
    }
  }
  return selectedEntries;
}

async function readZipEntry(file, entry) {
  const headerBytes = new Uint8Array(await file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
  const header = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
  if (readUint32(header, 0) !== 0x04034b50) throw new Error(`ZIP 파일이 손상되었습니다: ${entry.name}`);
  const localNameLength = header.getUint16(26, true);
  const localExtraLength = header.getUint16(28, true);
  const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > file.size) throw new Error(`ZIP 파일이 잘렸습니다: ${entry.name}`);
  const compressed = file.slice(dataStart, dataEnd);
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) throw new Error(`저장된 ZIP 파일 크기가 올바르지 않습니다: ${entry.name}`);
    return new Uint8Array(await compressed.arrayBuffer());
  }
  if (typeof DecompressionStream !== 'function') throw new Error('이 환경은 ZIP 압축 해제를 지원하지 않습니다. JSON 파일을 직접 선택해 주세요.');
  let decompressor;
  try {
    decompressor = new DecompressionStream('deflate-raw');
  } catch {
    throw new Error('이 환경은 ZIP 압축 형식을 지원하지 않습니다. JSON 파일을 직접 선택해 주세요.');
  }
  const reader = compressed.stream().pipeThrough(decompressor).getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_ENTRY_BYTES || size > entry.uncompressedSize) {
        await reader.cancel();
        throw new Error(`압축 해제 후 JSON 파일이 너무 큽니다: ${entry.name}`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size !== entry.uncompressedSize) throw new Error(`압축 해제된 파일 크기가 맞지 않습니다: ${entry.name}`);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function textFrom(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
  for (const key of ['parts', 'blocks', 'content', 'body', 'value']) {
    if (value[key] !== undefined) {
      const content = textFrom(value[key]);
      if (content) return content;
    }
  }
  return '';
}

function externalId(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value).slice(0, 160);
  if (!value || typeof value !== 'object') return '';
  return String(value.uuid || value.id || value.project_uuid || value.project_id || '').slice(0, 160);
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1_000_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  return Date.now();
}

function conversationMessages(record) {
  let sourceMessages = [];
  if (record.mapping && typeof record.mapping === 'object') {
    const mapping = record.mapping;
    const ordered = [];
    let nodeId = record.current_node;
    const seen = new Set();
    while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
      seen.add(nodeId);
      ordered.unshift(mapping[nodeId]);
      nodeId = mapping[nodeId].parent;
    }
    sourceMessages = ordered.length ? ordered : Object.values(mapping).sort((left, right) => {
      return timestamp(left?.message?.create_time || 0) - timestamp(right?.message?.create_time || 0);
    });
    sourceMessages = sourceMessages.map((item) => item?.message).filter(Boolean);
  } else if (Array.isArray(record.chat_messages)) {
    sourceMessages = record.chat_messages;
  } else if (Array.isArray(record.messages)) {
    sourceMessages = record.messages;
  }

  return sourceMessages.flatMap((message) => {
    const rawRole = String(message?.role || message?.sender || message?.author?.role || '').toLowerCase();
    const role = ['user', 'human'].includes(rawRole) ? 'user' : rawRole === 'assistant' ? 'assistant' : null;
    const content = textFrom(message?.content ?? message?.text ?? message?.message).trim();
    return role && content ? [{ role, content: content.slice(0, 40_000) }] : [];
  });
}

function isConversation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Boolean(value.mapping && typeof value.mapping === 'object')
    || Array.isArray(value.chat_messages)
    || (Array.isArray(value.messages) && (value.title || value.name || value.uuid || value.conversation_id));
}

function normalizeConversation(record) {
  const messages = conversationMessages(record);
  if (!messages.length) return null;
  const rawProject = record.project_uuid || record.project_id || record.projectId || record.project;
  const projectId = externalId(rawProject);
  const projectName = typeof record.project_name === 'string'
    ? record.project_name
    : typeof record.projectName === 'string'
      ? record.projectName
      : typeof rawProject === 'object'
        ? String(rawProject.name || rawProject.title || '')
        : '';
  const firstUserMessage = messages.find((message) => message.role === 'user')?.content || '';
  const title = String(record.title || record.name || record.conversation_title || record.subject || firstUserMessage || '가져온 대화')
    .replace(/\s+/g, ' ').trim().slice(0, 80);
  return {
    sourceId: externalId(record.uuid || record.id || record.conversation_id || record.chat_id),
    sourceProjectId: projectId,
    sourceProjectName: projectName.slice(0, 60),
    title,
    createdAt: timestamp(record.updated_at || record.update_time || record.created_at || record.create_time),
    messages,
  };
}

function isProject(value, fileName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const hasProjectContent = ['description', 'instructions', 'custom_instructions', 'prompt', 'knowledge', 'knowledge_base', 'docs', 'files']
    .some((key) => value[key] !== undefined);
  return Boolean((value.name || value.title) && (hasProjectContent || /projects?\.json$/i.test(fileName)));
}

function normalizeProject(record) {
  const documents = record.knowledge_base || record.knowledge || record.documents || record.docs || record.files || [];
  const material = Array.isArray(documents) ? documents : [documents];
  const knowledge = material.flatMap((document) => {
    const content = textFrom(document?.content ?? document?.text ?? document?.body ?? document);
    if (!content.trim()) return [];
    const name = typeof document?.name === 'string' ? `${document.name}\n` : '';
    return [`${name}${content.trim()}`];
  }).join('\n\n').slice(0, 16_000);
  const instructions = textFrom(record.instructions || record.custom_instructions || record.project_instructions || record.prompt || record.description || '')
    .trim().slice(0, 8_000);
  return {
    sourceId: externalId(record.uuid || record.id || record.project_id || record.project_uuid),
    name: String(record.name || record.title || '가져온 프로젝트').trim().slice(0, 60),
    instructions,
    knowledge,
  };
}

function collectRecords(value, fileName, conversations, projects, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isConversation(item)) conversations.push(item);
      else if (isProject(item, fileName)) projects.push(item);
      else collectRecords(item, fileName, conversations, projects, depth + 1);
    }
    return;
  }
  if (isConversation(value)) {
    conversations.push(value);
    return;
  }
  if (isProject(value, fileName)) {
    projects.push(value);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (['conversations', 'chats', 'threads', 'history', 'messages'].includes(key.toLowerCase()) && Array.isArray(child)) {
      collectRecords(child, fileName, conversations, projects, depth + 1);
    } else if (['projects', 'project_list', 'projectlist'].includes(key.toLowerCase())) {
      collectRecords(child, 'projects.json', conversations, projects, depth + 1);
    } else if (depth < 2 && child && typeof child === 'object') {
      collectRecords(child, fileName, conversations, projects, depth + 1);
    }
  }
}

function parseJson(bytes, fileName) {
  try {
    const text = new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch {
    throw new Error(`JSON 파일을 읽지 못했습니다: ${fileName}`);
  }
}

export async function parseProviderExport(file) {
  if (!(file instanceof Blob)) throw new Error('가져올 내보내기 파일을 선택해 주세요.');
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error('내보내기 파일은 256MB 이하만 가져올 수 있습니다.');
  const conversations = [];
  const projects = [];
  let jsonBytes = 0;
  let fileCount = 0;

  if (/\.json$/i.test(file.name)) {
    if (file.size > MAX_JSON_ENTRY_BYTES) throw new Error('JSON 파일은 64MB 이하만 가져올 수 있습니다.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    collectRecords(parseJson(bytes, file.name), file.name, conversations, projects);
    jsonBytes = bytes.byteLength;
    fileCount = 1;
  } else if (/\.zip$/i.test(file.name)) {
    const entries = await readZipEntries(file);
    if (!entries.length) throw new Error('ZIP에서 대화나 프로젝트 JSON 파일을 찾지 못했습니다.');
    for (const entry of entries) {
      jsonBytes += entry.uncompressedSize;
      if (jsonBytes > MAX_TOTAL_JSON_BYTES) throw new Error('ZIP 내 JSON 자료의 압축 해제 총량이 128MB를 넘습니다.');
      const bytes = await readZipEntry(file, entry);
      collectRecords(parseJson(bytes, entry.name), entry.name, conversations, projects);
      fileCount += 1;
    }
  } else {
    throw new Error('ChatGPT 또는 Claude 내보내기 ZIP이나 JSON 파일을 선택해 주세요.');
  }

  const uniqueProjects = new Map();
  for (const record of projects) {
    const normalized = normalizeProject(record);
    const key = normalized.sourceId || `${normalized.name}:${normalized.instructions}`;
    if (key && !uniqueProjects.has(key)) uniqueProjects.set(key, normalized);
  }
  const uniqueConversations = new Map();
  for (const record of conversations) {
    const normalized = normalizeConversation(record);
    if (!normalized) continue;
    const key = normalized.sourceId || `${normalized.title}:${normalized.createdAt}:${normalized.messages[0]?.content || ''}`;
    if (!uniqueConversations.has(key)) uniqueConversations.set(key, normalized);
    if (uniqueConversations.size > MAX_IMPORT_CONVERSATIONS) {
      throw new Error(`가져올 수 있는 대화는 한 번에 ${MAX_IMPORT_CONVERSATIONS.toLocaleString()}개까지입니다.`);
    }
  }
  if (!uniqueProjects.size && !uniqueConversations.size) throw new Error('내보내기에서 가져올 대화나 프로젝트를 찾지 못했습니다.');
  return {
    suggestedProvider: [...conversations].some((item) => Array.isArray(item?.chat_messages) || item?.project_uuid)
      ? 'anthropic'
      : 'openai',
    projects: [...uniqueProjects.values()],
    conversations: [...uniqueConversations.values()],
    sourceFileCount: fileCount,
    sourceJsonBytes: jsonBytes,
  };
}

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_RESPONSE_BYTES = 2_000_000;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('올바른 API 기본 주소를 입력해 주세요.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw fail('API 주소에는 HTTPS를 사용해 주세요. 로컬 서버만 HTTP를 사용할 수 있습니다.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw fail('API 주소에 로그인 정보, 쿼리 또는 #을 포함할 수 없습니다.');
  }
  if (/\/(models|chat\/completions)\/?$/.test(url.pathname)) {
    throw fail('API 기본 주소만 입력해 주세요. /models 또는 /chat/completions는 자동으로 붙습니다.');
  }
  return url.href.replace(/\/+$/, '');
}

function chatModelId(connection, model) {
  if (new URL(connection.baseUrl).hostname === 'generativelanguage.googleapis.com') {
    return model.replace(/^models\//, '');
  }
  return model;
}

function validateKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\r\n\0]/.test(value)) {
    throw fail('유효한 API 키를 입력해 주세요.');
  }
  return value.trim();
}

function remoteError(status) {
  const messages = {
    400: 'API가 요청을 거절했습니다. 선택한 모델의 Chat Completions 지원 여부와 대화 길이를 확인해 주세요.',
    401: 'API 키가 올바르지 않거나 만료되었습니다. 연결을 편집해 키를 다시 입력해 주세요.',
    403: '이 API 키에 모델 접근 권한이 없습니다.',
    404: 'API 경로 또는 모델을 찾지 못했습니다. 기본 주소를 확인하고 모델을 새로고침해 주세요.',
    429: 'API의 사용 한도 또는 요청 제한에 도달했습니다. 해당 서비스의 사용량을 확인해 주세요.',
  };
  const error = fail(messages[status] || `API 서버가 요청을 처리하지 못했습니다 (HTTP ${status}).`, 502);
  error.remoteStatus = status;
  return error;
}

async function readLimitedJson(response) {
  const parts = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw fail('API 응답이 너무 큽니다.', 502);
    parts.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw fail('API가 올바른 JSON 응답을 반환하지 않았습니다.', 502); }
}

// 암호화는 renderer나 HTTP에 노출하지 않고 Electron 부모 프로세스에만 요청합니다.
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

export class ApiConnections {
  #directory;
  #file;
  #connections = [];
  #keys = new Map();
  #active = new Map();
  #ready;
  #writes = Promise.resolve();
  #secrets = desktopSecrets();

  constructor(directory) {
    this.#directory = directory;
    this.#file = join(directory, 'api-connections.json');
    this.#ready = this.#load();
    this.#ready.catch(() => {});
  }

  async #load() {
    try {
      const data = JSON.parse(await readFile(this.#file, 'utf8'));
      if (!Array.isArray(data.connections)) throw new Error('Invalid connections');
      this.#connections = data.connections;
    } catch (error) {
      if (error.code !== 'ENOENT') throw fail('API 연결 설정을 읽지 못했습니다. 기존 설정 파일을 확인해 주세요.', 500);
    }
  }

  #public(connection) {
    const connected = Boolean(this.#keys.has(connection.id) || (this.#secrets && connection.encryptedKey));
    return {
      id: connection.id, name: connection.name, baseUrl: connection.baseUrl,
      models: connection.models, connected, updatedAt: connection.updatedAt,
      label: connected ? '연결됨' : 'API 키 필요',
    };
  }

  async list() {
    await this.#ready;
    return { connections: this.#connections.map((item) => this.#public(item)), keyStorage: this.#secrets ? 'keychain' : 'session' };
  }

  #mutate(callback) {
    const operation = this.#writes.then(async () => { await this.#ready; return callback(); });
    this.#writes = operation.catch(() => {});
    return operation;
  }

  async #save(connections) {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const temporaryFile = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryFile, JSON.stringify({ version: 1, connections }, null, 2), { mode: 0o600 });
      await rename(temporaryFile, this.#file);
      this.#connections = connections;
    } finally { await rm(temporaryFile, { force: true }); }
  }

  #find(id) {
    const connection = this.#connections.find((item) => item.id === id);
    if (!connection) throw fail('삭제되었거나 존재하지 않는 API 연결입니다. 다른 모델을 선택해 주세요.', 404);
    return connection;
  }

  #assertIdle(id) {
    if (this.#active.get(id)) throw fail('이 에이전트의 응답이 끝난 뒤 연결을 변경해 주세요.', 409);
  }

  async #key(connection) {
    if (this.#keys.has(connection.id)) return this.#keys.get(connection.id);
    if (this.#secrets && connection.encryptedKey) return this.#secrets('decrypt', connection.encryptedKey);
    throw fail('이 에이전트의 API 키를 다시 입력해 주세요.', 401);
  }

  async #request(connection, key, path, options = {}) {
    try {
      const response = await fetch(`${connection.baseUrl}/${path}`, {
        ...options,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...options.headers },
        // 다른 호스트로 이동하면서 API 키가 전달되는 것을 막습니다.
        redirect: 'manual',
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status >= 300 && response.status < 400) throw fail('API 주소가 다른 주소로 이동합니다. 서비스가 제공한 최종 기본 주소를 입력해 주세요.', 502);
        throw remoteError(response.status);
      }
      return response;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (error.status) throw error;
      throw fail('API 서버에 연결하지 못했습니다. 주소와 네트워크 연결을 확인해 주세요.', 502);
    }
  }

  async #models(connection, key) {
    const signal = AbortSignal.timeout(20_000);
    try {
      const response = await this.#request(connection, key, 'models', { signal });
      const payload = await readLimitedJson(response);
      if (!Array.isArray(payload.data)) throw fail('이 서버는 OpenAI 호환 /models 목록을 제공하지 않습니다.', 502);
      const seen = new Set();
      const models = payload.data.filter((model) => {
        if (typeof model?.id !== 'string' || !model.id.trim() || model.id.length > 240 || /[\x00-\x1f]/.test(model.id) || seen.has(model.id)) return false;
        if (Array.isArray(model.output_modalities) && !model.output_modalities.includes('text')) return false;
        if (new URL(connection.baseUrl).hostname === 'api.openai.com' && /^(text-embedding|tts-|whisper-|dall-e-|gpt-image|omni-moderation|text-moderation|sora-)|realtime|transcribe/.test(model.id)) return false;
        seen.add(model.id);
        return true;
      }).slice(0, 500).map((model) => ({ id: model.id, label: String(model.name || model.id).slice(0, 240) }));
      if (!models.length) throw fail('이 API 키로 사용할 수 있는 텍스트 모델이 없습니다.', 502);
      return models.sort((a, b) => a.label.localeCompare(b.label));
    } catch (error) {
      if (signal.aborted) throw fail('모델 목록 조회 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.', 504);
      throw error;
    }
  }

  async connect(input, id = null) {
    return this.#mutate(async () => {
      if (!input || typeof input !== 'object') throw fail('연결 정보를 입력해 주세요.');
      const previous = id ? this.#find(id) : null;
      if (id) this.#assertIdle(id);
      if (!id && this.#connections.length >= 32) throw fail('API 에이전트는 최대 32개까지 연결할 수 있습니다.');
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name || name.length > 60) throw fail('에이전트 이름은 1~60자로 입력해 주세요.');
      const baseUrl = normalizeBaseUrl(input.baseUrl);
      const hasNewKey = typeof input.apiKey === 'string' && input.apiKey.trim().length > 0;
      if (previous && previous.baseUrl !== baseUrl && !hasNewKey) throw fail('API 주소를 변경할 때는 해당 서버의 API 키도 새로 입력해 주세요.');
      const key = hasNewKey ? validateKey(input.apiKey) : previous ? await this.#key(previous) : validateKey(input.apiKey);
      const connection = { id: id || randomUUID(), name, baseUrl };
      connection.models = await this.#models(connection, key);
      connection.encryptedKey = this.#secrets ? await this.#secrets('encrypt', key) : null;
      connection.updatedAt = Date.now();
      // 조회 중 시작된 응답도 보호합니다. 저장 실패 시 기존 연결과 키를 보존합니다.
      if (id) this.#assertIdle(id);
      await this.#save(previous ? this.#connections.map((item) => item.id === id ? connection : item) : [...this.#connections, connection]);
      this.#keys.set(connection.id, key);
      return this.#public(connection);
    });
  }

  async refresh(id) {
    return this.#mutate(async () => {
      const previous = this.#find(id);
      const key = await this.#key(previous);
      const models = await this.#models(previous, key);
      const connection = { ...previous, models, updatedAt: Date.now() };
      await this.#save(this.#connections.map((item) => item.id === id ? connection : item));
      return this.#public(connection);
    });
  }

  async remove(id, disconnectOnly = false) {
    return this.#mutate(async () => {
      this.#find(id);
      this.#assertIdle(id);
      const next = disconnectOnly
        ? this.#connections.map((item) => item.id === id ? { ...item, encryptedKey: null } : item)
        : this.#connections.filter((item) => item.id !== id);
      await this.#save(next);
      this.#keys.delete(id);
    });
  }

  async chat(id, model, messages, { signal, onDelta, onUsage }) {
    await this.#ready;
    await this.#writes;
    const connection = this.#find(id);
    if (!connection.models.some((item) => item.id === model)) throw fail('이 연결의 모델 목록에 없는 모델입니다. 목록을 새로고침해 주세요.');
    this.#active.set(id, (this.#active.get(id) || 0) + 1);
    const timeout = AbortSignal.timeout(180_000);
    const requestSignal = AbortSignal.any([signal, timeout]);
    let outputLength = 0;
    const append = (text) => {
      if (typeof text !== 'string' || !text) return;
      outputLength += text.length;
      if (outputLength > 40_000) throw fail('응답이 저장 가능한 길이를 초과했습니다. 더 짧게 요청해 주세요.', 502);
      onDelta(text);
    };
    try {
      const key = await this.#key(connection);
      let response;
      try {
        response = await this.#request(connection, key, 'chat/completions', {
          method: 'POST', signal: requestSignal,
          body: JSON.stringify({ model: chatModelId(connection, model), messages, stream: true, stream_options: { include_usage: true } }),
        });
      } catch (error) {
        // Some OpenAI-compatible services reject stream_options. Retry only their explicit
        // HTTP 400 response so those integrations keep working without usage metadata.
        if (error.remoteStatus !== 400) throw error;
        response = await this.#request(connection, key, 'chat/completions', {
          method: 'POST', signal: requestSignal,
          body: JSON.stringify({ model: chatModelId(connection, model), messages, stream: true }),
        });
      }
      if ((response.headers.get('content-type') || '').includes('application/json')) {
        const result = await readLimitedJson(response);
        append(result.choices?.[0]?.message?.content);
        if (!outputLength) throw fail('API가 텍스트 응답을 반환하지 않았습니다.', 502);
        await onUsage?.(result.usage, connection);
        return;
      }
      let buffer = '';
      let completed = false;
      let terminal = false;
      let reportedUsage = null;
      const decoder = new TextDecoder();
      const consume = (frame) => {
        const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n').trim();
        if (!data) return;
        if (data === '[DONE]') { completed = true; terminal = true; return; }
        let payload;
        try { payload = JSON.parse(data); } catch { throw fail('API 응답 스트림의 형식이 올바르지 않습니다.', 502); }
        if (payload.error) throw fail('API가 응답 도중 오류를 반환했습니다. 서비스 상태와 사용 한도를 확인해 주세요.', 502);
        if (payload.usage && typeof payload.usage === 'object') reportedUsage = payload.usage;
        const choice = payload.choices?.find((item) => item.index === 0) || payload.choices?.[0];
        append(choice?.delta?.content);
        if (choice?.finish_reason) {
          if (!['stop', 'length'].includes(choice.finish_reason)) throw fail('모델이 텍스트 응답을 완료하지 못했습니다. 다른 모델이나 요청을 사용해 주세요.', 502);
          completed = true;
        }
      };
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        if (buffer.length > MAX_RESPONSE_BYTES) throw fail('API 스트림의 한 이벤트가 너무 큽니다.', 502);
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          consume(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (terminal) break;
        }
        if (terminal) break;
      }
      buffer += decoder.decode();
      if (!terminal && buffer.trim()) consume(buffer.replace(/\r\n/g, '\n'));
      if (!completed) throw fail('API 연결이 응답 완료 전에 끊겼습니다. 다시 시도해 주세요.', 502);
      if (!outputLength) throw fail('모델이 텍스트를 반환하지 않았습니다. Chat Completions를 지원하는 모델을 선택해 주세요.', 502);
      await onUsage?.(reportedUsage, connection);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (timeout.aborted) throw fail('API 응답 시간이 초과되었습니다.', 504);
      if (error.status) throw error;
      throw fail('API 응답을 읽는 도중 연결이 끊겼습니다.', 502);
    } finally {
      const count = (this.#active.get(id) || 1) - 1;
      if (count) this.#active.set(id, count); else this.#active.delete(id);
    }
  }
}

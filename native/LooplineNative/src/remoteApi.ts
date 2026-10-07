import type {ModelChoice} from './types';

export type RemoteStatus = {
  tailscale: {
    installed: boolean;
    online: boolean;
    login: string;
    url: string;
    serveEnabled: boolean;
    routeConflict: boolean;
  };
  backendConnected: boolean;
  models: ModelChoice[];
};

export type RemoteRunEvent = {
  id?: string;
  title: string;
  detail?: string;
  status?: string;
  createdAt?: number;
  model?: {provider?: string; label?: string; model?: string};
};

export type RemoteRun = {
  id: string;
  status: string;
  stage?: string;
  round?: number;
  rounds?: number;
  task: string;
  summary?: string;
  canResume?: boolean;
  stageModels?: Record<string, {label?: string; provider?: string; effort?: string} | null>;
  events: RemoteRunEvent[];
};

export type RemoteChatEvent = {name: string; data: Record<string, unknown>};

export const TERMINAL_REMOTE_RUN_STATES = new Set([
  'completed', 'reviewed', 'stopped', 'failed', 'limit', 'blocked', 'interrupted',
]);

export class RemoteApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown>) {
    super(message);
    this.name = 'RemoteApiError';
  }
}

export function normalizeTailscaleBaseUrl(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error('Mac의 Tailscale 주소를 입력해 주세요.');
  const match = raw.match(/^(?:https:\/\/)?([^/:?#@]+)(?::(\d+))?(\/[^?#]*)?$/i);
  const host = match?.[1]?.toLowerCase() || '';
  const port = match?.[2] || '';
  const path = match?.[3] || '';
  const validHost = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/.test(host);
  if (!match || !validHost || (port && port !== '443') || !['', '/', '/loopline', '/loopline/'].includes(path)) {
    throw new Error('HTTPS Tailscale Serve 주소만 사용할 수 있습니다. 예: https://mac.tailnet.ts.net/loopline');
  }

  return `https://${host}/loopline`;
}

async function remoteJson<T>(baseUrl: string, path: string, method = 'GET', body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${normalizeTailscaleBaseUrl(baseUrl)}/remote-api/${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : {
          'Content-Type': 'application/json',
          'X-Loopline-Client': 'native-ios',
        }),
      },
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown> & {error?: string};
    if (!response.ok) throw new RemoteApiError(data.error || `원격 요청을 처리하지 못했습니다 (${response.status}).`, response.status, data);
    return data as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('원격 서버 응답 시간이 초과되었습니다. 연결을 확인해 주세요.');
    }
    throw error instanceof Error ? error : new Error('원격 서버에 연결하지 못했습니다.');
  } finally {
    clearTimeout(timeout);
  }
}

export function getRemoteStatus(baseUrl: string): Promise<RemoteStatus> {
  return remoteJson<RemoteStatus>(baseUrl, 'status');
}

export function createRemoteRun(baseUrl: string, input: {
  task: string;
  roles: {planner: string; worker: string; judge: string};
  roleEfforts?: {planner: string; worker: string; judge: string};
  rounds: number;
}): Promise<RemoteRun> {
  return remoteJson<RemoteRun>(baseUrl, 'runs', 'POST', input);
}

export function getRemoteRun(baseUrl: string, runId: string): Promise<RemoteRun> {
  return remoteJson<RemoteRun>(baseUrl, `runs/${encodeURIComponent(runId)}`);
}

export function stopRemoteRun(baseUrl: string, runId: string): Promise<RemoteRun> {
  return remoteJson<RemoteRun>(baseUrl, `runs/${encodeURIComponent(runId)}/stop`, 'POST', {});
}

export function resumeRemoteRun(baseUrl: string, runId: string): Promise<RemoteRun> {
  return remoteJson<RemoteRun>(baseUrl, `runs/${encodeURIComponent(runId)}/resume`, 'POST', {});
}

export type RemoteChatRequest = {
  modelKey: string;
  messages: Array<{role: 'user' | 'assistant'; content: string}>;
};

export function startRemoteChatStream(
  baseUrl: string,
  request: RemoteChatRequest,
  onEvent: (event: RemoteChatEvent) => void,
): {promise: Promise<void>; abort: () => void} {
  const xhr = new XMLHttpRequest();
  let offset = 0;
  let buffer = '';
  let settled = false;
  let streamError = '';

  const promise = new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };

    const handleBlock = (block: string) => {
      const lines = block.split(/\r?\n/);
      const name = lines.find(line => line.startsWith('event:'))?.slice(6).trim() || 'message';
      const rawData = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!rawData) return;
      try {
        const data = JSON.parse(rawData) as Record<string, unknown>;
        if (name === 'error') streamError = typeof data.error === 'string' ? data.error : '모델 응답에 실패했습니다.';
        onEvent({name, data});
      } catch {
        // Ignore partial or malformed SSE blocks and continue reading the stream.
      }
    };

    const readNewText = () => {
      try {
        const current = xhr.responseText || '';
        if (current.length < offset) offset = 0;
        buffer += current.slice(offset).replace(/\r\n/g, '\n');
        offset = current.length;
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          handleBlock(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
        }
      } catch {
        // Some iOS XHR implementations expose responseText only after completion.
      }
    };

    xhr.onreadystatechange = () => {
      if (xhr.readyState >= 3) readNewText();
      if (xhr.readyState !== 4) return;
      readNewText();
      if (xhr.status < 200 || xhr.status >= 300) {
        let message = `원격 대화 요청에 실패했습니다 (${xhr.status || '네트워크'}).`;
        try { message = (JSON.parse(xhr.responseText) as {error?: string}).error || message; } catch { /* Keep fallback. */ }
        finish(new Error(message));
        return;
      }
      if (buffer.trim()) handleBlock(buffer);
      finish(streamError ? new Error(streamError) : undefined);
    };
    xhr.onerror = () => finish(new Error('Mac에 연결하지 못했습니다. Tailscale 연결과 원격 접속 상태를 확인해 주세요.'));
    xhr.ontimeout = () => finish(new Error('응답이 오래 걸리고 있습니다. 계속 기다리거나 중지해 주세요.'));
    xhr.onabort = () => {
      const error = new Error('응답을 중지했습니다.');
      error.name = 'AbortError';
      finish(error);
    };

    try {
      xhr.open('POST', `${normalizeTailscaleBaseUrl(baseUrl)}/remote-api/chat`);
      xhr.setRequestHeader('Accept', 'text/event-stream');
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('X-Loopline-Client', 'native-ios');
      xhr.timeout = 30 * 60 * 1000;
      xhr.send(JSON.stringify(request));
    } catch (error) {
      finish(error instanceof Error ? error : new Error('요청을 시작하지 못했습니다.'));
    }
  });

  return {promise, abort: () => xhr.abort()};
}

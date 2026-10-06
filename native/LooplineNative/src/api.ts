import type {ConnectionSummary, ModelChoice, ProviderId} from './types';

export const DEFAULT_API_BASE_URL = 'http://localhost:4173';
export const LOOP_COMPLETE_MARKER = '[[LOOP_ENGINEERING_COMPLETE]]';

type ProviderStatus = {
  linked?: boolean;
  connected?: boolean;
  models?: Array<Record<string, unknown>>;
};

type StatusResponse = {
  providers?: Record<string, ProviderStatus>;
  codexAccounts?: Array<{
    id: string;
    name?: string;
    linked?: boolean;
    connected?: boolean;
    models?: Array<Record<string, unknown>>;
  }>;
  connections?: Array<{
    id: string;
    name: string;
    connected?: boolean;
    models?: Array<Record<string, unknown>>;
  }>;
};

const claudeModels = [
  {id: 'claude-sonnet-5', label: 'Claude Sonnet 5'},
  {id: 'claude-opus-5', label: 'Claude Opus 5'},
  {id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5'},
];

export function normalizeLocalApiUrl(value: string): string {
  const normalized = value.trim();
  const match = normalized.match(/^http:\/\/(localhost|127\.0\.0\.1)(?::(\d{1,5}))?\/?$/i);
  if (!match) {
    if (/^https?:\/\//i.test(normalized)) {
      throw new Error('보안을 위해 현재 앱은 이 Mac의 localhost 서버에만 연결합니다.');
    }
    throw new Error('서버 주소를 확인해 주세요. 예: http://localhost:4173');
  }

  const port = Number(match[2] || 80);
  if (port < 1 || port > 65_535) throw new Error('서버 포트는 1부터 65535 사이여야 합니다.');
  return `http://${match[1].toLowerCase()}${match[2] ? `:${port}` : ''}`;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function createChoice(input: {
  provider: ProviderId;
  providerLabel: string;
  id: unknown;
  label: unknown;
  accountId?: string;
  accountName?: string;
  connectionId?: string;
  connectionName?: string;
  reasoningEfforts?: unknown;
}): ModelChoice | null {
  const id = text(input.id);
  if (!id) return null;
  const label = text(input.label) || id.replace(/^models\//, '');
  const key = [input.provider, input.accountId || '', input.connectionId || '', id].join(':');
  return {
    key,
    provider: input.provider,
    providerLabel: input.providerLabel,
    id,
    label,
    ...(input.accountId ? {accountId: input.accountId} : {}),
    ...(input.connectionId ? {connectionId: input.connectionId} : {}),
    ...(input.connectionName ? {connectionName: input.connectionName} : {}),
    ...(input.accountName ? {accountName: input.accountName} : {}),
    ...(Array.isArray(input.reasoningEfforts)
      ? {supportedReasoningEfforts: input.reasoningEfforts.filter((item): item is string => typeof item === 'string')}
      : {}),
  };
}

function collectChoices(status: StatusResponse): ModelChoice[] {
  const choices: ModelChoice[] = [];
  const openaiStatus = status.providers?.openai;
  const codexAccounts = Array.isArray(status.codexAccounts) ? status.codexAccounts : [];

  for (const account of codexAccounts) {
    if (!account.connected || account.linked === false) continue;
    for (const model of account.models || []) {
      const choice = createChoice({
        provider: 'openai',
        providerLabel: 'Codex',
        id: model.id || model.model,
        label: model.label || model.displayName || model.id,
        accountId: account.id,
        accountName: account.name,
        reasoningEfforts: model.supportedReasoningEfforts,
      });
      if (choice) choices.push(choice);
    }
  }

  if (!choices.some(choice => choice.provider === 'openai') && openaiStatus?.connected) {
    for (const model of openaiStatus.models || []) {
      const choice = createChoice({
        provider: 'openai',
        providerLabel: 'Codex',
        id: model.id || model.model,
        label: model.label || model.displayName || model.id,
        accountId: 'default',
        reasoningEfforts: model.supportedReasoningEfforts,
      });
      if (choice) choices.push(choice);
    }
  }

  const claudeStatus = status.providers?.anthropic;
  if (claudeStatus?.connected && claudeStatus.linked !== false) {
    for (const model of claudeModels) {
      const choice = createChoice({
        provider: 'anthropic',
        providerLabel: 'Claude Code',
        id: model.id,
        label: model.label,
      });
      if (choice) choices.push(choice);
    }
  }

  for (const connection of status.connections || []) {
    if (!connection.connected) continue;
    for (const model of connection.models || []) {
      const choice = createChoice({
        provider: 'api',
        providerLabel: 'API 연결',
        id: model.id || model.displayId,
        label: model.label || model.id,
        connectionId: connection.id,
        connectionName: connection.name,
      });
      if (choice) choices.push(choice);
    }
  }

  return choices;
}

export async function loadModelChoices(apiBaseUrl: string): Promise<{
  models: ModelChoice[];
  summary: ConnectionSummary;
}> {
  const baseUrl = normalizeLocalApiUrl(apiBaseUrl);
  const response = await fetch(`${baseUrl}/api/status`, {
    headers: {Accept: 'application/json'},
  });
  const body = (await response.json().catch(() => ({}))) as StatusResponse & {error?: string};
  if (!response.ok) {
    throw new Error(body.error || `서버 응답을 읽지 못했습니다 (${response.status}).`);
  }

  const models = collectChoices(body);
  const summary: ConnectionSummary = {
    connectedModels: models.length,
    connectedProviders: [...new Set(models.map(model => model.providerLabel))],
  };
  return {models, summary};
}

export type ChatStreamEvent = {
  name: string;
  data: Record<string, unknown>;
};

export type ChatStreamCallbacks = {
  onDelta: (value: string) => void;
  onEvent?: (event: ChatStreamEvent) => void;
};

export type ChatStreamRequest = {
  provider: ProviderId;
  model: string;
  connectionId?: string;
  codexAccountId?: string;
  codexThreadId?: string;
  reasoningEffort?: string;
  agentInstructions?: string;
  messages: Array<{role: 'user' | 'assistant'; content: string}>;
};

export function startChatStream(
  apiBaseUrl: string,
  request: ChatStreamRequest,
  callbacks: ChatStreamCallbacks,
): {promise: Promise<void>; abort: () => void} {
  const baseUrl = normalizeLocalApiUrl(apiBaseUrl);
  const xhr = new XMLHttpRequest();
  let settled = false;
  let offset = 0;
  let buffer = '';
  let streamError: string | undefined;

  const promise = new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };

    const handleBlock = (block: string) => {
      const lines = block.split(/\r?\n/);
      const eventName = lines.find(line => line.startsWith('event:'))?.slice(6).trim() || 'message';
      const dataText = lines
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
      if (!dataText) return;

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(dataText) as Record<string, unknown>;
      } catch {
        return;
      }

      if (eventName === 'delta' && typeof data.text === 'string') callbacks.onDelta(data.text);
      if (eventName === 'error') streamError = text(data.error) || 'AI 응답에 실패했습니다.';
      callbacks.onEvent?.({name: eventName, data});
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
        // Some native XMLHttpRequest implementations do not expose partial responseText.
        // The final readyState still contains the complete event stream.
      }
    };

    xhr.onreadystatechange = () => {
      if (xhr.readyState >= 3) readNewText();
      if (xhr.readyState !== 4) return;
      readNewText();

      if (xhr.status < 200 || xhr.status >= 300) {
        let message = `요청에 실패했습니다 (${xhr.status || '네트워크'}).`;
        try {
          const body = JSON.parse(xhr.responseText) as {error?: string};
          message = body.error || message;
        } catch {
          // Keep the status based message for non-JSON responses.
        }
        finish(new Error(message));
        return;
      }

      if (buffer.trim()) handleBlock(buffer);
      finish(streamError ? new Error(streamError) : undefined);
    };
    xhr.onerror = () => finish(new Error('Loopline 서버에 연결하지 못했습니다. 서버 실행 상태를 확인해 주세요.'));
    xhr.ontimeout = () => finish(new Error('응답 시간이 초과되었습니다. 계속 기다리거나 중지해 주세요.'));
    xhr.onabort = () => {
      const error = new Error('응답을 중지했습니다.');
      error.name = 'AbortError';
      finish(error);
    };

    try {
      xhr.open('POST', `${baseUrl}/api/chat`);
      xhr.setRequestHeader('Accept', 'text/event-stream');
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.timeout = 30 * 60 * 1000;
      xhr.send(JSON.stringify(request));
    } catch (error) {
      finish(error instanceof Error ? error : new Error('요청을 시작하지 못했습니다.'));
    }
  });

  return {promise, abort: () => xhr.abort()};
}

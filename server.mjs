import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, 'public');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';

const modelAllowlist = {
  openai: new Set(['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna']),
  anthropic: new Set(['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001']),
};

await loadLocalEnv();

function parseEnvValue(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, '');
}

async function loadLocalEnv() {
  try {
    const source = await readFile(join(root, '.env'), 'utf8');
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = parseEnvValue(match[2]);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const hostHeader = req.headers.host || '';
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(hostHeader)) return false;
  return origin === `http://${hostHeader}`;
}

async function readJson(req) {
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

function sendEvent(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function* sseEvents(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');

      let separator;
      while ((separator = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const data = block.split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) yield data;
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

async function readProviderError(response) {
  const body = await response.text();
  let message = `제공자 요청이 실패했습니다 (${response.status}).`;
  try {
    const parsed = JSON.parse(body);
    message = parsed.error?.message || parsed.message || message;
  } catch {
    if (body) message = body.slice(0, 500);
  }
  if (response.status === 401 || response.status === 403) {
    return 'API 키가 유효하지 않거나 해당 모델을 사용할 권한이 없습니다. .env 설정을 확인해 주세요.';
  }
  if (response.status === 429) {
    return `제공자 API 한도 또는 예산에 도달했습니다. 계정의 사용량·결제 설정을 확인해 주세요. (${message})`;
  }
  return message;
}

async function relayChat(req, res) {
  let abortController;
  try {
    const body = await readJson(req);
    const { provider, model } = body;
    if (!Object.hasOwn(modelAllowlist, provider) || !modelAllowlist[provider].has(model)) {
      return json(res, 400, { error: '지원하지 않는 제공자 또는 모델입니다.' });
    }

    const apiKey = provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return json(res, 400, {
        error: provider === 'openai'
          ? 'OPENAI_API_KEY가 설정되지 않았습니다. 앱 폴더의 .env 파일을 확인해 주세요.'
          : 'ANTHROPIC_API_KEY가 설정되지 않았습니다. 앱 폴더의 .env 파일을 확인해 주세요.',
      });
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 60) {
      return json(res, 400, { error: '대화 메시지 형식이 올바르지 않습니다.' });
    }
    const messages = body.messages.map((message) => {
      if (!['user', 'assistant'].includes(message?.role) || typeof message.content !== 'string') {
        throw Object.assign(new Error('메시지 형식이 올바르지 않습니다.'), { status: 400 });
      }
      return { role: message.role, content: message.content.slice(0, 40_000) };
    });

    abortController = new AbortController();
    res.on('close', () => abortController.abort());
    const providerUrl = provider === 'openai'
      ? 'https://api.openai.com/v1/responses'
      : 'https://api.anthropic.com/v1/messages';
    const headers = provider === 'openai'
      ? { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
      : {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        };
    const payload = provider === 'openai'
      ? { model, input: messages, stream: true, max_output_tokens: 4096 }
      : { model, messages, stream: true, max_tokens: 4096 };

    const upstream = await fetch(providerUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(120_000)]),
    });
    if (!upstream.ok) {
      const message = await readProviderError(upstream);
      return json(res, upstream.status, { error: message });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });

    for await (const rawEvent of sseEvents(upstream.body)) {
      if (rawEvent === '[DONE]') break;
      let event;
      try {
        event = JSON.parse(rawEvent);
      } catch {
        continue;
      }

      if (provider === 'openai') {
        if (event.type === 'response.output_text.delta' && event.delta) {
          sendEvent(res, 'delta', { text: event.delta });
        } else if (event.type === 'error' || event.type === 'response.failed') {
          const message = event.error?.message || event.response?.error?.message || 'OpenAI 응답 생성에 실패했습니다.';
          sendEvent(res, 'error', { error: message });
          return res.end();
        }
      } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        sendEvent(res, 'delta', { text: event.delta.text });
      } else if (event.type === 'error') {
        sendEvent(res, 'error', { error: event.error?.message || 'Claude 응답 생성에 실패했습니다.' });
        return res.end();
      }
    }
    sendEvent(res, 'done', {});
    res.end();
  } catch (error) {
    if (res.destroyed) return;
    if (res.headersSent) {
      if (!res.writableEnded) {
        sendEvent(res, 'error', { error: error.name === 'TimeoutError' ? '요청 시간이 초과되었습니다.' : error.message || '요청 처리 중 오류가 발생했습니다.' });
        return res.end();
      }
      return;
    }
    json(res, error.status || 500, { error: error.message || '요청 처리 중 오류가 발생했습니다.' });
  }
}

async function serveFile(res, pathname) {
  const files = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  };
  const entry = files[pathname];
  if (!entry) return json(res, 404, { error: '페이지를 찾을 수 없습니다.' });
  try {
    const content = await readFile(join(publicDir, entry[0]));
    res.writeHead(200, {
      'Content-Type': entry[1],
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    });
    res.end(content);
  } catch {
    json(res, 500, { error: '화면 파일을 읽을 수 없습니다.' });
  }
}

const server = createServer(async (req, res) => {
  if (!allowedOrigin(req)) return json(res, 403, { error: '허용되지 않은 요청 출처입니다.' });
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  if (req.method === 'GET' && url.pathname === '/api/status') {
    return json(res, 200, {
      providers: {
        openai: Boolean(process.env.OPENAI_API_KEY),
        anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
      },
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/chat') return relayChat(req, res);
  if (req.method === 'GET') return serveFile(res, url.pathname);
  return json(res, 405, { error: '지원하지 않는 요청입니다.' });
});

server.listen(port, host, () => {
  console.log(`Mosaic AI 실행 중: http://${host}:${port}`);
  console.log('종료하려면 Ctrl+C를 누르세요.');
});

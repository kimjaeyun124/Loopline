import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ASSETS = Object.freeze({
  '/': { file: './index.html', contentType: 'text/html; charset=utf-8' },
  '/index.html': { file: './index.html', contentType: 'text/html; charset=utf-8' },
  '/styles.css': { file: './styles.css', contentType: 'text/css; charset=utf-8' },
  '/app.mjs': { file: './app.mjs', contentType: 'text/javascript; charset=utf-8' },
  '/model.mjs': { file: './model.mjs', contentType: 'text/javascript; charset=utf-8' },
});

function respond(response, status, contentType, body, headOnly = false) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(headOnly ? '' : body);
}

export async function handleRequest(request, response) {
  const method = String(request.method ?? 'GET').toUpperCase();
  const headOnly = method === 'HEAD';
  if (method !== 'GET' && !headOnly) {
    response.writeHead(405, {
      'Content-Type': 'text/plain; charset=utf-8',
      Allow: 'GET, HEAD',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end('Method Not Allowed\n');
    return;
  }

  let pathname;
  try {
    pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    respond(response, 400, 'text/plain; charset=utf-8', 'Bad Request\n', headOnly);
    return;
  }

  const asset = ASSETS[pathname];
  if (!asset) {
    respond(response, 404, 'text/plain; charset=utf-8', 'Not Found\n', headOnly);
    return;
  }

  try {
    const body = await readFile(new URL(asset.file, import.meta.url), 'utf8');
    respond(response, 200, asset.contentType, body, headOnly);
  } catch {
    respond(response, 500, 'text/plain; charset=utf-8', 'Internal Server Error\n', headOnly);
  }
}

export function resolvePort(env = process.env) {
  const value = env.PORT;
  if (value === undefined || String(value).trim() === '') return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError('PORT must be an integer from 0 to 65535.');
  }
  return port;
}

const entry = process.argv[1];
if (entry && pathToFileURL(resolve(entry)).href === import.meta.url) {
  const port = resolvePort();
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Focus Board: http://127.0.0.1:${port}/`);
  });
}

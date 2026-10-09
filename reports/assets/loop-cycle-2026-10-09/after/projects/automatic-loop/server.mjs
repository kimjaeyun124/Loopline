import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROUTES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/app.mjs', 'app.mjs'],
  ['/model.mjs', 'model.mjs'],
]);

const MIME_TYPES = new Map([
  ['index.html', 'text/html'],
  ['styles.css', 'text/css'],
  ['app.mjs', 'application/javascript'],
  ['model.mjs', 'application/javascript'],
]);

export function getPort(portValue = process.env.PORT) {
  if (portValue === undefined || portValue === '') return 3000;
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError('PORT must be an integer between 0 and 65535.');
  }
  return port;
}

export async function handleRequest(request, response) {
  if (request.method && request.method !== 'GET' && request.method !== 'HEAD') {
    response.statusCode = 405;
    response.setHeader('Allow', 'GET, HEAD');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end('Method not allowed');
    return;
  }

  let pathname;
  try {
    pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    response.statusCode = 400;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end('Bad request');
    return;
  }

  const filename = ROUTES.get(pathname);
  if (!filename) {
    response.statusCode = 404;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end('Not found');
    return;
  }

  try {
    const content = await readFile(new URL(filename, import.meta.url), 'utf8');
    response.statusCode = 200;
    response.setHeader('Content-Type', `${MIME_TYPES.get(filename)}; charset=utf-8`);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.end(request.method === 'HEAD' ? '' : content);
  } catch {
    response.statusCode = 500;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end('Unable to read application file');
  }
}

const isMainModule = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  const port = getPort();
  createServer(handleRequest).listen(port, '127.0.0.1', () => {
    console.log(`Focus Board is available at http://127.0.0.1:${port}/`);
  });
}

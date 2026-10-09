import assert from 'node:assert/strict';
import test from 'node:test';
import { getPort, handleRequest } from './server.mjs';

class FakeResponse {
  statusCode = 200;
  headers = new Map();
  body = '';

  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), value);
  }

  end(chunk = '') {
    this.body += chunk;
  }

  getHeader(name) {
    return this.headers.get(name.toLowerCase());
  }
}

async function request(path, method = 'GET') {
  const response = new FakeResponse();
  await handleRequest({ url: path, method }, response);
  return response;
}

test('serves the HTML page, stylesheet, and JavaScript modules with their MIME types', async () => {
  const cases = [
    ['/', 'text/html; charset=utf-8'],
    ['/styles.css', 'text/css; charset=utf-8'],
    ['/app.mjs', 'application/javascript; charset=utf-8'],
    ['/model.mjs', 'application/javascript; charset=utf-8'],
  ];

  for (const [path, mimeType] of cases) {
    const response = await request(path);
    assert.equal(response.statusCode, 200, path);
    assert.equal(response.getHeader('content-type'), mimeType, path);
    assert.ok(response.body.length > 0, path);
  }
});

test('returns 404 for an unknown path', async () => {
  const response = await request('/missing.js');
  assert.equal(response.statusCode, 404);
  assert.equal(response.getHeader('content-type'), 'text/plain; charset=utf-8');
  assert.equal(response.body, 'Not found');
});

test('uses the default port and honors PORT without opening a server', () => {
  const previousPort = process.env.PORT;
  try {
    delete process.env.PORT;
    assert.equal(getPort(), 3000);
    process.env.PORT = '4321';
    assert.equal(getPort(), 4321);
  } finally {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
});

test('rejects invalid PORT values', () => {
  assert.throws(() => getPort('not-a-port'), RangeError);
  assert.throws(() => getPort('65536'), RangeError);
});

test('rejects unsupported methods without serving a file', async () => {
  const response = await request('/', 'POST');
  assert.equal(response.statusCode, 405);
  assert.equal(response.getHeader('allow'), 'GET, HEAD');
});

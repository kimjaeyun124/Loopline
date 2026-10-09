import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, resolvePort } from './server.mjs';

function makeResponse() {
  return {
    statusCode: undefined,
    headers: undefined,
    body: undefined,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = '') {
      this.body = String(body);
    },
  };
}

async function request(path, method = 'GET') {
  const response = makeResponse();
  await handleRequest({ method, url: path }, response);
  return response;
}

test('루트와 화면 자산에 상태·본문·MIME을 반환한다', async (t) => {
  const cases = [
    ['/', 'text/html; charset=utf-8', '<title>Focus Board'],
    ['/styles.css?version=1', 'text/css; charset=utf-8', '.board'],
    ['/app.mjs', 'text/javascript; charset=utf-8', 'focus-board-v1'],
    ['/model.mjs', 'text/javascript; charset=utf-8', 'addTask'],
  ];

  for (const [path, mime, marker] of cases) {
    await t.test(path, async () => {
      const response = await request(path);
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['Content-Type'], mime);
      assert.ok(response.body.includes(marker), `응답에 ${marker} 내용이 있어야 합니다.`);
      assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
    });
  }
});

test('알 수 없는 경로는 404를, 지원하지 않는 메서드는 405를 반환한다', async () => {
  const missing = await request('/missing.js');
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.headers['Content-Type'], 'text/plain; charset=utf-8');
  assert.equal(missing.body, 'Not Found\n');

  const unsupported = await request('/', 'POST');
  assert.equal(unsupported.statusCode, 405);
  assert.equal(unsupported.headers.Allow, 'GET, HEAD');
  assert.equal(unsupported.body, 'Method Not Allowed\n');
});

test('HEAD는 GET과 같은 성공 상태와 MIME을 주고 본문은 비운다', async () => {
  const response = await request('/styles.css', 'HEAD');
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Content-Type'], 'text/css; charset=utf-8');
  assert.equal(response.body, '');
});

test('기본 포트와 PORT 환경 설정을 해석한다', () => {
  assert.equal(resolvePort({}), 3000);
  assert.equal(resolvePort({ PORT: '' }), 3000);
  assert.equal(resolvePort({ PORT: '4317' }), 4317);
  assert.throws(() => resolvePort({ PORT: 'invalid' }), RangeError);
  assert.throws(() => resolvePort({ PORT: '65536' }), RangeError);
});

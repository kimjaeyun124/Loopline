import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "./server.mjs";

function createResponse() {
  return {
    statusCode: undefined,
    headers: undefined,
    body: undefined,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body ?? Buffer.alloc(0);
    },
  };
}

async function request(url, method = "GET") {
  const response = createResponse();
  await handleRequest({ url, method, headers: { host: "127.0.0.1" } }, response);
  return response;
}

test("루트 경로에서 HTML을 제공한다", async () => {
  const response = await request("/");

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["Content-Type"], /^text\/html; charset=utf-8$/);
  assert.match(response.body.toString("utf8"), /<html[\s>]/i);
});

test("CSS와 브라우저 모듈에 올바른 MIME을 제공한다", async () => {
  const cases = [
    ["/styles.css", /^text\/css; charset=utf-8$/],
    ["/app.mjs", /^text\/javascript; charset=utf-8$/],
    ["/model.mjs", /^text\/javascript; charset=utf-8$/],
  ];

  for (const [url, contentType] of cases) {
    const response = await request(url);
    assert.equal(response.statusCode, 200, url);
    assert.match(response.headers["Content-Type"], contentType, url);
    assert.ok(response.body.length > 0, `${url} 응답 본문이 비어 있습니다`);
  }
});

test("알 수 없는 경로는 404를 반환한다", async () => {
  const response = await request("/missing.js");

  assert.equal(response.statusCode, 404);
  assert.equal(response.body.toString("utf8"), "Not Found");
});

test("잘못된 경로와 경로 순회 요청은 400으로 거부한다", async () => {
  for (const url of ["/%ZZ", "/%2e%2e/README.md"]) {
    const response = await request(url);
    assert.equal(response.statusCode, 400, url);
  }
});

test("지원하지 않는 HTTP 메서드는 허용 메서드와 함께 405를 반환한다", async () => {
  const response = await request("/", "POST");

  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.Allow, "GET, HEAD");
});

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const STATIC_FILES = new Map([
  ["/", { file: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", contentType: "text/css; charset=utf-8" }],
  ["/app.mjs", { file: "app.mjs", contentType: "text/javascript; charset=utf-8" }],
  ["/model.mjs", { file: "model.mjs", contentType: "text/javascript; charset=utf-8" }],
]);

function send(response, statusCode, contentType, body, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
}

/** HTTP request handler is exported so tests can call it without opening a socket. */
export async function handleRequest(request, response) {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    send(response, 405, "text/plain; charset=utf-8", "Method Not Allowed", { Allow: "GET, HEAD" });
    return;
  }

  const target = request.url;
  if (typeof target !== "string" || !target.startsWith("/") || target.startsWith("//")) {
    send(response, 400, "text/plain; charset=utf-8", "Bad Request");
    return;
  }

  const rawPath = target.split(/[?#]/, 1)[0];
  let pathname;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    send(response, 400, "text/plain; charset=utf-8", "Bad Request");
    return;
  }

  if (pathname.includes("\\") || pathname.split("/").some((part) => part === "." || part === "..")) {
    send(response, 400, "text/plain; charset=utf-8", "Bad Request");
    return;
  }

  const asset = STATIC_FILES.get(pathname);
  if (!asset) {
    send(response, 404, "text/plain; charset=utf-8", "Not Found");
    return;
  }

  try {
    const body = await readFile(join(ROOT_DIR, asset.file));
    send(response, 200, asset.contentType, method === "HEAD" ? undefined : body);
  } catch {
    send(response, 500, "text/plain; charset=utf-8", "Internal Server Error");
  }
}

function startServer() {
  const port = Number(process.env.PORT || 3000);
  const server = createServer(handleRequest);
  server.listen(port, "127.0.0.1", () => {
    console.log(`Focus Board: http://127.0.0.1:${port}/`);
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  startServer();
}

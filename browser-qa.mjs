import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const QA_CATEGORIES = ['input', 'save', 'empty', 'keyboard'];
const ACTIONS = new Set(['reset', 'reload', 'fill', 'click', 'press', 'visible', 'hidden', 'text', 'value', 'count', 'focused', 'focus-visible']);
const KEYS = new Set(['Tab', 'Enter', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space', 'Backspace']);
export const BROWSER_QA_EXECUTOR = Object.freeze({
  viewports: [{ id: 'desktop', width: 1440, height: 900 }, { id: 'mobile', width: 390, height: 844 }],
  actions: [...ACTIONS],
  keys: [...KEYS],
  fixedChecks: [{ id: 'layout', after: 'every planned check and the final state', criteria: ['nonblank rendered page', 'no horizontal overflow', 'requested viewport width'] }],
  focusVisibleEvidence: 'focus-visible asserts keyboard focus plus a visible outline or a box shadow that changed from its unfocused style; focused alone asserts only the active element.',
  textEvidence: 'text asserts rendered, visible text. A document title or head metadata is not visible page text; use a visible heading for page-title UI assertions.',
});

const README_LAUNCH_RESULT = '__LOOPLINE_README_LAUNCH_QA__';
const README_MAX_BYTES = 160_000;
const README_MAX_CHECKS = 24;
const inside = (root, path) => path === root || path.startsWith(root + sep);

function parseSimpleNodeLaunch(command) {
  const line = String(command || '').trim();
  const inline = line.match(/^node\s+-e\s+'([^'\r\n]*)'\s*$/);
  if (inline) return { kind: 'inline', source: inline[1], display: 'node -e' };
  const file = line.match(/^node\s+((?:\.?\/?)[A-Za-z0-9_.\/-]+\.(?:mjs|cjs|js))\s*$/);
  if (file && !isAbsolute(file[1]) && !file[1].split(/[\\/]/).includes('..')) return { kind: 'file', path: file[1], display: `node ${file[1]}` };
  return null;
}

function supportsStaticHttpSmoke(source) {
  return /(?:node:)?http/.test(source) && /createServer/.test(source) && /\.listen\s*\(/.test(source)
    && /(?:readFile|sendFile|express\.static)/.test(source) && !/createReadStream|\.pipe\s*\(/.test(source);
}

export async function inspectReadmeLaunch(workspace) {
  let readme;
  try {
    const path = resolve(workspace, 'README.md'), info = await lstat(path);
    if (!info.isFile() || info.size > README_MAX_BYTES) return { applicable: false, reason: 'README.md가 일반 문서가 아니거나 검사 크기를 초과했습니다.' };
    readme = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { applicable: false, reason: 'README.md가 없어 실행 안내 검사를 생략했습니다.' };
    throw error;
  }
  const lines = readme.split(/\r?\n/), heading = lines.findIndex((line) => /^#{1,3}\s*(?:실행|시작|run|getting\s+started)(?:\s|$)/i.test(line));
  if (heading < 0) return { applicable: false, reason: 'README.md에 실행 안내 구역이 없어 실행 안내 검사를 생략했습니다.' };
  const end = lines.findIndex((line, index) => index > heading && /^#{1,3}\s/.test(line));
  const section = lines.slice(heading + 1, end < 0 ? lines.length : end).join('\n');
  const blocks = [...section.matchAll(/^```(?:sh|bash|shell)\s*\r?\n([\s\S]*?)^```\s*$/gim)].map((match) => match[1]);
  const commands = blocks.map((block) => block.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('#'))).filter(Boolean);
  for (const command of commands) {
    const direct = parseSimpleNodeLaunch(command);
    if (direct) return await resolveReadmeNodeLaunch(workspace, direct);
    const npm = command.match(/^npm\s+(?:run\s+)?(start|dev|serve)\s*$/);
    if (!npm) continue;
    let pkg;
    try {
      const path = resolve(workspace, 'package.json'), info = await lstat(path);
      if (!info.isFile() || info.size > 64_000) continue;
      pkg = JSON.parse(await readFile(path, 'utf8'));
    } catch { continue; }
    const scripted = parseSimpleNodeLaunch(pkg?.scripts?.[npm[1]]);
    if (scripted) return await resolveReadmeNodeLaunch(workspace, scripted, `npm ${npm[1]} → ${scripted.display}`, ['README.md', 'package.json']);
  }
  return { applicable: false, reason: 'README에 지원하는 로컬 Node 실행 명령이 없습니다. 임의 셸 명령은 실행하지 않았습니다.' };
}

async function resolveReadmeNodeLaunch(workspace, launch, display = launch.display, ownerPaths = ['README.md']) {
  if (launch.kind === 'inline') return supportsStaticHttpSmoke(launch.source) && launch.source.length <= 32_000
    ? { applicable: true, launch: { kind: 'inline', source: launch.source }, display, ownerPaths }
    : { applicable: false, reason: 'README Node 명령이 검사 가능한 내장 정적 HTTP 서버 형태가 아니어서 실행하지 않았습니다.' };
  const root = await realpath(workspace), target = resolve(root, launch.path);
  if (!inside(root, target)) return { applicable: false, reason: 'README 실행 파일이 프로젝트 폴더 밖을 가리켜 검사를 생략했습니다.' };
  let actual;
  try { actual = await realpath(target); }
  catch (error) { if (error.code === 'ENOENT') return { applicable: false, reason: `README 실행 파일 ${launch.path}이 없어 검사를 생략했습니다.` }; throw error; }
  if (!inside(root, actual) || !(await stat(actual)).isFile()) return { applicable: false, reason: 'README 실행 파일이 프로젝트 내부의 일반 파일이 아니어서 검사를 생략했습니다.' };
  const source = await readFile(actual, 'utf8');
  if (!supportsStaticHttpSmoke(source)) return { applicable: false, reason: 'README Node 명령이 검사 가능한 내장 정적 HTTP 서버 형태가 아니어서 실행하지 않았습니다.' };
  const launchPath = relative(root, actual);
  return { applicable: true, launch: { kind: 'file', path: launchPath }, display, ownerPaths: [...new Set([launchPath, ...ownerPaths])] };
}

export const README_LAUNCH_QA_PRELOAD = String.raw`
import http from 'node:http';
const marker = '__LOOPLINE_README_LAUNCH_QA__';
if (process.env.LOOPLINE_README_QA === '1') {
  const maxResponseBytes = 1_048_576;
  const maxHeaderCount = 64;
  const maxHeaderBytes = 65_536;
  const originalListen = http.Server.prototype.listen;
  const originalAddress = http.Server.prototype.address;
  const originalClose = http.Server.prototype.close;
  const active = new WeakMap();
  const emit = (payload) => process.stdout.write(marker + JSON.stringify(payload) + '\n');
  const header = (headers, name) => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1] || '';
  const request = (handler, url) => new Promise((resolve) => {
    const result = { url, status: 200, headers: {}, body: '', error: '' };
    let done = false, headersSent = false, bodyBytes = 0, headerBytes = 0;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { result.error = '응답 제한 시간 초과'; finish(); }, 1800);
    const rejectHeaders = () => {
      result.error = '응답 헤더 제한 초과 (64개 또는 64 KiB)';
      finish();
      return false;
    };
    const validateHeader = (name, value) => {
      try {
        http.validateHeaderName(name);
        http.validateHeaderValue(name, value);
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'ERR_INVALID_HEADER';
        const invalid = new Error('잘못된 응답 헤더 (' + code + ')');
        invalid.code = code;
        throw invalid;
      }
    };
    const assertHeadersMutable = () => {
      if (headersSent) {
        const error = new Error('응답 헤더 전송 후 변경 시도 (ERR_HTTP_HEADERS_SENT)');
        error.code = 'ERR_HTTP_HEADERS_SENT';
        throw error;
      }
    };
    const storeHeader = (name, value) => {
      assertHeadersMutable();
      if (done) return false;
      const rawName = String(name), rawNameBytes = Buffer.byteLength(rawName);
      if (!rawNameBytes || rawNameBytes > maxHeaderBytes) return rejectHeaders();
      if (Array.isArray(value) && value.length > maxHeaderCount) return rejectHeaders();
      validateHeader(rawName, value);
      const key = rawName.toLowerCase();
      const nameBytes = Buffer.byteLength(key);
      if (!nameBytes || nameBytes > maxHeaderBytes) return rejectHeaders();
      let normalized, valueBytes;
      if (Array.isArray(value)) {
        if (value.length > maxHeaderCount) return rejectHeaders();
        const parts = [];
        valueBytes = 0;
        for (const item of value) {
          const part = String(item), partBytes = Buffer.byteLength(part) + (parts.length ? 2 : 0);
          valueBytes += partBytes;
          if (nameBytes + valueBytes > maxHeaderBytes) return rejectHeaders();
          parts.push(part);
        }
        normalized = parts.join(', ');
      } else {
        normalized = String(value);
        valueBytes = Buffer.byteLength(normalized);
      }
      const previous = result.headers[key];
      const previousBytes = previous === undefined ? 0 : nameBytes + Buffer.byteLength(String(previous));
      const nextBytes = headerBytes - previousBytes + nameBytes + valueBytes;
      if ((previous === undefined && Object.keys(result.headers).length >= maxHeaderCount) || nextBytes > maxHeaderBytes) return rejectHeaders();
      result.headers[key] = normalized;
      headerBytes = nextBytes;
      return true;
    };
    const appendBody = (chunk) => {
      if (done || chunk == null) return !done;
      const value = Buffer.isBuffer(chunk) ? null : String(chunk);
      const byteLength = value === null ? chunk.length : Buffer.byteLength(value);
      if (bodyBytes + byteLength > maxResponseBytes) {
        result.error = '응답 크기 제한 초과 (1 MiB)';
        finish();
        return false;
      }
      bodyBytes += byteLength;
      result.body += value === null ? chunk.toString('utf8') : value;
      return true;
    };
    const response = {
      statusCode: 200,
      get headersSent() { return headersSent; },
      writeHead(status, headers = {}) {
        assertHeadersMutable();
        result.status = this.statusCode = status;
        if (headers && typeof headers === 'object') {
          for (const name in headers) if (Object.hasOwn(headers, name) && !storeHeader(name, headers[name])) break;
        }
        headersSent = true;
        return this;
      },
      setHeader(name, value) { storeHeader(name, value); return this; },
      getHeader(name) { return header(result.headers, String(name).toLowerCase()); },
      hasHeader(name) { return Object.keys(result.headers).some((key) => key.toLowerCase() === String(name).toLowerCase()); },
      removeHeader(name) {
        assertHeadersMutable();
        const key = String(name).toLowerCase(), previous = result.headers[key];
        if (previous !== undefined) { headerBytes -= Buffer.byteLength(key) + Buffer.byteLength(String(previous)); delete result.headers[key]; }
      },
      write(chunk) { headersSent = true; return appendBody(chunk); },
      end(chunk) { headersSent = true; appendBody(chunk); result.status = this.statusCode || result.status; finish(); return this; },
      flushHeaders() { headersSent = true; },
      destroy(error) { if (error) result.error = String(error.message || error); finish(); },
    };
    try {
      const returned = handler({ method: 'GET', url, headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } }, response);
      returned?.catch?.((error) => { result.error = String(error.message || error); finish(); });
    } catch (error) { result.error = String(error.message || error); finish(); }
  });
  const verify = async (server) => {
    const handler = server.listeners('request')[0];
    const checks = [], failures = [];
    if (typeof handler !== 'function') {
      emit({ passed: false, checks, failures: ['README 실행 안내가 HTTP 요청 처리기를 등록하지 않았습니다.'] });
      process.exitCode = 1; return;
    }
    const root = await request(handler, '/');
    const rootType = String(header(root.headers, 'content-type')).toLowerCase();
    const rootPassed = root.status === 200 && /text\/html/.test(rootType) && /<(?:!doctype\s+html|html)\b/i.test(root.body) && !root.error;
    checks.push({ id: 'root', passed: rootPassed, actual: { status: root.status, contentType: rootType || null, html: /<(?:!doctype\s+html|html)\b/i.test(root.body), ...(root.error ? { error: root.error } : {}) } });
    if (!rootPassed) failures.push('README 실행 안내 / 경로 / HTTP ' + root.status + ': 기본 주소가 실행 가능한 HTML을 반환하지 않았습니다' + (root.error ? ' (' + root.error + ')' : '') + '.');
    const assets = new Set();
    for (const match of root.body.matchAll(/<(script|link)\b[^>]*>/gi)) {
      const tag = match[0], kind = match[1].toLowerCase();
      const raw = kind === 'script' ? tag.match(/\bsrc\s*=\s*(["'])(.*?)\1/i)?.[2]
        : /\brel\s*=\s*(["'])[^"']*stylesheet[^"']*\1/i.test(tag) ? tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2] : null;
      if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) continue;
      try {
        const url = new URL(raw, 'http://127.0.0.1/');
        if (url.origin !== 'http://127.0.0.1') continue;
        if (/\.(?:css|m?js|cjs)$/i.test(url.pathname)) assets.add(url.pathname + url.search);
      } catch { /* Invalid external asset references are covered by browser QA. */ }
      if (assets.size >= 20) break;
    }
    for (const url of assets) {
      const result = await request(handler, url), type = String(header(result.headers, 'content-type')).toLowerCase();
      const extension = new URL(url, 'http://127.0.0.1').pathname.split('.').at(-1).toLowerCase();
      const mimePassed = extension === 'css' ? /text\/css/.test(type) : /(?:javascript|ecmascript)/.test(type);
      const passed = result.status === 200 && mimePassed && !result.error;
      checks.push({ id: 'asset:' + url, passed, actual: { status: result.status, contentType: type || null, ...(result.error ? { error: result.error } : {}) } });
      if (!passed) failures.push('README 실행 안내 / ' + url + ' / HTTP ' + result.status + ': 브라우저 자산 응답 또는 MIME 형식이 올바르지 않습니다.');
    }
    emit({ passed: failures.length === 0, checks, failures });
    if (failures.length) process.exitCode = 1;
  };
  http.Server.prototype.listen = function (...args) {
    const server = this;
    if (!active.has(server)) {
      active.set(server, { port: args.find((value) => Number.isInteger(value)) || 8000, address: args.find((value) => typeof value === 'string') || '127.0.0.1' });
      setImmediate(() => verify(server).catch((error) => { emit({ passed: false, checks: [], failures: ['README 실행 안내 QA 오류: ' + String(error.message || error).slice(0, 500)] }); process.exitCode = 1; }));
    }
    return server;
  };
  http.Server.prototype.address = function () { return active.get(this) || originalAddress.call(this); };
  http.Server.prototype.close = function (callback) { if (active.has(this)) { callback?.(); return this; } return originalClose.call(this, callback); };
}
`;

export async function verifyReadmeLaunch(workspace, { execute, signal } = {}) {
  if (signal?.aborted) throw signal.reason || new Error('README 실행 안내 QA를 중지했습니다.');
  const inspected = await inspectReadmeLaunch(workspace);
  if (!inspected.applicable) return { passed: true, applicable: false, skipped: true, display: '', ownerPaths: [], checks: [], failures: [], reason: inspected.reason };
  if (typeof execute !== 'function') throw new TypeError('README 실행 안내 검증 실행기가 필요합니다.');
  const execution = await execute(inspected.launch, { preload: README_LAUNCH_QA_PRELOAD, signal });
  if (signal?.aborted) throw signal.reason || new Error('README 실행 안내 QA를 중지했습니다.');
  const text = `${execution?.output || ''}\n${execution?.error || ''}`;
  const markers = [...text.matchAll(new RegExp(`${README_LAUNCH_RESULT}({[^\\n]*})`, 'g'))];
  const marker = markers.length === 1 ? markers[0][1] : null;
  let evidence;
  try { evidence = marker ? JSON.parse(marker) : null; } catch { evidence = null; }
  const rawFailures = evidence?.failures;
  const failuresAreValid = Array.isArray(rawFailures) && rawFailures.every((item) => typeof item === 'string');
  const failures = Array.isArray(rawFailures) ? rawFailures.filter((item) => typeof item === 'string').slice(0, 16) : [];
  const rawChecks = evidence?.checks;
  const checksAreValid = Array.isArray(rawChecks) && rawChecks.length > 0 && rawChecks.length <= README_MAX_CHECKS
    && rawChecks.every((item) => item && typeof item === 'object' && !Array.isArray(item)
      && typeof item.id === 'string' && item.id.length > 0 && typeof item.passed === 'boolean')
    && new Set(rawChecks.map((item) => item.id)).size === rawChecks.length;
  const checks = Array.isArray(rawChecks)
    ? rawChecks.filter((item) => item && typeof item === 'object' && !Array.isArray(item)
      && typeof item.id === 'string' && typeof item.passed === 'boolean').slice(0, README_MAX_CHECKS)
    : [];
  if (!evidence || !checksAreValid || !failuresAreValid || evidence.passed !== true || execution?.code !== 0) {
    if (!failures.length) {
      const reason = markers.length > 1 ? '검사 결과 표식이 여러 개라 응답이 모호합니다.'
        : !evidence ? '실제 HTTP 검사 결과를 받지 못했습니다.'
        : !checksAreValid ? '실제 HTTP 검사 목록이 누락됐거나 형식이 올바르지 않습니다.'
          : !failuresAreValid ? '실제 HTTP 실패 목록의 형식이 올바르지 않습니다.'
            : `검사 실행이 통과를 확정하지 않았습니다${Number.isInteger(execution?.code) ? ` (종료 코드 ${execution.code})` : ''}.`;
      failures.push(`README 실행 안내 ${inspected.display}: ${reason}`);
    }
  }
  return { passed: Boolean(evidence?.passed === true && checksAreValid && failuresAreValid
    && checks.every((check) => check.passed) && failures.length === 0 && execution?.code === 0),
    applicable: true, skipped: false, display: inspected.display, ownerPaths: inspected.ownerPaths, checks, failures };
}

export function needsBrowserQa(task, files = '') {
  return /(?:website|web\s*(?:app|page|site)|front[- ]end|dashboard|landing\s*page|\bUI\b|웹\s*(?:사이트|앱|페이지)|프론트엔드|대시보드|랜딩|화면|디자인)/i.test(task)
    || /(?:^|\n).*\.(?:html|jsx|tsx|vue|svelte|astro)(?:\n|$)/i.test(files);
}
function validateNotApplicable(value, covered, invalid) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((category) => !QA_CATEGORIES.includes(category))) invalid('notApplicable은 허용 분류에 대한 근거 객체여야 합니다. 허용 분류: input, save, empty, keyboard. 실행기가 지원하지 않는 개별 시나리오는 별도 Node 검증 조건으로 다루세요.');
  for (const [category, reason] of Object.entries(value)) {
    if (covered.has(category)) invalid(`${category}: 기존 검사가 있는 기능을 해당 없음으로 바꿀 수 없습니다.`);
    if (typeof reason !== 'string' || reason.trim().length < 12 || reason.length > 500) invalid(`${category}: 해당 없음의 구체적인 근거가 필요합니다.`);
  }
}
export function validateBrowserPlan(plan) {
  const invalid = (reason) => { throw Object.assign(new Error(`독립 QA 계획 오류: ${reason}`), { invalidStructuredOutput: true }); };
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) invalid('JSON 객체가 필요합니다.');
  if (typeof plan.entry !== 'string' || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.html$/.test(plan.entry) || plan.entry.includes('..')) invalid('실행 가능한 상대 HTML 경로가 필요합니다.');
  if (!Array.isArray(plan.checks) || plan.checks.length < 1 || plan.checks.length > 16) invalid('검사는 1~16개여야 합니다.');
  const ids = new Set(), covered = new Set();
  for (const check of plan.checks) {
    if (!check || typeof check.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(check.id) || ids.has(check.id)) invalid('검사 ID가 누락되거나 중복됐습니다.');
    ids.add(check.id);
    if (!Array.isArray(check.categories)) invalid(`${check.id}: categories는 배열이어야 합니다. 허용 분류: ${QA_CATEGORIES.join(', ')}.`);
    const unsupportedCategories = check.categories.filter((category) => !QA_CATEGORIES.includes(category));
    if (unsupportedCategories.length) invalid(`${check.id}: 지원하지 않는 검사 분류 ${JSON.stringify(unsupportedCategories).slice(0, 180)}입니다. 허용 분류: ${QA_CATEGORIES.join(', ')}. 추가 동작 검사는 기존 분류 또는 빈 배열을 사용하고 assertion을 유지하세요.`);
    check.categories.forEach((category) => covered.add(category));
    if (!Array.isArray(check.steps) || check.steps.length < 1 || check.steps.length > 24) invalid(`${check.id}: 검사 단계는 1~24개여야 합니다. 실제 단계 수: ${Array.isArray(check.steps) ? check.steps.length : '배열 아님'}. 긴 시나리오는 필요한 초기 입력과 assertion을 유지해 독립 검사로 나누세요.`);
    if (check.steps.some((step) => !step || typeof step !== 'object' || Array.isArray(step))) invalid(`${check.id}: 각 검사 단계는 브라우저 동작 객체여야 합니다.`);
    const assertions = check.steps.filter((step) => ['visible', 'hidden', 'text', 'value', 'count', 'focused', 'focus-visible'].includes(step?.action));
    if (!assertions.length) invalid(`${check.id}: 각 검사에 실제 assertion이 필요합니다.`);
    const assertsAfter = (action) => {
      const index = check.steps.findLastIndex((step) => step.action === action);
      return index >= 0 && check.steps.slice(index + 1).some((step) => assertions.includes(step));
    };
    if (check.categories.includes('input') && !assertsAfter('fill')) invalid(`${check.id}: 입력 검사에는 실제 입력 이후의 assertion이 필요합니다.`);
    if (check.categories.includes('save') && !assertsAfter('reload')) invalid(`${check.id}: 저장 검사에는 새로고침 이후의 assertion이 필요합니다.`);
    if (check.categories.includes('empty') && !check.steps.some((s) => ['visible', 'hidden', 'count'].includes(s.action))) invalid(`${check.id}: 빈 상태의 표시 검사가 필요합니다.`);
    if (check.categories.includes('keyboard') && !assertsAfter('press')) invalid(`${check.id}: 키보드 검사에는 실제 키 입력 이후의 assertion이 필요합니다.`);
    for (const step of check.steps) {
      if (!ACTIONS.has(step.action)) invalid(`${check.id}: 허용되지 않은 브라우저 동작입니다.`);
      if (!['reset', 'reload', 'press'].includes(step.action) && (typeof step.selector !== 'string' || !step.selector.trim() || step.selector.length > 300)) invalid(`${check.id}: 검사할 selector가 필요합니다.`);
      // Head metadata cannot satisfy a rendered-text assertion. Reject these
      // clear cases before freezing a contract the implementation cannot meet.
      if (['text', 'visible', 'fill', 'click', 'focused', 'focus-visible'].includes(step.action)
        && /^(?:html\s*(?:>\s*)?)?(?:head\s*(?:>\s*)?)?(?:head|title|meta|link|script|style)$/i.test(step.selector.trim())) invalid(`${check.id}: ${step.action} ${step.selector}는 표시되는 화면 요소를 검사할 수 없습니다. text는 가시성도 확인하므로 문서 메타데이터 대신 화면의 heading 등 실제 표시 요소를 검사하세요.`);
      if (step.action === 'press' && !KEYS.has(step.key)) invalid(`${check.id}: 허용되지 않은 키 입력 ${JSON.stringify(step.key)?.slice(0, 180)}입니다. 허용 키: ${[...KEYS].join(', ')}. 지원하는 실제 키 입력과 후속 assertion으로 보완하세요.`);
      if (['fill', 'text', 'value'].includes(step.action) && (typeof step.value !== 'string' || step.value.length > 2000)) invalid(`${check.id}: 검사 값이 올바르지 않습니다.`);
      if (step.action === 'count' && (!Number.isSafeInteger(step.value) || step.value < 0 || step.value > 1000)) invalid(`${check.id}: 검사 개수가 올바르지 않습니다.`);
    }
  }
  validateNotApplicable(plan.notApplicable, covered, invalid);
  for (const category of QA_CATEGORIES) if (!covered.has(category)) {
    const reason = plan.notApplicable?.[category];
    if (typeof reason !== 'string' || reason.trim().length < 12 || reason.length > 500) invalid(`${category} 검사가 없으며 해당 없음의 구체적인 근거도 없습니다.`);
  }
  return JSON.parse(JSON.stringify(plan));
}

export function applyBrowserPlanPatch(plan, patch, replaceableCheckIds = []) {
  const base = validateBrowserPlan(plan);
  const invalid = (reason) => { throw Object.assign(new Error(`독립 QA 보완 오류: ${reason}`), { invalidStructuredOutput: true }); };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) invalid('JSON 보완 객체가 필요합니다.');
  const fields = new Set(['addChecks', 'replaceChecks', 'extendChecks', 'notApplicable']);
  if (Object.keys(patch).some((field) => !fields.has(field))) invalid('전체 계획을 다시 작성하지 마세요. addChecks, replaceChecks, extendChecks, notApplicable만 반환하세요. entry와 기존 검사 순서는 유지합니다.');
  const additions = patch.addChecks === undefined ? [] : patch.addChecks;
  const replacements = patch.replaceChecks === undefined ? [] : patch.replaceChecks;
  const extensions = patch.extendChecks === undefined ? [] : patch.extendChecks;
  if (!Array.isArray(additions) || !Array.isArray(replacements) || !Array.isArray(extensions)) invalid('addChecks, replaceChecks, extendChecks는 배열이어야 합니다.');
  if (additions.length + replacements.length + extensions.length > 16) invalid('한 번에 보완할 검사는 최대 16개입니다.');
  const existing = new Map(base.checks.map((check) => [check.id, check]));
  const replaceable = new Set(replaceableCheckIds), changed = new Set(), replacementMap = new Map();
  for (const check of [...replacements, ...additions, ...extensions]) {
    if (!check || typeof check.id !== 'string' || changed.has(check.id)) invalid('추가·교체 검사 ID가 누락되거나 중복됐습니다.');
    changed.add(check.id);
  }
  for (const check of replacements) {
    const previous = existing.get(check.id);
    if (!previous || !replaceable.has(check.id)) invalid(`${String(check.id).slice(0, 64)}: 이번 판정에서 실패한 검사만 교체할 수 있습니다. 통과한 검사와 selector·assertion은 보존하세요.`);
    if (!Array.isArray(check.categories) || previous.categories.some((category) => !check.categories.includes(category))) invalid(`${check.id}: 기존 검사 분류를 삭제할 수 없습니다.`);
    replacementMap.set(check.id, check);
  }
  for (const check of additions) if (existing.has(check.id)) invalid(`${check.id}: 기존 ID를 새 검사로 추가할 수 없습니다.`);
  for (const extension of extensions) {
    const previous = existing.get(extension.id);
    if (!previous || Object.keys(extension).some((field) => !['id', 'steps'].includes(field))
      || !Array.isArray(extension.steps) || extension.steps.length < 1 || extension.steps.length > 24) invalid(`${String(extension.id).slice(0, 64)}: extendChecks는 기존 ID와 끝에 추가할 steps만 포함해야 합니다.`);
    if (!['visible', 'hidden', 'text', 'value', 'count', 'focused', 'focus-visible'].includes(extension.steps.at(-1)?.action)) invalid(`${extension.id}: 추가 단계는 실제 assertion으로 끝나야 합니다.`);
    // Appending cannot hide an earlier failing assertion: the executor still
    // performs every retained step before these additional observations.
    replacementMap.set(extension.id, { ...previous, steps: [...previous.steps, ...extension.steps] });
  }
  // Keep every earlier case, position and accepted selector. Only an explicit
  // failed-check verdict grants replacement; missing coverage permits new cases
  // or observations appended after all retained assertions.
  const checks = [...base.checks.map((check) => replacementMap.get(check.id) || check), ...additions];
  validateNotApplicable(patch.notApplicable, new Set(checks.flatMap((check) => check.categories || [])), invalid);
  const notApplicable = { ...(base.notApplicable || {}), ...(patch.notApplicable || {}) };
  // An added executable check replaces its earlier exemption, never the reverse.
  for (const category of checks.flatMap((check) => check.categories || [])) delete notApplicable[category];
  const merged = validateBrowserPlan({ ...base, checks,
    ...(base.notApplicable !== undefined || Object.keys(notApplicable).length ? { notApplicable } : {}),
  });
  if (isDeepStrictEqual(merged, base)) invalid('실제 보완 내용이 없습니다. 판정에서 누락된 행동 검사를 추가하거나 허용된 실패 검사만 고치세요.');
  return merged;
}

export class BrowserQaBridge {
  constructor(port = process.env.MOSAIC_DESKTOP === '1' ? process.parentPort : null) {
    this.port = port; this.pending = new Map();
    port?.on('message', ({ data }) => {
      if (data?.scope !== 'loopline-browser-qa' || !this.pending.has(data.id)) return;
      this.pending.get(data.id).finish(data.error ? new Error(data.error) : null, data.result);
    });
  }
  verify(input, signal) {
    if (!this.port) return Promise.resolve({ passed: false, checks: [], failures: ['독립 브라우저 QA는 Loopline 데스크톱에서 실행해야 합니다.'], unavailable: true });
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error, result) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(result);
      };
      const cancel = () => { this.port.postMessage({ scope: 'loopline-browser-qa', id, action: 'cancel' }); finish(signal?.reason || new Error('브라우저 QA를 중지했습니다.')); };
      const timer = setTimeout(() => { this.port.postMessage({ scope: 'loopline-browser-qa', id, action: 'cancel' }); finish(new Error('독립 브라우저 QA의 제한 시간에 도달했습니다.')); }, 120_000);
      this.pending.set(id, { finish }); signal?.addEventListener('abort', cancel, { once: true });
      this.port.postMessage({ scope: 'loopline-browser-qa', id, action: 'verify', input });
    });
  }
}

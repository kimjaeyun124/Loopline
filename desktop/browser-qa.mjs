import { app, BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const inside = (root, path) => path === root || path.startsWith(root + sep);
export async function verifyBrowser({ workspace, runId, round, plan }, userData, signal) {
  // Electron Builder places shared server modules outside app.asar via extraResources.
  const { validateBrowserPlan, BROWSER_QA_EXECUTOR } = await import(app.isPackaged
    ? pathToFileURL(join(process.resourcesPath, 'app-server', 'browser-qa.mjs')).href
    : new URL('../browser-qa.mjs', import.meta.url).href);
  plan = validateBrowserPlan(plan);
  if (!/^[a-f0-9-]{36}$/.test(runId) || !Number.isInteger(round) || round < 1 || round > 10) throw new Error('브라우저 QA 실행 정보가 올바르지 않습니다.');
  const expected = await realpath(join(userData, 'harness', runId, 'workspace'));
  if (await realpath(workspace) !== expected) throw new Error('관리되는 Loop 작업 공간만 검사할 수 있습니다.');
  const entry = await realpath(join(expected, plan.entry));
  if (!inside(expected, entry) || !(await stat(entry)).isFile()) throw new Error('독립 QA에서 실행할 HTML 파일이 없습니다. 계획한 웹 실행 파일을 생성하거나 빌드하세요.');
  const webRoot = dirname(entry), outputDir = join(userData, 'harness', runId, 'browser-qa', `round-${round}`);
  await mkdir(outputDir, { recursive: true });
  const server = createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (path.split('/').some((p) => p.startsWith('.') || p.includes('\\'))) throw new Error('Forbidden');
      const file = await realpath(join(webRoot, path === '/' ? plan.entry.split('/').at(-1) : path));
      if (!inside(webRoot, file) || !mime[extname(file)]) throw new Error('Forbidden');
      const body = await readFile(file);
      if (body.length > 10_000_000) throw new Error('Too large');
      res.writeHead(200, { 'Content-Type': mime[extname(file)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; object-src 'none'" });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(404).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const checks = [], failures = [], screenshots = [];
  let window;
  const cancel = () => { if (window && !window.isDestroyed()) window.destroy(); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (const { id: label, width, height } of BROWSER_QA_EXECUTOR.viewports) {
      if (signal?.aborted) throw signal.reason;
      window = new BrowserWindow({ show: false, useContentSize: true, width, height, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, partition: `qa-${randomUUID()}`, backgroundThrottling: false } });
      const wc = window.webContents, session = wc.session;
      session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      session.setPermissionCheckHandler(() => false);
      session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(origin + '/') && !/^(?:data:|blob:)/.test(details.url) }));
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('will-navigate', (event, url) => { if (!url.startsWith(origin + '/')) event.preventDefault(); });
      const errors = [];
      wc.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(String(details.message).slice(0, 600)); });
      wc.on('render-process-gone', () => errors.push('브라우저 렌더러가 종료됐습니다.'));
      await window.loadURL(origin + '/'); wc.debugger.attach('1.3'); await wc.debugger.sendCommand('Runtime.enable');
      wc.debugger.on('message', (_event, method, params) => { if (method === 'Runtime.exceptionThrown') errors.push(String(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'JavaScript error').slice(0, 600)); });
      const js = (body, data) => wc.executeJavaScript(`(${body})(${JSON.stringify(data)})`, true);
      // CSS can override the hidden attribute, so assertions must inspect the rendered state.
      const inspect = (step) => js(`(s) => {
        const list=[...document.querySelectorAll(s.selector)];
        // Focus assertions concern the matching active element, not DOM order.
        const el=['focused','focus-visible'].includes(s.action)?list.find(e=>e===document.activeElement):list[0];
        const visible=e=>{if(!e)return false;const c=getComputedStyle(e),r=e.getBoundingClientRect();return c.display!=='none'&&c.visibility!=='hidden'&&r.width>0&&r.height>0};
        if(s.action==='count')return {ok:list.length===s.value,actual:list.length};
        if(s.action==='hidden')return {ok:!visible(el),actual:visible(el)};
        if(s.action==='visible')return {ok:visible(el),actual:visible(el)};
        if(s.action==='text')return {ok:visible(el)&&el.textContent.includes(s.value),actual:el?.textContent?.slice(0,400)};
        if(s.action==='value')return {ok:el?.value===s.value,actual:el?.value};
        if(s.action==='focused')return {ok:el===document.activeElement,actual:document.activeElement?.outerHTML?.slice(0,300)};
        if(s.action==='focus-visible'){
          const c=el&&getComputedStyle(el), keyboard=!!el?.matches(':focus-visible');
          const painted=color=>!!color&&color!=='transparent'&&!/rgba\\([^)]*,\\s*0(?:\\.0+)?\\s*\\)/.test(color);
          const outline=!!c&&parseFloat(c.outlineWidth)>0&&!['none','hidden'].includes(c.outlineStyle)&&painted(c.outlineColor);
          const shadow=!!c&&typeof s.unfocusedBoxShadow==='string'&&c.boxShadow!=='none'&&c.boxShadow!==s.unfocusedBoxShadow&&painted(c.boxShadow);
          return {ok:visible(el)&&el===document.activeElement&&keyboard&&parseFloat(c.opacity)>0&&(outline||shadow),actual:{keyboard,outline:c?.outline,boxShadow:c?.boxShadow,unfocusedBoxShadow:s.unfocusedBoxShadow,active:el===document.activeElement}};
        }
        return {ok:false};
      }`, step);
      const inspectLayout = async (id) => {
        const actual = await js('()=>({overflow:Math.max(document.documentElement.scrollWidth,document.body?.scrollWidth||0)>innerWidth+1,width:innerWidth,body:!!document.body?.innerText.trim()})', null);
        const passed = !actual.overflow && actual.body && actual.width === width;
        checks.push({ id, viewport: label, passed, actual });
        if (!passed) failures.push(`${label}/${id}: 빈 화면 또는 가로 넘침 ${JSON.stringify(actual)}`);
      };
      for (const check of plan.checks) {
        let failure = null;
        const focusBaselines = {};
        try {
          for (const [index, step] of check.steps.entries()) {
            if (signal?.aborted) throw signal.reason;
            if (step.action === 'reset') { await js('() => {localStorage.clear();sessionStorage.clear();}', null); await window.loadURL(origin + '/'); }
            else if (step.action === 'reload') await window.loadURL(origin + '/');
            else if (step.action === 'fill') {
              const exists = await js('(s)=>{const el=document.querySelector(s.selector);if(!el)return false;el.focus();if(el.select)el.select();return true;}', step);
              if (!exists) throw new Error(`입력 요소 없음: ${step.selector}`);
              await wc.debugger.sendCommand('Input.insertText', { text: step.value });
            } else if (step.action === 'click') {
              const point = await js('(s)=>{const e=document.querySelector(s.selector);if(!e)return null;e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};}', step);
              if (!point) throw new Error(`클릭 요소 없음: ${step.selector}`);
              await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
              await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
            } else if (step.action === 'press') {
              // A permanent card shadow is not evidence of a keyboard focus cue.
              for (const selector of new Set(check.steps.filter(s => s.action === 'focus-visible').map(s => s.selector))) {
                const before = await js('(selector)=>{const e=document.querySelector(selector);return e&&e!==document.activeElement?getComputedStyle(e).boxShadow:null;}', selector);
                if (before !== null) focusBaselines[selector] = before;
              }
              const codes = { Tab: 9, Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Space: 32, Backspace: 8 };
              const key = step.key === 'Space' ? ' ' : step.key;
              await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: codes[step.key], ...(step.key === 'Enter' ? { text: '\r' } : step.key === 'Space' ? { text: ' ' } : {}) });
              await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: codes[step.key] });
            } else {
              const until = Date.now() + 2500; let result;
              do { result = await inspect({ ...step, ...(step.action === 'focus-visible' ? { unfocusedBoxShadow: focusBaselines[step.selector] } : {}) }); if (result.ok) break; await pause(80); } while (Date.now() < until);
              if (!result.ok) throw new Error(`단계 ${index + 1}: ${step.action} ${step.selector} · 예상 ${JSON.stringify(step.value ?? true)} · 실제 ${JSON.stringify(result.actual)}`);
            }
            await pause(40);
          }
        } catch (error) { if (signal?.aborted) throw signal.reason; failure = String(error.message).slice(0, 1000); }
        const result = { id: check.id, viewport: label, passed: !failure, ...(failure ? { failure } : {}) }; checks.push(result);
        if (failure) failures.push(`${label}/${check.id}: ${failure}`);
        await inspectLayout(`${check.id}-layout`);
        const name = `${label}-${check.id}.png`;
        await writeFile(join(outputDir, name), (await wc.capturePage()).toPNG()); screenshots.push({ checkId: check.id, viewport: label, name });
      }
      await inspectLayout('layout');
      if (errors.length) failures.push(`${label}/runtime: ${[...new Set(errors)].join('\n')}`);
      window.destroy(); window = null;
      await session.clearStorageData(); await session.closeAllConnections();
    }
    return { passed: failures.length === 0, checks, failures, screenshots, outputDirectory: relative(userData, outputDir), testedAt: Date.now() };
  } finally {
    signal?.removeEventListener('abort', cancel); cancel();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { validateBrowserPlan, BROWSER_QA_EXECUTOR } from '../browser-qa.mjs';
import { RESPONSE_SCHEMAS } from '../harness-response-schemas.mjs';
import { runCommand } from '../harness-engine.mjs';

const exemption = {
  input: 'This fixture isolates restored storage rather than form inputs.',
  empty: 'This fixture has no empty-state requirement.',
  keyboard: 'This fixture does not require keyboard navigation.',
};
const storagePlan = (value = '{broken') => ({ entry: 'index.html', checks: [{
  id: 'damaged-storage', categories: ['save'], steps: [
    { action: 'reset' }, { action: 'set-storage', key: 'qa-state', value },
    { action: 'reload' }, { action: 'visible', selector: '#warning' },
  ],
}], notApplicable: exemption });

test('storage fixture contracts accept raw strings and restrict scope and size', () => {
  assert.ok(BROWSER_QA_EXECUTOR.actions.includes('set-storage'));
  const plan = storagePlan('"quoted\\value"; window.injected=true;');
  assert.deepEqual(validateBrowserPlan(plan), plan);
  for (const value of ['', 'x'.repeat(2000)]) assert.doesNotThrow(() => validateBrowserPlan(storagePlan(value)));
  for (const bad of [
    { key: '' }, { key: ' ' }, { key: 'x'.repeat(129) }, { key: 'a\u0000b' }, { key: 2 },
    { value: null }, { value: {} }, { value: 'x'.repeat(2001) },
    { origin: 'https://example.com' }, { storage: 'cookies' }, { script: 'alert(1)' }, { selector: '#other' },
  ]) {
    const invalid = storagePlan(); Object.assign(invalid.checks[0].steps[1], bad);
    assert.throws(() => validateBrowserPlan(invalid), /set-storage/);
  }
  const variants = RESPONSE_SCHEMAS.browserPlan.properties.checks.items.properties.steps.items.anyOf;
  const step = variants.find(v => v.properties.action.enum.includes('set-storage'));
  assert.deepEqual(Object.keys(step.properties).sort(), ['action', 'key', 'value']);
  assert.deepEqual([...step.required].sort(), ['action', 'key', 'value']);
  assert.equal(step.additionalProperties, false);
});

test('each storage fixture needs a reload and assertion before reset or replacement', () => {
  const base = storagePlan(), seed = base.checks[0].steps[1], reload = { action: 'reload' }, assertion = { action: 'visible', selector: '#warning' };
  for (const steps of [
    [seed, assertion], [reload, assertion, seed], [seed, reload],
    [seed, { action: 'reset' }, reload, assertion],
    [seed, reload, { action: 'reset' }, assertion],
    [seed, seed, reload, assertion],
  ]) {
    const plan = structuredClone(base); plan.checks[0].categories = []; plan.notApplicable = { ...exemption, save: 'Separate reload evidence remains mandatory for fixture preparation.' }; plan.checks[0].steps = steps;
    const original = structuredClone(plan);
    assert.throws(() => validateBrowserPlan(plan), /assertion|저장 시험 데이터/);
    assert.deepEqual(plan, original);
  }
  const plan = structuredClone(base); plan.checks[0].steps.push(seed, reload, assertion);
  assert.doesNotThrow(() => validateBrowserPlan(plan));
});

test('real Chromium verifies damaged storage recovery and isolated fixture reset without hiding failures', async (t) => {
  const { default: electron } = await import('electron');
  const directory = await mkdtemp(join(tmpdir(), 'loopline-storage-qa-'));
  const runId = randomUUID(), workspace = join(directory, 'harness', runId, 'workspace');
  await mkdir(workspace, { recursive: true });
  await mkdir(join(directory, 'electron-data'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
    <h1>Storage recovery fixture</h1><p id="warning" hidden>Recovered damaged storage</p><ul id="list"></ul>
    <form><label for="name">Name</label><input id="name"><button>Add</button></form><output id="sentinel">untouched</output>
    <script>
      let rows=[];
      try { rows=JSON.parse(localStorage.getItem('qa-state')||'[]'); if(!Array.isArray(rows)||rows.some(x=>typeof x!=='string'))throw Error('invalid'); }
      catch { rows=[]; localStorage.removeItem('qa-state'); document.querySelector('#warning').hidden=HIDE_RECOVERY; }
      function render(){const list=document.querySelector('#list');list.replaceChildren();for(const row of rows){const li=document.createElement('li');li.textContent=row;list.append(li);}}
      document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();rows.push(document.querySelector('#name').value);localStorage.setItem('qa-state',JSON.stringify(rows));render();});render();
    </script></body></html>`;
  const recovery = (id, value) => ({ id, categories: ['input', 'save', 'empty', 'keyboard'], steps: [
    { action: 'reset' }, { action: 'set-storage', key: 'qa-state', value }, { action: 'reload' },
    { action: 'visible', selector: '#warning' }, { action: 'count', selector: '#list li', value: 0 },
    { action: 'text', selector: '#sentinel', value: 'untouched' },
    { action: 'fill', selector: '#name', value: 'Recovered task' }, { action: 'press', key: 'Enter' },
    { action: 'text', selector: '#list', value: 'Recovered task' }, { action: 'reload' },
    { action: 'hidden', selector: '#warning' }, { action: 'count', selector: '#list li', value: 1 },
    { action: 'text', selector: '#list', value: 'Recovered task' },
  ] });
  const plan = { entry: 'index.html', checks: [
    recovery('malformed-json', '");document.querySelector("#sentinel").textContent="injected";//'),
    recovery('invalid-shape', '{"unexpected":true}'),
    { id: 'reset-clears-fixture', categories: ['empty'], steps: [{ action: 'reset' }, { action: 'count', selector: '#list li', value: 0 }, { action: 'hidden', selector: '#warning' }] },
  ] };
  const main = join(directory, 'main.mjs'), resultFile = join(directory, 'result.json');
  await writeFile(main, `import { app } from 'electron';
    import { writeFile } from 'node:fs/promises';
    import { verifyBrowser } from ${JSON.stringify(new URL('../desktop/browser-qa.mjs', import.meta.url).href)};
    app.setPath('userData', ${JSON.stringify(join(directory, 'electron-data'))});
    app.on('window-all-closed', () => {});
    const timer=setTimeout(()=>app.exit(1),45000);
    app.whenReady().then(async()=>{try{
      const html=${JSON.stringify(html)}, input=${JSON.stringify({ workspace, runId, round: 1, plan })};
      await writeFile(${JSON.stringify(join(workspace, 'index.html'))},html.replace('HIDE_RECOVERY','true'));
      const before=await verifyBrowser(input,${JSON.stringify(directory)});
      await writeFile(${JSON.stringify(join(workspace, 'index.html'))},html.replace('HIDE_RECOVERY','false'));
      const after=await verifyBrowser({...input,round:2},${JSON.stringify(directory)});
      await writeFile(${JSON.stringify(resultFile)},JSON.stringify({native:!!process.versions.electron,before,after}));
      clearTimeout(timer);app.quit();
    }catch(error){console.error(error);clearTimeout(timer);app.exit(1);}});
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE'));
  const execution = await runCommand(electron, [main], { cwd: directory, env, timeout: 50000, limit: 10000 });
  assert.equal(execution.code, 0, execution.error || execution.output);
  const { native, before, after } = JSON.parse(await readFile(resultFile, 'utf8'));
  assert.equal(native, true); assert.equal(before.passed, false); assert.equal(before.failures.length, 4);
  for (const viewport of ['desktop', 'mobile']) {
    for (const id of ['malformed-json', 'invalid-shape']) assert.equal(before.checks.find(c => c.id === id && c.viewport === viewport).passed, false);
    assert.equal(before.checks.find(c => c.id === 'reset-clears-fixture' && c.viewport === viewport).passed, true);
  }
  assert.equal(after.passed, true, JSON.stringify(after.failures));
  assert.equal(after.checks.length, 14); assert.ok(after.checks.every(c => c.passed));
});

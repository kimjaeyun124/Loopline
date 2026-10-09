import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runCommand } from '../harness-engine.mjs';

test('real Chromium reports native input truncation without approving the failed error contract', async (t) => {
  const { default: electron } = await import('electron');
  const directory = await mkdtemp(join(tmpdir(), 'loopline-input-qa-'));
  const runId = randomUUID(), workspace = join(directory, 'harness', runId, 'workspace');
  await mkdir(workspace, { recursive: true });
  await mkdir(join(directory, 'electron-data'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
    <form novalidate><label for="title">Title</label><input id="title" maxlength="4"><button id="submit">Add</button></form>
    <p id="error" hidden>Too long</p><output id="result"></output><script>
      document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();const value=document.querySelector('#title').value;
      document.querySelector('#error').hidden=value.length<=4;document.querySelector('#result').textContent=value.length<=4?value:'';});
    </script></body></html>`;
  const plan = { entry: 'index.html', checks: [
    { id: 'over-limit', categories: ['input'], steps: [{ action: 'reset' }, { action: 'fill', selector: '#title', value: 'abcde' }, { action: 'click', selector: '#submit' }, { action: 'visible', selector: '#error' }] },
    { id: 'at-limit', categories: ['input'], steps: [{ action: 'reset' }, { action: 'fill', selector: '#title', value: 'abcd' }, { action: 'click', selector: '#submit' }, { action: 'hidden', selector: '#error' }, { action: 'text', selector: '#result', value: 'abcd' }] },
  ], notApplicable: { save: 'This fixture does not persist data.', empty: 'This fixture has no list or empty-state requirement.', keyboard: 'This fixture isolates length validation rather than keyboard navigation.' } };
  const main = join(directory, 'main.mjs'), resultFile = join(directory, 'result.json');
  await writeFile(main, `import { app } from 'electron';
    import { writeFile } from 'node:fs/promises';
    import { verifyBrowser } from ${JSON.stringify(new URL('../desktop/browser-qa.mjs', import.meta.url).href)};
    app.setPath('userData', ${JSON.stringify(join(directory, 'electron-data'))});
    app.on('window-all-closed', () => {});
    const timer = setTimeout(() => app.exit(1), 25000);
    app.whenReady().then(async () => {
      try {
        const html = ${JSON.stringify(html)}, input = ${JSON.stringify({ workspace, runId, round: 1, plan })};
        await writeFile(${JSON.stringify(join(workspace, 'index.html'))}, html);
        const before = await verifyBrowser(input, ${JSON.stringify(directory)});
        // Only the disposable fixture implementation changes. The QA plan and
        // assertions stay identical across both executions.
        await writeFile(${JSON.stringify(join(workspace, 'index.html'))}, html.replace(' maxlength="4"', ''));
        const after = await verifyBrowser({ ...input, round: 2 }, ${JSON.stringify(directory)});
        await writeFile(${JSON.stringify(resultFile)}, JSON.stringify({ electron: Boolean(process.versions.electron), before, after }));
        clearTimeout(timer); app.quit();
      } catch (error) { console.error(error); clearTimeout(timer); app.exit(1); }
    });
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE'));
  const execution = await runCommand(electron, [main], { cwd: directory, env, timeout: 30000, limit: 10000 });
  assert.equal(execution.code, 0, execution.error || execution.output);
  const { electron: native, before, after } = JSON.parse(await readFile(resultFile, 'utf8'));
  assert.equal(native, true);
  assert.equal(before.passed, false);
  assert.equal(before.failures.length, 2);
  for (const viewport of ['desktop', 'mobile']) {
    const failed = before.checks.find(check => check.viewport === viewport && check.id === 'over-limit');
    assert.equal(failed.passed, false);
    assert.match(failed.failure, /"requestedLength":5/);
    assert.match(failed.failure, /"actualLength":4/);
    assert.match(failed.failure, /"maxLength":4/);
    assert.ok(failed.failure.length <= 1000);
    assert.equal(before.checks.find(check => check.viewport === viewport && check.id === 'at-limit').passed, true);
  }
  assert.equal(after.passed, true, JSON.stringify(after.failures));
  assert.equal(after.checks.length, 10);
  assert.ok(after.checks.every(check => check.passed));
});

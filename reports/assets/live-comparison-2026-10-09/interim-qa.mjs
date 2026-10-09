import { app } from 'electron';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBrowser } from '../../../desktop/browser-qa.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const runId = process.argv[2];
const response = await fetch(`http://127.0.0.1:41743/api/harness/runs/${runId}`);
if (!response.ok) throw new Error('진단할 실행 기록을 찾을 수 없습니다.');
const run = await response.json();
const userData = join(directory, 'interim-qa');
const workspace = join(userData, 'harness', runId, 'workspace');
const filter = path => !relative(run.workspace, path).split(sep).some(part => part.startsWith('.') || part === 'node_modules');
await mkdir(dirname(workspace), { recursive: true });
await cp(run.workspace, workspace, { recursive: true, filter });
// 한 viewport 창을 닫은 뒤 다음 검사 창을 만들 때 프로세스가 종료되지 않게 한다.
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
try {
  const plan = JSON.parse(await readFile(join(directory, 'common-qa.json'), 'utf8'));
  let qa;
  try { qa = await verifyBrowser({ workspace, runId, round: 1, plan }, userData); }
  catch (error) { qa = { passed: false, checks: [], failures: [String(error.message)], unavailable: true }; }
  const output = { capturedAt: new Date().toISOString(), runId, runStageAtCopy: run.stage, runRoundAtCopy: run.round,
    kind: '부분 산출물의 읽기 전용 사본 진단. 원래 실행에 검사 결과를 전달하거나 코드를 수정하지 않음.',
    milestonesAtCopy: run.milestones.map(m => ({ id: m.id, status: m.status, attempts: m.attempts })),
    expectedCheckCount: 50, passedCheckCount: qa.checks.filter(check => check.passed).length, ...qa };
  await writeFile(join(directory, 'interim-ui-diagnostic.json'), JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify({ passed: output.passed, checksPassed: output.passedCheckCount, checks: output.checks.length, failures: output.failures }));
} finally { app.quit(); }
}).catch(error => { console.error(error.message); app.exit(1); });

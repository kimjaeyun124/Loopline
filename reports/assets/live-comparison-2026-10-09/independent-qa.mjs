import { app } from 'electron';
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBrowser } from '../../../desktop/browser-qa.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const userData = join(directory, 'qa-user-data');
const results = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'));
const plan = JSON.parse(await readFile(join(directory, 'common-qa.json'), 'utf8'));
// 세 프로그램과 두 viewport의 검사가 끝날 때까지 headless 런타임을 유지한다.
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
try {
  for (const trial of results.trials.filter(item => item.finishedAt)) {
    const runRoot = join(userData, 'harness', trial.runId);
    const workspace = join(runRoot, 'workspace');
    await mkdir(runRoot, { recursive: true });
    let qa;
    try {
      const source = trial.applied ? trial.source : trial.workspace;
      if (!source) throw new Error('생성된 작업 공간이 없습니다.');
      // 추가 파일을 누락해 측정용 복사본에서만 실패하는 것을 방지한다.
      const filter = path => !relative(source, path).split(sep).some(part => part.startsWith('.') || part === 'node_modules');
      await cp(source, workspace, { recursive: true, filter });
      const preview = join(directory, 'projects', trial.configuration);
      await cp(source, preview, { recursive: true, filter });
      trial.exportedFiles = await readdir(preview);
      qa = await verifyBrowser({ workspace, runId: trial.runId, round: 1, plan }, userData);
    }
    catch (error) { qa = { passed: false, checks: [], failures: [String(error.message)], unavailable: true }; }
    trial.independentQa = { ...qa, expectedCheckCount: 50, passedCheckCount: qa.checks.filter(item => item.passed).length };
    await writeFile(join(directory, `${trial.configuration}-independent-qa.json`), JSON.stringify(trial.independentQa, null, 2) + '\n');
    await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2) + '\n');
    console.log(JSON.stringify({ configuration: trial.configuration, passed: qa.passed, checksPassed: trial.independentQa.passedCheckCount, actualCheckCount: qa.checks.length, failures: qa.failures }));
  }
} finally { app.quit(); }
}).catch(error => { console.error(error.message); app.exit(1); });

import { app } from 'electron';
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBrowser } from '../../../desktop/browser-qa.mjs';

const phase = process.argv[2];
if (!['before', 'after'].includes(phase)) throw new Error('before 또는 after 측정 단계를 지정하세요.');
const directory = join(dirname(fileURLToPath(import.meta.url)), phase);
const variant = process.argv[3] || 'common';
if (!['common', 'storage'].includes(variant)) throw new Error('지원하지 않는 검사입니다.');
const storage = variant === 'storage';
const userData = join(directory, storage ? 'storage-qa-user-data' : 'qa-user-data');
const results = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'));
const plan = JSON.parse(await readFile(join(directory, storage ? 'storage-qa.json' : 'common-qa.json'), 'utf8'));
// 프로그램과 두 viewport의 검사가 끝날 때까지 headless 런타임을 유지한다.
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
      await readFile(join(source, plan.entry)); // 화면 미생성은 50개 검사 실패가 아니라 미실행이다.
      // 추가 파일을 누락해 측정용 복사본에서만 실패하는 것을 방지한다.
      const filter = path => !relative(source, path).split(sep).some(part => part.startsWith('.') || part === 'node_modules');
      await cp(source, workspace, { recursive: true, filter });
      const preview = join(directory, 'projects', trial.configuration);
      await cp(source, preview, { recursive: true, filter });
      trial.exportedFiles = await readdir(preview);
      qa = await verifyBrowser({ workspace, runId: trial.runId, round: 1, plan }, userData);
    }
    catch (error) { qa = { passed: false, checks: [], failures: [String(error.message)], unavailable: true }; }
    const field = storage ? 'storageQa' : 'independentQa';
    trial[field] = { ...qa, expectedCheckCount: storage ? 14 : 50, passedCheckCount: qa.checks.filter(item => item.passed).length };
    await writeFile(join(directory, `${trial.configuration}-${storage ? 'storage' : 'independent'}-qa.json`), JSON.stringify(trial[field], null, 2) + '\n');
    await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2) + '\n');
    console.log(JSON.stringify({ configuration: trial.configuration, passed: qa.passed, variant, checksPassed: trial[field].passedCheckCount, actualCheckCount: qa.checks.length, failures: qa.failures }));
  }
} finally { app.quit(); }
}).catch(error => { console.error(error.message); app.exit(1); });

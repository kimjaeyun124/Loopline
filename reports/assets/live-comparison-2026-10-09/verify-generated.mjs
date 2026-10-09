import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const directory = dirname(fileURLToPath(import.meta.url));
const results = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'));
const checks = [];
for (const trial of results.trials) {
  const workspace = join(directory, 'projects', trial.configuration);
  const files = await readdir(workspace);
  if (!files.some(file => file.endsWith('.test.mjs'))) {
    checks.push({ configuration: trial.configuration, status: 'NOT_RUN', reason: '구현 단계 전에 종료되어 테스트 파일이 생성되지 않았습니다.' });
    continue;
  }
  const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: workspace, encoding: 'utf8', timeout: 60000, maxBuffer: 2000000 });
  const log = child.stdout + child.stderr;
  const value = key => Number(log.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] ?? NaN);
  checks.push({ configuration: trial.configuration, status: child.status === 0 && value('tests') > 0 ? 'PASS' : 'FAIL', exitCode: child.status,
    tests: value('tests'), passed: value('pass'), failed: value('fail'), error: child.error?.message || null });
  await writeFile(join(directory, `${trial.configuration}-node-tests.log`), log);
}
await writeFile(join(directory, 'generated-project-tests.json'), JSON.stringify(checks, null, 2) + '\n');
console.log(JSON.stringify(checks, null, 2));

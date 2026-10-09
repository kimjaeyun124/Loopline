import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const directory = dirname(fileURLToPath(import.meta.url));
const root = fileURLToPath(new URL('../../../', import.meta.url));
const original = await readFile(join(root, 'tests/harness-milestones.test.mjs'), 'utf8');
const temporary = await mkdtemp(join(tmpdir(), 'loopline-evidence-triage-'));
const helper = `
function completeMockEvidence(plan, passed = true) {
  return BROWSER_QA_EXECUTOR.viewports.flatMap(({id: viewport}) => [
    ...plan.checks.flatMap(({id}) => [{id, viewport, passed}, {id:id+'-layout', viewport, passed}]),
    {id:'layout', viewport, passed},
  ]);
}
`;
let adapted = original.replaceAll("checks: [{ id: 'task-flow', passed: !failed }]", 'checks: completeMockEvidence(qaPlan, !failed)')
  .replaceAll("checks: [{ id: 'flow', passed: true }]", 'checks: completeMockEvidence(qa)');
if (adapted === original) throw new Error('분석할 fixture의 위치가 변경됐습니다.');
adapted = adapted.replace(/^(import .+ from )'\.\.\/([^']+)'/gm, (_, prefix, file) => `${prefix}'${pathToFileURL(join(root, file)).href}'`);
adapted = helper + adapted;
try {
  const path = join(temporary, 'harness-milestones.test.mjs');
  await writeFile(path, adapted);
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path], { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 2000000 });
  await writeFile(join(directory, 'fixture-triage.log'), result.stdout + result.stderr);
  const diagnostic = {
    sourceModified: false, productionModified: false,
    intervention: '저장소 밖 임시 테스트 사본에서 두 mock 응답에 기존 계획의 viewport/check/layout 근거를 채움. 제품 검증 조건은 변경하지 않음.',
    exitCode: result.status, error: result.error?.message || null,
    summary: result.stdout.split('\n').filter(line => /^# (tests|pass|fail|duration_ms)/.test(line)),
    limitations: '이 결과는 저장소 원본 전체 테스트 통과를 의미하지 않음. 원본 실패를 숨기거나 성공률에 포함하지 않음.',
  };
  await writeFile(join(directory, 'fixture-triage.json'), JSON.stringify(diagnostic, null, 2) + '\n');
  console.log(JSON.stringify(diagnostic));
} finally { await rm(temporary, { recursive: true, force: true }); }

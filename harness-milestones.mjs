import { createHash } from 'node:crypto';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';

const invalid = (message) => { throw Object.assign(new Error(`부분 작업 계획 오류: ${message}`), { invalidStructuredOutput: true }); };
export function needsMilestones(task, files = '') {
  return String(task).length >= 240 || /(?:full.stack|multi.page|large.project|대규모|여러\s*(?:페이지|기능|모듈)|복합|풀스택)/i.test(task) || files.split('\n').filter(Boolean).length >= 80;
}
export function matchesMilestone(path, milestone) {
  return milestone.paths.some((pattern) => pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -2)) : path === pattern);
}
export function validateMilestones(value) {
  if (!value || !Array.isArray(value.tasks) || value.tasks.length < 2 || value.tasks.length > 8) invalid('검증 가능한 작업 2~8개가 필요합니다.');
  const seen = new Set();
  const tasks = value.tasks.map((task) => {
    if (!task || !/^[a-z0-9-]{1,48}$/.test(task.id) || seen.has(task.id)) invalid('작업 ID가 누락됐거나 중복됐습니다.');
    if (typeof task.title !== 'string' || !task.title.trim() || task.title.length > 160) invalid('작업 제목이 필요합니다.');
    if (!Array.isArray(task.dependsOn) || task.dependsOn.some((id) => !seen.has(id))) invalid('의존 작업은 앞에서 선언된 ID여야 합니다.');
    if (!Array.isArray(task.paths) || !task.paths.length || task.paths.length > 16 || task.paths.some((path) => typeof path !== 'string' || path.length > 300 || path.startsWith('/') || /[\\\x00-\x1f]/.test(path) || path.split('/').some((p) => !p || ['.', '..', '.git', 'node_modules'].includes(p)) || path.includes('*') && !/^[^*]+\/\*\*$/.test(path))) invalid('담당 파일 또는 폴더/** 경로가 필요합니다.');
    if (!Array.isArray(task.criteria) || !task.criteria.length || task.criteria.length > 8 || task.criteria.some((text) => typeof text !== 'string' || text.trim().length < 8 || text.length > 600)) invalid('관찰 가능한 완료 기준이 필요합니다.');
    if (typeof task.verifyCommand !== 'string' || task.verifyCommand.trim().length < 5 || task.verifyCommand.length > 1600 || /^(?:true|echo\s+|printf\s+|exit\s+0\s*$)/.test(task.verifyCommand.trim())) invalid('실제 부분 작업 검증 명령이 필요합니다.');
    seen.add(task.id);
    return { id: task.id, title: task.title.trim(), dependsOn: [...new Set(task.dependsOn)], paths: [...new Set(task.paths)], criteria: [...task.criteria], verifyCommand: task.verifyCommand.trim(), status: 'pending', evidence: null, attempts: 0 };
  });
  return tasks;
}
export function milestoneContract(tasks) {
  return createHash('sha256').update(JSON.stringify(tasks.map(({ id, title, dependsOn, paths, criteria, verifyCommand }) => ({ id, title, dependsOn, paths, criteria, verifyCommand })))).digest('hex');
}
export async function milestoneFiles(workspace, inventory, milestone) {
  const paths = new Set(inventory.filter((path) => matchesMilestone(path, milestone)));
  for (const path of milestone.paths) if (!path.endsWith('/**')) paths.add(path);
  if (paths.size > 250) throw new Error('부분 작업 담당 파일이 너무 많습니다. 계획을 더 작은 단위로 나누세요.');
  const result = {};
  const root = await realpath(workspace);
  for (const path of [...paths].sort()) {
    try {
      const full = join(root, path);
      if ((await lstat(full)).isSymbolicLink()) throw new Error('부분 완료 근거에 심볼릭 링크를 사용할 수 없습니다.');
      const resolved = await realpath(full);
      if (!resolved.startsWith(root + sep)) throw new Error('작업 공간 밖 파일은 완료 근거로 사용할 수 없습니다.');
      result[path] = createHash('sha256').update(await readFile(resolved)).digest('hex');
    } catch (error) { if (error.code === 'ENOENT') result[path] = null; else throw error; }
  }
  return result;
}
export async function refreshMilestones(tasks, workspace, inventory) {
  const invalidated = [];
  for (const task of tasks) {
    if (task.status !== 'completed') continue;
    const files = await milestoneFiles(workspace, inventory, task);
    if (JSON.stringify(files) !== JSON.stringify(task.evidence?.files) || task.dependsOn.some((id) => tasks.find((t) => t.id === id)?.status !== 'completed')) {
      task.status = 'needs-review'; invalidated.push(task.id);
    }
  }
  return invalidated;
}
export function nextMilestone(tasks) { return tasks.find((task) => task.status !== 'completed' && task.dependsOn.every((id) => tasks.find((candidate) => candidate.id === id)?.status === 'completed')); }
export function milestoneCoverage(tasks, changedPaths) { return tasks.length > 0 && tasks.every((task) => task.status === 'completed' && task.evidence?.reviewed) && changedPaths.every((path) => tasks.some((task) => matchesMilestone(path, task) && Object.hasOwn(task.evidence.files, path))); }

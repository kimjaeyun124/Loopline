import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TaskModel,
  TaskValidationError,
  filterTasks,
  getTaskStats,
  parseStoredTasks,
  validateStoredTasks,
  validateTaskInput,
} from './model.mjs';

const validInput = { title: '  미적분 복습  ', subject: '  수학  ', minutes: '30' };

function storedTask(overrides = {}) {
  return {
    id: 'task-1',
    title: '복습',
    subject: '수학',
    minutes: 30,
    completed: false,
    ...overrides,
  };
}

test('입력 검증은 앞뒤 공백을 제거하고 제목·과목·시간의 경계값을 허용한다', () => {
  const result = validateTaskInput({
    title: `  ${'가'.repeat(100)}  `,
    subject: `  ${'수'.repeat(30)}  `,
    minutes: '1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.title, '가'.repeat(100));
  assert.equal(result.value.subject, '수'.repeat(30));
  assert.equal(result.value.minutes, 1);
  assert.equal(validateTaskInput({ ...validInput, minutes: '480' }).value.minutes, 480);
});

test('입력 검증은 필수값, 글자 수 초과, 비정수 및 시간 범위 밖 값을 거부한다', () => {
  assert.equal(validateTaskInput({ ...validInput, title: '   ' }).field, 'title');
  assert.equal(validateTaskInput({ ...validInput, subject: '' }).field, 'subject');
  assert.equal(validateTaskInput({ ...validInput, title: '가'.repeat(101) }).field, 'title');
  assert.equal(validateTaskInput({ ...validInput, subject: '수'.repeat(31) }).field, 'subject');

  for (const minutes of ['', '   ', 0, -1, 481, '1.5', 1.5, 'abc']) {
    assert.equal(validateTaskInput({ ...validInput, minutes }).ok, false, `minutes=${minutes}`);
  }
  assert.equal(validateTaskInput({ ...validInput, minutes: '1.0' }).value.minutes, 1);
  assert.equal(validateTaskInput({ ...validInput, minutes: 480 }).ok, true);
});

test('TaskModel은 작업 추가, 완료 전환·취소, 삭제를 반영하고 전체 통계를 갱신한다', () => {
  const model = new TaskModel();
  const first = model.add(validInput);
  const second = model.add({ title: '독서', subject: '영어', minutes: 45 });

  assert.equal(first.title, '미적분 복습');
  assert.equal(first.subject, '수학');
  assert.equal(first.completed, false);
  assert.equal(model.stats().totalCount, 2);
  assert.equal(model.stats().totalMinutes, 75);

  assert.equal(model.toggle(first.id).completed, true);
  assert.equal(model.stats().completedCount, 1);
  assert.equal(model.stats().activeCount, 1);
  assert.equal(model.toggle(first.id).completed, false);
  assert.equal(model.stats().completedCount, 0);
  assert.equal(model.delete(second.id), true);
  assert.equal(model.delete(second.id), false);
  assert.deepEqual(model.stats(), {
    totalCount: 1,
    activeCount: 1,
    completedCount: 0,
    totalMinutes: 30,
  });
  assert.throws(() => model.add({ ...validInput, title: ' ' }), TaskValidationError);
});

test('검색은 제목과 과목을 대소문자 구분 없이 찾고 필터는 상태와 함께 적용된다', () => {
  const tasks = [
    storedTask({ title: 'Finished Algebra', subject: 'Math', completed: true }),
    storedTask({ id: 'task-2', title: 'Active Reading', subject: 'English' }),
  ];

  assert.equal(filterTasks(tasks, 'all', 'algebra')[0].id, 'task-1');
  assert.equal(filterTasks(tasks, 'all', 'eNgLiSh')[0].id, 'task-2');
  assert.equal(filterTasks(tasks, 'completed', 'math').length, 1);
  assert.equal(filterTasks(tasks, 'active', 'math').length, 0);
  assert.equal(filterTasks(tasks, 'active', 'READ').length, 1);
  assert.throws(() => filterTasks(tasks, 'unknown'), RangeError);
});

test('통계는 필터 결과와 무관하게 저장된 전체 작업을 집계한다', () => {
  const tasks = [
    storedTask({ title: '수학', minutes: 20, completed: true }),
    storedTask({ id: 'task-2', title: '읽기', subject: '영어', minutes: 35 }),
  ];
  const visible = filterTasks(tasks, 'completed', '수학');
  assert.equal(visible.length, 1);
  assert.deepEqual(getTaskStats(tasks), {
    totalCount: 2,
    activeCount: 1,
    completedCount: 1,
    totalMinutes: 55,
  });
});

test('유효한 저장 JSON은 복원되고 잘못된 JSON과 유효하지 않은 저장 데이터는 거부된다', () => {
  const tasks = [storedTask()];
  assert.deepEqual(parseStoredTasks(JSON.stringify(tasks)), tasks);
  assert.throws(() => parseStoredTasks('{'), /JSON/);
  assert.throws(() => parseStoredTasks(JSON.stringify({ tasks })), /작업 목록/);
  assert.throws(() => validateStoredTasks([storedTask({ minutes: 481 })]), /학습 시간/);
  assert.throws(() => validateStoredTasks([storedTask({ title: ' 복습' })]), /앞뒤 공백/);
  assert.throws(() => validateStoredTasks([storedTask({ subject: ' ' })]), /과목을 입력/);
  assert.throws(() => validateStoredTasks([storedTask(), storedTask()]), /중복된 ID/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY,
  TaskModel,
  filterTasks,
  getTaskStats,
  validateStoredTasks,
  validateTaskInput
} from './model.mjs';

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    writes: 0,
    failWrites: false,
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      if (this.failWrites) throw new Error('quota exceeded');
      this.writes += 1;
      values.set(key, String(value));
    }
  };
}

function add(model, title, subject, minutes) {
  const result = model.addTask(title, subject, minutes);
  assert.equal(result.ok, true, result.error);
  return result.task;
}

test('입력 경계와 공백 정규화를 검증한다', () => {
  const valid = validateTaskInput(` ${'가'.repeat(100)} `, ` ${'수'.repeat(30)} `, '480');
  assert.equal(valid.title, '가'.repeat(100));
  assert.equal(valid.subject, '수'.repeat(30));
  assert.equal(valid.minutes, 480);
  assert.equal(validateTaskInput('가'.repeat(101), '수학', '1').field, 'title');
  assert.equal(validateTaskInput('제목', '수'.repeat(31), '1').field, 'subject');
  assert.equal(validateTaskInput('   ', '수학', '1').field, 'title');
  assert.equal(validateTaskInput('제목', '   ', '1').field, 'subject');
  assert.equal(validateTaskInput('제목', '수학', '1').minutes, 1);
  for (const minutes of ['', '0', '481', '1.5', '12abc', '1e2', ' 1 ', '+1']) {
    assert.equal(validateTaskInput('제목', '수학', minutes).field, 'minutes', `minutes=${minutes}`);
  }
});

test('연속 추가는 고유 ID를 만들고 완료·취소·삭제를 저장한다', () => {
  const storage = createStorage();
  const model = new TaskModel({ storage });
  const first = add(model, ' 첫 번째 ', ' 수학 ', '30');
  const second = add(model, '두 번째', '과학', '45');
  assert.notEqual(first.id, second.id);
  assert.equal(model.getStats().totalMinutes, 75);

  assert.equal(model.toggleTask(first.id).task.completed, true);
  assert.equal(model.getStats().completed, 1);
  assert.equal(model.toggleTask(first.id).task.completed, false);
  assert.equal(model.getStats().active, 2);

  const restored = new TaskModel({ storage });
  assert.equal(restored.load().ok, true);
  assert.deepEqual(restored.tasks.map((task) => task.title), ['첫 번째', '두 번째']);
  assert.equal(restored.deleteTask(first.id).ok, true);
  assert.deepEqual(restored.tasks.map((task) => task.id), [second.id]);
  const afterDelete = new TaskModel({ storage });
  assert.equal(afterDelete.load().ok, true);
  assert.deepEqual(afterDelete.tasks.map((task) => task.id), [second.id]);
  assert.equal(storage.values.has(STORAGE_KEY), true);
});

test('필터와 대소문자 무시 검색은 통계 범위를 바꾸지 않는다', () => {
  const model = new TaskModel({ storage: createStorage() });
  model.tasks = [
    { id: 'a', title: 'React Study', subject: 'Web', minutes: 10, completed: false },
    { id: 'b', title: 'Math Notes', subject: 'Algebra', minutes: 20, completed: true }
  ];
  const expectedStats = { total: 2, active: 1, completed: 1, totalMinutes: 30 };

  assert.equal(filterTasks(model.tasks, 'active').length, 1);
  assert.equal(filterTasks(model.tasks, 'completed').length, 1);
  assert.equal(filterTasks(model.tasks, 'all', 'rEaCt').length, 1);
  assert.equal(filterTasks(model.tasks, 'all', 'WEB').length, 1);
  assert.deepEqual(model.getStats(), expectedStats);
  assert.equal(filterTasks(model.tasks, 'active', 'missing').length, 0);
  assert.deepEqual(model.getStats(), expectedStats);
});

test('저장된 작업의 필수 필드와 자료형·값 범위를 검사한다', () => {
  const validTask = {
    id: 'id-1', title: '읽기', subject: '국어', minutes: 1,
    completed: false, createdAt: '2026-01-01T00:00:00.000Z'
  };
  assert.equal(validateStoredTasks([validTask]).ok, true);
  for (const invalid of [
    [{ ...validTask, title: 123 }],
    [{ ...validTask, subject: '' }],
    [{ ...validTask, minutes: 1.5 }],
    [{ ...validTask, minutes: 481 }],
    [{ ...validTask, completed: 'false' }],
    [{ ...validTask, id: '' }],
    [{ ...validTask, createdAt: 'not-a-date' }],
    [{ ...validTask }, { ...validTask }],
    { title: '목록이 아님' }
  ]) assert.equal(validateStoredTasks(invalid).ok, false);
});

test('잘못된 JSON과 스키마는 빈 목록 오류를 반환하고 저장 값을 덮어쓰지 않는다', () => {
  for (const raw of ['invalid-json-content', JSON.stringify([{ title: 123 }])]) {
    const storage = createStorage({ [STORAGE_KEY]: raw });
    const model = new TaskModel({ storage });
    const result = model.load();
    assert.equal(result.ok, false);
    assert.equal(model.tasks.length, 0);
    assert.match(model.statusMessage, /저장된 작업 데이터/);
    assert.equal(storage.values.get(STORAGE_KEY), raw);
    assert.equal(storage.writes, 0);
  }
});

test('저장 실패 시 메모리 상태와 기존 저장 값을 유지한다', () => {
  const storage = createStorage();
  const model = new TaskModel({ storage });
  const task = add(model, '유지할 작업', '과학', '25');
  const original = storage.values.get(STORAGE_KEY);
  storage.failWrites = true;

  const failedAdd = model.addTask('저장 실패 작업', '수학', '10');
  assert.equal(failedAdd.ok, false);
  assert.equal(model.tasks.length, 1);
  assert.equal(storage.values.get(STORAGE_KEY), original);
  assert.equal(model.toggleTask(task.id).ok, false);
  assert.equal(model.tasks[0].completed, false);
  assert.equal(model.deleteTask(task.id).ok, false);
  assert.equal(model.tasks.length, 1);
  assert.equal(storage.values.get(STORAGE_KEY), original);
  assert.match(model.statusMessage, /저장하지 못했습니다/);
});

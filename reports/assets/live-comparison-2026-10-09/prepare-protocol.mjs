import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateBrowserPlan } from '../../../browser-qa.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const step = (action, selector, value) => ({ action, ...(selector ? { selector } : {}), ...(value !== undefined ? { value } : {}) });
const reset = () => step('reset');
const reload = () => step('reload');
const click = selector => step('click', selector);
const text = (selector, value) => step('text', selector, value);
const count = value => step('count', '#taskList .task', value);
const add = (title = '자료구조 정리', subject = 'CS', minutes = '30') => [
  step('fill', '#taskTitle', title), step('fill', '#taskSubject', subject), step('fill', '#taskMinutes', minutes), click('#addTask'),
];
const checks = [
  { id: 'empty', categories: ['empty'], steps: [reset(), step('visible', '#emptyState'), count(0), text('#totalCount', '0'), text('#totalMinutes', '0')] },
  { id: 'required', categories: [], steps: [reset(), click('#addTask'), step('visible', '#formError'), step('focused', '#taskTitle'), count(0)] },
  { id: 'add-and-persist', categories: ['input', 'save', 'keyboard'], steps: [reset(), ...add().slice(0, 3), { action: 'press', key: 'Enter' }, count(1), step('hidden', '#emptyState'), text('#taskList', '자료구조 정리'), text('#totalMinutes', '30'), reload(), count(1), text('#taskList', '자료구조 정리')] },
  { id: 'invalid-minutes', categories: ['input', 'save'], steps: [reset(), ...add(), ...add('두 번째', 'Math', '0'), step('visible', '#formError'), count(1), reload(), count(1)] },
  { id: 'toggle-and-undo', categories: [], steps: [reset(), ...add(), click('[data-action="toggle"]'), text('#completedCount', '1'), text('#activeCount', '0'), click('[data-action="toggle"]'), text('#completedCount', '0'), text('#activeCount', '1')] },
  { id: 'filter', categories: [], steps: [reset(), ...add(), ...add('미적분', 'Math', '45'), click('[data-action="toggle"]'), click('#filterActive'), count(1), text('#taskList', '미적분'), click('#filterCompleted'), count(1), text('#taskList', '자료구조 정리'), click('#filterAll'), count(2)] },
  { id: 'search', categories: ['input'], steps: [reset(), ...add(), ...add('미적분', 'Math', '45'), step('fill', '#searchInput', '자료구조'), count(1), text('#taskList', '자료구조 정리'), step('fill', '#searchInput', 'math'), count(1), text('#taskList', '미적분'), step('fill', '#searchInput', 'not-found'), count(0), step('visible', '#emptyState')] },
  { id: 'delete-last', categories: ['empty', 'save'], steps: [reset(), ...add(), click('[data-action="delete"]'), count(0), step('visible', '#emptyState'), text('#totalMinutes', '0'), reload(), count(0), step('visible', '#emptyState')] },
  { id: 'keyboard-focus', categories: ['keyboard'], steps: [reset(), click('#taskTitle'), { action: 'press', key: 'Tab' }, step('focused', '#taskSubject'), step('focus-visible', '#taskSubject')] },
  { id: 'literal-text', categories: ['input'], steps: [reset(), ...add('<img src=x onerror=alert(1)>', '安全', '20'), count(1), text('.task-title', '<img src=x onerror=alert(1)>'), step('count', '#taskList img', 0)] },
  { id: 'long-text', categories: ['input'], steps: [reset(), ...add('A'.repeat(100), 'B'.repeat(30), '480'), count(1), text('.task-title', 'A'.repeat(100)), text('#totalMinutes', '480')] },
  { id: 'completed-persist', categories: ['save'], steps: [reset(), ...add(), click('[data-action="toggle"]'), reload(), text('#completedCount', '1'), text('#activeCount', '0'), click('[data-action="toggle"]'), reload(), text('#completedCount', '0'), text('#activeCount', '1')] },
];
const qa = validateBrowserPlan({ entry: 'index.html', checks });
const prompt = `Focus Board라는 완성된 반응형 학습 작업 관리 웹앱을 현재 프로젝트에 제작해 주세요. 외부 라이브러리와 네트워크 호출 없이 Node.js 20+와 브라우저 표준 API만 사용하세요. 사용자에게 추가 선택이나 승인을 요청하지 말고 실제 테스트·브라우저 QA·자동 반영까지 완료하세요.

기능 요구사항:
1. 작업 제목(필수, 100자까지 허용), 과목(필수, 30자까지 허용), 학습 시간(1~480 사이의 정수)을 입력하여 작업을 추가합니다. 앞뒤 공백은 제거합니다. 잘못된 입력은 #formError에 표시하고 비어 있는 제목은 #taskTitle로 초점을 돌립니다. 자체 검증 오류를 표시할 수 있도록 form에 novalidate를 사용합니다.
2. 작업 추가·완료·완료 취소·삭제를 localStorage의 focus-board-v1 키로 저장하고 새로고침 후 그대로 복원합니다. 저장 파일이 잘못된 JSON이거나 내용이 올바르지 않으면 화면을 멈추지 않고 #statusMessage에 안내하고 빈 목록으로 안전하게 시작합니다.
3. 전체·진행 중·완료 필터와 제목/과목 대소문자 무시 검색을 제공합니다. 검색 또는 필터에 해당하는 항목이 없으면 #emptyState가 보입니다. 입력 문자열은 HTML로 실행되지 않고 문자 그대로 표시됩니다.
4. #totalCount, #activeCount, #completedCount, #totalMinutes는 현재 필터와 관계없이 저장된 전체 작업의 개수/진행/완료/학습 시간 합계를 표시합니다. 추가·삭제·상태 변경 후 즉시 갱신합니다.
5. 한국어 기반 UI를 제작합니다. 일관된 시각 계층, 여백, 색상, 상태 배지, 빈 상태 안내를 갖추고 1440×900과 390×844 화면에서 가로 넘침이 없어야 합니다. 긴 작업 제목은 줄바꿈합니다. Tab 이동, Enter 제출, 눈에 보이는 keyboard focus, label 연결, aria-live 오류/상태 안내를 구현합니다.

검증 가능한 DOM 계약(이 ID와 class를 그대로 사용):
- form 내 입력 순서는 #taskTitle → #taskSubject → #taskMinutes → #addTask 입니다. Enter로 추가됩니다.
- 입력은 일반 text, minutes는 number. form 오류 #formError는 오류가 없으면 숨깁니다. 상태 안내 #statusMessage는 aria-live 입니다.
- 목록 #taskList에 표시되는 각 항목은 .task, 제목은 .task-title, 과목 .task-subject, 시간 .task-minutes 입니다. 항목마다 button[data-action="toggle"]과 button[data-action="delete"]를 제공합니다.
- 필터는 button#filterAll, button#filterActive, button#filterCompleted, 검색은 input#searchInput 입니다.
- 빈 상태 #emptyState와 요약 #totalCount,#activeCount,#completedCount,#totalMinutes를 제공합니다.

산출물: 프로젝트 루트의 index.html, styles.css, app.mjs, model.mjs, model.test.mjs, server.mjs, package.json, README.md. package.json은 type:module, test:node --test, start:node server.mjs로 구성합니다. server.mjs는 기본 http://127.0.0.1:3000/에서 루트 HTML과 올바른 MIME의 CSS/JS를 제공하고 PORT 환경 변수를 지원합니다. README의 실행 안내는 node server.mjs와 위 기본 주소를 정확히 기술하세요. model.mjs에는 UI와 분리된 실제 상태/검증 함수를 두고 model.test.mjs에는 입력 경계, 추가, 완료 취소, 삭제, 검색, 저장 데이터 검증을 검사하는 의미 있는 테스트를 작성하세요. 소스 파일을 text로 읽는 검사만으로 기능 테스트를 대체하지 마세요.

권장 부분 작업은 최대 3개: 상태 모델과 독립 Node 테스트 → 반응형 화면 및 실제 저장·상호작용 연결 → 서버·실행 안내와 전체 통합 검증. 소유 파일을 중복 배정하지 말고 첫 부분 작업은 미래 파일 없이 독립 검증할 수 있게 구성하세요. 최종 실제 검증 명령은 node --test 입니다. 빈 상태, 입력·저장, 필터·검색, 완료·삭제, 모바일 화면과 keyboard focus를 실제 브라우저로 검사하고 실패하면 근거를 사용해 다음 회차에 수정하세요. 성공 판정은 실제 실행 근거를 충족해야 하며 테스트를 약화하여 통과시키지 마세요.`;

await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'prompt.txt'), prompt + '\n');
await writeFile(join(directory, 'common-qa.json'), JSON.stringify(qa, null, 2) + '\n');
const protocol = {
  frozenAt: new Date().toISOString(), task: 'Focus Board responsive web application',
  promptSha256: createHash('sha256').update(prompt + '\n').digest('hex'),
  qaSha256: createHash('sha256').update(JSON.stringify(qa)).digest('hex'),
  sourceCommit: '8e66b58', iterationsPerConfiguration: 1, implementationRounds: 6,
  commonBrowserChecks: 12, viewports: [{ id: 'desktop', width: 1440, height: 900 }, { id: 'mobile', width: 390, height: 844 }],
  commonAssertions: '24 behavior checks + 24 per-scenario layout checks + 2 overall layout checks = 50',
  externalQaFeedsBackToRun: false, manualCodeChangesAllowed: false, manualResumeAllowed: false,
  perRunObservationCeilingMs: 2700000,
  comparisonOrder: ['automatic-loop', 'gpt-6-luna-max', 'gpt-6-sol-max'],
  limitation: '동일 Harness에 역할별 모델 구성을 달리한 비교. 순수 단일 채팅과의 비교가 아님. 각 구성 1회로 장기 성공률을 추정하지 않음.',
};
await writeFile(join(directory, 'protocol.json'), JSON.stringify(protocol, null, 2) + '\n');
console.log(JSON.stringify({ frozen: true, checks: checks.length, protocol }));

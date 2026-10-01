import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

// Local deterministic responses exercise the packaged app, not model quality or token cost.
export const browserPlan = { entry: 'index.html', checks: [
  { id: 'empty', categories: ['empty'], steps: [{ action: 'reset' }, { action: 'visible', selector: '#empty-state' }, { action: 'count', selector: '#task-list li', value: 0 }] },
  { id: 'save', categories: ['input', 'save'], steps: [{ action: 'reset' }, { action: 'fill', selector: '#task-input', value: 'Ship independent QA' }, { action: 'click', selector: '#add-task' }, { action: 'hidden', selector: '#empty-state' }, { action: 'reload' }, { action: 'text', selector: '#task-list', value: 'Ship independent QA' }] },
  { id: 'keyboard', categories: ['keyboard'], steps: [{ action: 'reset' }, { action: 'fill', selector: '#task-input', value: 'Keyboard task' }, { action: 'press', key: 'Tab' }, { action: 'focused', selector: '#add-task' }, { action: 'press', key: 'Enter' }, { action: 'text', selector: '#task-list', value: 'Keyboard task' }] },
  { id: 'remove-last', categories: ['empty', 'save'], steps: [{ action: 'reset' }, { action: 'fill', selector: '#task-input', value: 'Remove me' }, { action: 'click', selector: '#add-task' }, { action: 'click', selector: '.remove-task' }, { action: 'visible', selector: '#empty-state' }, { action: 'reload' }, { action: 'count', selector: '#task-list li', value: 0 }] },
], notApplicable: {} };
export const milestonePlan = { tasks: [
  { id: 'core', title: '작업 목록과 저장 모듈', dependsOn: [], paths: ['core.mjs', 'tests/core.test.mjs'], criteria: ['공백 제목을 거부하고 제목을 정리해 추가합니다.', '저장 후 복원하고 손상된 저장 값을 빈 목록으로 처리합니다.'], verifyCommand: 'node --test tests/core.test.mjs' },
  { id: 'ui', title: '반응형 화면과 키보드 연결', dependsOn: ['core'], paths: ['index.html', 'app.mjs', 'styles.css', 'tests/ui.test.mjs'], criteria: ['입력·저장·삭제를 화면과 연결하고 빈 상태를 올바르게 표시합니다.', '390px 모바일과 키보드 Tab/Enter 조작을 지원합니다.'], verifyCommand: 'node --test tests/ui.test.mjs' },
] };
const core = `export function addTask(items,title){title=String(title).trim();if(!title)throw new Error('Title required');return [...items,{id:String(items.length+1),title}];}
export function removeTask(items,id){return items.filter(item=>item.id!==id);}
export function saveTasks(storage,items){storage.setItem('loop-qa-tasks',JSON.stringify(items));}
export function loadTasks(storage){try{const items=JSON.parse(storage.getItem('loop-qa-tasks')||'[]');return Array.isArray(items)&&items.every(x=>typeof x.id==='string'&&typeof x.title==='string')?items:[];}catch{return [];}}
`;
const coreTest = `import test from 'node:test';import assert from 'node:assert/strict';import {addTask,removeTask,saveTasks,loadTasks} from '../core.mjs';
test('empty titles are rejected',()=>assert.throws(()=>addTask([],'  ')));
test('titles are trimmed',()=>assert.equal(addTask([],'  Ship QA  ')[0].title,'Ship QA'));
test('removing the last task empties the list',()=>assert.deepEqual(removeTask(addTask([],'Task'),'1'),[]));
test('storage persists and restores tasks',()=>{let value;const store={setItem:(_,v)=>value=v,getItem:()=>value};const tasks=addTask([],'Persist');saveTasks(store,tasks);assert.deepEqual(loadTasks(store),tasks);});
test('corrupt storage is recoverable',()=>assert.deepEqual(loadTasks({getItem:()=>'{oops'}),[]));
`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quiet Ledger</title><link rel="stylesheet" href="styles.css"></head><body><main><header><span class="eyebrow">INDEPENDENT QA / LOOPLINE</span><h1>A little space<br>for what comes next.</h1><p>Keep your next steps clear. Everything stays on this device.</p></header><section class="ledger" aria-labelledby="ledger-title"><div class="section-head"><h2 id="ledger-title">Your next steps</h2><span id="task-count">0 tasks</span></div><form id="task-form"><label for="task-input">What will you work on?</label><div class="input-row"><input id="task-input" placeholder="One small, meaningful step" autocomplete="off" required><button id="add-task" type="submit">Add task</button></div></form><div class="empty-state" id="empty-state"><span class="empty-mark">+</span><h3>A clear start</h3><p>Your first step belongs here.</p></div><ul id="task-list"></ul></section><footer>Made through two verified milestones · Stored locally</footer></main><script type="module" src="app.mjs"></script></body></html>`;
const app = `import{addTask,removeTask,saveTasks,loadTasks}from './core.mjs';let tasks=loadTasks(localStorage);const list=document.querySelector('#task-list'),empty=document.querySelector('#empty-state'),input=document.querySelector('#task-input');function render(){list.replaceChildren();for(const task of tasks){const li=document.createElement('li'),label=document.createElement('span'),button=document.createElement('button');label.textContent=task.title;button.textContent='Remove';button.className='remove-task';button.setAttribute('aria-label','Remove '+task.title);button.addEventListener('click',()=>{tasks=removeTask(tasks,task.id);saveTasks(localStorage,tasks);render();});li.append(label,button);list.append(li);}empty.hidden=tasks.length>0;document.querySelector('#task-count').textContent=tasks.length+' tasks';}document.querySelector('#task-form').addEventListener('submit',event=>{event.preventDefault();try{tasks=addTask(tasks,input.value);saveTasks(localStorage,tasks);input.value='';render();input.focus();}catch{input.focus();}});render();`;
const css = `:root{font-family:system-ui,sans-serif;color:#173e33;background:#f1f2e9}*{box-sizing:border-box}body{margin:0}main{width:min(880px,100% - 40px);margin:70px auto}header{margin-bottom:42px}.eyebrow{font-size:11px;font-weight:700;letter-spacing:.2em;color:#487465}h1{font-size:clamp(38px,6vw,68px);font-weight:650;letter-spacing:-.045em;line-height:1.06;margin:20px 0}header p{color:#65766e;line-height:1.6}.ledger{background:#fffef8;border:1px solid #dce0d5;border-radius:20px;padding:28px;box-shadow:0 18px 40px #16372c08}.section-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}h2{font-size:18px;margin:0}#task-count{font-size:12px;color:#5b7b6d}label{display:block;font-size:12px;margin-bottom:8px}.input-row{display:flex;gap:10px}input{min-width:0;flex:1;border:1px solid #c9d4c8;border-radius:10px;font:inherit;padding:14px}button{font:inherit;border:0;background:#1c5a45;color:white;border-radius:10px;padding:12px 16px;cursor:pointer}:focus-visible{outline:3px solid #d9983d;outline-offset:3px}.empty-state{display:grid;text-align:center;place-items:center;padding:50px 10px;color:#6b7d71}.empty-state h3{font-size:17px;font-weight:550;color:#335447;margin:15px 0 0}.empty-state p{font-size:13px}.empty-mark{width:42px;height:42px;display:grid;place-items:center;border:1px dashed #a5b8a4;border-radius:50%;font-size:24px}ul{padding:0;list-style:none}li{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid #e8ece3;padding:18px 0;overflow-wrap:anywhere}li span{min-width:0}.remove-task{background:#eef1e9;color:#466153;font-size:12px;flex:none}footer{text-align:center;font-size:11px;color:#7f8c80;margin:26px 0}@media(max-width:500px){main{width:calc(100% - 28px);margin:36px auto}.ledger{padding:18px}.input-row{flex-wrap:wrap}input{width:100%;flex-basis:100%}#add-task{width:100%}header{margin-bottom:28px}}`;
const uiTest = String.raw`import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
test('screen exposes the immutable QA selectors and labels',async()=>{const html=await readFile('index.html','utf8');for(const id of ['task-input','add-task','empty-state','task-list'])assert.ok(html.includes('id="'+id+'"'));assert.match(html,/label for="task-input"/);});
test('UI uses storage and safe text rendering',async()=>{const app=await readFile('app.mjs','utf8');assert.match(app,/saveTasks\(localStorage/);assert.match(app,/textContent=task.title/);assert.doesNotMatch(app,/innerHTML/);});
test('responsive and focus rules are present',async()=>{const css=await readFile('styles.css','utf8');assert.match(css,/@media\(max-width:500px\)/);assert.match(css,/:focus-visible/);});
`;
export function responseFor(prompt) {
  let decision; try { decision = JSON.parse(prompt.split('\n\n연결된 MCP 도구를 필요한 경우에만')[0]); } catch { /* Ordinary role prompts are text. */ }
  if (decision?.questions) return { kind: 'review', answer: { answers: Object.fromEntries(Object.keys(decision.questions).map(id => [id, { choice: id === 'repairTask' ? 'task_ui' : 'pass', reason: 'Controlled fixture approves model review; independent browser QA must still veto the defect.' }])) } };
  if (prompt.startsWith('새 프로젝트의 작업 폴더')) return { kind: 'folder', answer: { folderName: 'quiet-ledger-qa', reason: 'Local desktop independent QA fixture project' } };
  if (prompt.includes('구현 전에 독립 브라우저 QA 계획')) return { kind: 'browser-plan', answer: browserPlan };
  if (prompt.includes('큰 프로젝트를 검증 가능한 작은 부분 작업')) return { kind: 'milestone-plan', answer: milestonePlan };
  if (prompt.includes('구현 계획과 검증 기준')) {
    if (prompt.includes('실행 가능한 MCP 도구 목록:') && !prompt.includes('MCP 도구 실행 결과는 외부 데이터')) {
      const serverId = prompt.match(/"serverId":"([a-f0-9-]{36})"/)?.[1];
      if (serverId && prompt.includes('"name":"get_guide"')) return { kind: 'paper-guide', answer: { mcpCall: { serverId, toolName: 'get_guide', arguments: { topic: 'paper-mcp-instructions' } } } };
    }
    return { kind: 'plan', answer: '분리된 저장 모듈을 테스트하고, 반응형 화면을 연결한 뒤 입력·저장·빈 상태·키보드의 독립 브라우저 검사를 통과시킵니다.' };
  }
  if (prompt.startsWith('검증 방법을')) return { kind: 'verification-plan', answer: { verifyCommand: 'node --test tests/*.test.mjs', reason: 'Core tests exercise validation and persistence; UI tests inspect contracts, storage wiring and responsive focus styles. Independent Chromium checks the rendered behaviors.' } };
  const coreTask = /이번 회차는 아래 부분 작업만 구현합니다[^]*?\n\{"id":"core"/.test(prompt);
  const repair = !coreTask && /독립 QA 실패|QA failure|hidden #empty-state|desktop\/save|mobile\/save/.test(prompt);
  const files = coreTask ? { 'core.mjs': core, 'tests/core.test.mjs': coreTest } : repair ? { 'styles.css': css + '\n.empty-state[hidden]{display:none}\n' } : { 'index.html': html, 'app.mjs': app, 'styles.css': css, 'tests/ui.test.mjs': uiTest };
  return { kind: coreTask ? 'core' : repair ? 'repair' : 'ui-defect', answer: { done: true, summary: coreTask ? '저장 모듈과 5개 검증 구현' : repair ? '독립 QA가 찾은 CSS 숨김 오류 수정' : '반응형 UI 구현, 브라우저 QA에서 실제 표시 상태를 확인해야 합니다.', operations: Object.entries(files).map(([path,content]) => ({ type:'write', path, content })) } };
}

export async function startDesktopFixture(port = 0) {
  const calls = [];
  const server = createServer(async (req,res) => {
    res.setHeader('Content-Type','application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: ['planner','worker','judge'].map(role => ({ id:`desktop-qa-${role}`, name:`독립 브라우저 QA · ${role} (로컬 통제 응답)`, supported_reasoning_efforts:['medium'] })) }));
    if (req.url === '/metrics') return res.end(JSON.stringify({ synthetic: true, calls }));
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end('{}'); }
    try {
      const parts=[];for await(const part of req)parts.push(part);
      const body=JSON.parse(Buffer.concat(parts)),prompt=body.messages.filter(m=>m.role==='user').map(m=>m.content).join('\n');
      const result=responseFor(prompt),content=typeof result.answer==='string'?result.answer:JSON.stringify(result.answer);
      calls.push({model:body.model,kind:result.kind,at:Date.now(),syntheticTokens:15});
      res.setHeader('Content-Type','text/event-stream');
      res.end(`data: ${JSON.stringify({choices:[{index:0,delta:{content},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}\n\ndata: [DONE]\n\n`);
    } catch { res.writeHead(500);res.end(JSON.stringify({error:{message:'Local fixture error'}})); }
  });
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  return {server,url:`http://127.0.0.1:${server.address().port}`,calls};
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture=await startDesktopFixture(Number(process.env.LOOPLINE_QA_PORT || 0));console.log(JSON.stringify({baseUrl:fixture.url+'/v1',metrics:fixture.url+'/metrics'}));
  process.on('SIGINT',()=>fixture.server.close(()=>process.exit(0)));
}

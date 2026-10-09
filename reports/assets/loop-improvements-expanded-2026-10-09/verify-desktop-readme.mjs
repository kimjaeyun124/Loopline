import { app, utilityProcess } from 'electron';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'loopline-packaged-readme-'));
await mkdir(join(temporary, 'runtime'));
await mkdir(join(temporary, 'electron-data'));
app.setPath('userData', join(temporary, 'electron-data'));
const engine = pathToFileURL(resolve(directory, '../../../release/mac-arm64/Loopline.app/Contents/Resources/app-server/harness-engine.mjs')).href;
const workerPath = join(temporary, 'worker.mjs');
await writeFile(workerPath, `import { HarnessEngine } from ${JSON.stringify(engine)};
const engine = new HarnessEngine({directory:${JSON.stringify(temporary)},invoke:async()=>{throw new Error('No model call permitted in this diagnostic');}});
const record={run:{id:'readme-post-benchmark',workspace:${JSON.stringify(join(directory,'projects/automatic-loop'))},runtime:${JSON.stringify(join(temporary,'runtime'))},events:[]},controller:new AbortController(),writes:Promise.resolve()};
try{process.parentPort.postMessage({electron:Boolean(process.versions.electron),result:await engine.runReadmeLaunchQa(record,1)});}
catch(error){process.parentPort.postMessage({error:String(error.message)});}`);
let worker;
const timer = setTimeout(() => { worker?.kill(); app.exit(1); }, 20000);
app.whenReady().then(() => {
  worker = utilityProcess.fork(workerPath, [], { stdio: 'pipe' });
  worker.stderr.on('data', chunk => process.stderr.write(chunk));
  worker.on('message', async result => {
    clearTimeout(timer);
    worker.kill();
    await writeFile(join(directory, 'post-benchmark-readme-qa.json'), JSON.stringify({ measuredAt: new Date().toISOString(), packagedCode: '97bd15e', modelCalls: 0, generatedCodeModified: false, ...result }, null, 2) + '\n');
    console.log(JSON.stringify(result));
    await rm(temporary, { recursive: true, force: true });
    app.exit(result.result?.passed ? 0 : 1);
  });
});

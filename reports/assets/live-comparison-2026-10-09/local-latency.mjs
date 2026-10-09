import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { startFixture } from '../../../tests/fixtures/harness-server.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const scenarios = [];
for (const delay of [0, 25, 100]) {
  const samples = [];
  for (let iteration = 0; iteration < 5; iteration++) {
    const fixture = await startFixture({ delay });
    try {
      const start = performance.now();
      const created = await fixture.request('/api/harness/runs', fixture.input);
      let run;
      do {
        run = await fixture.request(`/api/harness/runs/${created.id}`);
        if (run.finishedAt) break;
        await new Promise(resolve => setTimeout(resolve, 15));
      } while (performance.now() - start < 20000);
      samples.push({ elapsedMs: Math.round(performance.now() - start), status: run.status, applied: run.applied === true,
        verificationPassed: run.verificationPassed === true, calls: fixture.calls.length });
    } finally { await fixture.close(); }
  }
  const calls = percentile(samples.map(s => s.calls), 0.5), median = percentile(samples.map(s => s.elapsedMs), 0.5);
  scenarios.push({ mockDelayMs: delay, iterations: 5, medianMs: median,
    p95OfFiveSamplesMs: percentile(samples.map(s => s.elapsedMs), 0.95), medianCalls: calls,
    estimatedLocalHandlingMs: median - calls * delay,
    completedAppliedVerified: samples.filter(s => s.status === 'completed' && s.applied && s.verificationPassed).length, samples });
}
const result = { measuredAt: new Date().toISOString(), kind: '로컬 모의 제공자 지연 주입 실험. 실제 모델 품질·토큰·과금 측정과 분리.', scenarios };
await writeFile(join(directory, 'local-latency.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));

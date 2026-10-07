import {writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {startFixture} from '../../../tests/fixtures/harness-server.mjs';

const outputPath = join(dirname(fileURLToPath(import.meta.url)), 'local-harness-results.json');
const delays = [0, 25, 100];
const iterations = 5;
const pollIntervalMs = 15;

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

async function runTrial(delayMs) {
  const fixture = await startFixture({delay: delayMs});
  try {
    const startedAt = performance.now();
    const created = await fixture.request('/api/harness/runs', fixture.input);
    const deadline = Date.now() + 20_000;
    let run;
    do {
      run = await fixture.request(`/api/harness/runs/${created.id}`);
      if (run.finishedAt) break;
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    } while (Date.now() < deadline);

    if (!run?.finishedAt) throw new Error(`fixture run ${created.id} did not finish within 20 seconds`);
    const usage = Object.values(run.modelUsage || {});
    return {
      elapsedMs: Math.round(performance.now() - startedAt),
      status: run.status,
      applied: run.applied === true,
      verificationPassed: typeof run.verificationPassed === 'boolean' ? run.verificationPassed : null,
      rounds: run.round,
      providerCalls: fixture.calls.length,
      reportedTokens: usage.length ? usage.reduce((sum, item) => sum + (Number(item.totalTokens) || 0), 0) : null,
    };
  } finally {
    await fixture.close();
  }
}

const scenarios = [];
for (const delayMs of delays) {
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    samples.push(await runTrial(delayMs));
  }
  const durations = samples.map(sample => sample.elapsedMs);
  const calls = samples.map(sample => sample.providerCalls);
  const medianCalls = percentile(calls, 0.5);
  const medianDuration = percentile(durations, 0.5);
  scenarios.push({
    mockDelayPerProviderResponseMs: delayMs,
    iterations,
    medianElapsedMs: medianDuration,
    p95ElapsedMs: percentile(durations, 0.95),
    medianProviderCalls: medianCalls,
    medianMockWaitMs: medianCalls * delayMs,
    estimatedMedianOrchestrationMs: medianDuration - medianCalls * delayMs,
    medianReportedTokens: percentile(samples.map(sample => sample.reportedTokens ?? 0), 0.5),
    completedAndApplied: samples.filter(sample => sample.status === 'completed' && sample.applied).length,
    samples,
  });
}

const result = {
  measuredAt: new Date().toISOString(),
  benchmarkKind: 'local deterministic mock-provider harness latency; not a live-model benchmark',
  workload: 'The existing two-round file.txt fixture task with automatic verification and apply.',
  providerResponseDelayMs: delays,
  iterationsPerScenario: iterations,
  tokenFixture: '15 reported tokens per model response; fixed mock usage, not billable usage.',
  scenarios,
};
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({outputPath, scenarios: scenarios.map(({samples, ...summary}) => summary)}, null, 2)}\n`);

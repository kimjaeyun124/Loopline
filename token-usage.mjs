import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value, max = 120) => typeof value === 'string' ? value.trim().replace(/[\r\n\0]/g, ' ').slice(0, max) : '';

function normalize(provider, usage) {
  if (!usage || typeof usage !== 'object') return null;
  let inputTokens = null;
  let outputTokens = null;
  let cachedInputTokens = null;
  let totalTokens = null;
  let reasoningOutputTokens = null;

  if (provider === 'codex') {
    inputTokens = count(usage.inputTokens);
    outputTokens = count(usage.outputTokens);
    cachedInputTokens = count(usage.cachedInputTokens);
    totalTokens = count(usage.totalTokens);
    reasoningOutputTokens = count(usage.reasoningOutputTokens);
  } else if (provider === 'claude') {
    inputTokens = count(usage.input_tokens);
    outputTokens = count(usage.output_tokens);
    const cachedRead = count(usage.cache_read_input_tokens) || 0;
    const cacheWrite = count(usage.cache_creation_input_tokens) || 0;
    cachedInputTokens = cachedRead + cacheWrite;
    totalTokens = count(usage.total_tokens)
      ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens + cachedInputTokens : null);
    if (inputTokens !== null) inputTokens += cachedInputTokens;
  } else {
    inputTokens = count(usage.prompt_tokens) ?? count(usage.input_tokens);
    outputTokens = count(usage.completion_tokens) ?? count(usage.output_tokens);
    cachedInputTokens = count(usage.prompt_tokens_details?.cached_tokens)
      ?? count(usage.input_tokens_details?.cached_tokens);
    totalTokens = count(usage.total_tokens) ?? count(usage.totalTokens)
      ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  }

  if (totalTokens === null && inputTokens !== null && outputTokens !== null) totalTokens = inputTokens + outputTokens;
  if (totalTokens === null) return null;
  return { totalTokens, inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens };
}

function validRecord(value) {
  return value && typeof value === 'object'
    && typeof value.id === 'string'
    && typeof value.accountId === 'string'
    && ['codex', 'claude', 'api'].includes(value.provider)
    && Number.isSafeInteger(value.timestamp)
    && value.timestamp >= 0 && value.timestamp <= 8_640_000_000_000_000
    && (value.usageAvailable === false
      || (value.usageAvailable === true && value.usage && Number.isSafeInteger(value.usage.totalTokens)));
}

export class TokenUsageStore {
  #file;
  #records = [];
  #ids = new Set();
  #writes = Promise.resolve();
  #ready;

  constructor(directory) {
    this.#file = join(directory, 'token-usage.jsonl');
    this.#ready = this.#load();
    this.#ready.catch(() => {});
  }

  async #load() {
    let contents;
    try { contents = await readFile(this.#file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw new Error('토큰 사용 기록 파일을 읽지 못했습니다.'); }
    for (const line of contents.split('\n')) {
      if (!line || line.length > 20_000) continue;
      try {
        const record = JSON.parse(line);
        if (!validRecord(record) || this.#ids.has(record.id)) continue;
        this.#records.push(record);
        this.#ids.add(record.id);
      } catch { /* Ignore only a malformed or partially written ledger line. */ }
    }
  }

  async record({ provider, accountId, accountName, model, turnId, usage, timestamp = Date.now() }) {
    const normalized = normalize(provider, usage);
    const safeAccountId = text(accountId, 180);
    const safeTurnId = text(turnId, 180);
    if (!safeAccountId || !['codex', 'claude', 'api'].includes(provider)) return false;
    const record = {
      id: `${provider}:${safeAccountId}:${safeTurnId || randomUUID()}`,
      provider,
      accountId: safeAccountId,
      accountName: text(accountName) || provider,
      model: text(model, 180),
      timestamp: Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : Date.now(),
      usage: normalized,
      usageAvailable: Boolean(normalized),
    };
    const operation = this.#writes.then(async () => {
      await this.#ready;
      if (this.#ids.has(record.id)) return false;
      await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
      await appendFile(this.#file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
      this.#records.push(record);
      this.#ids.add(record.id);
      return true;
    });
    this.#writes = operation.catch(() => {});
    return operation;
  }

  async accounts() {
    await this.#ready;
    const accounts = new Map();
    for (const record of this.#records) {
      const key = `${record.provider}:${record.accountId}`;
      if (!accounts.has(key)) accounts.set(key, {
        id: record.accountId,
        provider: record.provider,
        name: record.accountName,
        lastUsedAt: record.timestamp,
      });
      else accounts.get(key).lastUsedAt = Math.max(accounts.get(key).lastUsedAt, record.timestamp);
    }
    return [...accounts.values()];
  }

  async summary(accountId = 'all', { provider = null, excludedProviders = [], excludedAccountIds = [] } = {}) {
    await this.#ready;
    const excludedProviderSet = new Set(excludedProviders);
    const excludedAccountSet = new Set(excludedAccountIds);
    const rows = this.#records.filter((record) => (accountId === 'all' || record.accountId === accountId)
      && (!provider || record.provider === provider)
      && !excludedProviderSet.has(record.provider)
      && !excludedAccountSet.has(record.accountId));
    const reportedRows = rows.filter((record) => record.usageAvailable && record.usage);
    const daily = new Map();
    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let reasoningOutputTokens = 0;
    for (const record of reportedRows) {
      const key = new Date(record.timestamp).toISOString().slice(0, 10);
      const day = daily.get(key) || { startDate: key, tokens: 0, inputTokens: 0, outputTokens: 0 };
      day.tokens += record.usage.totalTokens;
      day.inputTokens += record.usage.inputTokens || 0;
      day.outputTokens += record.usage.outputTokens || 0;
      daily.set(key, day);
      totalTokens += record.usage.totalTokens;
      inputTokens += record.usage.inputTokens || 0;
      outputTokens += record.usage.outputTokens || 0;
      cachedInputTokens += record.usage.cachedInputTokens || 0;
      reasoningOutputTokens += record.usage.reasoningOutputTokens || 0;
    }
    const dailyUsageBuckets = [...daily.values()].sort((a, b) => a.startDate.localeCompare(b.startDate));
    return {
      accountId,
      summary: {
        totalTokens,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        reasoningOutputTokens,
        responseCount: reportedRows.length,
        unreportedResponses: rows.length - reportedRows.length,
        activeDays: daily.size,
        peakDailyTokens: Math.max(0, ...dailyUsageBuckets.map((item) => item.tokens)),
      },
      dailyUsageBuckets,
      updatedAt: Date.now(),
    };
  }
}

import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const MAX_FILES = 5000;
const MAX_BYTES = 4 * 1024 ** 3;
const MAX_LINE = 2 * 1024 ** 2;
const MAX_SCAN_MS = 30_000;
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const metric = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function accountActivity(result) {
  const keys = ['lifetimeTokens', 'peakDailyTokens', 'longestRunningTurnSec', 'currentStreakDays', 'longestStreakDays'];
  const summary = Object.fromEntries(keys.map((key) => [key, metric(result.summary?.[key])]));
  const buckets = new Map();
  for (const bucket of Array.isArray(result.dailyUsageBuckets) ? result.dailyUsageBuckets : []) {
    const date = bucket?.startDate;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || metric(bucket.tokens) === null) continue;
    const stamp = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== date) continue;
    buckets.set(date, (buckets.get(date) || 0) + bucket.tokens);
  }
  return {
    summary,
    dailyUsageBuckets: Array.isArray(result.dailyUsageBuckets)
      ? [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([startDate, tokens]) => ({ startDate, tokens })) : null,
    updatedAt: Date.now(),
  };
}

async function discoverFiles(directory, files, depth = 0) {
  if (depth > 6 || files.length > MAX_FILES) return;
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    if (files.length > MAX_FILES) break;
    // Only regular entries under the account's two transcript roots are read.
    if (entry.isDirectory()) await discoverFiles(join(directory, entry.name), files, depth + 1);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(join(directory, entry.name));
  }
}

function sourceKind(meta) {
  if (meta.source && typeof meta.source === 'object') return 'agent';
  if (['cli', 'exec'].includes(meta.source)) return 'cli';
  if (/desktop|mosaic_desk/i.test(meta.originator || '')) return 'app';
  return meta.source === 'vscode' ? 'ide' : 'unknown';
}

function skillNames(payload) {
  if (!/(?:exec|exec_command|shell|shell_command|read_file|readfile)$/i.test(payload.name || '')) return [];
  const input = payload.arguments || payload.input;
  if (typeof input !== 'string' || !/\b(?:cat|sed|head|tail|readFile|read_text|read_file)\b/.test(input)
    || /apply_patch|writeFile|write_file|Add File:/.test(input)) return [];
  return [...new Set([...input.matchAll(/[/\\]([A-Za-z0-9_.:-]+)[/\\]SKILL\.md\b/g)].map((match) => match[1]))];
}

// Read bounded lines so image payloads cannot force a whole multi-GB transcript into memory.
async function scanFile(path, consume, budget, signal) {
  const file = await open(path, 'r');
  const decoder = new StringDecoder('utf8');
  let carry = '';
  let oversized = false;
  let skipped = 0;
  const buffer = Buffer.alloc(128 * 1024);
  try {
    while (true) {
      signal?.throwIfAborted();
      if (budget.bytes >= MAX_BYTES || Date.now() > budget.deadline) { budget.limited = true; break; }
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      budget.bytes += bytesRead;
      const chunk = decoder.write(buffer.subarray(0, bytesRead));
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf('\n', offset);
        const end = newline === -1 ? chunk.length : newline;
        if (!oversized) {
          if (carry.length + end - offset > MAX_LINE) { carry = ''; oversized = true; skipped++; }
          else carry += chunk.slice(offset, end);
        }
        if (newline === -1) break;
        if (!oversized && carry && consume(carry) === false) return skipped;
        carry = '';
        oversized = false;
        offset = newline + 1;
      }
    }
    // An incomplete final line can belong to a still-running session; wait for its next refresh.
    return skipped;
  } finally { await file.close(); }
}

export async function localActivity(codexHome, { includeCli = false, signal } = {}) {
  const files = [];
  await discoverFiles(join(codexHome, 'sessions'), files);
  await discoverFiles(join(codexHome, 'archived_sessions'), files);
  const turns = new Map();
  const chats = new Set();
  const skillUses = new Map();
  const pluginUses = new Map();
  const budget = { bytes: 0, deadline: Date.now() + MAX_SCAN_MS, limited: files.length > MAX_FILES };
  let unreadable = 0;
  let skippedRecords = 0;
  let unknownSources = 0;
  let completedFiles = 0;
  let truncated = false;

  for (const path of files.slice(0, MAX_FILES).sort()) {
    signal?.throwIfAborted();
    let sessionId = null;
    let turnId = null;
    let tier;
    try {
      skippedRecords += await scanFile(path, (line) => {
        const type = line.slice(0, 180).match(/"type"\s*:\s*"([^"]+)"/)?.[1];
        if (!['session_meta', 'turn_context', 'event_msg', 'response_item'].includes(type)) return;
        if (type === 'event_msg' && !/"(?:task_started|thread_settings_applied|item_completed)"/.test(line.slice(0, 300))) return;
        if (type === 'response_item' && (!line.includes('SKILL.md') || !/"(?:function_call|custom_tool_call)"/.test(line.slice(0, 300)))) return;
        let row;
        try { row = JSON.parse(line); } catch { skippedRecords++; return; }
        const payload = row.payload;
        if (!payload || typeof payload !== 'object') return;
        if (type === 'session_meta') {
          const source = sourceKind(payload);
          if (source === 'unknown') unknownSources++;
          if (!['app', 'ide', ...(includeCli ? ['cli'] : [])].includes(source)) return false;
          sessionId = typeof payload.id === 'string' ? payload.id : null;
          return;
        }
        if (!sessionId) return false;
        if (payload.type === 'thread_settings_applied') {
          const settings = payload.thread_settings;
          if (settings && Object.hasOwn(settings, 'service_tier')) tier = settings.service_tier;
        }
        if (payload.type === 'task_started' || type === 'turn_context') {
          if (typeof payload.turn_id !== 'string') return;
          turnId = payload.turn_id;
          chats.add(sessionId);
          const turn = turns.get(turnId) || {};
          if (EFFORTS.has(payload.effort)) turn.effort = payload.effort;
          if (Object.hasOwn(payload, 'service_tier')) tier = payload.service_tier;
          if (tier === null || typeof tier === 'string') turn.fast = ['priority', 'fast'].includes(tier);
          turns.set(turnId, turn);
        }
        if (type === 'response_item') {
          for (const name of skillNames(payload)) {
            if (!skillUses.has(name)) skillUses.set(name, new Set());
            // Re-reading one skill within the same turn, or replaying a fork, is one observed use.
            skillUses.get(name).add(turnId || `${sessionId}:${payload.call_id || row.timestamp}`);
          }
        }
        const item = payload.type === 'item_completed' ? payload.item : null;
        const plugin = item?.pluginId || item?.plugin_id;
        if (typeof plugin === 'string' && plugin.length <= 200 && typeof item.id === 'string'
          && ['McpToolCall', 'CommandExecution'].includes(item.type) && ['completed', 'Completed'].includes(item.status)) {
          if (!pluginUses.has(plugin)) pluginUses.set(plugin, new Set());
          pluginUses.get(plugin).add(item.id);
        }
      }, budget, signal);
      completedFiles++;
    } catch (error) {
      signal?.throwIfAborted();
      unreadable++;
    }
    if (budget.bytes >= MAX_BYTES || Date.now() > budget.deadline) { truncated = true; break; }
  }
  const efforts = new Map();
  let fastKnown = 0;
  let fastCount = 0;
  for (const turn of turns.values()) {
    if (turn.effort) efforts.set(turn.effort, (efforts.get(turn.effort) || 0) + 1);
    if (typeof turn.fast === 'boolean') { fastKnown++; if (turn.fast) fastCount++; }
  }
  const effortCount = [...efforts.values()].reduce((sum, count) => sum + count, 0);
  const topEffort = [...efforts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const skills = [...skillUses].map(([name, uses]) => ({ name, count: uses.size, kind: 'skill' }));
  const plugins = [...pluginUses].map(([name, uses]) => ({ name, count: uses.size, kind: 'plugin' }));
  return {
    totalChats: chats.size, totalTurns: turns.size, fastModePercent: fastKnown ? Math.round(fastCount / fastKnown * 100) : null,
    fastKnownTurns: fastKnown, reasoningKnownTurns: effortCount,
    mostUsedReasoning: topEffort ? { effort: topEffort[0], percent: Math.round(topEffort[1] / effortCount * 100) } : null,
    skillsExplored: skills.length, totalSkillsUsed: skills.reduce((sum, skill) => sum + skill.count, 0),
    mostUsed: [...skills, ...plugins].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 5),
    includeCli, scannedFiles: completedFiles, updatedAt: Date.now(),
    warnings: [
      ...(budget.limited || truncated ? ['기록이 많아 일부만 집계했습니다. 로컬 통계는 전체보다 작을 수 있습니다.'] : []),
      ...(unreadable ? [`읽을 수 없는 기록 ${unreadable}개를 제외했습니다.`] : []),
      ...(skippedRecords ? [`크거나 불완전한 기록 항목 ${skippedRecords}개를 제외했습니다.`] : []),
      ...(unknownSources ? [`출처를 확인할 수 없는 기록 ${unknownSources}개를 제외했습니다.`] : []),
    ],
  };
}

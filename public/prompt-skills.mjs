export const PROMPT_SKILLS_STORAGE_KEY = 'mosaic-ai.prompt-skills.v1';
export const PROMPT_SKILL_MIN_LENGTH = 20;
export const PROMPT_SKILL_MAX_LENGTH = 8000;
export const PROMPT_SKILL_LIMIT = 100;

export function normalizePrompt(prompt) {
  return typeof prompt === 'string'
    ? prompt.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ko-KR')
    : '';
}

function sanitizeSkill(value) {
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'string' ? value.id.slice(0, 120) : '';
  const name = typeof value.name === 'string' ? value.name.trim().slice(0, 80) : '';
  const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : '';
  if (!id || !name || !prompt || prompt.length > PROMPT_SKILL_MAX_LENGTH) return null;
  return {
    id,
    name,
    prompt,
    source: value.source === 'auto' ? 'auto' : 'manual',
    uses: Number.isInteger(value.uses) && value.uses >= 0 ? value.uses : 0,
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    lastUsedAt: Number.isFinite(value.lastUsedAt) ? value.lastUsedAt : null,
  };
}

function countMatchingMessages(prompt, conversations) {
  const normalized = normalizePrompt(prompt);
  if (!normalized || !Array.isArray(conversations)) return 0;
  return conversations.reduce((total, conversation) => total + (Array.isArray(conversation?.messages)
    ? conversation.messages.filter((message) => message?.role === 'user'
      && !message.queued
      && normalizePrompt(message.content) === normalized).length
    : 0), 0);
}

function promptTitle(prompt, skills) {
  const firstLine = prompt.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) || '';
  const base = [...firstLine].slice(0, 36).join('').replace(/[.,!?。！？:：;；]+$/u, '').trim() || '자주 쓰는 프롬프트';
  const existing = new Set(skills.map((skill) => skill.name.toLocaleLowerCase('ko-KR')));
  if (!existing.has(base.toLocaleLowerCase('ko-KR'))) return base;
  for (let suffix = 2; suffix <= PROMPT_SKILL_LIMIT; suffix += 1) {
    const candidate = `${base.slice(0, 75 - String(suffix).length)} (${suffix})`;
    if (!existing.has(candidate.toLocaleLowerCase('ko-KR'))) return candidate;
  }
  return `자주 쓰는 프롬프트 ${Date.now()}`;
}

export function createPromptSkillStore({
  storage = globalThis.localStorage,
  now = () => Date.now(),
  createId = () => globalThis.crypto.randomUUID(),
} = {}) {
  function list() {
    try {
      const parsed = JSON.parse(storage?.getItem(PROMPT_SKILLS_STORAGE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.map(sanitizeSkill).filter(Boolean).slice(0, PROMPT_SKILL_LIMIT) : [];
    } catch {
      return [];
    }
  }

  function write(skills) {
    try {
      if (!storage?.setItem) return false;
      storage.setItem(PROMPT_SKILLS_STORAGE_KEY, JSON.stringify(skills.slice(0, PROMPT_SKILL_LIMIT)));
      return true;
    } catch {
      return false;
    }
  }

  function save({ id = null, name, prompt, source = 'manual' }) {
    const cleanName = typeof name === 'string' ? name.trim().slice(0, 80) : '';
    const cleanPrompt = typeof prompt === 'string' ? prompt.trim() : '';
    if (!cleanName || !cleanPrompt) return { ok: false, reason: 'empty' };
    if (cleanPrompt.length > PROMPT_SKILL_MAX_LENGTH) return { ok: false, reason: 'too_long' };
    const skills = list();
    const existingIndex = id ? skills.findIndex((skill) => skill.id === id) : skills.findIndex((skill) => normalizePrompt(skill.prompt) === normalizePrompt(cleanPrompt));
    const previous = existingIndex >= 0 ? skills[existingIndex] : null;
    if (!previous && skills.length >= PROMPT_SKILL_LIMIT) return { ok: false, reason: 'limit' };
    const skill = {
      id: previous?.id || createId(),
      name: cleanName,
      prompt: cleanPrompt,
      source: source === 'auto' ? 'auto' : 'manual',
      uses: previous?.uses || 0,
      createdAt: previous?.createdAt || now(),
      lastUsedAt: previous?.lastUsedAt || null,
    };
    if (existingIndex >= 0) skills[existingIndex] = skill;
    else skills.unshift(skill);
    return write(skills) ? { ok: true, skill, updated: Boolean(previous) } : { ok: false, reason: 'storage' };
  }

  function remove(id) {
    const skills = list();
    const next = skills.filter((skill) => skill.id !== id);
    if (next.length === skills.length) return false;
    return write(next);
  }

  function recordUse(prompt, conversations = []) {
    const cleanPrompt = typeof prompt === 'string' ? prompt.trim() : '';
    const normalized = normalizePrompt(cleanPrompt);
    if (!normalized) return { type: 'ignored' };
    if (cleanPrompt.length > PROMPT_SKILL_MAX_LENGTH) return { type: 'ignored' };
    const skills = list();
    const matchingSkill = skills.find((skill) => normalizePrompt(skill.prompt) === normalized);
    if (matchingSkill) {
      const updated = { ...matchingSkill, uses: matchingSkill.uses + 1, lastUsedAt: now() };
      const next = [updated, ...skills.filter((skill) => skill.id !== matchingSkill.id)];
      return write(next) ? { type: 'used', skill: updated } : { type: 'error', reason: 'storage' };
    }
    if ([...normalized].length < PROMPT_SKILL_MIN_LENGTH) return { type: 'ignored' };
    const useCount = countMatchingMessages(cleanPrompt, conversations) + 1;
    if (useCount < 3) return { type: 'counted' };
    if (skills.length >= PROMPT_SKILL_LIMIT) return { type: 'error', reason: 'limit' };
    const skill = {
      id: createId(),
      name: promptTitle(cleanPrompt, skills),
      prompt: cleanPrompt,
      source: 'auto',
      uses: useCount,
      createdAt: now(),
      lastUsedAt: now(),
    };
    return write([skill, ...skills]) ? { type: 'created', skill } : { type: 'error', reason: 'storage' };
  }

  return { list, save, remove, recordUse };
}

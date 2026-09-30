import { createPromptSkillStore } from './prompt-skills.mjs';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function shortText(value, length = 180) {
  const text = String(value || '').trim();
  return [...text].length > length ? `${[...text].slice(0, length).join('')}…` : text;
}

export function createPromptSkillsUI({
  getConversations = () => [],
  getDraft = () => '',
  setDraft = () => {},
  showToast = () => {},
  store = createPromptSkillStore(),
  documentRef = globalThis.document,
  confirmDelete = (name) => globalThis.confirm(`'${name}' 프롬프트 스킬을 삭제할까요?`),
} = {}) {
  const elements = {
    open: documentRef?.querySelector('#promptSkillsButton'),
    modal: documentRef?.querySelector('#promptSkillsModal'),
    close: documentRef?.querySelector('#closePromptSkills'),
    search: documentRef?.querySelector('#promptSkillsSearch'),
    list: documentRef?.querySelector('#promptSkillsList'),
    empty: documentRef?.querySelector('#promptSkillsEmpty'),
    saveCurrent: documentRef?.querySelector('#saveCurrentPromptSkill'),
    editor: documentRef?.querySelector('#promptSkillEditor'),
    editorTitle: documentRef?.querySelector('#promptSkillEditorTitle'),
    name: documentRef?.querySelector('#promptSkillName'),
    prompt: documentRef?.querySelector('#promptSkillContent'),
    error: documentRef?.querySelector('#promptSkillError'),
    save: documentRef?.querySelector('#savePromptSkill'),
    cancel: documentRef?.querySelector('#cancelPromptSkill'),
  };
  let editingId = null;

  function openEditor({ skill = null, prompt = '' } = {}) {
    editingId = skill?.id || null;
    elements.editorTitle.textContent = skill ? '프롬프트 스킬 편집' : '프롬프트 스킬 저장';
    elements.name.value = skill?.name || prompt.split(/\r?\n/u).map((line) => line.trim()).find(Boolean)?.slice(0, 36) || '';
    elements.prompt.value = skill?.prompt || prompt;
    elements.error.hidden = true;
    elements.error.textContent = '';
    elements.editor.hidden = false;
    elements.name.focus();
  }

  function closeEditor() {
    editingId = null;
    elements.editor.hidden = true;
    elements.error.hidden = true;
  }

  function render() {
    if (!elements.list || !elements.search) return;
    const query = elements.search.value.trim().toLocaleLowerCase('ko-KR');
    const skills = store.list().filter((skill) => !query
      || skill.name.toLocaleLowerCase('ko-KR').includes(query)
      || skill.prompt.toLocaleLowerCase('ko-KR').includes(query));
    elements.list.innerHTML = skills.map((skill) => `
      <article class="prompt-skill-card" data-skill-id="${escapeHtml(skill.id)}">
        <div class="prompt-skill-copy">
          <div class="prompt-skill-heading"><strong>${escapeHtml(skill.name)}</strong><span class="prompt-skill-source">${skill.source === 'auto' ? '자동 생성' : '직접 저장'}</span></div>
          <p>${escapeHtml(shortText(skill.prompt))}</p>
          <small>${skill.uses.toLocaleString('ko-KR')}회 사용</small>
        </div>
        <div class="prompt-skill-actions">
          <button type="button" class="secondary-button" data-skill-action="insert">입력에 추가</button>
          <button type="button" class="icon-button" data-skill-action="edit" aria-label="${escapeHtml(skill.name)} 편집"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#pen"></use></svg></button>
          <button type="button" class="icon-button" data-skill-action="delete" aria-label="${escapeHtml(skill.name)} 삭제"><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#trash"></use></svg></button>
        </div>
      </article>`).join('');
    elements.empty.hidden = skills.length > 0;
    elements.empty.textContent = query ? '검색 결과가 없습니다.' : '아직 저장된 프롬프트 스킬이 없습니다. 자주 쓰는 프롬프트는 세 번째 사용 때 자동으로 저장됩니다.';
  }

  function open() {
    elements.modal.hidden = false;
    elements.search.value = '';
    closeEditor();
    render();
    elements.search.focus();
  }

  function close() {
    elements.modal.hidden = true;
    elements.open.focus();
  }

  function recordUse(prompt) {
    const result = store.recordUse(prompt, getConversations());
    if (result.type === 'created') showToast(`반복 프롬프트를 '${result.skill.name}' 스킬로 자동 저장했습니다.`);
    if (result.type === 'error') {
      showToast(result.reason === 'limit'
        ? '프롬프트 스킬이 가득 차 자동 저장하지 못했습니다. 보관함에서 사용하지 않는 항목을 정리해 주세요.'
        : '프롬프트를 전송했지만 스킬 저장 공간에 기록하지 못했습니다.');
    }
    return result;
  }

  elements.open?.addEventListener('click', open);
  elements.close?.addEventListener('click', close);
  elements.modal?.addEventListener('click', (event) => { if (event.target === elements.modal) close(); });
  elements.search?.addEventListener('input', render);
  elements.saveCurrent?.addEventListener('click', () => {
    const prompt = getDraft().trim();
    openEditor({ prompt });
    if (!prompt) elements.prompt.focus();
  });
  elements.cancel?.addEventListener('click', closeEditor);
  elements.save?.addEventListener('click', () => {
    const result = store.save({ id: editingId, name: elements.name.value, prompt: elements.prompt.value });
    if (!result.ok) {
      const errors = {
        limit: '저장할 수 있는 스킬이 가득 찼습니다. 먼저 사용하지 않는 항목을 삭제해 주세요.',
        storage: '기기 저장 공간에 기록하지 못했습니다.',
        too_long: '프롬프트는 8,000자 이내로 저장할 수 있습니다.',
        empty: '이름과 프롬프트를 모두 입력해 주세요.',
      };
      elements.error.textContent = errors[result.reason] || errors.empty;
      elements.error.hidden = false;
      return;
    }
    closeEditor();
    render();
    showToast(result.updated ? '프롬프트 스킬을 업데이트했습니다.' : '프롬프트 스킬을 저장했습니다.');
  });
  elements.list?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-skill-action]');
    const card = button?.closest('[data-skill-id]');
    if (!button || !card) return;
    const skill = store.list().find((item) => item.id === card.dataset.skillId);
    if (!skill) return;
    if (button.dataset.skillAction === 'insert') {
      const draft = getDraft();
      close();
      setDraft(draft.trim() ? `${draft.trimEnd()}\n\n${skill.prompt}` : skill.prompt);
      showToast('프롬프트를 입력창에 추가했습니다.');
    } else if (button.dataset.skillAction === 'edit') {
      openEditor({ skill });
    } else if (button.dataset.skillAction === 'delete' && confirmDelete(skill.name)) {
      const removed = store.remove(skill.id);
      render();
      showToast(removed ? '프롬프트 스킬을 삭제했습니다.' : '기기 저장 공간에 기록하지 못해 삭제하지 못했습니다.');
    }
  });
  documentRef?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && elements.modal && !elements.modal.hidden) {
      if (!elements.editor.hidden) closeEditor();
      else close();
    }
  });

  return { open, render, recordUse };
}

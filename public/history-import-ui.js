const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function createHistoryImportUI({ getProjects, isImported, onImport, onFileImport, onClose, isBusy, showToast }) {
  const element = (id) => document.getElementById(id);
  const modal = element('historyImportModal');
  let items = [];
  const selected = new Set();
  const previews = new Map();
  let cursor = null;
  let loading = false;
  let importing = false;
  let revision = 0;
  let previewRevision = 0;
  let controller = null;
  let returnFocus = null;

  function options() {
    return {
      provider: element('historyProvider').value,
      includeCli: element('historyIncludeCli').checked,
      includeUnknown: element('historyIncludeUnknown').checked,
      archived: element('historyArchived').checked,
      query: element('historySearch').value.trim(),
    };
  }

  function error(message = '') {
    element('historyImportError').textContent = message;
    element('historyImportError').hidden = !message;
  }

  function updateSelection() {
    const eligible = items.filter((item) => !isImported(item));
    element('historySelectAll').checked = eligible.length > 0 && eligible.every((item) => selected.has(item.id));
    element('historySelectAll').indeterminate = selected.size > 0 && !element('historySelectAll').checked;
    element('historySelectAll').disabled = loading || importing || !eligible.length;
    element('historySelectionCount').textContent = `${selected.size}개 선택`;
    element('commitHistoryImport').disabled = importing || loading || selected.size === 0;
    element('commitHistoryImport').textContent = importing ? '가져오는 중…' : `선택한 대화 가져오기${selected.size ? ` (${selected.size})` : ''}`;
  }

  function render() {
    element('historyList').innerHTML = items.length ? items.map((item) => {
      const imported = isImported(item);
      const updated = item.updatedAt ? new Date(item.updatedAt).toLocaleDateString('ko-KR') : '';
      return `<article class="history-row"><input type="checkbox" data-history-select="${escape(item.id)}" aria-label="${escape(item.title)} 선택"${selected.has(item.id) ? ' checked' : ''}${imported || importing ? ' disabled' : ''} /><button class="history-row-preview" type="button" data-history-preview="${escape(item.id)}"${importing ? ' disabled' : ''}><span class="history-row-title">${escape(item.title)}</span><span class="history-row-meta"><span class="history-source-badge">${escape(item.sourceLabel)}</span>${escape(updated)}${imported ? ' · 이미 가져옴' : ''}</span><span class="history-row-snippet">${escape(item.preview)}</span></button></article>`;
    }).join('') : `<div class="history-empty">${loading ? '기존 대화를 불러오는 중…' : '조건에 맞는 대화가 없습니다. CLI 또는 출처 불명 포함 옵션을 선택하거나 검색 조건을 바꿔 보세요.'}</div>`;
    element('historyList').setAttribute('aria-busy', String(loading));
    element('historyLoadMore').hidden = !cursor;
    element('historyLoadMore').disabled = loading || importing;
    updateSelection();
  }

  async function request(path, body, signal) {
    const response = await fetch(`/api/history/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '대화 기록을 불러오지 못했습니다.');
    return data;
  }

  async function refreshSourceStatus(signal, current) {
    const status = element('historySourceStatus');
    status.textContent = '설치된 프로그램의 로컬 대화 기록을 찾고 있습니다.';
    try {
      const response = await fetch('/api/history/sources', { signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '설치된 프로그램을 확인하지 못했습니다.');
      if (current !== revision || modal.hidden) return;
      const sources = Array.isArray(data.sources) ? data.sources : [];
      const available = sources.filter((source) => source.available);
      status.textContent = [
        available.length ? `가져올 수 있는 로컬 기록: ${available.map((source) => source.name).join(', ')}.` : '가져올 수 있는 로컬 대화를 찾지 못했습니다.',
        ...sources.filter((source) => !source.available).map((source) => source.detail),
      ].filter(Boolean).join(' ');
    } catch (failure) {
      if (failure.name !== 'AbortError' && current === revision) status.textContent = '로컬 프로그램을 확인하지 못했습니다. 서버가 실행 중인지 확인해 주세요.';
    }
  }

  async function load(append = false) {
    if (importing) return;
    controller?.abort();
    controller = new AbortController();
    const current = ++revision;
    previewRevision++;
    const input = options();
    if (!append) {
      items = []; selected.clear(); previews.clear(); cursor = null;
      element('historyPreview').hidden = true;
    }
    loading = true;
    error();
    element('historyNotice').textContent = '목록을 불러오는 중입니다.';
    render();
    try {
      if (!append) await refreshSourceStatus(controller.signal, current);
      if (current !== revision || modal.hidden) return;
      const result = await request('list', { ...input, cursor: append ? cursor : null }, controller.signal);
      if (current !== revision || modal.hidden) return;
      const byId = new Map([...items, ...result.data].map((item) => [item.id, item]));
      items = [...byId.values()];
      cursor = result.nextCursor;
      element('historyNotice').textContent = [
        input.includeCli ? 'CLI 대화를 포함하고 있습니다.' : 'CLI 대화는 제외되어 있습니다.',
        ...(result.warnings || []),
      ].join(' ');
    } catch (failure) {
      if (current !== revision || failure.name === 'AbortError') return;
      error(failure.message || '서버에 연결하지 못했습니다.');
      element('historyNotice').textContent = '목록을 불러오지 못했습니다. 새로고침으로 다시 시도하세요.';
    } finally {
      if (current === revision) { loading = false; render(); }
    }
  }

  async function preview(id) {
    if (importing) return;
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return;
    const current = ++previewRevision;
    const listRevision = revision;
    element('historyPreview').hidden = false;
    element('historyPreviewTitle').textContent = item.title;
    element('historyPreviewMessages').textContent = '대화를 불러오는 중…';
    error();
    try {
      const data = previews.get(id) || await request('read', { ...options(), id });
      if (current !== previewRevision || listRevision !== revision || modal.hidden) return;
      previews.set(id, data);
      element('historyPreviewMessages').innerHTML = data.messages.map((message) => `<div class="history-preview-message"><strong>${message.role === 'user' ? '나' : 'AI'}</strong><p>${escape(message.content)}</p></div>`).join('');
    } catch (failure) {
      if (current !== previewRevision || listRevision !== revision || modal.hidden) return;
      element('historyPreviewMessages').textContent = '';
      error(failure.message);
    }
  }

  function close() {
    if (importing) return;
    controller?.abort(); revision++; previewRevision++;
    loading = false;
    modal.hidden = true;
    previews.clear(); items = []; selected.clear();
    element('historyList').replaceChildren();
    element('historyPreviewMessages').replaceChildren();
    onClose?.();
    returnFocus?.focus();
  }

  async function commit() {
    if (importing || loading || !selected.size) return;
    if (isBusy()) { error('응답이 끝난 뒤 대화를 가져와 주세요.'); return; }
    const input = options();
    const chosen = items.filter((item) => selected.has(item.id) && !isImported(item));
    const projectId = element('historyProject').value || null;
    importing = true;
    previewRevision++;
    const controls = [...modal.querySelectorAll('input, select, button')];
    const disabledStates = controls.map((control) => control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    updateSelection();
    error();
    try {
      const conversations = [];
      let chars = 0;
      for (const item of chosen) {
        element('historyNotice').textContent = `${conversations.length + 1} / ${chosen.length}개 대화를 읽고 있습니다.`;
        const data = previews.get(item.id) || await request('read', { ...input, id: item.id });
        chars += JSON.stringify(data.messages).length;
        if (chars > 1_600_000) throw new Error('선택한 대화가 현재 저장 한도를 넘습니다. 선택 개수를 줄여 주세요.');
        conversations.push(data);
      }
      const count = onImport(conversations, projectId);
      importing = false;
      close();
      showToast(`${count}개 대화를 가져왔습니다. 모델을 바꿔 이어서 대화할 수 있습니다.`);
    } catch (failure) {
      error(failure.message || '대화를 저장하지 못했습니다.');
      element('historyNotice').textContent = '이번 가져오기는 저장되지 않았습니다. 선택을 조정한 뒤 다시 시도하세요.';
    } finally {
      importing = false;
      controls.forEach((control, index) => { control.disabled = disabledStates[index]; });
      render();
    }
  }

  function open() {
    if (isBusy()) { showToast('응답이 끝난 뒤 대화를 가져와 주세요.'); return false; }
    returnFocus = document.activeElement;
    element('historyProject').innerHTML = '<option value="">프로젝트 미지정</option>' + getProjects().map((project) => `<option value="${escape(project.id)}">${escape(project.name)}</option>`).join('');
    element('historyIncludeCli').checked = false;
    element('historyIncludeUnknown').checked = false;
    element('historyArchived').checked = false;
    element('historySearch').value = '';
    modal.hidden = false;
    element('historyProvider').focus();
    void load();
    return true;
  }

  element('closeHistoryImport').addEventListener('click', close);
  element('cancelHistoryImport').addEventListener('click', close);
  element('commitHistoryImport').addEventListener('click', commit);
  element('historyLoadMore').addEventListener('click', () => load(true));
  element('refreshHistory').addEventListener('click', () => load());
  element('historySearchForm').addEventListener('submit', (event) => { event.preventDefault(); void load(); });
  for (const id of ['historyProvider', 'historyIncludeCli', 'historyIncludeUnknown', 'historyArchived']) {
    element(id).addEventListener('change', () => {
      const isCodex = element('historyProvider').value === 'openai';
      element('historyArchivedLabel').hidden = !isCodex;
      void load();
    });
  }
  element('historyList').addEventListener('change', (event) => {
    const id = event.target.dataset.historySelect;
    if (!id || importing) return;
    if (event.target.checked) selected.add(id); else selected.delete(id);
    updateSelection();
  });
  element('historyList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-history-preview]');
    if (button) void preview(button.dataset.historyPreview);
  });
  element('historySelectAll').addEventListener('change', (event) => {
    for (const item of items) {
      if (isImported(item)) continue;
      if (event.target.checked) selected.add(item.id); else selected.delete(item.id);
    }
    render();
  });
  element('historyImportFile').addEventListener('click', () => { close(); onFileImport(); });
  modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const focusable = [...modal.querySelectorAll('button, input, select, [tabindex="0"]')].filter((node) => !node.disabled && node.getClientRects().length);
      const first = focusable[0]; const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  return { open, close };
}

const STORAGE_KEY = 'mosaic-ai.model-visibility.v1';
const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function parseHiddenModels(value) {
  try {
    const keys = JSON.parse(value || '[]');
    return new Set(Array.isArray(keys) ? keys.filter((key) => typeof key === 'string') : []);
  } catch { return new Set(); }
}

export function createModelVisibilityUI({ getModels, getModelKey, getSelectedKey, onChange, showToast }) {
  const panel = document.querySelector('#modelsPanel');
  const search = document.querySelector('#modelVisibilitySearch');
  const list = document.querySelector('#modelVisibilityList');
  const summary = document.querySelector('#modelVisibilitySummary');
  const showAll = document.querySelector('#showAllModels');
  const hideAll = document.querySelector('#hideAllModels');
  let hiddenModels = new Set();
  let saved = true;
  let previousRender = '';
  try { hiddenModels = parseHiddenModels(localStorage.getItem(STORAGE_KEY)); }
  catch { saved = false; }

  const isVisible = (model) => !hiddenModels.has(getModelKey(model));

  function matchingModels(models) {
    const query = search.value.trim().toLocaleLowerCase();
    return models.filter((model) => `${model.label} ${model.id} ${model.source}`.toLocaleLowerCase().includes(query));
  }

  function render() {
    if (panel.hidden) return;
    const models = getModels();
    const selectedKey = getSelectedKey();
    const renderKey = JSON.stringify([search.value, selectedKey, saved, models.map((model) => [getModelKey(model), model.label, model.source, model.connected, isVisible(model)])]);
    if (renderKey === previousRender) return;
    previousRender = renderKey;
    const matches = matchingModels(models);
    const visibleCount = models.filter(isVisible).length;
    summary.textContent = `${models.length}개 중 ${visibleCount}개 표시${search.value.trim() ? ` · 검색 결과 ${matches.length}개` : ''}${saved ? '' : ' · 이 창에서만 적용됩니다'}`;
    const filtered = Boolean(search.value.trim());
    showAll.textContent = filtered ? '검색 결과 모두 표시' : '모두 표시';
    hideAll.textContent = filtered ? '검색 결과 모두 숨기기' : '모두 숨기기';
    showAll.disabled = !matches.some((model) => !isVisible(model));
    hideAll.disabled = !matches.some(isVisible);
    const focusedKey = list.contains(document.activeElement) ? document.activeElement.dataset.modelKey : null;
    const groups = new Map();
    for (const model of matches.slice(0, 200)) {
      const groupKey = JSON.stringify([model.provider, model.connectionId || '']);
      if (!groups.has(groupKey)) groups.set(groupKey, { name: model.source, models: [] });
      groups.get(groupKey).models.push(model);
    }
    list.innerHTML = [...groups.values()].map((group) => `<fieldset class="model-visibility-group"><legend>${escape(group.name)}</legend>${group.models.map((model) => {
      const key = getModelKey(model);
      return `<label class="model-visibility-row"><span class="model-visibility-copy"><span><strong>${escape(model.label)}</strong>${key === selectedKey ? '<small class="model-current-badge">사용 중</small>' : ''}</span><small>${escape(model.id)}${!model.connected ? ' · 연결 필요' : ''}</small></span><input class="model-visibility-toggle" type="checkbox" role="switch" data-model-key="${escape(key)}" aria-label="${escape(`${model.label} · ${model.source} 표시`)}"${isVisible(model) ? ' checked' : ''} /></label>`;
    }).join('')}</fieldset>`).join('') || '<p class="model-empty">일치하는 모델이 없습니다. 검색어를 바꿔보세요.</p>';
    if (matches.length > 200) list.insertAdjacentHTML('beforeend', '<p class="model-empty">검색 결과 중 200개를 표시합니다. 이름으로 검색하면 나머지 모델도 찾을 수 있습니다.</p>');
    // Account status polling must not interrupt keyboard navigation through the switches.
    if (focusedKey) [...list.querySelectorAll('[data-model-key]')].find((input) => input.dataset.modelKey === focusedKey)?.focus({ preventScroll: true });
  }

  function updateVisibility(models, visible) {
    for (const model of models) {
      if (visible) hiddenModels.delete(getModelKey(model));
      else hiddenModels.add(getModelKey(model));
    }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...hiddenModels])); saved = true; }
    catch { saved = false; showToast('모델 표시 설정을 저장하지 못해 이 창에서만 적용됩니다.'); }
    render();
    onChange();
  }

  search.addEventListener('input', render);
  list.addEventListener('change', (event) => {
    const input = event.target.closest('input[data-model-key]');
    if (!input) return;
    const model = getModels().find((item) => getModelKey(item) === input.dataset.modelKey);
    if (model) updateVisibility([model], input.checked);
  });
  showAll.addEventListener('click', () => updateVisibility(matchingModels(getModels()), true));
  hideAll.addEventListener('click', () => updateVisibility(matchingModels(getModels()), false));
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    hiddenModels = parseHiddenModels(event.newValue);
    saved = true;
    render();
    onChange();
  });

  return { isVisible, render };
}

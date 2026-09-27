import { icon } from './icons.js';

const PRESETS = {
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  openai: { name: 'OpenAI API', baseUrl: 'https://api.openai.com/v1' },
  custom: { name: '', baseUrl: '' },
};
const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function createApiConnectionsUI({ onChange, showToast }) {
  const element = (id) => document.getElementById(id);
  const modal = element('apiConnectionModal');
  const form = element('apiConnectionForm');
  const list = element('apiConnectionsList');
  let connections = [];
  let keyStorage = 'session';
  let editingId = null;
  let saving = false;
  let returnFocus = null;
  const busy = new Set();

  function storageInfo() {
    return keyStorage === 'keychain'
      ? 'API 키는 이 Mac의 키체인을 이용해 암호화하여 저장합니다. API 사용료는 연결한 서비스에서 별도로 청구됩니다.'
      : '웹 실행에서는 키를 이번 서버 실행 동안만 보관합니다. 서버를 다시 시작하면 키를 다시 입력해야 합니다. API 사용료는 별도로 청구됩니다.';
  }

  function render() {
    element('apiConnectionCount').textContent = connections.length;
    element('apiKeyStorageInfo').textContent = storageInfo();
    element('apiEditorStorageInfo').textContent = storageInfo();
    list.innerHTML = connections.length ? connections.map((connection) => {
      const disabled = busy.has(connection.id) ? ' disabled' : '';
      return `<article class="api-connection-card">
        <div class="api-card-header"><span class="connection-logo api-logo" aria-hidden="true">${escape(connection.name.slice(0, 1).toUpperCase())}</span><div class="connection-details"><strong>${escape(connection.name)}</strong><small>${escape(connection.baseUrl)}</small></div><span class="connection-status${connection.connected ? ' ready' : ''}">${escape(connection.label)}</span></div>
        <div class="api-model-preview">${connection.models.slice(0, 4).map((model) => `<span>${escape(model.label)}</span>`).join('')}${connection.models.length > 4 ? `<span>+${connection.models.length - 4}</span>` : ''}</div>
        <div class="api-card-footer"><small>${connection.models.length}개 모델${busy.has(connection.id) ? ' · 처리 중…' : ''}</small><div class="account-button-group"><button type="button" class="account-use-button" data-api-action="edit" data-api-id="${escape(connection.id)}"${disabled}>${connection.connected ? '편집' : '다시 연결'}</button><button type="button" class="account-use-button" data-api-action="refresh" data-api-id="${escape(connection.id)}"${disabled}${connection.connected ? '' : ' disabled'}>모델 새로고침</button>${connection.connected ? `<button type="button" class="account-unlink-button" data-api-action="disconnect" data-api-id="${escape(connection.id)}"${disabled}>연결 해제</button>` : ''}<button type="button" class="account-delete-button" data-api-action="delete" data-api-id="${escape(connection.id)}"${disabled}>삭제</button></div></div>
      </article>`;
    }).join('') : `<div class="api-empty"><span aria-hidden="true">${icon('plug')}</span><strong>원하는 모델을 내 작업 공간에</strong><p>DeepSeek, OpenAI 또는 호환 API를 연결하세요.<br>연결된 모든 모델을 한 곳에서 선택할 수 있습니다.</p><button class="secondary-button" type="button" data-api-action="add">첫 에이전트 연결하기</button></div>`;
  }

  function openEditor(id = null) {
    if (saving) return;
    const connection = connections.find((item) => item.id === id);
    editingId = connection?.id || null;
    returnFocus = document.activeElement;
    form.reset();
    element('apiConnectionError').hidden = true;
    element('apiConnectionTitle').textContent = connection ? '에이전트 편집' : '에이전트 추가';
    element('apiPreset').value = connection ? 'custom' : 'deepseek';
    element('apiPreset').disabled = Boolean(connection);
    element('apiConnectionName').value = connection?.name || PRESETS.deepseek.name;
    element('apiBaseUrl').value = connection?.baseUrl || PRESETS.deepseek.baseUrl;
    element('apiKey').required = !connection?.connected;
    element('apiKeyHint').textContent = connection?.connected ? '변경할 때만 입력' : '';
    element('apiKey').placeholder = connection?.connected ? '기존 키 유지 · 새 주소에는 새 키 필요' : 'API 키 입력';
    element('saveApiConnection').textContent = connection ? '저장 및 모델 새로고침' : '연결 및 모델 가져오기';
    element('apiEditorStorageInfo').textContent = storageInfo();
    modal.hidden = false;
    requestAnimationFrame(() => element(connection ? 'apiConnectionName' : 'apiKey').focus());
  }

  function closeEditor() {
    if (saving) return;
    modal.hidden = true;
    element('apiKey').value = '';
    returnFocus?.focus();
  }

  async function request(url, options) {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'API 연결을 변경하지 못했습니다.');
    return data;
  }

  async function performAction(action, id) {
    if (action === 'add' || action === 'edit') { openEditor(id); return; }
    if (busy.has(id)) return;
    const connection = connections.find((item) => item.id === id);
    if (!connection) return;
    if (action === 'delete' && !window.confirm(`“${connection.name}” 연결과 저장된 API 키를 삭제할까요? 대화 내용은 보존됩니다.`)) return;
    if (action === 'disconnect' && !window.confirm(`“${connection.name}”의 API 키를 이 앱에서 제거하고 연결을 해제할까요?`)) return;
    busy.add(id);
    render();
    try {
      await request(`/api/connections/${encodeURIComponent(id)}${action === 'delete' ? '' : `/${action}`}`, { method: action === 'delete' ? 'DELETE' : 'POST' });
      await onChange();
      showToast(action === 'refresh' ? '모델 목록을 새로고침했습니다.' : action === 'delete' ? 'API 에이전트를 삭제했습니다.' : 'API 연결을 해제했습니다.');
    } catch (error) { showToast(error.message || '서버에 연결하지 못했습니다.'); }
    finally { busy.delete(id); render(); }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving) return;
    saving = true;
    const body = JSON.stringify({ name: element('apiConnectionName').value, baseUrl: element('apiBaseUrl').value.trim(), apiKey: element('apiKey').value });
    element('apiKey').value = '';
    element('apiConnectionError').hidden = true;
    form.querySelectorAll('input, select, button').forEach((item) => { item.disabled = true; });
    element('saveApiConnection').textContent = '모델 확인 중…';
    let connected = false;
    try {
      const data = await request(`/api/connections${editingId ? `/${encodeURIComponent(editingId)}` : ''}`, {
        method: editingId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body,
      });
      connected = true;
      try {
        await onChange();
        showToast(`${data.connection.name}의 모델 ${data.connection.models.length}개를 가져왔습니다.`);
      } catch {
        showToast('연결은 저장됐습니다. 연결 상태를 새로고침해 모델 목록을 불러와 주세요.');
      }
    } catch (error) {
      element('apiConnectionError').textContent = `${error.message || '연결하지 못했습니다.'} 새 키를 입력했다면 다시 입력해 주세요.`;
      element('apiConnectionError').hidden = false;
    } finally {
      saving = false;
      form.querySelectorAll('input, select, button').forEach((item) => { item.disabled = false; });
      element('apiPreset').disabled = Boolean(editingId);
      element('saveApiConnection').textContent = editingId ? '저장 및 모델 새로고침' : '연결 및 모델 가져오기';
      if (connected) closeEditor();
    }
  });
  element('apiPreset').addEventListener('change', (event) => {
    const preset = PRESETS[event.target.value];
    element('apiConnectionName').value = preset.name;
    element('apiBaseUrl').value = preset.baseUrl;
    element('apiKey').value = '';
    element(preset.name ? 'apiKey' : 'apiConnectionName').focus();
  });
  element('addApiConnection').addEventListener('click', () => openEditor());
  element('closeApiConnection').addEventListener('click', closeEditor);
  element('cancelApiConnection').addEventListener('click', closeEditor);
  modal.addEventListener('click', (event) => { if (event.target === modal) closeEditor(); });
  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-api-action]');
    if (button) void performAction(button.dataset.apiAction, button.dataset.apiId);
  });
  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); closeEditor(); }
    if (event.key !== 'Tab') return;
    const focusable = [...form.querySelectorAll('input, select, button')].filter((item) => !item.disabled);
    if (!focusable.length) { event.preventDefault(); return; }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  return {
    openEditor,
    update(status) { connections = status.connections || []; keyStorage = status.keyStorage || 'session'; render(); },
  };
}

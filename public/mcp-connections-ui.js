const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createMcpConnectionsUI({ toast }) {
  const list = document.querySelector('#mcpServersList');
  const modal = document.querySelector('#mcpConnectionModal');
  const form = document.querySelector('#mcpConnectionForm');
  const error = document.querySelector('#mcpConnectionError');
  const transport = document.querySelector('#mcpTransport');
  const autoRun = document.querySelector('#mcpAutoRun');
  const stdioFields = document.querySelector('#mcpStdioFields');
  const httpFields = document.querySelector('#mcpHttpFields');
  let servers = [];
  let keyStorage = 'session';
  let editingId = '';

  async function request(path, { method = 'GET', body } = {}) {
    const response = await fetch(path, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'MCP 연결 요청을 처리하지 못했습니다.'), { code: data.code || '' });
    return data;
  }

  function render() {
    if (!servers.length) {
      list.innerHTML = '<p class="mcp-empty">연결된 MCP 서버가 없습니다. Paper 또는 Figma를 빠른 연결하면 Loop 실행에 자동으로 포함됩니다.</p>';
      return;
    }
    list.innerHTML = servers.map((server) => {
      const endpoint = server.transport === 'stdio' ? `${server.command}${server.cwd ? ` · ${server.cwd}` : ''}` : server.url;
      const tools = server.tools.map((tool) => `<li><strong>${escape(tool.name)}</strong>${tool.description ? `<small>${escape(tool.description)}</small>` : ''}</li>`).join('');
      const state = server.connecting ? '연결 중…' : server.connected ? `연결됨 · ${server.tools.length}개 도구` : server.needsConfiguration ? '다시 설정 필요' : '연결 안 됨';
      return `<article class="mcp-server-card" data-mcp-server="${escape(server.id)}"><div class="mcp-server-heading"><div><strong>${escape(server.name)}</strong><small>${server.transport === 'stdio' ? '로컬 프로그램 · stdio' : '원격 서버 · Streamable HTTP'} · ${escape(endpoint)}</small></div><span class="mcp-connection-state ${server.connected ? 'connected' : ''}">${state}</span></div>${server.error ? `<p class="mcp-server-error">${escape(server.error)}</p>` : ''}<label class="mcp-auto-run"><input type="checkbox" data-mcp-auto-run="${escape(server.id)}"${server.autoRun ? ' checked' : ''}${server.connecting ? ' disabled' : ''} /><span>Loop 자동 연결·사용${server.autoRun ? ' · 매 실행에 자동 제공' : ''}</span></label><div class="mcp-server-actions">${server.connecting ? '<button type="button" disabled>연결 중…</button>' : server.connected ? `<button type="button" data-mcp-action="disconnect" data-id="${escape(server.id)}">연결 해제</button>` : `<button class="primary-button" type="button" data-mcp-action="connect" data-id="${escape(server.id)}">연결</button>`}<button type="button" data-mcp-action="edit" data-id="${escape(server.id)}"${server.connecting ? ' disabled' : ''}>설정</button><button type="button" data-mcp-action="delete" data-id="${escape(server.id)}"${server.connecting ? ' disabled' : ''}>삭제</button></div>${server.connected ? `<details class="mcp-tool-list"><summary>사용 가능한 도구 ${server.tools.length}개</summary><ul>${tools || '<li>제공된 도구가 없습니다.</li>'}</ul></details>` : ''}</article>`;
    }).join('');
  }

  async function refresh({ quiet = false } = {}) {
    try {
      const data = await request('/api/mcp/servers');
      servers = Array.isArray(data.servers) ? data.servers : [];
      keyStorage = data.keyStorage || 'session';
      document.querySelector('#mcpStorageInfo').textContent = keyStorage === 'keychain'
        ? '연결 암호와 실행 인자는 macOS 보안 저장소로 암호화합니다.'
        : '웹 개발 모드에서는 토큰·환경 변수·실행 인자를 메모리에만 보관합니다. 서버를 다시 시작하면 MCP 연결을 다시 입력해야 합니다.';
      render();
      return servers;
    } catch (cause) {
      if (!quiet) toast(cause.message);
      list.innerHTML = `<p class="mcp-empty">${escape(cause.message)}</p>`;
      return [];
    }
  }

  function tools() {
    return servers.filter((server) => server.connected).flatMap((server) => server.tools.map((tool) => ({
      serverId: server.id,
      serverName: server.name,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      autoRun: server.autoRun === true,
    })));
  }

  function setTransport() {
    const isHttp = transport.value === 'http';
    stdioFields.hidden = isHttp;
    httpFields.hidden = !isHttp;
    document.querySelector('#mcpCommand').required = !isHttp;
    document.querySelector('#mcpServerUrl').required = isHttp;
  }

  function open(server = null) {
    form.reset();
    editingId = server?.id || '';
    error.hidden = true;
    error.textContent = '';
    transport.value = server?.transport || 'stdio';
    autoRun.checked = server ? server.autoRun === true : true;
    if (server) {
      document.querySelector('#mcpConnectionName').value = server.name;
      if (server.transport === 'stdio') {
        document.querySelector('#mcpCommand').value = server.command || '';
        document.querySelector('#mcpWorkingDirectory').value = server.cwd || '';
      } else document.querySelector('#mcpServerUrl').value = server.url || '';
    }
    document.querySelector('#mcpConnectionTitle').textContent = server ? 'MCP 연결 설정' : 'MCP 연결 추가';
    document.querySelector('#saveMcpConnection').textContent = server ? '저장 후 다시 연결' : '저장 후 연결';
    const hint = document.querySelector('#mcpConnectionHint');
    hint.hidden = !server;
    if (server) hint.textContent = server.needsConfiguration
      ? '이 실행 환경에는 기존 비밀 설정이 없습니다. 필요한 인자·환경 변수·토큰을 다시 입력해 주세요.'
      : '비밀 입력란을 비워두면 기존 인자·환경 변수·토큰을 유지합니다. 값을 지우려면 연결을 삭제한 뒤 다시 추가하세요.';
    setTransport();
    modal.hidden = false;
    document.querySelector('#mcpConnectionName').focus();
  }

  function close() {
    modal.hidden = true;
    editingId = '';
    document.querySelector('#addMcpServer').focus();
  }

  transport.addEventListener('change', setTransport);
  document.querySelector('.mcp-quick-connect').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-mcp-quick]');
    if (!button) return;
    const kind = button.dataset.mcpQuick;
    button.disabled = true;
    try {
      let saved;
      try { saved = await request('/api/mcp/quick-connect', { method: 'POST', body: { kind } }); }
      catch (cause) {
        if (kind !== 'paper-desktop' || cause.code !== 'PAPER_CLI_REQUIRED') throw cause;
        const choose = window.looplineWorkspace?.chooseMcpCommand;
        if (!choose) throw new Error('Paper Desktop MCP CLI를 찾지 못했습니다. Loopline 데스크톱 앱에서 Paper CLI 경로를 선택해 주세요.');
        const command = await choose();
        if (!command) return;
        saved = await request('/api/mcp/quick-connect', { method: 'POST', body: { kind, command } });
      }
      await refresh({ quiet: true });
      toast(`${saved.name}을(를) 연결했습니다. Loop에서 자동으로 이어서 사용합니다.`);
    } catch (cause) {
      await refresh({ quiet: true });
      toast(cause.message);
    } finally { button.disabled = false; }
  });
  document.querySelector('#addMcpServer').addEventListener('click', open);
  document.querySelector('#closeMcpConnection').addEventListener('click', close);
  document.querySelector('#cancelMcpConnection').addEventListener('click', close);
  modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
  modal.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const isHttp = transport.value === 'http';
    const body = {
      name: document.querySelector('#mcpConnectionName').value,
      transport: transport.value,
      autoRun: autoRun.checked,
      ...(isHttp ? {
        url: document.querySelector('#mcpServerUrl').value,
        token: document.querySelector('#mcpBearerToken').value,
      } : {
        command: document.querySelector('#mcpCommand').value,
        args: document.querySelector('#mcpArgs').value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
        cwd: document.querySelector('#mcpWorkingDirectory').value,
        env: Object.fromEntries(document.querySelector('#mcpEnvironment').value.split(/\r?\n/).filter(Boolean).map((line) => {
          const divider = line.indexOf('=');
          return divider < 1 ? [line, ''] : [line.slice(0, divider).trim(), line.slice(divider + 1)];
        })),
      }),
    };
    const submit = document.querySelector('#saveMcpConnection');
    submit.disabled = true;
    submit.textContent = '연결 중…';
    error.hidden = true;
    try {
      const saved = await request(editingId ? `/api/mcp/servers/${encodeURIComponent(editingId)}` : '/api/mcp/servers', { method: editingId ? 'PUT' : 'POST', body });
      await refresh({ quiet: true });
      close();
      try {
        await request(`/api/mcp/servers/${encodeURIComponent(saved.id)}/connect`, { method: 'POST', body: {} });
        await refresh({ quiet: true });
        toast(autoRun.checked ? 'MCP 서버를 연결했습니다. Loop에서 자동으로 이어서 사용합니다.' : 'MCP 서버를 연결했습니다.');
      } catch (cause) {
        await refresh({ quiet: true });
        toast(`연결 설정은 저장했습니다. 서버 연결을 확인해 주세요: ${cause.message}`);
      }
    } catch (cause) {
      await refresh({ quiet: true });
      error.textContent = cause.message;
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = '저장 후 연결';
    }
  });

  list.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-mcp-action]');
    if (!button) return;
    const { id, mcpAction } = button.dataset;
    if (mcpAction === 'edit') {
      const server = servers.find((item) => item.id === id);
      if (server) open(server);
      return;
    }
    button.disabled = true;
    try {
      if (mcpAction === 'connect') await request(`/api/mcp/servers/${encodeURIComponent(id)}/connect`, { method: 'POST', body: {} });
      if (mcpAction === 'disconnect') await request(`/api/mcp/servers/${encodeURIComponent(id)}/disconnect`, { method: 'POST', body: {} });
      if (mcpAction === 'delete') {
        if (!window.confirm('이 MCP 연결과 저장된 설정을 삭제할까요?')) return;
        await request(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
      }
      await refresh({ quiet: true });
    } catch (cause) { toast(cause.message); }
    finally { button.disabled = false; }
  });

  list.addEventListener('change', async (event) => {
    const checkbox = event.target.closest('[data-mcp-auto-run]');
    if (!checkbox) return;
    const id = checkbox.dataset.mcpAutoRun;
    const enabled = checkbox.checked;
    checkbox.disabled = true;
    try {
      const result = await request(`/api/mcp/servers/${encodeURIComponent(id)}/auto-run`, { method: 'POST', body: { enabled } });
      await refresh({ quiet: true });
      if (enabled && !result.connected) toast(result.error || '자동 사용 설정은 저장했지만 서버에 연결되지 않았습니다. 서버 상태를 확인해 주세요.');
    } catch (cause) {
      checkbox.checked = !enabled;
      toast(cause.message);
    } finally { checkbox.disabled = false; }
  });

  void refresh({ quiet: true });
  return { refresh, tools, open };
}

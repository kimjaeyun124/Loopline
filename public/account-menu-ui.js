import { icon } from './icons.js';

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function usageWindows(account) {
  if (!account?.connected || !account.usageSummary?.available || !Array.isArray(account.usageSummary.windows)) return [];
  return account.usageSummary.windows.filter((window) => Number.isFinite(window.remainingPercent))
    .map((window) => ({ ...window, remainingPercent: Math.max(0, Math.min(100, window.remainingPercent)) }));
}

export function createAccountMenuUI({ onOpen, onUsage, onSettings, formatAccountName, formatWindow, formatReset }) {
  const element = (id) => document.getElementById(id);
  const trigger = element('settingsButton');
  const menu = element('accountMenu');
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  const usagePanel = element('usagePanel');
  let context = { accounts: [], connections: [], claude: {}, provider: 'openai' };
  let previousUsage = '';

  function profile() {
    const account = context.accounts.find((item) => item.id === context.accountId);
    if (context.provider === 'openai' && account?.connected) {
      return { name: formatAccountName(account), detail: `Codex${account.planType ? ` · ${account.planType}` : ''}`, account };
    }
    if (context.provider === 'anthropic') {
      return { name: 'Claude Code', detail: context.claude.connected ? '구독 계정 연결됨' : '로그인 필요' };
    }
    const connection = context.provider === 'api' && context.connections.find((item) => item.id === context.connectionId);
    if (connection) return { name: connection.name, detail: connection.connected ? 'API 연결됨' : 'API 키 필요' };
    return { name: 'Loopline', detail: '계정을 연결해 주세요.' };
  }

  function renderProfile() {
    const current = profile();
    element('accountDisplayName').textContent = current.name;
    element('accountMenuName').textContent = current.name;
    element('accountMenuDetail').textContent = current.detail;
    element('accountMenuAvatar').textContent = Array.from(current.name.trim()).slice(0, 2).join('').toUpperCase();
    trigger.title = `${current.name} · Usage / Settings`;
    trigger.setAttribute('aria-label', `${current.name} 계정 메뉴`);
    const hint = element('accountUsageHint');
    hint.removeAttribute('title');
    if (context.error) hint.textContent = '조회 실패';
    else if (context.provider === 'anthropic') hint.textContent = '/usage';
    else if (context.provider === 'api') hint.textContent = '별도 과금';
    else if (current.account?.usageSummary?.rateLimitReachedType || current.account?.usageSummary?.ordinaryUsageAllowed === false) hint.textContent = '한도 도달';
    else {
      // The most restrictive Codex window determines the compact remaining allowance.
      const windows = usageWindows(current.account).filter((window) => window.limitId === 'codex');
      hint.textContent = windows.length ? `${Math.min(...windows.map((window) => window.remainingPercent))}% 남음`
        : current.account ? '확인 불가' : context.updatedAt ? '로그인 필요' : '확인 중';
      if (windows.length) hint.title = '선택한 Codex 계정의 기간별 한도 중 가장 적게 남은 비율';
    }
  }

  function renderUsage() {
    if (usagePanel.hidden) return;
    const cards = context.accounts.map((account) => {
      const name = formatAccountName(account);
      const windows = usageWindows(account);
      const active = context.provider === 'openai' && account.id === context.accountId && account.connected;
      const usage = windows.length ? windows.map((window) => {
        const label = `${window.limitName || (window.limitId === 'codex' ? 'Codex' : window.limitId)} · ${formatWindow(window.windowDurationMins, window.period)}`;
        const resets = formatReset(window.resetsAt);
        return `<div class="usage-window"><div class="usage-window-heading"><span>${escape(label)}</span><strong${window.remainingPercent <= 10 ? ' class="usage-low"' : ''}>${window.remainingPercent}% 남음</strong></div><div class="usage-meter${window.remainingPercent <= 10 ? ' usage-low' : ''}" role="meter" aria-label="${escape(`${name} · ${label} 남은 한도`)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${window.remainingPercent}"><span style="width: ${window.remainingPercent}%"></span></div><small>${resets ? `${escape(resets)} 초기화` : '초기화 시각을 확인할 수 없습니다.'}</small></div>`;
      }).join('') : `<p class="usage-description">${account.connected ? '사용 한도를 현재 확인할 수 없습니다. 잠시 후 새로고침해 주세요.' : '로그인 후 사용 한도를 확인할 수 있습니다.'}</p>`;
      return `<article class="usage-account-card"><div class="usage-account-heading"><span class="usage-provider-icon" aria-hidden="true">${icon('terminal')}</span><div><strong>${escape(name)}</strong><small>Codex${account.planType ? ` · ${escape(account.planType)}` : ''}</small></div>${active ? '<span class="active-account-badge">사용 중</span>' : ''}</div>${usage}</article>`;
    });
    if (!cards.length) cards.push('<p class="usage-description">Codex 계정을 연결하면 남은 사용 한도가 표시됩니다.</p>');
    cards.push(`<article class="usage-account-card"><div class="usage-account-heading"><span class="usage-provider-icon" aria-hidden="true">${icon('asterisk')}</span><div><strong>Claude Code</strong><small>${context.claude.connected ? '구독 계정 연결됨' : '로그인 필요'}</small></div></div><p class="usage-description">${escape(context.claude.usageSummary?.message || 'Claude Code CLI에 로그인한 뒤 /usage에서 플랜 사용 한도를 확인하세요.')}</p><code class="usage-command">/usage</code></article>`);
    for (const connection of context.connections) {
      cards.push(`<article class="usage-account-card"><div class="usage-account-heading"><span class="usage-provider-icon" aria-hidden="true">${icon('plug')}</span><div><strong>${escape(connection.name)}</strong><small>${connection.connected ? 'API 연결됨' : 'API 키 필요'}</small></div></div><p class="usage-description">API 사용량과 잔액은 연결한 서비스의 대시보드에서 확인하세요.</p></article>`);
    }
    const markup = cards.join('');
    if (markup !== previousUsage) { element('usageAccounts').innerHTML = markup; previousUsage = markup; }
    const checked = context.updatedAt ? new Date(context.updatedAt).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' }) : '';
    element('usageStatus').textContent = context.error
      ? `사용 한도를 새로 불러오지 못했습니다.${checked ? ` 마지막 조회: ${checked}` : ' 연결 상태를 확인해 주세요.'}`
      : checked ? `최근 조회: ${checked}` : '사용 한도를 불러오는 중…';
    element('usageStatus').classList.toggle('usage-low', Boolean(context.error));
  }

  function position() {
    if (menu.hidden) return;
    const bounds = trigger.getBoundingClientRect();
    menu.style.left = `${Math.max(12, Math.min(bounds.left, innerWidth - menu.offsetWidth - 12))}px`;
    menu.style.top = `${Math.max(12, Math.min(bounds.top - menu.offsetHeight - 8, innerHeight - menu.offsetHeight - 12))}px`;
  }

  function close(restoreFocus = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
  }

  function open(focusLast = false) {
    renderProfile();
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    position();
    (focusLast ? items.at(-1) : items[0]).focus();
    onOpen();
  }

  trigger.addEventListener('click', () => { if (menu.hidden) open(); else close(); });
  trigger.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    open(event.key === 'ArrowUp');
  });
  element('accountUsage').addEventListener('click', () => { close(true); onUsage(); });
  element('accountSettings').addEventListener('click', () => { close(true); onSettings(); });
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'Tab') { close(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  });
  menu.addEventListener('focusout', () => {
    requestAnimationFrame(() => { if (!menu.contains(document.activeElement) && document.activeElement !== trigger) close(); });
  });
  document.addEventListener('click', (event) => { if (!menu.contains(event.target) && !trigger.contains(event.target)) close(); });
  window.addEventListener('resize', position);

  return {
    close,
    renderUsage,
    update(data) { context = data; renderProfile(); renderUsage(); position(); },
  };
}

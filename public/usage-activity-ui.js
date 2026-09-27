import { icon } from './icons.js';

const DAY = 86_400_000;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const number = (value) => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value) : '—';
const exact = (value) => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('ko-KR').format(value) : '제공되지 않음';
const dayKey = (stamp) => new Date(stamp).toISOString().slice(0, 10);
const effortLabel = (value) => ({ none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra' }[value] || '—');

function duration(seconds) {
  if (typeof seconds !== 'number') return '—';
  if (seconds < 60) return `${Math.floor(seconds)}초`;
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분` : `${minutes}분`;
}

export function createUsageActivityUI({ getAccounts, getActiveAccountId, formatAccountName }) {
  const element = (id) => document.getElementById(id);
  const panel = element('usagePanel');
  const source = element('usageActivityAccount');
  const chart = element('usageActivityChart');
  let accountKey = '';
  let selectedKey = '';
  let activity = null;
  let insights = null;
  let mode = 'daily';
  let activityController;
  let insightsController;

  function selectedAccount() { return getAccounts().find((account) => account.id === source.value && account.connected); }
  function identity(account) { return account ? JSON.stringify([account.id, account.accountEmail, account.accountName]) : ''; }

  function renderMetrics() {
    const data = activity?.summary || {};
    const metrics = [
      ['누적 토큰', number(data.lifetimeTokens), `${exact(data.lifetimeTokens)} 토큰`],
      ['최대 일일 토큰', number(data.peakDailyTokens), `${exact(data.peakDailyTokens)} 토큰`],
      ['최장 실행', duration(data.longestRunningTurnSec), '가장 오래 실행된 한 번의 응답'],
      ['현재 연속', data.currentStreakDays == null ? '—' : `${data.currentStreakDays}일`, '현재 연속 사용일'],
      ['최장 연속', data.longestStreakDays == null ? '—' : `${data.longestStreakDays}일`, '최장 연속 사용일'],
    ];
    element('usageActivityMetrics').innerHTML = metrics.map(([label, value, title]) => `<div title="${escape(title)}"><dt>${label}</dt><dd>${escape(value)}</dd></div>`).join('');
  }

  function renderChart() {
    const available = Array.isArray(activity?.dailyUsageBuckets);
    element('usageActivityLegend').hidden = !available || mode !== 'daily';
    element('usageActivityModes').querySelectorAll('button').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.activityMode === mode));
      button.disabled = !available;
    });
    element('usageChartDetail').textContent = available ? '활동에 마우스를 올리거나 방향키로 토큰 수를 확인하세요.' : '';
    if (!available) {
      chart.innerHTML = '<p class="activity-empty">일별 활동 데이터가 제공되면 여기에 표시됩니다.</p>';
      element('usageActivityRange').textContent = '최근 1년';
      return;
    }
    const end = Date.parse(`${dayKey(Date.now())}T00:00:00Z`);
    const start = end - 364 * DAY;
    const gridStart = start - new Date(start).getUTCDay() * DAY;
    const weeks = Math.ceil((end - gridStart + DAY) / (7 * DAY));
    const buckets = new Map(activity.dailyUsageBuckets.map((bucket) => [bucket.startDate, bucket.tokens]));
    const days = Array.from({ length: weeks * 7 }, (_, index) => {
      const stamp = gridStart + index * DAY;
      return { stamp, date: dayKey(stamp), tokens: buckets.get(dayKey(stamp)) || 0, outside: stamp < start || stamp > end };
    });
    const months = [];
    for (let week = 0; week < weeks; week++) {
      const date = new Date(gridStart + week * 7 * DAY);
      const month = date.getUTCMonth();
      if (!months.length || month !== months.at(-1).month) months.push({ week, month });
    }
    const visibleMonths = months.filter(({ week }, index) => index === months.length - 1
      ? week < weeks - 2 : months[index + 1].week - week >= 3);
    const monthLabels = `<div class="activity-months" style="--activity-weeks:${weeks}" aria-hidden="true">${visibleMonths.map(({ week, month }) => `<span style="grid-column:${week + 1}">${month + 1}월</span>`).join('')}</div>`;
    const total = days.reduce((sum, day) => sum + (day.outside ? 0 : day.tokens), 0);
    element('usageActivityRange').textContent = `${dayKey(start)} – ${dayKey(end)} · ${number(total)} 토큰`;
    if (mode === 'daily') {
      const peak = Math.max(1, ...days.filter((day) => !day.outside).map((day) => day.tokens));
      chart.innerHTML = `<div class="activity-calendar" style="--activity-weeks:${weeks}" role="group" aria-label="일별 토큰 활동">${days.map((day) => {
        if (day.outside) return '<span class="activity-cell outside" aria-hidden="true"></span>';
        const level = day.tokens ? Math.max(1, Math.ceil(day.tokens / peak * 4)) : 0;
        const label = `${day.date} · ${exact(day.tokens)} 토큰`;
        return `<button type="button" class="activity-cell activity-level-${level}" data-chart-detail="${escape(label)}" title="${escape(label)}" aria-label="${escape(label)}" tabindex="${day.stamp === end ? 0 : -1}"></button>`;
      }).join('')}</div>${monthLabels}`;
    } else {
      let cumulative = 0;
      const bars = Array.from({ length: weeks }, (_, week) => {
        const entries = days.slice(week * 7, week * 7 + 7).filter((day) => !day.outside);
        const tokens = entries.reduce((sum, day) => sum + day.tokens, 0);
        cumulative += tokens;
        return { value: mode === 'weekly' ? tokens : cumulative, label: `${entries[0].date} – ${entries.at(-1).date}${mode === 'cumulative' ? '까지 기간 누적' : ''} · ${exact(mode === 'weekly' ? tokens : cumulative)} 토큰` };
      });
      const peak = Math.max(1, ...bars.map((bar) => bar.value));
      chart.innerHTML = `<div class="activity-bars" role="group" aria-label="${mode === 'weekly' ? '주별' : '최근 1년 누적'} 토큰 활동">${bars.map((bar, index) => `<button type="button" data-chart-detail="${escape(bar.label)}" title="${escape(bar.label)}" aria-label="${escape(bar.label)}" tabindex="${index === bars.length - 1 ? 0 : -1}"><span style="height:${bar.value ? Math.max(2, bar.value / peak * 100) : 0}%"></span></button>`).join('')}</div>${monthLabels}`;
    }
  }

  function renderInsights() {
    const data = insights;
    const reasoning = data?.mostUsedReasoning;
    const entries = [
      ['Fast 모드', data?.fastModePercent == null ? '—' : `${data.fastModePercent}%`, data ? `속도 설정이 기록된 ${exact(data.fastKnownTurns)}개 응답 기준` : ''],
      ['가장 많이 쓴 추론', reasoning ? `${effortLabel(reasoning.effort)} · ${reasoning.percent}%` : '—', data ? `추론 설정이 기록된 ${exact(data.reasoningKnownTurns)}개 응답 기준` : ''],
      ['사용한 스킬 종류', number(data?.skillsExplored), '도구로 SKILL.md를 읽은 스킬'],
      ['스킬 사용 횟수', number(data?.totalSkillsUsed), '같은 응답에서 반복해서 읽은 스킬은 한 번으로 집계'],
      ['전체 대화', number(data?.totalChats), '선택한 출처의 로컬 대화 · 보관 포함 · 하위 에이전트 제외'],
    ];
    element('usageActivityInsights').innerHTML = entries.map(([label, value, title]) => `<div title="${escape(title)}"><dt>${label}</dt><dd>${escape(value)}</dd></div>`).join('');
    element('usageActivityPlugins').innerHTML = data?.mostUsed?.length
      ? `<ol>${data.mostUsed.map((item) => `<li><span class="activity-plugin-icon">${icon(item.kind === 'skill' ? 'list' : 'plug')}</span><span class="activity-plugin-name" title="${escape(item.name)}">${escape(item.kind === 'skill' ? `$${item.name}` : item.name.split('@')[0])}<small>${item.kind === 'skill' ? '스킬 열람' : '플러그인 호출'}</small></span><strong>${exact(item.count)}회</strong></li>`).join('')}</ol>`
      : '<p class="activity-empty">기록된 스킬·플러그인 활동이 없습니다.</p>';
    element('usageInsightsWarnings').textContent = data?.warnings?.join(' ') || '';
    element('usageInsightsWarnings').hidden = !data?.warnings?.length;
  }

  async function loadActivity(account) {
    activityController?.abort();
    const controller = new AbortController();
    activityController = controller;
    activity = null;
    renderMetrics();
    renderChart();
    element('usageActivityStatus').textContent = '계정 활동을 불러오는 중…';
    element('usageActivityStatus').classList.remove('usage-low');
    element('usageAccountActivity').setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(`/api/usage/activity?${new URLSearchParams({ accountId: account.id })}`, { signal: controller.signal, cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '계정 활동을 불러오지 못했습니다.');
      if (controller.signal.aborted) return;
      activity = data;
      renderMetrics();
      renderChart();
      const time = new Date(data.updatedAt).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
      element('usageActivityStatus').textContent = `Codex 계정 전체 활동 · ${time} 조회`;
    } catch (error) {
      if (controller.signal.aborted) return;
      element('usageActivityStatus').textContent = error.message;
      element('usageActivityStatus').classList.add('usage-low');
    } finally {
      if (activityController === controller) element('usageAccountActivity').setAttribute('aria-busy', 'false');
    }
  }

  async function loadInsights(account) {
    insightsController?.abort();
    const controller = new AbortController();
    insightsController = controller;
    insights = null;
    renderInsights();
    element('usageInsightsStatus').textContent = '이 Mac의 활동 기록을 집계하는 중…';
    element('usageInsightsStatus').classList.remove('usage-low');
    element('usageLocalActivity').setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(`/api/usage/insights?${new URLSearchParams({ accountId: account.id, includeCli: element('usageIncludeCli').checked })}`, { signal: controller.signal, cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '로컬 활동을 불러오지 못했습니다.');
      if (controller.signal.aborted) return;
      insights = data;
      renderInsights();
      element('usageInsightsStatus').textContent = `이 Mac · 앱 / IDE${data.includeCli ? ' / CLI' : ''} · ${exact(data.totalTurns)}개 응답 기준`;
    } catch (error) {
      if (controller.signal.aborted) return;
      element('usageInsightsStatus').textContent = error.message;
      element('usageInsightsStatus').classList.add('usage-low');
    } finally {
      if (insightsController === controller) element('usageLocalActivity').setAttribute('aria-busy', 'false');
    }
  }

  function load(force = false) {
    const account = selectedAccount();
    const key = identity(account);
    if (!force && key === accountKey) return;
    accountKey = key;
    activityController?.abort();
    insightsController?.abort();
    if (!account) {
      activity = null;
      insights = null;
      renderMetrics(); renderChart(); renderInsights();
      element('usageAccountActivity').setAttribute('aria-busy', 'false');
      element('usageLocalActivity').setAttribute('aria-busy', 'false');
      element('usageActivityStatus').textContent = 'Codex 계정을 연결하면 활동 통계를 확인할 수 있습니다.';
      element('usageInsightsStatus').textContent = '연결된 Codex 계정이 없습니다.';
      return;
    }
    void loadActivity(account);
    void loadInsights(account);
  }

  function updateAccounts(loadIfVisible = true) {
    const accounts = getAccounts().filter((account) => account.connected);
    const signature = JSON.stringify(accounts.map((account) => [identity(account), formatAccountName(account)]));
    if (signature !== selectedKey) {
      const previous = source.value;
      source.innerHTML = accounts.length ? accounts.map((account) => `<option value="${escape(account.id)}">${escape(formatAccountName(account))}</option>`).join('') : '<option value="">연결된 Codex 계정 없음</option>';
      source.value = accounts.some((account) => account.id === previous) ? previous
        : accounts.find((account) => account.id === getActiveAccountId())?.id || accounts[0]?.id || '';
      source.disabled = !accounts.length;
      element('usageIncludeCli').disabled = !accounts.length;
      selectedKey = signature;
    }
    if (loadIfVisible && !panel.hidden && !element('settingsModal').hidden) load();
  }

  source.addEventListener('change', () => load());
  element('usageIncludeCli').addEventListener('change', () => { const account = selectedAccount(); if (account) void loadInsights(account); });
  element('usageActivityModes').addEventListener('click', (event) => {
    const button = event.target.closest('[data-activity-mode]');
    if (!button || button.disabled) return;
    mode = button.dataset.activityMode;
    renderChart();
  });
  const showDetail = (event) => {
    const item = event.target.closest('[data-chart-detail]');
    if (item) element('usageChartDetail').textContent = item.dataset.chartDetail;
  };
  chart.addEventListener('pointerover', showDetail);
  chart.addEventListener('focusin', showDetail);
  chart.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const items = [...chart.querySelectorAll('[data-chart-detail]')];
    const current = items.indexOf(document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    const delta = { ArrowLeft: mode === 'daily' ? -7 : -1, ArrowRight: mode === 'daily' ? 7 : 1, ArrowUp: -1, ArrowDown: 1 }[event.key] || 0;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, current + delta));
    items.forEach((item, index) => { item.tabIndex = index === next ? 0 : -1; });
    items[next].focus();
  });
  renderMetrics(); renderChart(); renderInsights();
  return {
    update: updateAccounts,
    show() { updateAccounts(false); load(true); },
    refresh() { updateAccounts(false); load(true); },
    hide() {
      activityController?.abort(); insightsController?.abort();
      // An interrupted view must start a new fetch when it is opened again.
      if (!activity || !insights) accountKey = '';
    },
  };
}

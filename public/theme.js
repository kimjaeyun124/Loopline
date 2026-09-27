(() => {
  const storageKey = 'mosaic-ai.theme.v1';
  const choices = ['system', 'light', 'dark'];
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  const root = document.documentElement;
  let preference = 'system';
  let saved = true;
  try {
    const stored = localStorage.getItem(storageKey);
    if (choices.includes(stored)) preference = stored;
  } catch { /* Apply the system theme when browser storage is unavailable. */ }

  function applyTheme() {
    const resolved = preference === 'system' ? (systemTheme.matches ? 'dark' : 'light') : preference;
    root.dataset.theme = resolved;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#101010' : '#ffffff');
    document.querySelectorAll('input[name="appearanceTheme"]').forEach((input) => { input.checked = input.value === preference; });
    const status = document.querySelector('#appearanceStatus');
    if (status) status.textContent = `${preference === 'system' ? '시스템 설정 · ' : ''}${resolved === 'dark' ? '다크' : '라이트'} 모드 적용 중${saved ? '' : ' · 이 창에만 적용됩니다'}`;
    window.looplineAppearance?.setTheme(preference);
  }

  // Run before the stylesheet and first paint so a saved dark theme never flashes white.
  applyTheme();
  systemTheme.addEventListener('change', () => { if (preference === 'system') applyTheme(); });
  window.addEventListener('storage', (event) => {
    if (event.key !== storageKey && event.key !== null) return;
    preference = choices.includes(event.newValue) ? event.newValue : 'system';
    saved = true;
    applyTheme();
  });
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme();
    document.querySelectorAll('input[name="appearanceTheme"]').forEach((input) => {
      input.addEventListener('change', () => {
        if (!input.checked || !choices.includes(input.value)) return;
        preference = input.value;
        try { localStorage.setItem(storageKey, preference); saved = true; }
        catch { saved = false; }
        applyTheme();
      });
    });
  }, { once: true });
})();

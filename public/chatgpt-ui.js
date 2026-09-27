export function createChatGptUI({ beforeOpen, onWorkspace }) {
  const bridge = window.looplineChatGpt;
  if (!bridge) return { showWorkspace() {} };

  const workspace = document.querySelector('.main-panel');
  const panel = document.querySelector('#chatGptPanel');
  const viewport = document.querySelector('#chatGptViewport');
  const sidebarLink = document.querySelector('.sidebar .chatgpt-link');
  const returnButton = document.querySelector('#chatGptWorkspace');
  const status = document.querySelector('#chatGptStatus');
  const hostname = document.querySelector('#chatGptHostname');
  const placeholder = document.querySelector('#chatGptPlaceholder');
  const placeholderTitle = document.querySelector('#chatGptPlaceholderTitle');
  const placeholderDetail = document.querySelector('#chatGptPlaceholderDetail');
  const backButton = document.querySelector('#chatGptBack');
  const forwardButton = document.querySelector('#chatGptForward');
  const reloadButton = document.querySelector('#chatGptReload');
  const overlays = [...document.querySelectorAll('.modal-backdrop, .search-backdrop')];
  let active = false;
  let pendingFrame = 0;
  let previousLayout = '';

  function syncLayout() {
    pendingFrame = 0;
    const blocked = overlays.some((overlay) => !overlay.hidden);
    const bounds = viewport.getBoundingClientRect();
    const visible = active && !blocked && !document.hidden && bounds.width > 0 && bounds.height > 0;
    const layout = visible ? {
      visible: true,
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    } : { visible: false };
    const key = JSON.stringify(layout);
    if (key === previousLayout) return;
    previousLayout = key;
    bridge.setLayout(layout);
  }

  function scheduleLayout() {
    if (!pendingFrame) pendingFrame = requestAnimationFrame(syncLayout);
  }

  function open() {
    beforeOpen();
    active = true;
    workspace.hidden = true;
    panel.hidden = false;
    sidebarLink.setAttribute('aria-current', 'page');
    returnButton.focus();
    syncLayout();
  }

  function showWorkspace() {
    if (!active) return;
    active = false;
    panel.hidden = true;
    workspace.hidden = false;
    sidebarLink.removeAttribute('aria-current');
    syncLayout();
    onWorkspace();
  }

  function renderState(state) {
    if (!state) return;
    hostname.textContent = state.hostname || 'chatgpt.com';
    status.textContent = state.error ? '연결 실패' : state.loading ? '불러오는 중' : '공식 웹';
    status.classList.toggle('is-loading', state.loading && !state.error);
    status.classList.toggle('is-error', state.error);
    backButton.disabled = !state.canGoBack;
    forwardButton.disabled = !state.canGoForward;
    reloadButton.title = state.loading ? '다시 불러오기' : '새로고침';
    placeholder.hidden = !state.error && !state.loading;
    placeholderTitle.textContent = state.error ? 'ChatGPT에 연결하지 못했어요' : 'ChatGPT를 불러오는 중';
    placeholderDetail.textContent = state.error
      ? '연결 상태를 확인한 뒤 새로고침하거나 브라우저에서 열어 주세요.'
      : '잠시만 기다려 주세요.';
  }

  document.querySelectorAll('.chatgpt-link').forEach((link) => {
    link.addEventListener('click', (event) => { event.preventDefault(); open(); });
  });
  returnButton.addEventListener('click', showWorkspace);
  backButton.addEventListener('click', () => bridge.navigate('back'));
  forwardButton.addEventListener('click', () => bridge.navigate('forward'));
  reloadButton.addEventListener('click', () => bridge.navigate('reload'));
  document.querySelector('#chatGptBrowser').addEventListener('click', () => bridge.openInBrowser());

  const resizeObserver = new ResizeObserver(scheduleLayout);
  resizeObserver.observe(viewport);
  resizeObserver.observe(document.querySelector('#sidebar'));
  // Native views sit above DOM dialogs, so hide the view while a local dialog is open.
  const overlayObserver = new MutationObserver(syncLayout);
  overlays.forEach((overlay) => overlayObserver.observe(overlay, { attributes: true, attributeFilter: ['hidden'] }));
  window.addEventListener('resize', scheduleLayout);
  document.addEventListener('visibilitychange', syncLayout);
  const unsubscribeState = bridge.onState(renderState);
  const unsubscribeCommand = bridge.onCommand((command) => {
    if (command === 'open') open();
    if (command === 'workspace') showWorkspace();
  });
  void bridge.getState().then(renderState).catch(() => {});
  window.addEventListener('pagehide', () => {
    bridge.setLayout({ visible: false });
    cancelAnimationFrame(pendingFrame);
    resizeObserver.disconnect(); overlayObserver.disconnect();
    unsubscribeState(); unsubscribeCommand();
  }, { once: true });

  return { showWorkspace };
}

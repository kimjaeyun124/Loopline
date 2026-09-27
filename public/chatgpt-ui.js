export function createChatGptUI({ beforeOpen, onWorkspace }) {
  const services = [
    { id: 'chatgpt', name: 'ChatGPT', hostname: 'chatgpt.com', icon: 'chat', bridge: window.looplineChatGpt, link: document.querySelector('#chatGptOpen') },
    { id: 'gemini', name: 'Gemini', hostname: 'gemini.google.com', icon: 'sparkles', bridge: window.looplineGemini, link: document.querySelector('#geminiOpen') },
  ].filter((service) => service.bridge && service.link);
  if (!services.length) return { showWorkspace() {} };

  const workspace = document.querySelector('.main-panel');
  const panel = document.querySelector('#chatGptPanel');
  const viewport = document.querySelector('#chatGptViewport');
  const header = document.querySelector('#appHeader');
  const controls = document.querySelector('#webChatControls');
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
  let activeService = null;
  let pendingFrame = 0;
  const previousLayouts = new Map();
  const states = new Map();

  function syncLayout() {
    pendingFrame = 0;
    const blocked = overlays.some((overlay) => !overlay.hidden);
    const bounds = viewport.getBoundingClientRect();
    for (const service of services) {
      const visible = service === activeService && !blocked && !document.hidden && bounds.width > 0 && bounds.height > 0;
      const layout = visible ? {
        visible: true,
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      } : { visible: false };
      const key = JSON.stringify(layout);
      if (key === previousLayouts.get(service.id)) continue;
      previousLayouts.set(service.id, key);
      service.bridge.setLayout(layout);
    }
  }

  function scheduleLayout() {
    if (!pendingFrame) pendingFrame = requestAnimationFrame(syncLayout);
  }

  function open(service) {
    beforeOpen();
    activeService = service;
    document.body.classList.add('web-chat-active');
    workspace.hidden = true;
    panel.hidden = false;
    panel.setAttribute('aria-label', `${service.name} 대화`);
    controls.hidden = false;
    for (const item of services) {
      if (item === service) item.link.setAttribute('aria-current', 'page');
      else item.link.removeAttribute('aria-current');
    }
    returnButton.setAttribute('aria-pressed', 'false');
    service.link.focus();
    renderState(service, states.get(service.id) || { loading: true });
    syncLayout();
  }

  function showWorkspace() {
    if (!activeService) return;
    activeService = null;
    document.body.classList.remove('web-chat-active');
    panel.hidden = true;
    workspace.hidden = false;
    controls.hidden = true;
    services.forEach((service) => service.link.removeAttribute('aria-current'));
    returnButton.setAttribute('aria-pressed', 'true');
    delete header.dataset.webTheme;
    header.style.removeProperty('--web-background');
    syncLayout();
    onWorkspace();
  }

  function renderState(service, state) {
    if (!state) return;
    states.set(service.id, state);
    if (service !== activeService) return;
    for (const element of [header, panel]) {
      if (['light', 'dark'].includes(state.theme)) element.dataset.webTheme = state.theme;
      else delete element.dataset.webTheme;
      if (/^#[0-9a-f]{6}$/i.test(state.background || '')) element.style.setProperty('--web-background', state.background);
      else element.style.removeProperty('--web-background');
    }
    hostname.textContent = state.hostname || service.hostname;
    status.textContent = state.error ? '연결 실패' : state.loading ? '불러오는 중' : '';
    status.hidden = !state.error && !state.loading;
    status.classList.toggle('is-loading', state.loading && !state.error);
    status.classList.toggle('is-error', state.error);
    backButton.disabled = !state.canGoBack;
    forwardButton.disabled = !state.canGoForward;
    reloadButton.title = state.loading ? '다시 불러오기' : '새로고침';
    placeholder.hidden = !state.error && !state.loading;
    placeholder.querySelector('svg use').setAttribute('href', `/icons.svg#${service.icon}`);
    placeholderTitle.textContent = state.error ? `${service.name}에 연결하지 못했어요` : `${service.name}를 불러오는 중`;
    placeholderDetail.textContent = state.error
      ? '연결 상태를 확인한 뒤 새로고침하거나 브라우저에서 열어 주세요.'
      : '잠시만 기다려 주세요.';
    document.querySelector('#webChatRecovery').hidden = !state.error;
  }

  for (const service of services) {
    document.querySelectorAll(`.${service.id}-link`).forEach((link) => {
      link.addEventListener('click', (event) => { event.preventDefault(); open(service); });
    });
  }
  returnButton.addEventListener('click', showWorkspace);
  backButton.addEventListener('click', () => activeService?.bridge.navigate('back'));
  forwardButton.addEventListener('click', () => activeService?.bridge.navigate('forward'));
  reloadButton.addEventListener('click', () => activeService?.bridge.navigate('reload'));
  document.querySelector('#chatGptBrowser').addEventListener('click', () => activeService?.bridge.openInBrowser());
  document.querySelector('#openWebChatBrowser').addEventListener('click', () => activeService?.bridge.openInBrowser());
  document.querySelector('#retryWebChat').addEventListener('click', () => activeService?.bridge.navigate('reload'));

  const resizeObserver = new ResizeObserver(scheduleLayout);
  resizeObserver.observe(viewport);
  resizeObserver.observe(document.querySelector('#sidebar'));
  // Native views sit above DOM dialogs, so hide the view while a local dialog is open.
  const overlayObserver = new MutationObserver(syncLayout);
  overlays.forEach((overlay) => overlayObserver.observe(overlay, { attributes: true, attributeFilter: ['hidden'] }));
  window.addEventListener('resize', scheduleLayout);
  document.addEventListener('visibilitychange', syncLayout);
  const unsubscribe = [];
  for (const service of services) {
    unsubscribe.push(service.bridge.onState((state) => renderState(service, state)));
    unsubscribe.push(service.bridge.onCommand((command) => {
      if (command === 'open') open(service);
      if (command === 'workspace') showWorkspace();
    }));
    void service.bridge.getState().then((state) => renderState(service, state))
      .catch(() => renderState(service, { loading: false, error: true }));
  }
  window.addEventListener('pagehide', () => {
    services.forEach((service) => service.bridge.setLayout({ visible: false }));
    cancelAnimationFrame(pendingFrame);
    resizeObserver.disconnect(); overlayObserver.disconnect();
    unsubscribe.forEach((stop) => stop());
  }, { once: true });

  return { showWorkspace };
}

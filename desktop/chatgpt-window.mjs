import { BrowserWindow, WebContentsView, dialog, nativeTheme, session, shell } from 'electron';

export const CHATGPT_URL = 'https://chatgpt.com/';
const PARTITION = 'persist:loopline-chatgpt';
const PAGE_HOSTS = new Set([
  'chatgpt.com', 'chat.openai.com', 'auth.openai.com', 'auth0.openai.com',
  'accounts.google.com', 'appleid.apple.com', 'login.live.com', 'login.microsoftonline.com',
]);

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null;
  } catch { return null; }
}

function allowedPage(value) {
  const url = httpsUrl(value);
  return Boolean(url && PAGE_HOSTS.has(url.hostname));
}

export function createChatGptView(owner, onState) {
  let view = null;
  let requestedBounds = null;
  let visible = false;
  let loadFailed = false;
  let configured = false;
  let showingExternalPrompt = false;
  const popups = new Set();
  const mediaGrants = new Set();

  function getState() {
    const contents = view?.webContents;
    const alive = contents && !contents.isDestroyed();
    return {
      hostname: alive ? httpsUrl(contents.getURL())?.hostname || '' : '',
      loading: Boolean(alive && contents.isLoading()),
      canGoBack: Boolean(alive && contents.navigationHistory.canGoBack()),
      canGoForward: Boolean(alive && contents.navigationHistory.canGoForward()),
      error: loadFailed,
    };
  }

  function publishState() { onState(getState()); }

  function updateBackground() {
    if (view && !view.webContents.isDestroyed()) view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#101010' : '#ffffff');
  }

  function applyLayout() {
    if (!view || view.webContents.isDestroyed() || owner.isDestroyed()) return;
    if (requestedBounds) {
      const [width, height] = owner.getContentSize();
      const zoom = owner.webContents.getZoomFactor();
      const x = Math.min(width, Math.max(0, Math.round(requestedBounds.x * zoom)));
      const y = Math.min(height, Math.max(0, Math.round(requestedBounds.y * zoom)));
      // The host fills the area below the toolbar and to the right of the sidebar.
      view.setBounds({ x, y, width: Math.max(0, width - x), height: Math.max(0, height - y) });
    }
    view.setVisible(visible && !loadFailed && Boolean(requestedBounds));
  }

  const preferences = () => ({
    partition: PARTITION,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    navigateOnDragDrop: false,
  });

  async function openExternal(value) {
    const url = httpsUrl(value);
    if (!url || showingExternalPrompt || owner.isDestroyed()) return;
    showingExternalPrompt = true;
    try {
      const result = await dialog.showMessageBox(owner, {
        type: 'question', title: '브라우저에서 열기',
        message: `${url.hostname}을(를) 기본 브라우저에서 열까요?`,
        buttons: ['취소', '열기'], defaultId: 0, cancelId: 0,
      });
      if (result.response === 1) await shell.openExternal(url.href);
    } finally { showingExternalPrompt = false; }
  }

  function configureSession() {
    if (configured) return;
    configured = true;
    const webSession = session.fromPartition(PARTITION);
    const fromChatGpt = (contents, requestingUrl) => !contents?.isDestroyed()
      && httpsUrl(contents?.getURL())?.origin === 'https://chatgpt.com'
      && httpsUrl(requestingUrl)?.origin === 'https://chatgpt.com';
    webSession.setPermissionCheckHandler((contents, permission, origin, details) => {
      if (!fromChatGpt(contents, origin)) return false;
      if (permission === 'media') return mediaGrants.has(details.mediaType);
      return ['clipboard-sanitized-write', 'fullscreen'].includes(permission);
    });
    webSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
      if (!fromChatGpt(contents, details.requestingUrl)) { callback(false); return; }
      if (['clipboard-sanitized-write', 'fullscreen'].includes(permission)) { callback(true); return; }
      const types = permission === 'media' ? details.mediaTypes : [];
      const permissionOwner = BrowserWindow.fromWebContents(contents) || owner;
      if (permissionOwner.isDestroyed() || !types?.length || types.some((type) => !['audio', 'video'].includes(type))) { callback(false); return; }
      if (types.every((type) => mediaGrants.has(type))) { callback(true); return; }
      try {
        const names = types.map((type) => type === 'audio' ? '마이크' : '카메라').join('·');
        const result = await dialog.showMessageBox(permissionOwner, {
          type: 'question', title: 'ChatGPT 권한 요청',
          message: `ChatGPT에서 ${names}를 사용하도록 허용할까요?`,
          detail: 'chatgpt.com에서 요청했습니다. macOS의 권한 확인이 추가로 표시될 수 있습니다.',
          buttons: ['허용 안 함', '허용'], defaultId: 0, cancelId: 0,
        });
        const granted = result.response === 1 && !contents.isDestroyed();
        if (granted) types.forEach((type) => mediaGrants.add(type));
        callback(granted);
      } catch { callback(false); }
    });
  }

  function configureContents(contents, popupWindow = null) {
    const updateTitle = () => {
      if (popupWindow && !popupWindow.isDestroyed()) popupWindow.setTitle(`ChatGPT · Loopline — ${httpsUrl(contents.getURL())?.hostname || '불러오는 중'}`);
      if (!popupWindow) publishState();
    };
    contents.on('page-title-updated', (event) => { event.preventDefault(); updateTitle(); });
    contents.on('did-navigate', updateTitle);
    contents.on('did-navigate-in-page', updateTitle);
    contents.on('will-navigate', (event) => {
      if (allowedPage(event.url)) return;
      event.preventDefault();
      void openExternal(event.url).catch(() => {});
    });
    contents.on('will-redirect', (event) => {
      if (!event.isMainFrame || allowedPage(event.url)) return;
      event.preventDefault();
      void openExternal(event.url).catch(() => {});
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (allowedPage(url) || url === 'about:blank') {
        return { action: 'allow', overrideBrowserWindowOptions: {
          title: 'ChatGPT 로그인 · Loopline', width: 620, height: 780,
          parent: owner,
          webPreferences: preferences(),
        } };
      }
      void openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    contents.on('did-create-window', (popup) => {
      popups.add(popup);
      configureContents(popup.webContents, popup);
      popup.on('closed', () => popups.delete(popup));
    });
  }

  async function openInBrowser() {
    await shell.openExternal(CHATGPT_URL);
  }

  function ensureView() {
    if (view && !view.webContents.isDestroyed()) return;
    configureSession();
    if (view) owner.contentView.removeChildView(view);
    view = new WebContentsView({ webPreferences: preferences() });
    view.setVisible(false);
    updateBackground();
    owner.contentView.addChildView(view);
    const contents = view.webContents;
    configureContents(contents);
    contents.on('did-start-loading', () => {
      loadFailed = false;
      applyLayout();
      publishState();
    });
    contents.on('did-stop-loading', publishState);
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      loadFailed = true;
      applyLayout();
      publishState();
    });
    contents.on('render-process-gone', () => {
      loadFailed = true;
      applyLayout();
      publishState();
    });
    // Only the local shell gets a preload bridge; the remote page keeps its own session.
    void contents.loadURL(CHATGPT_URL).catch(() => {});
  }

  function setLayout(layout) {
    if (typeof layout?.visible !== 'boolean' || owner.isDestroyed()) return;
    if (layout.visible) {
      const bounds = layout.bounds;
      if (!bounds || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key]) && bounds[key] >= 0 && bounds[key] <= 30_000)
        || bounds.width < 1 || bounds.height < 1) return;
      requestedBounds = bounds;
      ensureView();
    }
    const changed = visible !== layout.visible;
    visible = layout.visible;
    applyLayout();
    if (changed && !visible) owner.webContents.focus();
  }

  function hide() {
    visible = false;
    applyLayout();
  }

  function navigate(action) {
    const focused = BrowserWindow.getFocusedWindow();
    const contents = popups.has(focused) ? focused.webContents : view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    const history = contents.navigationHistory;
    if (action === 'back' && history.canGoBack()) history.goBack();
    if (action === 'forward' && history.canGoForward()) history.goForward();
    if (action === 'reload') contents.reload();
  }

  function dispose() {
    nativeTheme.removeListener('updated', updateBackground);
    owner.removeListener('resize', applyLayout);
    for (const popup of popups) if (!popup.isDestroyed()) popup.destroy();
    popups.clear(); mediaGrants.clear();
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
    view = null;
  }

  owner.on('resize', applyLayout);
  nativeTheme.on('updated', updateBackground);
  return { setLayout, hide, navigate, openInBrowser, getState, dispose };
}

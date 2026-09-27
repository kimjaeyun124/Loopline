import { BrowserWindow, dialog, session, shell } from 'electron';

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

export function createChatGptWindow() {
  let chatWindow = null;
  let configured = false;
  let showingExternalPrompt = false;
  const popups = new Set();
  const mediaGrants = new Set();

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
    if (!url || showingExternalPrompt || !chatWindow || chatWindow.isDestroyed()) return;
    showingExternalPrompt = true;
    try {
      const result = await dialog.showMessageBox(chatWindow, {
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
      const owner = BrowserWindow.fromWebContents(contents);
      if (!owner || !types?.length || types.some((type) => !['audio', 'video'].includes(type))) { callback(false); return; }
      if (types.every((type) => mediaGrants.has(type))) { callback(true); return; }
      try {
        const names = types.map((type) => type === 'audio' ? '마이크' : '카메라').join('·');
        const result = await dialog.showMessageBox(owner, {
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

  function configureWindow(window) {
    const contents = window.webContents;
    const updateTitle = () => {
      if (!window.isDestroyed()) window.setTitle(`ChatGPT · Loopline — ${httpsUrl(contents.getURL())?.hostname || '불러오는 중'}`);
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
          webPreferences: preferences(),
        } };
      }
      void openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    contents.on('did-create-window', (popup) => {
      popups.add(popup);
      configureWindow(popup);
      popup.on('closed', () => popups.delete(popup));
    });
  }

  async function openInBrowser() {
    await shell.openExternal(CHATGPT_URL);
  }

  function open() {
    if (chatWindow && !chatWindow.isDestroyed()) {
      if (chatWindow.isMinimized()) chatWindow.restore();
      chatWindow.show(); chatWindow.focus();
      return;
    }
    configureSession();
    const window = new BrowserWindow({
      title: 'ChatGPT · Loopline', width: 1160, height: 820,
      minWidth: 760, minHeight: 560, backgroundColor: '#ffffff',
      webPreferences: preferences(),
    });
    chatWindow = window;
    configureWindow(window);
    window.on('closed', () => {
      for (const popup of popups) if (!popup.isDestroyed()) popup.destroy();
      popups.clear(); mediaGrants.clear(); chatWindow = null;
    });
    // This view has no preload bridge. Website login cookies stay in its own session.
    void window.loadURL(CHATGPT_URL).catch(async (error) => {
      if (window.isDestroyed() || error.code === 'ERR_ABORTED') return;
      const result = await dialog.showMessageBox(window, {
        type: 'warning', title: 'ChatGPT 연결', message: 'ChatGPT 화면을 불러오지 못했습니다.',
        detail: '네트워크 연결을 확인해 주세요. 상단 ChatGPT 메뉴에서 다시 불러오거나 브라우저로 열 수 있습니다.',
        buttons: ['닫기', '브라우저에서 열기'], defaultId: 0, cancelId: 0,
      });
      if (result.response === 1) await openInBrowser();
    }).catch(() => {});
  }

  function navigate(action) {
    const focused = BrowserWindow.getFocusedWindow();
    const window = popups.has(focused) ? focused : chatWindow;
    if (!window || window.isDestroyed()) return;
    const history = window.webContents.navigationHistory;
    if (action === 'back' && history.canGoBack()) history.goBack();
    if (action === 'forward' && history.canGoForward()) history.goForward();
    if (action === 'reload') window.webContents.reload();
  }

  return { open, navigate, openInBrowser };
}

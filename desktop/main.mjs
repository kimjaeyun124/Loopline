import { app, BrowserWindow, dialog, Menu, safeStorage, shell, utilityProcess } from 'electron';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_NAME = 'Mosaic Desk';
const EXTERNAL_AUTH_HOSTS = new Set(['auth.openai.com', 'chatgpt.com']);
const BACKEND_PORT = process.env.MOSAIC_DESKTOP_PORT || '41743';
const desktopDir = dirname(fileURLToPath(import.meta.url));
let backendProcess = null;
let backendUrl = null;
let mainWindow = null;

app.setName(APP_NAME);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    installApplicationMenu();
    try {
      backendUrl = await startBackend();
      await createMainWindow(backendUrl);
    } catch (error) {
      stopBackend();
      await dialog.showMessageBox({
        type: 'error',
        title: `${APP_NAME} 실행 실패`,
        message: `${APP_NAME}을(를) 시작하지 못했습니다.`,
        detail: error instanceof Error ? error.message : '로컬 서버 시작에 실패했습니다.',
      });
      app.quit();
    }
  });

  app.on('before-quit', stopBackend);
  app.on('window-all-closed', () => app.quit());
}

function getBackendRoot() {
  return app.isPackaged
    ? join(process.resourcesPath, 'app-server')
    : resolve(desktopDir, '..');
}

function getCliPath() {
  const candidates = [
    join(homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    process.env.PATH || '',
  ];
  return [...new Set(candidates.flatMap((entry) => entry.split(delimiter)).filter(Boolean))].join(delimiter);
}

function startBackend() {
  const backendRoot = getBackendRoot();
  const serverEntry = join(backendRoot, 'server.mjs');

  return new Promise((resolveBackend, rejectBackend) => {
    let settled = false;
    let outputBuffer = '';
    let errorBuffer = '';
    const timeout = setTimeout(() => finish(new Error('로컬 서버가 제한 시간 안에 시작되지 않았습니다.')), 20_000);

    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) rejectBackend(error);
      else resolveBackend(url);
    };

    try {
      backendProcess = utilityProcess.fork(serverEntry, [], {
        cwd: backendRoot,
        env: {
          ...process.env,
          HOST: '127.0.0.1',
          PORT: BACKEND_PORT,
          MOSAIC_DESKTOP: '1',
          MOSAIC_USER_DATA_DIR: app.getPath('userData'),
          PATH: getCliPath(),
        },
        serviceName: `${APP_NAME} Local Server`,
        stdio: 'pipe',
      });
    } catch (error) {
      finish(error);
      return;
    }

    const child = backendProcess;
    child.on('message', async (message) => {
      if (message?.scope !== 'mosaic-secrets' || !['encrypt', 'decrypt'].includes(message.action)) return;
      try {
        if (typeof message.value !== 'string' || message.value.length > 64_000 || !await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Keychain unavailable');
        const value = message.action === 'encrypt'
          ? (await safeStorage.encryptStringAsync(message.value)).toString('base64')
          : (await safeStorage.decryptStringAsync(Buffer.from(message.value, 'base64'))).result;
        if (child.pid) child.postMessage({ scope: 'mosaic-secrets', id: message.id, value });
      } catch {
        if (child.pid) child.postMessage({ scope: 'mosaic-secrets', id: message.id, error: true });
      }
    });

    backendProcess.stdout?.on('data', (chunk) => {
      const lines = (outputBuffer + chunk.toString()).split(/\r?\n/);
      outputBuffer = lines.pop() || '';
      for (const line of lines) {
        const match = line.match(/^MOSAIC_SERVER_READY=(http:\/\/127\.0\.0\.1:\d+)$/);
        if (!match) continue;
        const readyUrl = new URL(match[1]);
        if (Number(readyUrl.port) > 0) finish(null, readyUrl.href);
      }
    });
    backendProcess.stderr?.on('data', (chunk) => {
      errorBuffer = (errorBuffer + chunk.toString()).slice(-2000);
    });

    backendProcess.once('exit', (code) => {
      finish(new Error(errorBuffer.trim() || `로컬 서버가 시작 중 종료되었습니다${code === undefined ? '' : ` (${code})`}.`));
    });
    backendProcess.once('error', () => {
      finish(new Error('로컬 서버 프로세스를 시작하지 못했습니다.'));
    });
  });
}

function stopBackend() {
  if (!backendProcess) return;
  backendProcess.kill();
  backendProcess = null;
}

function installApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '편집',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ]));
}

async function openAllowedExternal(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || !EXTERNAL_AUTH_HOSTS.has(url.hostname) || url.username || url.password) return;
    await shell.openExternal(url.href);
  } catch {
    // Ignore malformed or unapproved external URLs.
  }
}

async function createMainWindow(url) {
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#fafafa',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  const appOrigin = new URL(url).origin;
  mainWindow.webContents.on('will-navigate', (event, destination) => {
    if (new URL(destination).origin === appOrigin) return;
    event.preventDefault();
    void openAllowedExternal(destination);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: destination }) => {
    void openAllowedExternal(destination);
    return { action: 'deny' };
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });

  await mainWindow.loadURL(`${url}?desktop=1`);
}

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Keep the bridge specific to the local shell. Never expose ipcRenderer to websites.
contextBridge.exposeInMainWorld('looplineAppearance', {
  setTheme: (theme) => ipcRenderer.send('loopline:appearance', theme),
});
contextBridge.exposeInMainWorld('looplineWorkspace', {
  chooseFolder: () => ipcRenderer.invoke('loopline:choose-workspace'),
  chooseMcpCommand: () => ipcRenderer.invoke('loopline:choose-mcp-command'),
});

for (const [name, service] of [['looplineChatGpt', 'chatgpt'], ['looplineGemini', 'gemini']]) {
  const channel = `loopline-${service}`;
  contextBridge.exposeInMainWorld(name, {
    setLayout: (layout) => ipcRenderer.send(`${channel}:layout`, layout),
    navigate: (action) => ipcRenderer.send(`${channel}:navigate`, action),
    openInBrowser: () => ipcRenderer.send(`${channel}:browser`),
    getState: () => ipcRenderer.invoke(`${channel}:state`),
    onState: (callback) => subscribe(`${channel}:state`, callback),
    onCommand: (callback) => subscribe(`${channel}:command`, callback),
  });
}

'use strict';
// Pont minimal et typé entre la page et l'application (contextIsolation + sandbox : pas d'accès Node côté page).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('csmNative', {
  platform: process.platform,
  pickSave: name => ipcRenderer.invoke('csm:pick-save', typeof name === 'string' ? name : ''),
  saveText: (file, text) => ipcRenderer.invoke('csm:save-text', typeof file === 'string' ? file : '', typeof text === 'string' ? text : ''),
  pickFolder: initial => ipcRenderer.invoke('csm:pick-folder', typeof initial === 'string' ? initial : ''),
  setAttention: n => ipcRenderer.send('csm:attention', Number(n) || 0),
  focus: () => ipcRenderer.send('csm:focus'),
  allowPilot: origin => ipcRenderer.send('csm:pilot-origin', String(origin || '')), // pilotage à distance (public/remote.js)
  // notification par l'app (repli macOS sans signature Apple) ; id = session à ouvrir au clic
  notify: (title, body, id) => ipcRenderer.send('csm:notify', { title: String(title || ''), body: String(body || ''), id: String(id || '') }),
  notifyTest: () => ipcRenderer.invoke('csm:notify-test'),
  setPrefs: p => ipcRenderer.send('csm:prefs', { closeToTray: !!p.closeToTray }),
  toTray: () => ipcRenderer.send('csm:to-tray'), // fenêtre rangée dans la zone de notification / barre des menus
  appVersion: () => ipcRenderer.sendSync('csm:app-version'),
  restartServer: () => ipcRenderer.invoke('csm:restart-server'),
  update: action => ipcRenderer.invoke('csm:update', ['check', 'install', 'later', 'state'].includes(action) ? action : 'state'),
  onUpdate: cb => { const h = (e, st) => cb(st); ipcRenderer.on('csm:update-state', h); return () => ipcRenderer.removeListener('csm:update-state', h); },
  onAction: cb => {
    const h = (e, action) => { if (typeof action === 'string') cb(action); };
    ipcRenderer.on('csm:action', h);
    return () => ipcRenderer.removeListener('csm:action', h);
  },
});

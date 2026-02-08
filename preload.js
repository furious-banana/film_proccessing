const { contextBridge, ipcRenderer } = require('electron');

// Expose file system APIs to renderer
contextBridge.exposeInMainWorld('electronAPI', {
    openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
    saveFileDialog: (defaultName) => ipcRenderer.invoke('save-file-dialog', defaultName),
    writeFile: (filePath, buffer) => ipcRenderer.invoke('write-file', filePath, buffer),
    readFile: (filePath) => ipcRenderer.invoke('read-file', filePath)
});

const { contextBridge, ipcRenderer } = require('electron');

// Expose file system APIs to renderer
contextBridge.exposeInMainWorld('electronAPI', {
    // sourcePath (the opened image) makes dialogs start in its folder
    openFileDialog: (sourcePath) => ipcRenderer.invoke('open-file-dialog', sourcePath),
    saveFileDialog: (defaultName, sourcePath) => ipcRenderer.invoke('save-file-dialog', defaultName, sourcePath),
    writeFile: (filePath, buffer) => ipcRenderer.invoke('write-file', filePath, buffer),
    readFile: (filePath) => ipcRenderer.invoke('read-file', filePath)
});

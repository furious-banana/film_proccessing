const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const Store = require('electron-store');

const store = new Store();
let mainWindow;
let flaskProcess;

// Get Python path
function getPythonPath() {
    if (app.isPackaged) {
        // In production, use bundled Python from .venv structure
        return path.join(process.resourcesPath, 'python_runtime', 'Scripts', 'python.exe');
    } else {
        // In development, use system Python
        return 'uv';
    }
}

// Start Flask backend
function startFlaskServer() {
    return new Promise((resolve, reject) => {
        const pythonPath = getPythonPath();
        const scriptPath = path.join(__dirname, 'src', 'app.py');
        
        console.log('Starting Flask server...');
        console.log('Python:', pythonPath);
        console.log('Script:', scriptPath);
        
        // Start Flask with uv in dev, python in production
        if (app.isPackaged) {
            flaskProcess = spawn(pythonPath, [scriptPath]);
        } else {
            flaskProcess = spawn('uv', ['run', 'python', scriptPath]);
        }
        
        flaskProcess.stdout.on('data', (data) => {
            console.log(`Flask: ${data}`);
            if (data.toString().includes('Running on')) {
                resolve();
            }
        });
        
        flaskProcess.stderr.on('data', (data) => {
            console.error(`Flask Error: ${data}`);
        });
        
        flaskProcess.on('close', (code) => {
            console.log(`Flask process exited with code ${code}`);
        });
        
        // Timeout after 10 seconds
        setTimeout(() => resolve(), 10000);
    });
}

// Create main window
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1600,
        height: 1000,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'icon.ico')
    });
    
    // Disable disk cache so static file edits load immediately
    mainWindow.webContents.session.clearCache();
    
    // Load Flask app
    mainWindow.loadURL('http://localhost:5000');
    
    // DevTools disabled by default - press F12 to open if needed
    // if (!app.isPackaged) {
    //     mainWindow.webContents.openDevTools();
    // }
    
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// File picker for opening images
ipcMain.handle('open-file-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [
            { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'bmp'] },
            { name: 'Settings', extensions: ['json'] },
            { name: 'All Files', extensions: ['*'] }
        ]
    });
    
    if (!result.canceled && result.filePaths.length > 0) {
        const filePath = result.filePaths[0];
        // Store the directory for export
        store.set('lastOpenDirectory', path.dirname(filePath));
        return { filePath, directory: path.dirname(filePath) };
    }
    return null;
});

// Save file dialog for export
ipcMain.handle('save-file-dialog', async (event, defaultName) => {
    const lastDir = store.get('lastOpenDirectory', app.getPath('documents'));
    
    // Determine file type from extension
    const ext = path.extname(defaultName).toLowerCase();
    const filters = ext === '.json' ? 
        [{ name: 'Settings', extensions: ['json'] }] :
        [{ name: 'TIFF Image', extensions: ['tif', 'tiff'] }];
    
    const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: path.join(lastDir, defaultName),
        filters: filters
    });
    
    if (!result.canceled) {
        return result.filePath;
    }
    return null;
});

// Write file (for export)
ipcMain.handle('write-file', async (event, filePath, buffer) => {
    try {
        fs.writeFileSync(filePath, Buffer.from(buffer));
        return { success: true };
    } catch (error) {
        console.error('Error writing file:', error);
        return { success: false, error: error.message };
    }
});

// Read file (for loading settings)
ipcMain.handle('read-file', async (event, filePath) => {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return { success: true, content };
    } catch (error) {
        // Don't log error if file simply doesn't exist (ENOENT) - that's expected
        if (error.code !== 'ENOENT') {
            console.error('Error reading file:', error);
        }
        return { success: false, error: error.message };
    }
});

// Stop Flask and its whole process tree. On Windows, child.kill() only
// terminates the direct child (the `uv run` wrapper) and the actual
// python server survives, keeping port 5000 busy for the next launch.
function stopFlaskServer() {
    if (!flaskProcess) return;
    if (process.platform === 'win32') {
        try {
            spawnSync('taskkill', ['/pid', String(flaskProcess.pid), '/T', '/F']);
        } catch (e) {
            console.error('Failed to kill Flask process tree:', e);
        }
    } else {
        flaskProcess.kill();
    }
    flaskProcess = null;
}

// App lifecycle
app.whenReady().then(async () => {
    await startFlaskServer();
    createWindow();
    
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    stopFlaskServer();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    stopFlaskServer();
});

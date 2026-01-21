/**
 * Main Electron process - orchestrates the application
 *
 * This follows the ComfyUI architecture:
 * 1. Spawn a Python subprocess running the FastAPI server
 * 2. Wait for the server to be ready
 * 3. Load the server's web UI in an Electron window
 */

import { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, session } from "electron";
import * as path from "path";
import { PythonServer } from "./python-server";

// Keep a global reference of the window object to prevent garbage collection
let mainWindow: BrowserWindow | null = null;
let pythonServer: PythonServer | null = null;

const SERVER_PORT = 8188;

async function showUvNotFoundDialog(): Promise<void> {
  const result = await dialog.showMessageBox({
    type: "error",
    title: "Python Package Manager Required",
    message: "uv is not installed",
    detail:
      "NEXRAD Viewer requires 'uv' (a fast Python package manager) to run.\n\n" +
      "To install uv, open Terminal and run:\n\n" +
      "curl -LsSf https://astral.sh/uv/install.sh | sh\n\n" +
      "After installation, restart NEXRAD Viewer.",
    buttons: ["Open Installation Guide", "Copy Install Command", "Quit"],
    defaultId: 0,
    cancelId: 2,
  });

  if (result.response === 0) {
    // Open installation guide
    shell.openExternal("https://docs.astral.sh/uv/getting-started/installation/");
  } else if (result.response === 1) {
    // Copy install command to clipboard
    const { clipboard } = require("electron");
    clipboard.writeText("curl -LsSf https://astral.sh/uv/install.sh | sh");
    await dialog.showMessageBox({
      type: "info",
      title: "Command Copied",
      message: "Install command copied to clipboard",
      detail: "Open Terminal and paste (Cmd+V) to install uv.",
      buttons: ["OK"],
    });
  }

  app.quit();
}

async function createWindow(): Promise<void> {
  const iconPath = path.join(__dirname, "..", "icons", "icon.icns");
  const icon = nativeImage.createFromPath(iconPath);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "NEXRAD Viewer",
    icon: icon.isEmpty() ? undefined : icon,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false, // Don't show until ready
  });

  // Show loading page while Python server starts
  mainWindow.loadFile(path.join(__dirname, "..", "loading.html"));
  mainWindow.show();

  // Start the Python server
  pythonServer = new PythonServer(SERVER_PORT);

  try {
    console.log("Starting Python server...");
    await pythonServer.start();
    console.log("Python server is ready!");

    // Load the Python server's web UI
    mainWindow.loadURL(`http://localhost:${SERVER_PORT}`);
  } catch (error: any) {
    console.error("Failed to start Python server:", error);

    // Check if it's a uv not found error
    if (error.message === "UV_NOT_FOUND") {
      await showUvNotFoundDialog();
    } else {
      mainWindow.loadFile(path.join(__dirname, "..", "error.html"));
    }
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// IPC handlers for renderer communication
ipcMain.handle("get-server-status", async () => {
  return {
    running: pythonServer?.isRunning() ?? false,
    port: SERVER_PORT,
  };
});

ipcMain.handle("restart-server", async () => {
  if (pythonServer) {
    await pythonServer.stop();
    await pythonServer.start();
  }
  return { success: true };
});

// App lifecycle
app.whenReady().then(async () => {
  // Clear cache in dev mode
  await session.defaultSession.clearCache();

  // Set dock icon on macOS
  if (process.platform === "darwin" && app.dock) {
    const iconPath = path.join(__dirname, "..", "icons", "icon.icns");
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      app.dock.setIcon(icon);
    }
  }
  createWindow();
});

app.on("window-all-closed", async () => {
  // Stop the Python server when the app closes
  if (pythonServer) {
    console.log("Stopping Python server...");
    await pythonServer.stop();
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// Handle app quit
app.on("before-quit", async () => {
  if (pythonServer) {
    await pythonServer.stop();
  }
});

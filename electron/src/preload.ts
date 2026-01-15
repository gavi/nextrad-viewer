/**
 * Preload script - exposes a safe API to the renderer process
 *
 * This is the security boundary between the Node.js environment and
 * the web content. Only explicitly exposed APIs are available to
 * the renderer, following Electron security best practices.
 */

import { contextBridge, ipcRenderer } from "electron";

// Expose a type-safe API to the renderer process
contextBridge.exposeInMainWorld("electronAPI", {
  // Server management
  getServerStatus: () => ipcRenderer.invoke("get-server-status"),
  restartServer: () => ipcRenderer.invoke("restart-server"),

  // Platform info
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
});

// Type definitions for the exposed API
declare global {
  interface Window {
    electronAPI: {
      getServerStatus: () => Promise<{ running: boolean; port: number }>;
      restartServer: () => Promise<{ success: boolean }>;
      platform: string;
      versions: {
        node: string;
        chrome: string;
        electron: string;
      };
    };
  }
}

import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "./ipc.js";
import type { SetupBridge } from "./ipc.js";
import type { SetupProgress } from "./contracts.js";

const listeners = new Set<(progress: SetupProgress) => void>();
const receive = (_event: unknown, progress: SetupProgress) => { for (const listener of listeners) listener(progress); };
const bridge: SetupBridge = Object.freeze({
  getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.status),
  submit: (input) => ipcRenderer.invoke(IPC_CHANNELS.submit, input),
  rerunDiagnostics: () => ipcRenderer.invoke(IPC_CHANNELS.diagnostics),
  openConfigDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.openConfig),
  clearConfiguration: () => ipcRenderer.invoke(IPC_CHANNELS.clear),
  onProgress(listener) {
    if (typeof listener !== "function") throw new TypeError("Progress listener required");
    // Each registration is distinct, even if a caller registers the same callback twice.
    const wrapped = (progress: SetupProgress) => { listener(progress); };
    if (listeners.size === 0) { ipcRenderer.on(IPC_CHANNELS.progress, receive); ipcRenderer.send(IPC_CHANNELS.subscribe); }
    listeners.add(wrapped);
    return () => {
      if (!listeners.delete(wrapped)) return;
      if (listeners.size === 0) { ipcRenderer.removeListener(IPC_CHANNELS.progress, receive); ipcRenderer.send(IPC_CHANNELS.unsubscribe); }
    };
  },
});
contextBridge.exposeInMainWorld("hypitSetup", bridge);

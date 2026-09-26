import { contextBridge, ipcRenderer } from "electron";
import type { AppBridge } from "@magic/contracts";
const bridge: AppBridge = {
  execute: (command) => ipcRenderer.invoke("magic:execute", command),
  openExternal: (url) => ipcRenderer.invoke("magic:open", url),
  importFile: () => ipcRenderer.invoke("magic:import"),
  signInUW: () => ipcRenderer.invoke("magic:signin"),
  syncCanvas: () => ipcRenderer.invoke("magic:sync"),
  signOutUW: () => ipcRenderer.invoke("magic:signout"),
  localStatus: () => ipcRenderer.invoke("magic:local-status"),
  localAsk: (request) => ipcRenderer.invoke("magic:local-ask", request),
  cancelLocal: () => ipcRenderer.invoke("magic:local-cancel"),
};
contextBridge.exposeInMainWorld("magic", bridge);

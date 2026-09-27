import { contextBridge, ipcRenderer } from "electron";
import type { AppBridge } from "@magic/contracts";
const bridge: AppBridge = {
  execute: (command) => ipcRenderer.invoke("magic:execute", command),
  openExternal: (url) => ipcRenderer.invoke("magic:open", url),
  importFile: () => ipcRenderer.invoke("magic:import"),
  signInUW: (service) => ipcRenderer.invoke("magic:signin", service),
  syncCanvas: () => ipcRenderer.invoke("magic:sync"),
  syncPlanning: () => ipcRenderer.invoke("magic:planning-sync"),
  signOutUW: () => ipcRenderer.invoke("magic:signout"),
  localStatus: () => ipcRenderer.invoke("magic:local-status"),
  localAsk: (request) => ipcRenderer.invoke("magic:local-ask", request),
  cancelLocal: () => ipcRenderer.invoke("magic:local-cancel"),
  learningList: (id) => ipcRenderer.invoke("magic:learning-list", id),
  learningGet: (id) => ipcRenderer.invoke("magic:learning-get", id),
  learningStart: (request) => ipcRenderer.invoke("magic:learning-start", request),
  learningAct: (request) => ipcRenderer.invoke("magic:learning-act", request),
  learningSaveDraft: (request) => ipcRenderer.invoke("magic:learning-draft", request),
  cancelLearning: () => ipcRenderer.invoke("magic:learning-cancel"),
  exportMcp: (id) => ipcRenderer.invoke("magic:mcp-export", id),
};
contextBridge.exposeInMainWorld("magic", bridge);

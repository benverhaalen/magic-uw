import { contextBridge, ipcRenderer } from "electron";
import type { AppBridge, ClientsBridge } from "@magic/contracts";
// T80: terminal output arrives before a pane may have subscribed (the sign-in URL is printed
// first), so each session keeps a bounded backlog that a new subscriber receives first.
// Exits are kept too. Both are dropped on close(), once an exit reaches a subscriber, or
// five minutes after an exit nobody heard.
const backlogLimit = 256 * 1024;
const backlog = new Map<string, { chunks: string[]; size: number }>();
const exits = new Map<string, number | null>();
const dataSubscribers = new Set<(sessionId: string, chunk: string) => void>();
const exitSubscribers = new Set<(sessionId: string, code: number | null) => void>();
const forget = (sessionId: string) => {
  backlog.delete(sessionId);
  exits.delete(sessionId);
};
ipcRenderer.on("magic:terminal-data", (_event, sessionId: unknown, chunk: unknown) => {
  if (typeof sessionId !== "string" || typeof chunk !== "string") return;
  const entry = backlog.get(sessionId) ?? { chunks: [], size: 0 };
  const kept = chunk.length > backlogLimit ? chunk.slice(-backlogLimit) : chunk;
  entry.chunks.push(kept);
  entry.size += kept.length;
  while (entry.size > backlogLimit && entry.chunks.length > 1) entry.size -= entry.chunks.shift()!.length;
  backlog.set(sessionId, entry);
  for (const cb of dataSubscribers) cb(sessionId, chunk);
});
ipcRenderer.on("magic:terminal-exit", (_event, sessionId: unknown, code: unknown) => {
  if (typeof sessionId !== "string") return;
  const exitCode = typeof code === "number" ? code : null;
  for (const cb of exitSubscribers) cb(sessionId, exitCode);
  if (exitSubscribers.size) forget(sessionId);
  else {
    exits.set(sessionId, exitCode);
    setTimeout(() => forget(sessionId), 5 * 60_000);
  }
});
const ignore = () => undefined;
const clients: ClientsBridge = {
  detect: () => ipcRenderer.invoke("magic:clients-detect"),
  prepare: (id) => ipcRenderer.invoke("magic:clients-prepare", id),
  authStatus: (id) => ipcRenderer.invoke("magic:clients-auth", id),
  choose: (id) => ipcRenderer.invoke("magic:clients-choose", id),
  terminal: {
    open: (id, purpose) => ipcRenderer.invoke("magic:terminal-open", id, purpose),
    write: (sessionId, data) => void ipcRenderer.invoke("magic:terminal-write", sessionId, data).catch(ignore),
    resize: (sessionId, cols, rows) =>
      void ipcRenderer.invoke("magic:terminal-resize", sessionId, cols, rows).catch(ignore),
    close: async (sessionId) => {
      try {
        await ipcRenderer.invoke("magic:terminal-close", sessionId);
      } finally {
        forget(sessionId);
      }
    },
    onData(cb) {
      for (const [sessionId, entry] of backlog) for (const chunk of entry.chunks) cb(sessionId, chunk);
      dataSubscribers.add(cb);
      return () => void dataSubscribers.delete(cb);
    },
    onExit(cb) {
      for (const [sessionId, code] of [...exits]) {
        cb(sessionId, code);
        forget(sessionId);
      }
      exitSubscribers.add(cb);
      return () => void exitSubscribers.delete(cb);
    },
  },
};
const bridge: AppBridge = {
  execute: (command) => ipcRenderer.invoke("magic:execute", command),
  openExternal: (url) => ipcRenderer.invoke("magic:open", url),
  openLink: (url) => ipcRenderer.invoke("magic:open-link", url), // owner: T05b
  query: (request) => ipcRenderer.invoke("magic:query", request), // owner: T15
  importFile: () => ipcRenderer.invoke("magic:import"),
  signInUW: (service) => ipcRenderer.invoke("magic:signin", service),
  syncCanvas: () => ipcRenderer.invoke("magic:sync"),
  syncPlanning: () => ipcRenderer.invoke("magic:planning-sync"),
  signOutUW: () => ipcRenderer.invoke("magic:signout"),
  localStatus: () => ipcRenderer.invoke("magic:local-status"),
  localAsk: (request) => ipcRenderer.invoke("magic:local-ask", request),
  cancelLocal: () => ipcRenderer.invoke("magic:local-cancel"),
  exportMcp: (id) => ipcRenderer.invoke("magic:mcp-export", id),
  keepSignedIn: (value) => ipcRenderer.invoke("magic:keep-signed-in", value),
  clients,
};
contextBridge.exposeInMainWorld("magic", bridge);

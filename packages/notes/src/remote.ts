/**
 * Where the student writes: the NotesRemote port and its two adapters.
 * - Microsoft: the Graph app folder (packages/connectors/src/graph.ts, a teammate's), to its exact
 *   `appFolderPut` / `appFolderGet` signature. This file never imports graph.ts.
 * - Google: Drive with the `drive.file` scope. The HTTP call runs in main, which alone holds the
 *   token; the adapter only builds Drive requests and reads their JSON.
 */
import type { NoteSyncProvider } from "@magic/contracts";
import { z } from "zod";
import { DOCX_TYPE } from "./docx";

export const APP_FOLDER = "My Magic UW";
export interface RemoteFile {
  remoteId: string;
  webUrl: string | null;
  etag: string | null;
  modifiedTime: string | null;
}
export type RemoteRead =
  | { status: "unchanged" }
  | { status: "changed"; format: "docx" | "html"; bytes: Uint8Array; etag: string | null; modifiedTime: string | null }
  | { status: "missing" };
export interface NotesRemote {
  provider: NoteSyncProvider;
  /** Whether the provider is signed in (no network when it can answer locally). */
  connected(): Promise<boolean>;
  /** Create or replace the note's file. `folders` are below the app folder; `name` ends in .docx. */
  put(input: { folders: string[]; name: string; bytes: Uint8Array; remote: RemoteFile | null }): Promise<RemoteFile>;
  /** A conditional read: "unchanged" when the eTag or modified time still matches. */
  get(remote: RemoteFile): Promise<RemoteRead>;
}

/** OneDrive and Google Drive both refuse some characters; keep names readable and short. */
export function safeName(value: string, max = 120): string {
  const cleaned = value.replace(/[\\/:*?"<>|#%\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  return (cleaned || "Untitled").slice(0, max);
}

/** The teammate's Graph surface (feat/outlook-graph), exactly as briefed. */
export interface GraphAppFolder {
  appFolderPut(path: string, bytes: Uint8Array, contentType: string): Promise<{ id: string; webUrl: string; eTag: string }>;
  appFolderGet(id: string, ifNoneMatch?: string): Promise<304 | { bytes: Uint8Array; eTag: string }>;
  appFolderDelta?(): Promise<unknown>;
  connected?(): Promise<boolean>;
}
export function microsoftRemote(graph: GraphAppFolder): NotesRemote {
  return {
    provider: "microsoft",
    connected: async () => (graph.connected ? graph.connected() : true),
    async put({ folders, name, bytes }) {
      const path = [APP_FOLDER, ...folders.map((f) => safeName(f)), safeName(name.replace(/\.docx$/i, "")) + ".docx"].join("/");
      const saved = await graph.appFolderPut(path, bytes, DOCX_TYPE);
      return { remoteId: saved.id, webUrl: saved.webUrl, etag: saved.eTag, modifiedTime: null };
    },
    async get(remote) {
      const read = await graph.appFolderGet(remote.remoteId, remote.etag ?? undefined);
      if (read === 304) return { status: "unchanged" };
      if (read.eTag === remote.etag) return { status: "unchanged" };
      return { status: "changed", format: "docx", bytes: read.bytes, etag: read.eTag, modifiedTime: null };
    },
  };
}

/** One Drive REST call, performed by main with the student's token. */
export interface DriveRequest {
  method: "GET" | "POST" | "PATCH";
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
}
export interface DriveResponse {
  status: number;
  body: Uint8Array;
}
export type DriveHttp = (request: DriveRequest) => Promise<DriveResponse>;
export const DRIVE = "https://www.googleapis.com/drive/v3/files";
export const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const GOOGLE_DOC = "application/vnd.google-apps.document";
const FOLDER = "application/vnd.google-apps.folder";
const fileSchema = z.object({
  id: z.string().min(1).max(500),
  webViewLink: z.string().url().max(4000).optional(),
  modifiedTime: z.string().max(100).optional(),
  trashed: z.boolean().optional(),
});
const listSchema = z.object({ files: z.array(fileSchema).max(1000) });

function json<T>(schema: z.ZodType<T>, response: DriveResponse, what: string): T {
  if (response.status < 200 || response.status >= 300) throw new Error(`Google Drive refused ${what} (HTTP ${response.status}).`);
  return schema.parse(JSON.parse(new TextDecoder().decode(response.body)));
}
function multipart(metadata: unknown, media: Uint8Array, type: string): { body: Uint8Array; contentType: string } {
  const boundary = `magic-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n`,
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + media.length + tail.length);
  body.set(head, 0);
  body.set(media, head.length);
  body.set(tail, head.length + media.length);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}
const quoteQ = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/**
 * Google Docs through `drive.file`: the app sees only files it created. Upload converts the .docx
 * into a Google Doc; reading back exports HTML. `connected` asks main whether a token is saved.
 */
export function googleRemote(http: DriveHttp, connected: () => Promise<boolean>): NotesRemote {
  const folders = new Map<string, string>();
  async function folder(name: string, parent: string | null): Promise<string> {
    const key = `${parent ?? "root"}/${name}`;
    const cached = folders.get(key);
    if (cached) return cached;
    const q = `name = '${quoteQ(name)}' and mimeType = '${FOLDER}' and trashed = false${parent ? ` and '${quoteQ(parent)}' in parents` : ""}`;
    const found = json(listSchema, await http({ method: "GET", url: `${DRIVE}?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive` }), "the folder lookup");
    let id = found.files[0]?.id;
    if (!id) {
      const created = json(
        fileSchema,
        await http({
          method: "POST",
          url: `${DRIVE}?fields=id`,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode(JSON.stringify({ name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) })),
        }),
        "creating a folder",
      );
      id = created.id;
    }
    folders.set(key, id);
    return id;
  }
  const fields = "id,webViewLink,modifiedTime";
  return {
    provider: "google",
    connected,
    async put({ folders: path, name, bytes, remote }) {
      const title = safeName(name.replace(/\.docx$/i, ""));
      if (remote) {
        const { body, contentType } = multipart({ name: title }, bytes, DOCX_TYPE);
        const saved = json(
          fileSchema,
          await http({ method: "PATCH", url: `${DRIVE_UPLOAD}/${encodeURIComponent(remote.remoteId)}?uploadType=multipart&fields=${fields}`, headers: { "content-type": contentType }, body }),
          "updating the document",
        );
        return { remoteId: saved.id, webUrl: saved.webViewLink ?? remote.webUrl, etag: null, modifiedTime: saved.modifiedTime ?? null };
      }
      let parent = await folder(APP_FOLDER, null);
      for (const f of path) parent = await folder(safeName(f), parent);
      const { body, contentType } = multipart({ name: title, mimeType: GOOGLE_DOC, parents: [parent] }, bytes, DOCX_TYPE);
      const saved = json(
        fileSchema,
        await http({ method: "POST", url: `${DRIVE_UPLOAD}?uploadType=multipart&fields=${fields}`, headers: { "content-type": contentType }, body }),
        "creating the document",
      );
      return { remoteId: saved.id, webUrl: saved.webViewLink ?? null, etag: null, modifiedTime: saved.modifiedTime ?? null };
    },
    async get(remote) {
      const meta = await http({ method: "GET", url: `${DRIVE}/${encodeURIComponent(remote.remoteId)}?fields=id,modifiedTime,trashed` });
      if (meta.status === 404) return { status: "missing" };
      const file = json(fileSchema, meta, "the document check");
      if (file.trashed) return { status: "missing" };
      if (file.modifiedTime && file.modifiedTime === remote.modifiedTime) return { status: "unchanged" };
      const exported = await http({ method: "GET", url: `${DRIVE}/${encodeURIComponent(remote.remoteId)}/export?mimeType=text%2Fhtml` });
      if (exported.status < 200 || exported.status >= 300) throw new Error(`Google Drive refused the export (HTTP ${exported.status}).`);
      return { status: "changed", format: "html", bytes: exported.body, etag: null, modifiedTime: file.modifiedTime ?? null };
    },
  };
}

// owner: ui-wiring. Lecture notes through the notes service: notes.recent (the compact list),
// notes.tree (sessions with or without a note), notes.open (a session's scaffold, 0 tokens),
// notes.templates + notes.setTemplate, notes.fill (fill from slides, the student's own AI) and
// notes.sync.status (Word and Google Docs).
import { useState } from "react";
import type { NoteDetail, NoteSummary, NoteTemplateId, NotesResult } from "@magic/contracts";
import { notes, useAction, useLoad, type Course } from "./bridge";
import { Empty, ErrorLine, Loaded, Partial, PreviewSection, formatWhen } from "./ui";

/** The ok variant answering `Op` (several ops share one variant, so its `op` is a union). */
type Ok<Op, R = Extract<NotesResult, { status: "ok" }>> = R extends { op: infer O } ? (Op extends O ? R : never) : never;
/** The service's own answer: its `ok` body, or its status and message as a partial state. */
async function ask<Op extends NotesResult["op"]>(request: Parameters<typeof notes>[0] & { op: Op }): Promise<Ok<Op> | { failed: string; message: string }> {
  const result = await notes(request);
  return result.status === "ok" ? (result as Ok<Op>) : { failed: result.status, message: "message" in result ? result.message : "Notes could not answer." };
}
const failed = (value: object): value is { failed: string; message: string } => "failed" in value;

const syncLabels: Record<NoteSummary["sync"], string> = { local: "On this device", synced: "Synced", pending: "Sync pending", conflict: "Sync conflict" };

function firstLine(text: string) {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}

export function NotesPreview({ course }: { course: Course }) {
  const [open, setOpen] = useState<NoteDetail | null>(null);
  const [notice, setNotice] = useState<{ status: string; message: string } | null>(null);
  const action = useAction();
  const courseKey = `${course.accountScope}:${course.courseId}`;
  const [recent, reloadRecent] = useLoad(`notes-recent:${courseKey}`, () => ask({ op: "notes.recent", courseId: course.courseId, limit: 5 }));
  const [tree, reloadTree] = useLoad(`notes-tree:${courseKey}`, () => ask({ op: "notes.tree", courseId: course.courseId, accountScope: course.accountScope }));
  const [templates] = useLoad("notes-templates", () => ask({ op: "notes.templates" }));
  const [sync, reloadSync] = useLoad("notes-sync", () => ask({ op: "notes.sync.status" }));
  const [local, reloadLocal] = useLoad("notes-local", () => ask({ op: "notes.localFolders.status" }));
  const chooseFolder = async (folder: string | null) => {
    setNotice(null);
    const got = await action.run(() => ask({ op: "notes.localFolders.choose", folder }));
    if (!got) return;
    if (failed(got)) return setNotice({ status: got.failed, message: got.message });
    reloadLocal();
  };

  const show = async (request: { sessionId: string } | { noteId: string }) => {
    setNotice(null);
    const got = await action.run(() => ask({ op: "notes.open", ...request }));
    if (!got) return;
    if (failed(got)) return setNotice({ status: got.failed, message: got.message });
    setOpen(got.note);
    reloadRecent();
  };
  const setTemplate = async (template: NoteTemplateId) => {
    if (!open) return;
    const got = await action.run(() => ask({ op: "notes.setTemplate", noteId: open.id, template }));
    if (!got) return;
    if (failed(got)) return setNotice({ status: got.failed, message: got.message });
    setOpen(got.note);
  };
  const fill = async () => {
    if (!open) return;
    setNotice(null);
    const got = await action.run(() => ask({ op: "notes.fill", noteId: open.id }));
    if (!got) return;
    if (failed(got)) return setNotice({ status: got.failed, message: got.message });
    setOpen(got.note);
    setNotice({
      status: "done",
      message: `${got.suggestions.length} suggestions from the slides${got.cached ? " (cached, 0 tokens)" : ` · ${got.tokens.in + got.tokens.out} tokens`}${got.dropped ? ` · ${got.dropped} dropped by quote checks` : ""}.`,
    });
  };

  return (
    <PreviewSection
      title="Notes"
      op="notes.recent · notes.tree · notes.open · notes.templates · notes.setTemplate · notes.fill · notes.sync.status · notes.localFolders.status"
      actions={
        <button
          className="button small-button"
          onClick={() => {
            reloadRecent();
            reloadTree();
            reloadSync();
            reloadLocal();
          }}
        >
          Reload
        </button>
      }
    >
      <h3>Recent notes</h3>
      <Loaded load={recent} retry={reloadRecent}>
        {(got) =>
          failed(got) ? (
            <Partial status={got.failed}>{got.message}</Partial>
          ) : got.notes.length === 0 ? (
            <Empty>No notes for this course yet. A scaffold is made for each class session once the schedule lists it.</Empty>
          ) : (
            <ul className="backend-list">
              {got.notes.map((n) => (
                <li key={n.id}>
                  <div className="backend-row">
                    <button className="subtle-button" onClick={() => void show({ noteId: n.id })}>
                      <strong>{n.title}</strong>
                    </button>
                    <span className="inline-actions">
                      <span className="badge">{n.state === "untouched" ? "Untouched" : "Edited"}</span>
                      <span className="badge">{syncLabels[n.sync]}</span>
                    </span>
                  </div>
                  <div className="backend-meta">
                    {n.date ? formatWhen(n.date, false) : "No session date"} · last edit {n.editedAt ? formatWhen(n.editedAt) : "never"}
                  </div>
                  {firstLine(n.preview) ? <div className="backend-meta">{firstLine(n.preview)}</div> : null}
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
      <h3>Class sessions</h3>
      <Loaded load={tree} retry={reloadTree}>
        {(got) => {
          if (failed(got)) return <Partial status={got.failed}>{got.message}</Partial>;
          const sessions = got.tree.modules.flatMap((m) => m.sessions.map((s) => ({ ...s, moduleName: m.moduleName })));
          return sessions.length === 0 ? (
            <Empty>No class sessions found for this course: they come from My UW enrollment, the course's session list or its calendar.</Empty>
          ) : (
            <ul className="backend-list">
              {sessions.slice(0, 12).map((s) => (
                <li key={s.session.id} className="backend-row">
                  <span>
                    {s.session.title} · {formatWhen(s.session.date, false)} · {s.session.type}
                    <span className="backend-meta"> ({s.session.typeBasis})</span>
                  </span>
                  <button className="button small-button" disabled={action.busy} onClick={() => void show({ sessionId: s.session.id })}>
                    {s.note ? "Open note" : "Open scaffold"}
                  </button>
                </li>
              ))}
            </ul>
          );
        }}
      </Loaded>
      {notice ? <Partial status={notice.status}>{notice.message}</Partial> : null}
      <ErrorLine text={action.error} />
      {open ? (
        <div className="backend-card">
          <div className="backend-row">
            <strong>{open.title}</strong>
            <button className="button small-button" onClick={() => setOpen(null)}>
              Close
            </button>
          </div>
          <div className="backend-meta">
            {open.state === "untouched" ? "Untouched scaffold" : "Edited"} · revision {open.revision} · {open.templateReason}
          </div>
          <div className="backend-controls">
            <label>
              Template
              <select value={open.template} disabled={action.busy} onChange={(event) => void setTemplate(event.target.value as NoteTemplateId)}>
                {templates.state === "ready" && !failed(templates.value) ? (
                  templates.value.templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))
                ) : (
                  <option value={open.template}>{open.template}</option>
                )}
              </select>
            </label>
            <button className="button small-button" disabled={action.busy} onClick={() => void fill()}>
              Fill from slides
            </button>
          </div>
          {open.remotes.length ? (
            <p className="small muted">
              {open.remotes.map((r) => `${r.provider === "microsoft" ? "Word" : "Google Docs"}: ${r.status}${r.error ? ` (${r.error})` : ""}`).join(" · ")}
            </p>
          ) : null}
          <div className="backend-note-blocks">
            {open.blocks.map((block) => (
              <div key={block.id}>
                <h4>{block.heading}</h4>
                {block.items.length ? (
                  block.items.map((item) => (
                    <p key={item.id} className="small">
                      {item.text}
                      {item.link ? ` (${item.link.title})` : ""}
                    </p>
                  ))
                ) : (
                  <p className="small muted">{block.hint ?? "Empty"}</p>
                )}
              </div>
            ))}
          </div>
          {open.suggestions.filter((s) => s.status === "pending").length ? (
            <p className="small muted">{open.suggestions.filter((s) => s.status === "pending").length} suggestions from the slides wait for review.</p>
          ) : null}
        </div>
      ) : null}
      <h3>Sync with Word and Google Docs</h3>
      <Loaded load={sync} retry={reloadSync}>
        {(got) =>
          failed(got) ? (
            <Partial status={got.failed}>{got.message}</Partial>
          ) : (
            <ul className="backend-list">
              {got.sync.providers.map((p) => (
                <li key={p.provider}>
                  <div className="backend-row">
                    <strong>{p.provider === "microsoft" ? "Word (OneDrive)" : "Google Docs"}</strong>
                    <span className="badge">{!p.connected ? "Not connected" : p.enabled ? "On" : "Off"}</span>
                  </div>
                  <div className="backend-meta">
                    {p.notes} notes · {p.conflicts} conflicts · {p.errors} errors · last check {p.lastCheckAt ? formatWhen(p.lastCheckAt) : "never"}
                    {p.message ? ` · ${p.message}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
      <h3>Save to a local folder</h3>
      <Loaded load={local} retry={reloadLocal}>
        {(got) =>
          failed(got) ? (
            <Partial status={got.failed}>{got.message}</Partial>
          ) : (
            <>
              {got.local.folder ? (
                <div className="backend-row">
                  <span>Saving edited notes to {got.local.folder}. Its own sync client uploads them from there.</span>
                  <button className="button small-button" disabled={action.busy} onClick={() => void chooseFolder(null)}>
                    Stop
                  </button>
                </div>
              ) : got.local.folders.length === 0 ? (
                <Empty>No OneDrive, Google Drive or iCloud folder was found on this device.</Empty>
              ) : (
                <ul className="backend-list">
                  {got.local.folders.map((f) => (
                    <li key={f.id} className="backend-row">
                      <span>{f.label}</span>
                      <button className="button small-button" disabled={action.busy} onClick={() => void chooseFolder(f.path)}>
                        Save notes to {f.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {got.local.lastError ? <Partial status="failed">{got.local.lastError}</Partial> : null}
            </>
          )
        }
      </Loaded>
    </PreviewSection>
  );
}

// owner: ui-wiring. Outlook / Microsoft 365 through the existing T30 bridge: outlookStatus,
// outlookConnect (only on click), the `mail.search` query per category (sender, subject, date,
// gist and link; never a body), captured meetings (`resources` in the Outlook calendar) and a
// calendar proposal that is written only after the student clicks to add it.
import { useState } from "react";
import type { CalendarProposal, MailCategory, OUTLOOK_CALENDAR_COURSE_ID as OutlookCalendarId, OutlookConnectionState, OutlookStatus } from "@magic/contracts";

/** The contracts constant, checked at compile time without bundling the contracts module (zod). */
const OUTLOOK_CALENDAR_COURSE_ID: typeof OutlookCalendarId = "outlook-calendar";
import { openExternal, query, useAction, useLoad } from "./bridge";
import { Empty, ErrorLine, Loaded, Partial, PreviewSection, formatWhen } from "./ui";

const stateLabels: Record<OutlookConnectionState, string> = {
  connected: "Connected",
  needs_uw_approval: "Needs UW approval",
  not_set_up: "Not set up in this build",
  not_connected: "Not connected",
  expired: "Sign-in expired",
  error: "Connection error",
};
const categories: [MailCategory, string][] = [
  ["course", "Course"],
  ["advisor", "Advisor"],
  ["org", "Clubs"],
  ["admin", "Offices"],
  ["meeting", "Meetings"],
];

export function OutlookPreview() {
  const b = window.magic;
  const available = Boolean(b?.outlookStatus);
  const [status, setStatus] = useState<OutlookStatus | null>(null);
  const [category, setCategory] = useState<MailCategory>("course");
  const [statusLoad, reloadStatus] = useLoad(available ? "outlook-status" : null, () => {
    setStatus(null);
    return b.outlookStatus!();
  });
  const [mail, reloadMail] = useLoad(`mail:${category}`, () => query({ view: "mail.search", category, limit: 10 }));
  const [meetings, reloadMeetings] = useLoad("outlook-meetings", () =>
    query({ view: "resources", courseId: OUTLOOK_CALENDAR_COURSE_ID, kinds: ["event"], limit: 50 }),
  );
  const connect = useAction();
  const open = useAction();
  const doConnect = async () => {
    const value = await connect.run(() => b.outlookConnect!());
    if (value) {
      setStatus(value);
      reloadMail();
      reloadMeetings();
    }
  };
  return (
    <PreviewSection
      title="Outlook and Microsoft 365"
      op="outlookStatus · outlookConnect · query mail.search · query resources (outlook-calendar) · calendarProposeEvent / calendarCreateEvent"
    >
      {!available ? (
        <Partial status="unavailable">Outlook is available in the desktop app.</Partial>
      ) : (
        <Loaded load={statusLoad} retry={reloadStatus}>
          {(loaded) => {
            // A Connect click answers with the new status; until then the read's answer stands.
            const s = status ?? loaded;
            return (
              <>
                <div className="backend-row">
                  <span>
                    <span className="badge">{stateLabels[s.outlook]}</span>{" "}
                    <span className="small muted">
                      {s.counts.messages} messages · {s.counts.events} calendar events · last sync {s.lastSyncAt ? formatWhen(s.lastSyncAt) : "never"}
                      {s.icsConnected ? " · published calendar link saved" : ""}
                    </span>
                  </span>
                  {s.outlook !== "connected" && s.outlook !== "not_set_up" ? (
                    <button className="button small-button" disabled={connect.busy} onClick={() => void doConnect()}>
                      {connect.busy ? "Connecting…" : "Connect"}
                    </button>
                  ) : null}
                </div>
                {s.outlook === "needs_uw_approval" ? (
                  <Partial status="needs UW approval">
                    UW has to approve this app for Microsoft 365 access
                    {s.approvalRequest === "sent" ? "; the request was sent." : s.approvalRequest === "not_sent" ? "; no request has been sent yet." : "."}
                    {s.reason ? ` (${s.reason})` : ""}
                  </Partial>
                ) : s.outlook === "not_set_up" ? (
                  <Partial status="not set up">This build has no Microsoft app registration, so Outlook can't connect. Saved mail and meetings still show below.</Partial>
                ) : s.reason && s.outlook !== "connected" ? (
                  <p className="small muted">Reason: {s.reason}</p>
                ) : null}
              </>
            );
          }}
        </Loaded>
      )}
      <ErrorLine text={connect.error} />
      <h3>Recent mail</h3>
      <div className="backend-tabs" role="tablist" aria-label="Mail category">
        {categories.map(([value, label]) => (
          <button key={value} role="tab" aria-selected={category === value} aria-current={category === value ? "page" : undefined} className="button small-button" onClick={() => setCategory(value)}>
            {label}
          </button>
        ))}
      </div>
      <Loaded load={mail} retry={reloadMail}>
        {(result) =>
          result.items.length === 0 ? (
            <Empty>No saved {categories.find(([v]) => v === category)?.[1].toLowerCase()} mail. Mail appears once Outlook is connected and synced.</Empty>
          ) : (
            <ul className="backend-list">
              {result.items.map((m) => (
                <li key={m.id}>
                  <div className="backend-row">
                    <strong>{m.subject}</strong>
                    <span className="small muted">{formatWhen(m.receivedAt)}</span>
                  </div>
                  <div className="backend-meta">
                    {m.fromName ?? "Unknown sender"}
                    {m.org ? ` · ${m.org}` : ""} · {m.categoryReason}
                  </div>
                  <div className="backend-meta">{m.gist ?? "No gist written yet."}</div>
                  <button className="subtle-button backend-meta" onClick={() => void open.run(() => openExternal(m.webLink))}>
                    Open in Outlook ↗
                  </button>
                </li>
              ))}
            </ul>
          )
        }
      </Loaded>
      <h3>Meetings captured</h3>
      <Loaded load={meetings} retry={reloadMeetings}>
        {(result) => {
          const rows = result.items.filter((r) => !r.deleted && r.calendar?.entryKind === "meeting");
          return rows.length === 0 ? (
            <Empty>No meetings captured from Outlook yet{result.items.length ? ` (${result.items.length} calendar entries saved, none are meetings)` : ""}.</Empty>
          ) : (
            <ul className="backend-list">
              {rows.map((r) => (
                <li key={r.id}>
                  <div className="backend-row">
                    <strong>{r.title}</strong>
                    <span className="small muted">{formatWhen(r.calendar!.start)}</span>
                  </div>
                  <div className="backend-meta">
                    {[r.calendar!.organizer, r.calendar!.location, r.calendar!.responseStatus].filter(Boolean).join(" · ") || "No details saved"}
                  </div>
                  {r.calendar!.joinUrl ? (
                    <button className="subtle-button backend-meta" onClick={() => void open.run(() => openExternal(r.calendar!.joinUrl!))}>
                      Join link ({r.calendar!.onlineMeeting ?? "online"}) ↗
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          );
        }}
      </Loaded>
      <ErrorLine text={open.error} />
      <ProposeEvent />
    </PreviewSection>
  );
}

/** A proposal is built by main on click; the event is written only on the second, explicit click. */
function ProposeEvent() {
  const b = window.magic;
  const [subject, setSubject] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [proposal, setProposal] = useState<CalendarProposal | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const action = useAction();
  if (!b?.calendarProposeEvent) return null;
  const review = async () => {
    setCreated(null);
    const value = await action.run(() =>
      b.calendarProposeEvent!({ subject, start: new Date(start).toISOString(), end: new Date(end).toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    );
    if (value) setProposal(value);
  };
  const add = async () => {
    if (!proposal) return;
    const value = await action.run(() => b.calendarCreateEvent!(proposal.proposalId));
    setProposal(null);
    if (value) setCreated(value.created ? "Added to your Outlook calendar." : "Not added: Microsoft didn't grant calendar write access.");
  };
  return (
    <>
      <h3>Add to calendar</h3>
      <p className="small muted">Nothing is written until you review the proposal and click Add.</p>
      <div className="backend-controls">
        <label>
          Title
          <input className="text-input" value={subject} maxLength={255} onChange={(event) => setSubject(event.target.value)} />
        </label>
        <label>
          Start
          <input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} />
        </label>
        <label>
          End
          <input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} />
        </label>
        <button className="button small-button" disabled={action.busy || !subject.trim() || !start || !end} onClick={() => void review()}>
          Review event
        </button>
      </div>
      {proposal ? (
        <div className="backend-card">
          <p className="small">
            {proposal.subject} · {formatWhen(proposal.start)} to {formatWhen(proposal.end)} · proposal expires {formatWhen(proposal.expiresAt)}
          </p>
          <div className="inline-actions">
            <button className="button small-button" disabled={action.busy} onClick={() => void add()}>
              Add to Outlook calendar
            </button>
            <button className="subtle-button" onClick={() => setProposal(null)}>
              Discard
            </button>
          </div>
        </div>
      ) : null}
      {created ? <p className="small">{created}</p> : null}
      <ErrorLine text={action.error} />
    </>
  );
}

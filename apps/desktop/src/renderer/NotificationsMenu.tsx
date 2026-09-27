import { useEffect, useId, useRef, useState } from "react";
import type {
  AppNotification,
  Command,
  NotificationFeed,
} from "@magic/contracts";
import "./notifications.css";

/**
 * Top-bar notifications: a bell with the unread count of urgent + important items and a
 * non-modal panel anchored under it. Levels, counts and freshness arrive computed in the
 * snapshot; this component only displays them and sends read/dismiss commands.
 */
export function NotificationsMenu({
  feed,
  busy,
  run,
  canOpenResource,
  onOpenResource,
  onOpenSources,
  onOpenPrivacy,
}: {
  feed: NotificationFeed | undefined;
  busy: boolean;
  run: (command: Command) => Promise<unknown>;
  /** Whether the item detail can show this resource (it may be filtered out or removed). */
  canOpenResource: (id: string) => boolean;
  onOpenResource: (id: string) => void;
  onOpenSources: () => void;
  onOpenPrivacy: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const headingId = useId();

  const items = feed?.items ?? [];
  const attention = items.filter((item) => item.level !== "info");
  const other = items.filter((item) => item.level === "info");
  const unreadIds = items.filter((item) => !item.read).map((item) => item.id);
  const unread = feed?.unread ?? 0;
  const badge = unread > 9 ? "9+" : String(unread);
  const bellName = !feed
    ? "Notifications, not available yet"
    : unread > 0
      ? `Notifications, ${unread} need${unread === 1 ? "s" : ""} attention`
      : "Notifications";

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) bellRef.current?.focus();
  };

  // Clicking anywhere outside closes the panel without moving focus.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  // A dismissal or "Mark all read" disables or removes the focused control. Once the command
  // settles, put focus back on the same row (if it failed), the next row, or the panel.
  const restore = useRef<{ id: string; next: string | null } | "panel" | null>(null);
  useEffect(() => {
    if (!open || busy || !restore.current) return;
    const pending = restore.current;
    restore.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && rootRef.current?.contains(active)) return;
    const id =
      pending === "panel"
        ? null
        : items.some((item) => item.id === pending.id)
          ? pending.id
          : pending.next;
    const target = id
      ? panelRef.current?.querySelector<HTMLElement>(
          `[data-notification="${CSS.escape(id)}"]`,
        )
      : null;
    (target ?? panelRef.current)?.focus();
  });

  const markRead = (ids: string[]) => {
    if (ids.length) void run({ type: "notifications-read", ids: ids.slice(0, 500) });
  };

  const destination = (item: AppNotification): "resource" | "sources" | null => {
    if (item.reason === "sign_in" || item.reason === "source_stale") return "sources";
    if (item.resourceId && canOpenResource(item.resourceId)) return "resource";
    return null;
  };

  const activate = (item: AppNotification) => {
    if (!item.read) markRead([item.id]);
    const target = destination(item);
    if (target === "resource" && item.resourceId) onOpenResource(item.resourceId);
    else if (target === "sources") onOpenSources();
    // The panel hides; return focus to the bell rather than dropping it on the page.
    if (target) close(true);
  };

  const dismiss = (item: AppNotification, visible: AppNotification[]) => {
    const index = visible.findIndex((entry) => entry.id === item.id);
    const next = visible[index + 1] ?? visible[index - 1];
    restore.current = { id: item.id, next: next?.id ?? null };
    void run({ type: "notification-dismiss", id: item.id });
  };

  const go = (action: () => void) => {
    action();
    close(true);
  };

  const renderRows = (list: AppNotification[]) => (
    <ul className="notif-list">
      {list.map((item) => (
        <NotificationRow
          key={item.id}
          item={item}
          busy={busy}
          opens={destination(item)}
          onActivate={() => activate(item)}
          onDismiss={() => dismiss(item, [...attention, ...other])}
        />
      ))}
    </ul>
  );

  return (
    <div
      className="notif"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          close(true);
        }
      }}
      onBlur={(event) => {
        // Focus moving to another element outside closes the panel. A null target means the
        // window lost focus or the focused row was removed; outside clicks cover the rest.
        const next = event.relatedTarget as Node | null;
        if (open && next && !rootRef.current?.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={bellRef}
        type="button"
        className={`notif-bell ${open ? "open" : ""}`}
        aria-label={bellName}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <BellGlyph />
        {feed && unread > 0 ? (
          <span className="notif-badge" aria-hidden="true">
            {badge}
          </span>
        ) : null}
      </button>
      <div
        ref={panelRef}
        id={panelId}
        className="notif-panel"
        role="dialog"
        aria-labelledby={headingId}
        tabIndex={-1}
        hidden={!open}
      >
        <div className="notif-header">
          <h2 id={headingId}>Notifications</h2>
          {feed ? (
            <button
              type="button"
              className="subtle-button"
              disabled={busy || unreadIds.length === 0}
              onClick={() => {
                restore.current = "panel";
                markRead(unreadIds);
              }}
            >
              Mark all read
            </button>
          ) : null}
        </div>
        {!feed ? (
          <p className="notif-empty">Notifications aren’t available yet.</p>
        ) : items.length === 0 ? (
          <p className="notif-empty">
            {feed.degraded
              ? "Can’t confirm you’re up to date."
              : "Nothing new since your last look."}
          </p>
        ) : (
          <>
            <section className="notif-section" aria-label="Needs attention">
              <h3>Needs attention</h3>
              {attention.length ? (
                renderRows(attention)
              ) : (
                <p className="notif-none">
                  {feed.degraded
                    ? "Nothing needs attention in the sources that could be checked."
                    : "Nothing needs attention."}
                </p>
              )}
            </section>
            {other.length ? (
              <details className="notif-section notif-other">
                <summary>
                  Other updates <span className="notif-count">{other.length}</span>
                </summary>
                {renderRows(other)}
              </details>
            ) : null}
          </>
        )}
        {feed ? (
          <div className="notif-footer">
            {feed.degraded ? (
              <div className="notif-warning">
                <p>Some sources haven’t updated — updates may be missing.</p>
                <button
                  type="button"
                  className="subtle-button"
                  onClick={() => go(onOpenSources)}
                >
                  Check sources
                </button>
              </div>
            ) : (
              <p className="notif-checked">
                {feed.checkedAt
                  ? `Checked ${relativeTime(feed.checkedAt).toLowerCase()}`
                  : "Not checked yet"}
              </p>
            )}
            {feed.triage.status !== "on" ? (
              <div className="notif-triage">
                <p>
                  Announcement sorting by Jev{" "}
                  {feed.triage.status === "off" ? "is off" : "isn’t available"}.
                  {feed.triage.reason ? ` ${feed.triage.reason}` : ""}
                </p>
                <button
                  type="button"
                  className="subtle-button"
                  onClick={() => go(onOpenPrivacy)}
                >
                  Data & AI
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function NotificationRow({
  item,
  busy,
  opens,
  onActivate,
  onDismiss,
}: {
  item: AppNotification;
  busy: boolean;
  opens: "resource" | "sources" | null;
  onActivate: () => void;
  onDismiss: () => void;
}) {
  const evidence = item.evidence ?? {};
  // Core's detail already states a change in words ("Tue 11:59 PM → Mon 6:24 AM"); evidence
  // before/after holds exact instants, shown only when there is no detail to say it.
  const before = item.detail ? undefined : readable(evidence.before);
  const after = item.detail ? undefined : readable(evidence.after);
  const quote =
    evidence.quote && evidence.quote.trim() !== item.title.trim()
      ? evidence.quote
      : undefined;
  // Email rows name the sender; the code's category reason is available on hover and to
  // assistive technology through the row's description.
  const meta = (
    item.reason === "email"
      ? [
          item.from ? `From ${item.from}` : null,
          // The role label may already name the course ("Course staff · CS 220").
          item.courseName && item.courseName !== "Outlook mail"
            ? item.detail?.includes(item.courseName)
              ? null
              : item.courseName
            : "Email",
          relativeTime(item.observedAt),
        ]
      : [item.courseName, relativeTime(item.observedAt)]
  )
    .filter(Boolean)
    .join(" · ");
  const affects = item.raisedBy?.affects.filter(Boolean) ?? [];
  return (
    <li className={`notif-row ${item.read ? "read" : "unread"}`}>
      <button
        type="button"
        className="notif-open"
        data-notification={item.id}
        onClick={onActivate}
      >
        <span className="notif-title-line">
          {item.read ? null : (
            <span className="notif-dot">
              <span className="notif-hidden">Unread. </span>
            </span>
          )}
          {item.level === "urgent" ? (
            <span className="notif-chip">Urgent</span>
          ) : null}
          <span className="notif-title">{item.title}</span>
          {item.count && item.count > 1 ? (
            <span className="notif-count">{item.count} items</span>
          ) : null}
        </span>
        {item.detail ? <span className="notif-detail">{item.detail}</span> : null}
        {before || after ? (
          <span className="notif-detail notif-change">
            {before && after ? (
              <>
                <span className="notif-hidden">Changed from </span>
                <span className="notif-before">{before}</span>
                <span aria-hidden="true"> → </span>
                <span className="notif-hidden"> to </span>
                <span>{after}</span>
              </>
            ) : before ? (
              `Was ${before}`
            ) : (
              `Now ${after}`
            )}
          </span>
        ) : null}
        {quote ? <span className="notif-quote">“{quote}”</span> : null}
        {item.raisedBy ? (
          <span
            className="notif-jev"
            title={`Jev (${item.raisedBy.model}) raised this from ${levelLabel(item.raisedBy.from)}. This is a model’s judgment; check the message.`}
          >
            Flagged by Jev
            {affects.length ? ` · May affect ${affects.join(", ")}` : ""}
          </span>
        ) : null}
        {meta ? (
          <span
            className="notif-meta"
            title={item.senderReason ? `Sorted by code: ${item.senderReason}` : undefined}
          >
            {meta}
          </span>
        ) : null}
        {opens === "sources" ? (
          <span className="notif-hidden">. Opens Sources.</span>
        ) : null}
      </button>
      <button
        type="button"
        className="notif-dismiss"
        aria-label={`Dismiss ${item.title}`}
        disabled={busy}
        onClick={onDismiss}
      >
        <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
          <path
            d="m5 5 10 10M15 5 5 15"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </li>
  );
}

function levelLabel(level: AppNotification["level"]): string {
  return level === "info" ? "other updates" : level;
}

/** "Just now", "12 min ago", "3 hr ago", "Yesterday", weekday within a week, else a date. */
export /** An ISO instant as local text; any other evidence value is shown as given. */
function readable(value?: string) {
  if (!value) return value;
  const ms = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(ms)) return value;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}
function relativeTime(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  const seconds = (now.getTime() - date.getTime()) / 1000;
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (date >= startOfToday) return `${Math.floor(seconds / 3600)} hr ago`;
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (date >= startOfYesterday) return "Yesterday";
  if (seconds < 6 * 86400)
    return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  }).format(date);
}

function BellGlyph() {
  // Lucide "bell", drawn on its 24px grid at the app's 18px icon size.
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.268 21a2 2 0 0 0 3.464 0" />
      <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
    </svg>
  );
}

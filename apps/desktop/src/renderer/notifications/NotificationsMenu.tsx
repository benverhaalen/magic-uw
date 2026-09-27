import { MagicGlyph } from '../../../../../packages/ui/src/glyph';
import { useEffect, useId, useRef, useState } from "react";
import type { AppNotification, Command, NotificationFeed } from "@magic/contracts";
import { markAnchor } from "../../../../../packages/ui/src/motion";
import { destinationLabel, type NotificationDestination } from "./destination";

/**
 * Shell bell: unread count of urgent + important items and a nonmodal panel anchored under it
 * (native popover, like NavigationPopover). Levels, counts and freshness arrive computed in the
 * snapshot; this component displays them, sends read/dismiss commands and hands each row's
 * destination to the app, which owns routing and destination focus.
 */
export function NotificationsMenu({
  feed,
  busy,
  run,
  destinationOf,
  onOpen,
  onOpenSources,
  onOpenPrivacy,
}: {
  feed: NotificationFeed | undefined;
  busy: boolean;
  run: (command: Command) => Promise<unknown>;
  destinationOf: (item: AppNotification) => NotificationDestination | null;
  onOpen: (destination: NotificationDestination) => void;
  onOpenSources: () => void;
  onOpenPrivacy: () => void;
}) {
  const [open, setOpen] = useState(false);
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

  useEffect(() => {
    const panel = panelRef.current!;
    const update = () => setOpen(panel.matches(":popover-open"));
    panel.addEventListener("toggle", update);
    return () => panel.removeEventListener("toggle", update);
  }, []);

  // Right-aligned under the bell, kept inside the window.
  function place() {
    const panel = panelRef.current!, rect = bellRef.current!.getBoundingClientRect();
    const width = Math.min(380, innerWidth - 24);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(12, Math.min(rect.right - width + 6, innerWidth - width - 12))}px`;
    panel.style.top = `${rect.bottom + 8}px`;
    panel.style.maxHeight = `${Math.max(160, innerHeight - rect.bottom - 20)}px`;
    markAnchor(panel, bellRef.current!);
  }
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  const hide = (returnFocus: boolean) => {
    if (panelRef.current?.matches(":popover-open")) panelRef.current.hidePopover();
    if (returnFocus) bellRef.current?.focus();
  };

  // A dismissal or "Mark all read" disables or removes the focused control. Once the command
  // settles, put focus back on the same row (if it failed), the next row, or the panel.
  const restore = useRef<{ id: string; next: string | null } | "panel" | null>(null);
  useEffect(() => {
    if (!open || busy || !restore.current) return;
    const pending = restore.current;
    restore.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && panelRef.current?.contains(active)) return;
    const id =
      pending === "panel"
        ? null
        : items.some((item) => item.id === pending.id)
          ? pending.id
          : pending.next;
    const target = id
      ? panelRef.current?.querySelector<HTMLElement>(`[data-notification="${CSS.escape(id)}"]`)
      : null;
    (target ?? panelRef.current)?.focus();
  });

  const markRead = (ids: string[]) => {
    if (ids.length) void run({ type: "notifications-read", ids: ids.slice(0, 500) });
  };

  const activate = (item: AppNotification, destination: NotificationDestination | null) => {
    if (!item.read) markRead([item.id]);
    if (!destination) return;
    // In-app destinations take focus themselves (their heading, or the saved place on Back).
    // Outlook opens outside the app, so focus returns to the bell.
    hide(destination.kind === "outlook");
    onOpen(destination);
  };

  const dismiss = (item: AppNotification) => {
    const visible = [...attention, ...other];
    const index = visible.findIndex((entry) => entry.id === item.id);
    const next = visible[index + 1] ?? visible[index - 1];
    restore.current = { id: item.id, next: next?.id ?? null };
    void run({ type: "notification-dismiss", id: item.id });
  };

  const go = (action: () => void) => {
    hide(false);
    action();
  };

  const renderRows = (list: AppNotification[]) => (
    <ul className="notif-list">
      {list.map((item) => {
        const destination = destinationOf(item);
        return (
          <NotificationRow
            key={item.id}
            item={item}
            busy={busy}
            destination={destination}
            onActivate={() => activate(item, destination)}
            onDismiss={() => dismiss(item)}
          />
        );
      })}
    </ul>
  );

  return (
    <div className="notif">
      <button
        ref={bellRef}
        type="button"
        className="notif-bell"
        aria-label={bellName}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        popoverTarget={panelId}
        onClick={(event) => {
          // The bell is the declared invoker, so light dismiss ignores it; toggle here instead.
          event.preventDefault();
          const panel = panelRef.current!;
          if (panel.matches(":popover-open")) panel.hidePopover();
          else {
            panel.showPopover();
            place();
            panel.focus();
          }
        }}
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
        popover="auto"
        data-magic-motion="anchored"
        className="notif-panel"
        role="dialog"
        aria-labelledby={headingId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            hide(true);
          }
        }}
        onBlur={(event) => {
          // Focus moving elsewhere closes the panel; the bell toggles it itself. A null target
          // means the window lost focus or the focused row was removed, so the panel stays.
          const next = event.relatedTarget as Node | null;
          if (next && !event.currentTarget.contains(next) && next !== bellRef.current) hide(false);
        }}
      >
        <div className="notif-header">
          <h2 id={headingId}>Notifications</h2>
          {feed ? (
            <button
              type="button"
              className="notif-quiet"
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
            {feed.degraded ? "Can’t confirm you’re up to date." : "Nothing new since your last look."}
          </p>
        ) : (
          <>
            <section className="notif-section" aria-labelledby={`${headingId}-attention`}>
              <h3 id={`${headingId}-attention`}>Needs attention</h3>
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
                  <ChevronGlyph />
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
              <div className="notif-note notif-note--attention">
                <p>Some sources haven’t updated, so updates may be missing.</p>
                <button type="button" className="notif-quiet" onClick={() => go(onOpenSources)}>
                  Check sources
                </button>
              </div>
            ) : (
              <p className="notif-checked">
                {feed.checkedAt
                  ? `Checked ${relativeTime(feed.checkedAt).toLowerCase()}. Checks run while the app is open.`
                  : "Not checked yet"}
              </p>
            )}
            {feed.triage.status !== "on" ? (
              <div className="notif-note">
                <p>
                  Announcement and email sorting by Jev{" "}
                  {feed.triage.status === "off" ? "is off" : "isn’t available"}. Code rules
                  still sort everything.{feed.triage.reason ? ` ${feed.triage.reason}` : ""}
                </p>
                <button type="button" className="notif-quiet" onClick={() => go(onOpenPrivacy)}>
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
  destination,
  onActivate,
  onDismiss,
}: {
  item: AppNotification;
  busy: boolean;
  destination: NotificationDestination | null;
  onActivate: () => void;
  onDismiss: () => void;
}) {
  const evidence = item.evidence ?? {};
  // Core's detail already states a change in words ("Tue 11:59 PM → Mon 6:24 AM"); evidence
  // before/after holds exact instants, shown only when there is no detail to say it.
  const before = item.detail ? undefined : readable(evidence.before);
  const after = item.detail ? undefined : readable(evidence.after);
  const quote =
    evidence.quote && evidence.quote.trim() !== item.title.trim() ? evidence.quote : undefined;
  // Email rows name the sender; the code's category reason is available on hover.
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
  const hint = destinationLabel(destination);
  return (
    <li className={`notif-row ${item.read ? "read" : "unread"}`}>
      <button
        type="button"
        className="notif-open"
        data-notification={item.id}
        data-destination={destination?.kind ?? "none"}
        onClick={onActivate}
      >
        <span className="notif-title-line">
          {item.read ? null : (
            <span className="notif-dot">
              <span className="notif-hidden">Unread. </span>
            </span>
          )}
          {item.level === "urgent" ? <span className="notif-tag notif-tag--urgent">Urgent</span> : null}
          <span className="notif-title">{item.title}</span>
          {item.count && item.count > 1 ? <span className="notif-count">{item.count} items</span> : null}
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
            className="notif-tag notif-tag--jev"
            title={`Jev (${item.raisedBy.model}) raised this from ${levelLabel(item.raisedBy.from)}. This is a model’s judgment; check the message.`}
          >
            Flagged by Jev{affects.length ? ` · May affect ${affects.join(", ")}` : ""}
          </span>
        ) : null}
        {meta || hint ? (
          <span className="notif-meta">
            <span title={item.senderReason ? `Sorted by code: ${item.senderReason}` : undefined}>{meta}</span>
            {hint ? (
              <span className="notif-hint">
                <span className="notif-hidden">. </span>
                {hint}
                {destination?.kind === "outlook" ? <ExternalGlyph /> : null}
              </span>
            ) : null}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className="notif-dismiss"
        aria-label={`Dismiss ${item.title}`}
        disabled={busy}
        onClick={onDismiss}
      >
        <MagicGlyph name="close" size={14} />
      </button>
    </li>
  );
}

function levelLabel(level: AppNotification["level"]): string {
  return level === "info" ? "other updates" : level;
}

/** An ISO instant as local text; any other evidence value is shown as given. */
export function readable(value?: string) {
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

/** "Just now", "12 min ago", "3 hr ago", "Yesterday", weekday within a week, else a date. */
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
  if (seconds < 6 * 86400) return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  }).format(date);
}

function BellGlyph() { return <MagicGlyph name="bell" size={16} />; }
function ChevronGlyph() { return <MagicGlyph name="chevron" size={14} className="notif-chevron" />; }
function ExternalGlyph() { return <MagicGlyph name="external" size={12} />; }

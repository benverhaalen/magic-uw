import { useEffect, useId, useState, type ReactNode } from "react";
import type { ClientHealth } from "@magic/contracts";
import { healthCopy, type NoticeAction } from "./health-copy";
import { Icon, Spinner } from "./icons";

/**
 * owner: client-health (D50). One notice for a client's health: the state, the plain cause and
 * the exact next step, with the actions that step needs. "Quick chat" opens the client in the
 * built-in terminal, started in the student's chosen mode, so they can check their own account.
 * Styles live in client-health.css (imported by the screens that use this component).
 */
export interface ClientHealthNoticeProps {
  health: ClientHealth;
  /** Opens a `chat` terminal session for this client; resolves with its session id. */
  onQuickChat?: () => Promise<string>;
  onCloseChat?: (sessionId: string) => void;
  /** Renders the built-in terminal for a session (TerminalPane in the app). */
  renderTerminal?: (sessionId: string) => ReactNode;
  onCheckAgain?: () => void;
  onSwitch?: () => void;
  onUseProfile?: () => void;
  onAddKey?: () => void;
  openExternal?: (url: string) => void;
  checking?: boolean;
  /** Compact: the ok state as one line (the client tiles). */
  compact?: boolean;
}

/**
 * owner: client-detection. What detection saw, so a student can tell us: the folders searched,
 * where the client was found, its version and the version the app was tested with, and any
 * missing option. Names only.
 */
function Diagnostics({ health }: { health: ClientHealth }) {
  const d = health.diagnostics;
  const missing = health.instant.missingFlags;
  if (!d && !missing?.length) return null;
  return (
    <details className="chn-details">
      <summary>{health.state === "not_installed" ? "Why wasn't my client found?" : "What My Magic UW found"}</summary>
      <dl className="chn-details-list">
        <div>
          <dt>Found</dt>
          <dd>{d?.found ?? "Not in any folder below"}</dd>
        </div>
        {health.version ? (
          <div>
            <dt>Version</dt>
            <dd>
              {health.version}
              {health.instant.testedWith ? ` (tested with ${health.instant.testedWith})` : ""}
            </dd>
          </div>
        ) : null}
        {missing?.length ? (
          <div>
            <dt>Missing options</dt>
            <dd>{missing.join(", ")}</dd>
          </div>
        ) : null}
        {d?.searched.length ? (
          <div>
            <dt>Folders searched</dt>
            <dd>
              <ul className="chn-details-dirs">
                {d.searched.map((dir) => (
                  <li key={dir}>{dir}</li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
      </dl>
    </details>
  );
}

/** The next step with its command, if any, shown as code (a real command, not decoration). */
function nextStep(text: string, command?: string): ReactNode {
  if (!command || !text.includes("{command}")) return text;
  const [before, after] = text.split("{command}");
  return (
    <>
      {before}
      <code className="chn-command">{command}</code>
      {after}
    </>
  );
}

export function ClientHealthNotice(props: ClientHealthNoticeProps) {
  const { health } = props;
  const copy = healthCopy(health, { chat: !!props.onQuickChat });
  const titleId = useId();
  const [chat, setChat] = useState<string | null>(null);
  const [chatProblem, setChatProblem] = useState("");
  const [opening, setOpening] = useState(false);
  useEffect(
    () => () => {
      if (chat) props.onCloseChat?.(chat);
    },
    // Close the session when the notice goes away or the client changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chat, health.id],
  );

  if (props.compact && copy.tone === "ok")
    return (
      <p className="chn-line" role="status">
        <Icon name="check" className="onb-ok" />
        <span>{copy.cause}</span>
      </p>
    );

  const openChat = async () => {
    if (!props.onQuickChat) return;
    setOpening(true);
    setChatProblem("");
    try {
      setChat(await props.onQuickChat());
    } catch {
      setChatProblem("Quick chat couldn't start. Check that the client opens in your own terminal.");
    } finally {
      setOpening(false);
    }
  };
  const button = (action: NoticeAction, index: number) => {
    const primary = index === 0;
    const cls = primary ? "chn-action primary" : "chn-action";
    switch (action.kind) {
      case "quick_chat":
        return props.onQuickChat ? (
          <button key="chat" className={cls} disabled={opening || !!chat} onClick={() => void openChat()}>
            <Icon name="terminal" />
            Quick chat
          </button>
        ) : null;
      case "check_again":
        return props.onCheckAgain ? (
          <button key="check" className={cls} disabled={props.checking} onClick={props.onCheckAgain}>
            {props.checking ? <Spinner /> : <Icon name="refresh" />}
            Check again
          </button>
        ) : null;
      case "switch":
        return props.onSwitch ? (
          <button key="switch" className={cls} onClick={props.onSwitch}>
            Choose another AI
          </button>
        ) : null;
      case "use_profile":
        return props.onUseProfile ? (
          <button key="profile" className={cls} onClick={props.onUseProfile}>
            {action.label ?? "Sign in here"}
          </button>
        ) : null;
      case "add_key":
        return props.onAddKey ? (
          <button key="key" className={cls} onClick={props.onAddKey}>
            Paste an API key
          </button>
        ) : null;
      case "link":
        return props.openExternal ? (
          <button
            key={action.url}
            className={`${cls} link`}
            onClick={() => props.openExternal?.(action.url)}
            aria-label={`${action.label} (opens in your browser)`}
          >
            {action.label}
            <Icon name="external" />
          </button>
        ) : null;
    }
  };
  const actions = copy.actions.map(button).filter(Boolean);
  return (
    <section
      className={`chn chn-${copy.tone}`}
      role={copy.tone === "problem" ? "alert" : "status"}
      aria-labelledby={titleId}
      data-health-state={health.state}
    >
      <div className="chn-head">
        <Icon name={copy.tone === "ok" ? "check" : copy.tone === "wait" ? "clock" : "alert"} className="chn-mark" />
        <h2 className="chn-title" id={titleId}>
          {copy.title}
        </h2>
      </div>
      <p className="chn-cause">{copy.cause}</p>
      {copy.tone !== "ok" ? <p className="chn-next">{nextStep(copy.next, copy.command)}</p> : null}
      {actions.length ? <div className="chn-actions">{actions}</div> : null}
      {chatProblem ? <p className="chn-error-text">{chatProblem}</p> : null}
      {copy.tone !== "ok" ? <Diagnostics health={health} /> : null}
      {chat ? (
        <div className="chn-chat">
          <div className="chn-chat-bar">
            <span>Quick chat. Nothing from your courses is sent here.</span>
            <button
              className="chn-action"
              onClick={() => {
                props.onCloseChat?.(chat);
                setChat(null);
              }}
            >
              Close chat
            </button>
          </div>
          <div className="chn-chat-terminal">
            {props.renderTerminal ? props.renderTerminal(chat) : <p className="chn-cause">The terminal appears here in the desktop app.</p>}
          </div>
        </div>
      ) : null}
    </section>
  );
}

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/**
 * T80: one hosted client session (sign-in or interactive) bound to the main-process PTY.
 * Unstyled beyond xterm's own sheet; the onboarding screen sizes and styles the container.
 * Keystrokes go to the session only; the command and its arguments were fixed by main.
 */
export function TerminalPane({ sessionId }: { sessionId: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bridge = window.magic?.clients?.terminal;
    const element = host.current;
    if (!bridge || !element) return;
    const term = new Terminal({ convertEol: false, cursorBlink: true, scrollback: 2000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    const resize = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      bridge.resize(sessionId, term.cols, term.rows);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    const input = term.onData((data) => bridge.write(sessionId, data));
    const offData = bridge.onData((id, chunk) => {
      if (id === sessionId) term.write(chunk);
    });
    const offExit = bridge.onExit((id) => {
      if (id === sessionId) term.options.disableStdin = true;
    });
    term.focus();
    return () => {
      offData();
      offExit();
      input.dispose();
      observer.disconnect();
      term.dispose();
    };
  }, [sessionId]);
  return <div ref={host} data-terminal-session={sessionId} style={{ width: "100%", height: "100%" }} />;
}

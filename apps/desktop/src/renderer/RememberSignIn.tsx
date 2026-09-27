// owner: T05e. The "Forget my sign-in" row (plan D39). Main owns the saved sign-in; only its
// status crosses the bridge, never the NetID or password. Hidden where the bridge has no
// rememberSignIn (the browser preview) and in a build with the feature switched off.
import { useEffect, useState } from "react";
import type { AppBridge, RememberSignInStatus } from "@magic/contracts";

export const rememberCopy = {
  label: "Remember my sign-in",
  saved:
    "Your NetID sign-in is saved encrypted on this computer only and never sent anywhere. When UW asks you to sign in again while you're here, My Magic UW fills it in on UW's own sign-in page; Duo is still yours to approve.",
  notSaved:
    "Off. To turn it on, tick “Remember my sign-in on this computer” on UW's sign-in page.",
  forget: "Forget my sign-in",
  forgotten: "Your saved sign-in was deleted from this computer.",
} as const;

export function RememberSignInView({
  status,
  busy,
  message,
  onForget,
}: {
  status: RememberSignInStatus | null;
  busy: boolean;
  message?: string;
  onForget: () => void;
}) {
  if (!status || !status.offered) return null;
  const description = status.saved
    ? rememberCopy.saved
    : !status.available
      ? (status.reason ?? rememberCopy.notSaved)
      : rememberCopy.notSaved;
  return (
    <div
      className={`setting-toggle ${status.saved ? "" : "disabled-setting"}`}
      data-remember-signin={status.saved ? "saved" : status.available ? "off" : "unavailable"}
    >
      <span>
        <strong>{rememberCopy.label}</strong>
        <span>{message ?? description}</span>
      </span>
      {status.saved ? (
        <button className="subtle-button" disabled={busy} onClick={onForget}>
          {rememberCopy.forget}
        </button>
      ) : null}
    </div>
  );
}

export function RememberSignIn({
  busy,
  bridge = window.magic,
}: {
  busy: boolean;
  bridge?: Pick<AppBridge, "rememberSignIn">;
}) {
  const [status, setStatus] = useState<RememberSignInStatus | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  useEffect(() => {
    let live = true;
    bridge.rememberSignIn?.("status")
      .then((current) => {
        if (live) setStatus(current);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [bridge]);
  if (!bridge.rememberSignIn) return null;
  return (
    <RememberSignInView
      status={status}
      busy={busy || working}
      message={message}
      onForget={() => {
        setWorking(true);
        bridge.rememberSignIn!("forget")
          .then((next) => {
            setStatus(next);
            setMessage(rememberCopy.forgotten);
          })
          .catch(() => {})
          .finally(() => setWorking(false));
      }}
    />
  );
}
// end owner: T05e

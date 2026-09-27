// owner: accounts. The My Magic UW account on the Data & AI page: sign in with an emailed code,
// see this account's $5-a-month subscription, subscribe or manage it on the website, sign out.
// Status only: nothing in the app is locked by it yet. See docs/accounts-and-payments.md.
import { useCallback, useEffect, useState } from "react";
import type { AccountStatus } from "@magic/contracts";

const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "long" }) : "");

function subscriptionText(status: Extract<AccountStatus, { state: "signed-in" }>): string {
  switch (status.subscription) {
    case "active":
      return status.until ? `Subscribed. Renews on ${day(status.until)}.` : "Subscribed. Thank you!";
    case "cancelling":
      return status.until ? `Cancelled. You have access until ${day(status.until)}.` : "Cancelled. Access continues to the end of the month.";
    case "past-due":
      return "Your last payment didn't go through. Update your card on the website.";
    case "paused":
      return "Your subscription is paused.";
    case "on-hold":
      return "Your subscription is on hold because payments didn't go through.";
    case "ended":
      return "Your subscription has ended.";
    case "not-subscribed":
      return "Not subscribed yet. $5 a month, cancel anytime.";
    case "test-only":
      return "Test subscription only. It doesn't count.";
    default:
      return "Couldn't confirm the subscription.";
  }
}

export function AccountSection() {
  const bridge = window.magic?.account;
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    if (!bridge) return;
    try {
      setStatus(await bridge.status());
    } catch {
      setMessage("Couldn't load your account. Try again in a moment.");
    }
  }, [bridge]);
  useEffect(() => void refresh(), [refresh]);

  if (!bridge || !status || status.state === "unconfigured") return null;

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await work();
    } catch {
      setMessage("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const send = () =>
    act(async () => {
      const result = await bridge.sendCode(email);
      if (result.sent) {
        setStep("code");
        setMessage(`We emailed a code to ${email.trim()}.`);
      } else
        setMessage(
          result.reason === "invalid"
            ? "Enter a full email address, like you@wisc.edu."
            : result.reason === "rate-limited"
              ? "Too many codes requested. Wait a minute and try again."
              : "Couldn't reach the account server. Check your connection and try again.",
        );
    });
  const verify = () =>
    act(async () => {
      const result = await bridge.verifyCode(email, code);
      if (result.signedIn) {
        setCode("");
        setStep("email");
        await refresh();
      } else
        setMessage(
          result.reason === "wrong-code"
            ? "That code didn't work or has expired. Check it, or send a new one."
            : result.reason === "invalid"
              ? "Enter the code from the email: numbers only."
              : "Couldn't reach the account server. Check your connection and try again.",
        );
    });

  return (
    <section className="settings-section">
      <h2>Account</h2>
      {status.state === "signed-out" ? (
        <>
          <p>
            Sign in with your My Magic UW account to see your subscription. Only your email is sent
            to the account server; no coursework is.
          </p>
          {step === "email" ? (
            <form
              className="inline-actions"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <label className="field-label" htmlFor="account-email">
                Email
              </label>
              <input
                id="account-email"
                type="email"
                autoComplete="email"
                value={email}
                disabled={busy}
                onChange={(event) => setEmail(event.target.value)}
              />
              <button className="button primary" type="submit" disabled={busy || !email.trim()}>
                Email me a code
              </button>
            </form>
          ) : (
            <form
              className="inline-actions"
              onSubmit={(event) => {
                event.preventDefault();
                void verify();
              }}
            >
              <label className="field-label" htmlFor="account-code">
                Code from the email
              </label>
              <input
                id="account-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                spellCheck={false}
                value={code}
                disabled={busy}
                onChange={(event) => setCode(event.target.value)}
              />
              <button className="button primary" type="submit" disabled={busy || !code.trim()}>
                Sign in
              </button>
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => {
                  setStep("email");
                  setCode("");
                  setMessage("");
                }}
              >
                Use a different email
              </button>
            </form>
          )}
        </>
      ) : (
        <>
          <p>
            Signed in as <strong>{status.email || "your account"}</strong>.
          </p>
          <p>
            <strong>{subscriptionText(status)}</strong>
            {status.offline && (
              <span className="small muted">
                {" "}
                Offline: showing the last confirmed status
                {status.checkedAt ? ` from ${new Date(status.checkedAt).toLocaleDateString()}` : ""}.
              </span>
            )}
          </p>
          <div className="inline-actions">
            <button
              className={status.entitled ? "button" : "button primary"}
              disabled={busy}
              onClick={() => void act(() => bridge.buy())}
            >
              {status.entitled || status.subscription === "paused" || status.subscription === "on-hold"
                ? "Manage on the website"
                : "Subscribe on the website"}
            </button>
            <button className="button" disabled={busy} onClick={() => void act(refresh)}>
              Check again
            </button>
            <button
              className="subtle-button"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await bridge.signOut();
                  await refresh();
                })
              }
            >
              Sign out
            </button>
          </div>
        </>
      )}
      {message && (
        <p className="small" role="status">
          {message}
        </p>
      )}
    </section>
  );
}

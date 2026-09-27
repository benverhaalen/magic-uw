// Account page: email sign-in (Supabase magic link), payment status, and checkout.
// The browser only ever holds the public anon key; the entitlements table's row-level security
// lets a signed-in student read their own row and nothing else. See docs/accounts-and-payments.md.
const config = window.MAGIC_CONFIG ?? {};
const page = new URL(location.href);
const wantsToBuy = page.searchParams.get("buy") === "1";
const justPaid = page.searchParams.get("paid") === "1";
// Read before Supabase consumes them: how a sign-in link landed here, if it did.
const hash = new URLSearchParams(location.hash.slice(1));
const linkError = page.searchParams.get("error_code") ?? hash.get("error_code");
const cameFromLink = page.searchParams.has("code");
// The email's link lands here with its one-time token in the hash. It's only spent when the
// student presses Finish signing in, so a scanner that opens the link can't use it (or the
// code, which is the same token) up. It works in any browser, unlike a PKCE redirect.
let emailLink = hash.get("token_hash");

const $ = (selector) => document.querySelector(selector);
const views = [...document.querySelectorAll("[data-view]")];
const show = (name) => views.forEach((el) => (el.hidden = el.dataset.view !== name));
const bind = (name, text) => ($(`[data-bind="${name}"]`).textContent = text);
const say = (text) => bind("message", text);

if (!config.supabaseUrl || !config.supabaseAnonKey) {
  show("off");
} else {
  start().catch(() => {
    show("signed-out");
    say("Something went wrong loading your account. Refresh to try again.");
  });
}

async function start() {
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm");
  const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, detectSessionInUrl: true, flowType: "pkce" },
  });

  const form = $('[data-view="signed-out"]');
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = form.email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      say("Enter a full email address, like you@wisc.edu.");
      form.email.focus();
      return;
    }
    const button = form.querySelector("button");
    button.disabled = true;
    say("");
    const back = new URL("/account/", location.origin);
    if (wantsToBuy) back.searchParams.set("buy", "1");
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: back.href } });
    button.disabled = false;
    if (error) {
      say(error.status === 429 ? "Too many sign-in emails for now. Try again later." : "We couldn't send the email. Try again.");
      return;
    }
    sentTo = email;
    bind("sent-to", email);
    show("sent");
    codeForm.code.focus();
  });

  // The code in the email works in any browser and on any device, unlike the link,
  // and email security scanners that open links can't use it up.
  let sentTo = "";
  const codeForm = $('[data-form="code"]');
  codeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const token = codeForm.code.value.replace(/\s+/g, "");
    if (!/^\d{6,10}$/.test(token)) {
      say("Enter the code from the email: numbers only.");
      codeForm.code.focus();
      return;
    }
    const button = codeForm.querySelector("button");
    button.disabled = true;
    say("");
    const { error } = await supabase.auth.verifyOtp({ email: sentTo, token, type: "email" });
    button.disabled = false;
    if (error) {
      say(error.status === 429 ? "Too many tries. Wait a minute and try again." : "That code didn't work or has expired. Check it, or send a new email.");
      return;
    }
    codeForm.reset(); // signing in re-renders the page through onAuthStateChange
  });

  $('[data-action="confirm"]').addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    say("");
    const { error } = await supabase.auth.verifyOtp({ token_hash: emailLink, type: "email" });
    button.disabled = false;
    emailLink = null;
    if (error) {
      show("signed-out");
      say("That sign-in link has expired or was already used. Enter your email for a new one.");
    } // on success, signing in re-renders the page through onAuthStateChange
  });

  $('[data-action="restart"]').addEventListener("click", () => {
    codeForm.reset();
    say("");
    show("signed-out");
    form.email.focus();
  });
  $('[data-action="sign-out"]').addEventListener("click", async () => {
    await supabase.auth.signOut({ scope: "local" }); // leaves the desktop app signed in
    say("You're signed out.");
  });

  let current = null;
  let renders = 0;
  isCurrent = (run) => run === renders;
  $('[data-action="buy"]').addEventListener("click", () => {
    if (!current || !config.checkoutUrl) return;
    // The account id travels with the order so the webhook can attach the purchase to it.
    const checkout = new URL(config.checkoutUrl);
    checkout.searchParams.set("checkout[email]", current.email ?? "");
    checkout.searchParams.set("checkout[custom][user_id]", current.id);
    location.href = checkout.href;
  });

  let explained = false;
  async function render(session) {
    current = session?.user ?? null;
    window.dispatchEvent(new CustomEvent("magic:account", { detail: { email: current ? (current.email ?? "") : null } }));
    if (!explained) {
      explained = true;
      // A link that didn't sign in would otherwise just show the form again with no reason.
      if (!current && linkError) say("That sign-in link has expired or was already used. Email security scanners sometimes open links before you do. Enter your email for a new one.");
      else if (!current && cameFromLink) say("Sign-in links only work in the browser you requested them from. Enter your email here for a new link, then open it in this browser.");
      const clean = new URL(location.href);
      ["code", "error", "error_code", "error_description"].forEach((key) => clean.searchParams.delete(key));
      history.replaceState(null, "", clean.pathname + clean.search);
    }
    if (!current && emailLink) {
      show("confirm");
      $('[data-action="confirm"]').focus();
      return;
    }
    if (!current) {
      show("signed-out");
      return;
    }
    bind("email", current.email ?? "your account");
    show("signed-in");
    const run = ++renders;
    await renderStatus(supabase, justPaid ? 10 : 0, run);
  }

  // Fires once with the initial session (including one from a sign-in link), then on each change.
  supabase.auth.onAuthStateChange((_event, session) => {
    // Defer: Supabase calls this while it holds its auth lock.
    setTimeout(() => render(session), 0);
  });
}

let isCurrent = () => true;

// Lemon Squeezy's customer portal on the same store, where subscribers cancel, resume or update
// their card (docs.lemonsqueezy.com/help/online-store/customer-portal).
const portalUrl = (() => {
  try {
    return config.checkoutUrl ? new URL("/billing", config.checkoutUrl).href : null;
  } catch {
    return null;
  }
})();
const longDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "long" }) : null);

async function renderStatus(supabase, retriesLeft, run) {
  const subscribe = $('[data-action="buy"]');
  const manage = $('[data-action="manage"]');
  // entitled is computed by the database view, the one place the access rule lives.
  const { data, error } = await supabase
    .from("subscription_access")
    .select("status,test_mode,renews_at,ends_at,entitled")
    .maybeSingle();
  if (!isCurrent(run)) return; // a newer sign-in state has taken over
  const state = (status, note, { canSubscribe = false, canManage = false } = {}) => {
    bind("status", status);
    bind("status-note", note);
    subscribe.hidden = !(canSubscribe && config.checkoutUrl);
    manage.hidden = !(canManage && portalUrl);
    if (portalUrl) manage.href = portalUrl;
  };
  if (error) return state("We couldn't check your subscription right now.", "Refresh in a moment. Nothing about your subscription has changed.");
  const entitled = Boolean(data?.entitled);
  if (!entitled && retriesLeft > 0) {
    // Returning from checkout: the payment notice can take a few seconds to arrive.
    state("Confirming your subscription…", "This usually takes a few seconds.");
    setTimeout(() => renderStatus(supabase, retriesLeft - 1, run), 3000);
    return;
  }
  if (!entitled && justPaid)
    return state("We haven't received the payment notice yet.", "Refresh in a minute. If it still doesn't show, email the team with your receipt.");
  const waiting = "The app isn't ready to download yet. The download will appear here as soon as it is, and the app will recognise this account.";
  if (entitled && data.status === "past_due")
    return state("Your last payment didn't go through.", "Update your card to keep your subscription. You keep access while the payment is retried.", { canManage: true });
  if (entitled && data.status === "cancelled")
    return state(`Cancelled. You have access until ${longDate(data.ends_at)}.`, "You can resume anytime before then.", { canManage: true });
  if (entitled) {
    const renews = longDate(data.renews_at);
    return state("Subscribed. Thank you!", `${renews ? `Renews on ${renews} for $5. ` : ""}${waiting}`, { canManage: true });
  }
  if (data?.test_mode)
    return state("Test subscription only.", "This is a Lemon Squeezy test-mode subscription, so it doesn't count.", { canSubscribe: true });
  if (data?.status === "paused") return state("Your subscription is paused.", "Resume it to use the app again.", { canManage: true });
  if (data?.status === "unpaid")
    return state("Your subscription is on hold.", "The renewal payments didn't go through. Update your card to resume it.", { canManage: true });
  if (data) return state("Your subscription has ended.", "Subscribe again anytime.", { canSubscribe: true });
  state(
    "Not subscribed yet.",
    config.checkoutUrl
      ? "$5 a month, cancel anytime. The app isn't ready to download yet; your subscription is saved to this account and the download will appear here when it is."
      : "Subscriptions aren't open yet.",
    { canSubscribe: true },
  );
  if (wantsToBuy && !subscribe.hidden) subscribe.focus();
}

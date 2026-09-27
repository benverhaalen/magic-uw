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
    await supabase.auth.signOut();
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

async function renderStatus(supabase, retriesLeft, run) {
  const buy = $('[data-action="buy"]');
  const { data, error } = await supabase.from("entitlements").select("status,test_mode,purchased_at").maybeSingle();
  if (!isCurrent(run)) return; // a newer sign-in state has taken over
  if (error) {
    bind("status", "We couldn't check your purchase right now.");
    bind("status-note", "Refresh in a moment. Nothing about your purchase has changed.");
    buy.hidden = true;
    return;
  }
  const paid = data?.status === "paid" && !data.test_mode;
  if (!paid && retriesLeft > 0) {
    // Returning from checkout: the payment notice can take a few seconds to arrive.
    bind("status", "Confirming your payment…");
    bind("status-note", "This usually takes a few seconds.");
    buy.hidden = true;
    setTimeout(() => renderStatus(supabase, retriesLeft - 1, run), 3000);
    return;
  }
  if (!paid && justPaid) {
    bind("status", "We haven't received the payment notice yet.");
    bind("status-note", "Refresh in a minute. If it still doesn't show, email the team with your order receipt.");
    buy.hidden = true;
    return;
  }
  if (paid) {
    const when = data.purchased_at ? new Date(data.purchased_at).toLocaleDateString(undefined, { dateStyle: "long" }) : null;
    bind("status", when ? `Bought on ${when}. Thank you!` : "Bought. Thank you!");
    bind("status-note", "The app isn't ready to download yet. The download will appear here as soon as it is, and the app will recognise this account.");
    buy.hidden = true;
  } else if (data?.status === "paid" && data.test_mode) {
    bind("status", "Test purchase only.");
    bind("status-note", "This was a Lemon Squeezy test-mode order, so it doesn't count as buying the app.");
    buy.hidden = !config.checkoutUrl;
  } else if (data?.status === "refunded") {
    bind("status", "Refunded.");
    bind("status-note", "Your payment was refunded, so the app is no longer bought on this account.");
    buy.hidden = !config.checkoutUrl;
  } else {
    bind("status", "Not bought yet.");
    bind(
      "status-note",
      config.checkoutUrl
        ? "A one-time $10 purchase. The app isn't ready to download yet; your purchase is saved to this account and the download will appear here when it is."
        : "Buying isn't open yet.",
    );
    buy.hidden = !config.checkoutUrl;
    if (wantsToBuy && !buy.hidden) buy.focus();
  }
}

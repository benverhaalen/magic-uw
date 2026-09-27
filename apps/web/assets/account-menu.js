// Header account button on every page. It reads the sign-in that supabase-js saved in this
// browser on the account page, so it needs no network request; Supabase itself only loads when
// the student signs out here. See docs/accounts-and-payments.md.
const config = window.MAGIC_CONFIG ?? {};
const menu = document.querySelector("[data-account-menu]");
const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";

if (menu && config.supabaseUrl && config.supabaseAnonKey) setUp();

function setUp() {
  const storageKey = `sb-${new URL(config.supabaseUrl).hostname.split(".")[0]}-auth-token`;
  const link = menu.querySelector("[data-account-link]");
  const toggle = menu.querySelector("[data-account-toggle]");
  const popover = menu.querySelector("[data-account-popover]");
  const signOut = menu.querySelector("[data-account-sign-out]");

  // null when signed out; the email ("" if unknown) when this browser holds a sign-in.
  const savedEmail = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      return saved?.refresh_token ? (saved.user?.email ?? "") : null;
    } catch {
      return null;
    }
  };

  const close = () => {
    popover.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  };
  const render = (email) => {
    const signedIn = email !== null;
    link.hidden = signedIn;
    toggle.hidden = !signedIn;
    menu.querySelector("[data-account-email]").textContent = email || "Signed in";
    if (!signedIn) close();
  };

  toggle.addEventListener("click", () => {
    if (!popover.hidden) return close();
    popover.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    popover.querySelector("a").focus();
  });
  document.addEventListener("click", (event) => {
    if (!menu.contains(event.target)) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !popover.hidden) {
      close();
      toggle.focus();
    }
  });

  signOut.addEventListener("click", async () => {
    signOut.disabled = true;
    try {
      const { createClient } = await import(SUPABASE_JS);
      const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, { auth: { detectSessionInUrl: false } });
      // Local scope: signing out of the website leaves the desktop app signed in.
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      // Offline or the library didn't load: still forget the sign-in in this browser.
    }
    localStorage.removeItem(storageKey);
    signOut.disabled = false;
    render(null);
    if (location.pathname.startsWith("/account")) location.reload();
    else link.focus();
  });

  // Same tab: the account page reports sign-in changes. Other tabs: the saved sign-in changes.
  window.addEventListener("magic:account", (event) => render(event.detail.email));
  window.addEventListener("storage", (event) => {
    if (event.key === storageKey) render(savedEmail());
  });
  render(savedEmail());
}

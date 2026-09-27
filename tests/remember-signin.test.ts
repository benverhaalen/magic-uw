// owner: T05e. Remember my sign-in (plan D39, spec A1). Synthetic credentials only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AUTO_SIGN_IN_SPACING_MS,
  REMEMBERED_SIGNIN_FILE,
  UNAVAILABLE_ENCRYPTION,
  UNAVAILABLE_LINUX_KEYRING,
  autoSignInWanted,
  createAutoSignIn,
  createRememberedSignInStore,
  parseCapture,
  parseSignIn,
  rememberAvailability,
  rememberSignInBuildEnabled,
} from "../apps/desktop/src/remember-signin";
import {
  REMEMBER_FAILED,
  REMEMBER_LABEL,
  REMEMBER_NOTE,
  isNetIdLoginPage,
  rememberBoxMarkup,
  runSignInPage,
  type NetIdFormHandle,
  type SignInCaptureMessage,
  type SignInPageEnv,
} from "../apps/desktop/src/signin-page";
import { RememberSignInView, rememberCopy } from "../apps/desktop/src/renderer/RememberSignIn";
import { fusesLeftAtDefault, packagedFuses, uninstall } from "../apps/desktop/packaging/fuses";

const LOGIN = "https://login.wisc.edu/idp/profile/SAML2/Redirect/SSO?execution=e1s2";
const SYNTHETIC = { netid: "bbadger", password: "synthetic-Passw0rd!" } as const;
const read = (path: string) => readFileSync(path, "utf8");
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

// A fake XOR cipher tests the boundary; Electron's safeStorage supplies the real OS encryption.
function fakeEncryption(available = true) {
  const calls = { encrypt: 0, decrypt: 0 };
  return {
    calls,
    available: () => available,
    encrypt: (value: string) => {
      calls.encrypt++;
      return Buffer.from(value).map((b) => b ^ 0x5a);
    },
    decrypt: (value: Uint8Array) => {
      calls.decrypt++;
      return Buffer.from(value).map((b) => b ^ 0x5a).toString();
    },
  };
}

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "magic-remember-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A fake sign-in page for runSignInPage: the rules without a browser. */
function fakePage(options: { href?: string; top?: boolean; state?: unknown; form?: boolean } = {}) {
  let href = options.href ?? LOGIN;
  let top = options.top ?? true;
  const log = { invoked: 0, submitted: 0, markup: "", captures: [] as SignInCaptureMessage[] };
  const formMarker = {};
  const changeListeners: Array<(trusted: boolean) => void> = [];
  let submitListener:
    | ((event: { target: unknown; isTrusted: boolean; defaultPrevented: boolean }) => void)
    | undefined;
  const box = {
    checked: false,
    onChange(listener: (trusted: boolean) => void) {
      changeListeners.push(listener);
    },
  };
  const form: NetIdFormHandle = {
    username: { value: "" },
    password: { value: "" },
    insertBox(markup) {
      log.markup = markup;
      box.checked = / checked[ >]/.test(markup);
      return box;
    },
    submit() {
      log.submitted++;
      // requestSubmit fires a trusted submit event, like the student's own.
      submitListener?.({ target: formMarker, isTrusted: true, defaultPrevented: false });
    },
    isForm: (target) => target === formMarker,
    connected: () => true,
  };
  const page = {
    env: undefined as unknown as SignInPageEnv,
    log,
    form,
    box,
    beforeState: undefined as undefined | (() => void),
    navigate(url: string) {
      href = url;
    },
    frame(isTop: boolean) {
      top = isTop;
    },
    tick(value: boolean, trusted = true) {
      box.checked = value;
      for (const listener of changeListeners) listener(trusted);
    },
    submit(event: Partial<{ isTrusted: boolean; defaultPrevented: boolean; target: unknown }> = {}) {
      submitListener?.({ target: formMarker, isTrusted: true, defaultPrevented: false, ...event });
    },
  };
  page.env = {
    isTop: () => top,
    href: () => href,
    findForm: () => (options.form === false ? null : form),
    onSubmit(listener) {
      submitListener = listener;
    },
    async pageState() {
      log.invoked++;
      page.beforeState?.();
      return options.state ?? { offer: true, checked: false };
    },
    capture(message) {
      log.captures.push(message);
    },
  };
  return page;
}

test("origin: only UW's exact NetID login origin counts, under /idp/", () => {
  const cases: Array<[string, boolean]> = [
    [LOGIN, true],
    ["https://login.wisc.edu/idp/profile/SAML2/Redirect/SSO?execution=e1s1", true],
    ["https://login.wisc.edu:443/idp/profile/SAML2/Redirect/SSO", true],
    ["https://login.wisc.edu.evil.test/idp/profile/SAML2/Redirect/SSO", false],
    ["https://login.wisc.edu./idp/profile/SAML2/Redirect/SSO", false],
    ["https://evil-login.wisc.edu/idp/", false],
    ["https://sso.login.wisc.edu/idp/", false],
    ["https://loginwisc.edu/idp/", false],
    ["http://login.wisc.edu/idp/", false],
    ["https://login.wisc.edu:8443/idp/", false],
    ["https://user:pass@login.wisc.edu/idp/", false],
    ["https://login.wisc.edu/", false],
    ["https://login.wisc.edu/redirect/password-recovery", false],
    ["https://api-abc123.duosecurity.com/frame/v4/auth/prompt", false],
    ["https://canvas.wisc.edu/login/saml", false],
    ["https://sso.canvaslms.com/", false],
    ["javascript:alert(1)", false],
    ["not a url", false],
  ];
  for (const [url, expected] of cases) assert.equal(isNetIdLoginPage(url), expected, url);
  assert.equal(isNetIdLoginPage(undefined), false);
  assert.equal(isNetIdLoginPage(42), false);
});

test("page: never acts on a look-alike host, an iframe, or a page without the NetID form", async () => {
  for (const href of [
    "https://login.wisc.edu.evil.test/idp/profile/SAML2/Redirect/SSO",
    "https://api-abc123.duosecurity.com/frame/v4/auth/prompt",
  ]) {
    const page = fakePage({ href, state: { offer: true, checked: true, fill: SYNTHETIC } });
    assert.equal(await runSignInPage(page.env), "skipped", href);
    assert.equal(page.log.invoked, 0, "main is never even asked");
    assert.equal(page.form.password.value, "");
  }
  const iframe = fakePage({ top: false, state: { offer: true, checked: true, fill: SYNTHETIC } });
  assert.equal(await runSignInPage(iframe.env), "skipped");
  assert.equal(iframe.log.invoked, 0);
  assert.equal(iframe.form.password.value, "");
  const noForm = fakePage({ form: false });
  assert.equal(await runSignInPage(noForm.env), "skipped");
  assert.equal(noForm.log.invoked, 0);
});

test("page: the origin and frame are checked again at the moment of filling", async () => {
  const moved = fakePage({ state: { offer: true, checked: true, fill: SYNTHETIC } });
  moved.beforeState = () => moved.navigate("https://login.wisc.edu.evil.test/idp/");
  assert.equal(await runSignInPage(moved.env), "skipped");
  assert.equal(moved.form.password.value, "");
  assert.equal(moved.log.submitted, 0);
  const reframed = fakePage({ state: { offer: true, checked: true, fill: SYNTHETIC } });
  reframed.beforeState = () => reframed.frame(false);
  assert.equal(await runSignInPage(reframed.env), "skipped");
  assert.equal(reframed.form.password.value, "");
});

test("page: the box is off by default, and a capture carries the sign-in only when the student ticked it", async () => {
  const page = fakePage();
  assert.equal(await runSignInPage(page.env), "offered");
  assert.equal(page.box.checked, false, "off by default");
  assert.match(page.log.markup, /type="checkbox"/);
  assert.doesNotMatch(page.log.markup, / checked[ >]/);
  page.form.username.value = SYNTHETIC.netid;
  page.form.password.value = SYNTHETIC.password;
  page.submit();
  assert.deepEqual(page.log.captures, [{ remember: false }], "unticked: the password never crosses");
  // A page script ticking the box (an untrusted change) is undone and doesn't count.
  page.tick(true, false);
  assert.equal(page.box.checked, false);
  page.submit();
  assert.deepEqual(page.log.captures.at(-1), { remember: false });
  // A synthetic submit event, or one the page's own handler cancelled, is ignored.
  page.tick(true);
  page.submit({ isTrusted: false });
  page.submit({ defaultPrevented: true });
  page.submit({ target: {} });
  assert.equal(page.log.captures.length, 2);
  page.submit();
  assert.deepEqual(page.log.captures.at(-1), { remember: true, signIn: SYNTHETIC });
  assert.equal(page.log.submitted, 0, "a manual window never submits for the student");
});

test("page: a saved sign-in shows the box ticked; unticking it sends only { remember: false }", async () => {
  const page = fakePage({ state: { offer: true, checked: true } });
  assert.equal(await runSignInPage(page.env), "offered");
  assert.equal(page.box.checked, true);
  page.tick(false);
  page.form.password.value = SYNTHETIC.password;
  page.submit();
  assert.deepEqual(page.log.captures, [{ remember: false }]);
});

test("page: an automatic window fills and submits once, and its own submit is never captured", async () => {
  const page = fakePage({ state: { offer: true, checked: true, fill: SYNTHETIC } });
  assert.equal(await runSignInPage(page.env), "filled");
  assert.equal(page.form.username.value, SYNTHETIC.netid);
  assert.equal(page.form.password.value, SYNTHETIC.password);
  assert.equal(page.log.submitted, 1);
  assert.deepEqual(page.log.captures, []);
  assert.equal(page.log.invoked, 1);
});

test("page: encryption unavailable disables the box with the reason, and nothing is captured", async () => {
  const page = fakePage({ state: { offer: true, checked: false, disabledReason: UNAVAILABLE_ENCRYPTION } });
  assert.equal(await runSignInPage(page.env), "offered");
  assert.match(page.log.markup, / disabled[ >]/);
  assert.ok(text(page.log.markup).includes(text(UNAVAILABLE_ENCRYPTION)));
  page.tick(true);
  assert.equal(page.box.checked, false);
  page.form.password.value = SYNTHETIC.password;
  page.submit();
  assert.deepEqual(page.log.captures, []);
});

test("page: the build switch (offer: false) shows no box and captures nothing", async () => {
  const page = fakePage({ state: { offer: false } });
  assert.equal(await runSignInPage(page.env), "skipped");
  assert.equal(page.log.markup, "");
  page.submit();
  assert.deepEqual(page.log.captures, []);
  // A malformed answer from main is treated the same way.
  const odd = fakePage({ state: { offer: true, checked: "yes" } });
  assert.equal(await runSignInPage(odd.env), "skipped");
});

test("availability: the build switch, encryption and the Linux keyring", () => {
  assert.equal(rememberSignInBuildEnabled(undefined), true);
  assert.equal(rememberSignInBuildEnabled("on"), true);
  assert.equal(rememberSignInBuildEnabled("off"), false);
  const base = { buildEnabled: true, encryptionAvailable: true, platform: "win32" };
  assert.deepEqual(rememberAvailability(base), { state: "available" });
  assert.deepEqual(rememberAvailability({ ...base, platform: "darwin" }), { state: "available" });
  assert.deepEqual(rememberAvailability({ ...base, buildEnabled: false }), { state: "off" });
  assert.deepEqual(rememberAvailability({ ...base, buildEnabled: false, encryptionAvailable: false }), { state: "off" });
  assert.deepEqual(rememberAvailability({ ...base, encryptionAvailable: false }), {
    state: "unavailable",
    reason: UNAVAILABLE_ENCRYPTION,
  });
  assert.deepEqual(rememberAvailability({ ...base, platform: "linux", linuxBackend: "basic_text" }), {
    state: "unavailable",
    reason: UNAVAILABLE_LINUX_KEYRING,
  });
  assert.deepEqual(rememberAvailability({ ...base, platform: "linux" }).state, "unavailable");
  assert.deepEqual(rememberAvailability({ ...base, platform: "linux", linuxBackend: "gnome_libsecret" }), {
    state: "available",
  });
});

test("build switch: baked into the bundle at build time, and the preload is built", () => {
  const build = read("scripts/build.ts");
  assert.match(build, /"apps\/desktop\/src\/signin-preload\.ts"/);
  assert.match(build, /process\.env\.MAGIC_REMEMBER_SIGNIN === "off" \? "off" : "on"/);
  assert.match(build, /define: \{ "process\.env\.MAGIC_REMEMBER_SIGNIN": JSON\.stringify\(rememberSignIn\) \}/);
  const main = read("apps/desktop/src/main.ts");
  assert.match(main, /rememberSignInBuildEnabled\(process\.env\.MAGIC_REMEMBER_SIGNIN\)/);
  // A switched-off build keeps no saved sign-in from an earlier build.
  assert.match(main, /if \(rememberState\(\)\.state === "off"\) await remembered\.forget\(\)/);
});

test("store: encrypted at rest, validated, and forget removes the file", async () => {
  await withDir(async (dir) => {
    const path = join(dir, REMEMBERED_SIGNIN_FILE);
    const encryption = fakeEncryption();
    const store = createRememberedSignInStore(path, encryption);
    assert.equal(await store.saved(), false);
    assert.equal(await store.load(), null);
    await store.save(SYNTHETIC);
    const bytes = await readFile(path);
    assert.equal(bytes.includes(Buffer.from(SYNTHETIC.password)), false, "no plaintext password on disk");
    assert.equal(bytes.includes(Buffer.from(SYNTHETIC.netid)), false, "no plaintext NetID on disk");
    const before = encryption.calls.decrypt;
    assert.equal(await store.saved(), true);
    assert.equal(encryption.calls.decrypt, before, "status never decrypts (no Keychain prompt)");
    assert.deepEqual(await store.load(), SYNTHETIC);
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o077, 0);
    await store.forget();
    assert.equal(await store.saved(), false);
    await store.forget(); // idempotent
    await assert.rejects(store.save({ netid: "", password: "x" }), /can't be saved/);
    await assert.rejects(store.save({ netid: "bbadger", password: "x".repeat(128) }), /can't be saved/);
  });
});

test("store: encryption unavailable saves nothing; an unreadable file is removed, not retried", async () => {
  await withDir(async (dir) => {
    const path = join(dir, REMEMBERED_SIGNIN_FILE);
    const off = createRememberedSignInStore(path, fakeEncryption(false));
    await assert.rejects(off.save(SYNTHETIC), /protected storage/);
    assert.equal(await off.saved(), false);
    await writeFile(path, "not encrypted json");
    const store = createRememberedSignInStore(path, fakeEncryption());
    assert.equal(await store.load(), null);
    assert.equal(await store.saved(), false, "the corrupt file is gone");
  });
});

test("capture and sign-in shapes are checked in main", () => {
  assert.deepEqual(parseCapture({ remember: false }), { remember: false });
  assert.deepEqual(parseCapture({ remember: true, signIn: SYNTHETIC }), { remember: true, signIn: SYNTHETIC });
  assert.equal(parseCapture({ remember: true }), null);
  assert.equal(parseCapture({ remember: "yes", signIn: SYNTHETIC }), null);
  assert.equal(parseCapture(null), null);
  assert.deepEqual(parseSignIn({ netid: "  bbadger ", password: "p w" }), { netid: "bbadger", password: "p w" });
  assert.equal(parseSignIn({ netid: "b badger", password: "x" }), null);
  assert.equal(parseSignIn({ netid: "x".repeat(51), password: "x" }), null);
  assert.equal(parseSignIn({ netid: "bbadger", password: "" }), null);
  assert.equal(parseSignIn({ netid: "bbadger", password: "a\nb" }), null);
});

test("automatic sign-in: one fill; the NetID form coming back fails it; no retry loop", () => {
  const auto = createAutoSignIn(true);
  assert.equal(auto.formShown(true), "fill");
  assert.equal(auto.phase, "submitted");
  assert.equal(auto.formShown(true), "failed", "UW showed the form again: wrong password");
  assert.equal(auto.formShown(true), "none", "never fills again in this window");
  assert.equal(auto.closed(false), "none");
  // Nothing saved, or a manual window: never fills.
  assert.equal(createAutoSignIn(true).formShown(false), "none");
  const manual = createAutoSignIn(false);
  assert.equal(manual.formShown(true), "none");
  assert.equal(manual.closed(false), "none");
});

test("automatic sign-in: reaching Duo means UW accepted the password; Duo stays the student's", () => {
  const auto = createAutoSignIn(true);
  auto.formShown(true);
  auto.navigated("https://login.wisc.edu/idp/profile/SAML2/Redirect/SSO?execution=e1s3");
  assert.equal(auto.phase, "submitted", "an IdP page on the same origin proves nothing yet");
  auto.navigated("https://api-abc123.duosecurity.com/frame/v4/auth/prompt");
  assert.equal(auto.phase, "accepted");
  // The student closing the Duo prompt isn't a failed sign-in: the saved sign-in is kept.
  assert.equal(auto.closed(false), "none");
  assert.equal(auto.formShown(true), "none");
});

test("automatic sign-in: an error page or a failed load, then closing, clears it", () => {
  const closedEarly = createAutoSignIn(true);
  closedEarly.formShown(true);
  assert.equal(closedEarly.closed(false), "failed");
  const failedLoad = createAutoSignIn(true);
  failedLoad.formShown(true);
  assert.equal(failedLoad.loadFailed(), "failed");
  assert.equal(failedLoad.closed(false), "none", "cleared once");
  const confirmed = createAutoSignIn(true);
  confirmed.formShown(true);
  assert.equal(confirmed.closed(true), "none");
  const abandoned = createAutoSignIn(true);
  abandoned.formShown(true);
  abandoned.abandon();
  assert.equal(abandoned.closed(false), "none");
});

test("a failed automatic sign-in clears the saved sign-in and shows the normal sign-in", async () => {
  await withDir(async (dir) => {
    const store = createRememberedSignInStore(join(dir, REMEMBERED_SIGNIN_FILE), fakeEncryption());
    await store.save(SYNTHETIC);
    // Main's magic-signin:page answer, step by step (main.ts, owner: T05e).
    const auto = createAutoSignIn(true);
    assert.equal(auto.formShown(await store.saved()), "fill");
    const first = fakePage({ state: { offer: true, checked: true, fill: await store.load() } });
    assert.equal(await runSignInPage(first.env), "filled");
    // UW answers with the NetID form again.
    assert.equal(auto.formShown(await store.saved()), "failed");
    await store.forget();
    const second = fakePage({ state: { offer: true, checked: false, notice: "failed" } });
    assert.equal(await runSignInPage(second.env), "offered");
    assert.equal(second.form.password.value, "", "the normal sign-in: nothing filled");
    assert.ok(text(second.log.markup).includes(text(REMEMBER_FAILED)));
    assert.equal(await store.saved(), false);
  });
  const main = read("apps/desktop/src/main.ts");
  assert.match(main, /if \(step === "failed"\) \{[\s\S]{0,200}await remembered\.forget\(\);/);
  assert.match(main, /attempt\.auto\.closed\(confirmed\) === "failed"\) \{\s*void remembered\.forget\(\)/);
  assert.match(main, /attempt\.auto\.loadFailed\(\) === "failed"\) \{\s*void remembered\.forget\(\)/);
});

test("the automatic open after a sync's expiry: present, not headless, spaced, and only with a saved sign-in", () => {
  const now = 10_000_000;
  const yes = {
    availability: { state: "available" } as const,
    saved: true,
    present: true,
    headless: false,
    signInOpen: false,
    lastAutoAt: undefined,
    now,
  };
  assert.equal(autoSignInWanted(yes), true);
  assert.equal(autoSignInWanted({ ...yes, saved: false }), false);
  assert.equal(autoSignInWanted({ ...yes, present: false }), false);
  assert.equal(autoSignInWanted({ ...yes, headless: true }), false);
  assert.equal(autoSignInWanted({ ...yes, signInOpen: true }), false);
  assert.equal(autoSignInWanted({ ...yes, availability: { state: "off" } }), false);
  assert.equal(autoSignInWanted({ ...yes, availability: { state: "unavailable", reason: "x" } }), false);
  assert.equal(autoSignInWanted({ ...yes, lastAutoAt: now - AUTO_SIGN_IN_SPACING_MS + 1 }), false);
  assert.equal(autoSignInWanted({ ...yes, lastAutoAt: now - AUTO_SIGN_IN_SPACING_MS }), true);
  // Main opens it only when the sync's own profile read confirms the session ended.
  const main = read("apps/desktop/src/main.ts");
  assert.match(
    main,
    /service === "canvas" &&\s*new URL\(target\)\.pathname === canvasProfilePath &&\s*canvasProfileSignedOut\(/,
  );
});

test("main accepts the two messages only from the sign-in window's top frame on the exact origin", () => {
  const main = read("apps/desktop/src/main.ts");
  const guard = main.slice(main.indexOf("function signInFrame("), main.indexOf('ipcMain.handle("magic-signin:page"'));
  assert.match(guard, /event\.sender !== attempt\.contents/);
  assert.match(guard, /frame !== attempt\.contents\.mainFrame/);
  assert.match(guard, /!isNetIdLoginPage\(frame\.url\)/);
  assert.match(main, /ipcMain\.handle\("magic-signin:page", async \(event\)[^{]*\{\s*const attempt = signInFrame\(event\)/);
  assert.match(main, /ipcMain\.on\("magic-signin:capture"[\s\S]{0,200}attempt = signInFrame\(event\)/);
  // Re-checked after the awaits, before the fill is returned.
  assert.match(main, /const fill = await remembered\.load\(\);\s*\/\/[^\n]*\n\s*signInFrame\(event\);/);
  // The preload goes only into UW sign-in windows, which keep contextIsolation and the sandbox.
  assert.match(main, /\.\.\.\(gitlab \? \{\} : \{ preload: join\(root, "signin-preload\.cjs"\) \}\)/);
  const preload = read("apps/desktop/src/signin-preload.ts");
  assert.doesNotMatch(preload, /contextBridge\.|exposeInMainWorld\(/);
  assert.match(preload, /attachShadow\(\{ mode: "closed" \}\)/);
  const channels = [...preload.matchAll(/ipcRenderer\.(\w+)\("([^"]+)"/g)].map(([, how, channel]) => `${how}:${channel}`);
  assert.deepEqual(channels.sort(), ["invoke:magic-signin:page", "send:magic-signin:capture"]);
});

test("forget, sign out and purge each delete the saved sign-in", () => {
  const main = read("apps/desktop/src/main.ts");
  const block = (start: string) => {
    const from = main.indexOf(start);
    assert.ok(from >= 0, start);
    const to = main.indexOf("ipcMain.handle(", from + start.length);
    return main.slice(from, to < 0 ? undefined : to);
  };
  assert.match(block('ipcMain.handle("magic:signout"'), /await remembered\.forget\(\)/);
  assert.match(block('ipcMain.handle("magic:execute"'), /if \(purging\) \{[\s\S]*await remembered\.forget\(\)/);
  assert.match(block('"magic:remember-signin"'), /if \(op === "forget"\) await remembered\.forget\(\)/);
  assert.equal(uninstall.deleteAppData, true, "uninstall removes the data folder that holds it");
  const bridge = read("apps/desktop/src/preload.ts");
  assert.match(bridge, /rememberSignIn: \(op\) => ipcRenderer\.invoke\("magic:remember-signin", op\)/);
});

test("no log, receipt, trial log, database or worker path can carry the credential", () => {
  const sinks = /\b(?:trialLog|console\.\w+|worker\.postMessage|port\.postMessage|execute|appendFile|workerQuery)\(/g;
  const credential = /password|netid|\bfill\b|\.signIn\b|pending|remembered\.load|capture\b/;
  const files = [
    "apps/desktop/src/main.ts",
    "apps/desktop/src/remember-signin.ts",
    "apps/desktop/src/signin-page.ts",
    "apps/desktop/src/signin-preload.ts",
  ];
  for (const file of files) {
    const source = read(file);
    for (const match of source.matchAll(sinks)) {
      // The whole call: from the sink to its balanced closing parenthesis.
      let depth = 0,
        end = match.index! + match[0].length - 1;
      for (; end < source.length; end++) {
        if (source[end] === "(") depth++;
        else if (source[end] === ")" && --depth === 0) break;
      }
      // String literals are fixed texts; only the identifiers inside the call can carry a value.
      const call = source.slice(match.index, end + 1).replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
      assert.doesNotMatch(call, credential, `${file}: ${call.slice(0, 160)}`);
    }
  }
  for (const file of files.slice(1))
    assert.doesNotMatch(read(file), /console\.|trialLog|appendFile/, `${file} never logs`);
  // The worker, the store and the course bank never see it: nothing there references it.
  for (const file of [
    "apps/desktop/src/worker.ts",
    "apps/desktop/src/ingestion.ts",
    "apps/desktop/src/mcp-server.ts",
    "packages/storage/src/index.ts",
    "packages/core/src/index.ts",
  ])
    assert.doesNotMatch(read(file), /remember-signin|remembered-signin|magic-signin:|signin-page/, file);
  // The workspace bridge carries status only.
  const main = read("apps/desktop/src/main.ts");
  const status = main.slice(main.indexOf('"magic:remember-signin"'), main.indexOf("// end owner: T05e", main.indexOf('"magic:remember-signin"')));
  assert.doesNotMatch(status, /load\(|fill|password|netid/);
});

test("headless render: the sign-in box and the Settings row", () => {
  const box = rememberBoxMarkup({ checked: false });
  assert.match(box, /<input type="checkbox" id="magic-remember">/);
  assert.ok(text(box).includes(REMEMBER_LABEL));
  assert.ok(text(box).includes(text(REMEMBER_NOTE)));
  assert.match(REMEMBER_NOTE, /encrypted on this computer only/);
  assert.match(REMEMBER_NOTE, /never sent anywhere/);
  assert.match(REMEMBER_NOTE, /Forget my sign-in/);
  assert.match(rememberBoxMarkup({ checked: true }), / checked>/);
  assert.match(rememberBoxMarkup({ checked: true, disabledReason: "<b>x</b>" }), /&#60;b&#62;x/);

  const render = (status: Parameters<typeof RememberSignInView>[0]["status"], message?: string) =>
    renderToStaticMarkup(createElement(RememberSignInView, { status, busy: false, message, onForget: () => {} }));
  const saved = render({ offered: true, available: true, saved: true });
  assert.match(saved, /data-remember-signin="saved"/);
  assert.match(saved, /<button[^>]*>Forget my sign-in<\/button>/);
  assert.ok(text(saved).includes(text(rememberCopy.saved)));
  const off = render({ offered: true, available: true, saved: false });
  assert.doesNotMatch(off, /<button/);
  assert.ok(text(off).includes(text(rememberCopy.notSaved)));
  const unavailable = render({ offered: true, available: false, reason: UNAVAILABLE_ENCRYPTION, saved: false });
  assert.match(unavailable, /data-remember-signin="unavailable"/);
  assert.ok(text(unavailable).includes(text(UNAVAILABLE_ENCRYPTION)));
  const forgotten = render({ offered: true, available: true, saved: false }, rememberCopy.forgotten);
  assert.ok(text(forgotten).includes(rememberCopy.forgotten));
  assert.equal(render({ offered: false }), "", "the build switch hides the row");
  assert.equal(render(null), "");
  const app = read("apps/desktop/src/renderer/App.tsx");
  assert.match(app, /<KeepSignedInToggle busy=\{busy\} \/>[\s\S]{0,200}<RememberSignIn busy=\{busy\} \/>/);
});

test("packaging: cookie encryption is on, RunAsNode stays for the MCP export", () => {
  assert.equal(packagedFuses.EnableCookieEncryption, true);
  assert.deepEqual([...fusesLeftAtDefault], ["RunAsNode"]);
  assert.match(read("apps/desktop/src/main.ts"), /ELECTRON_RUN_AS_NODE: "1"/);
});
// end owner: T05e

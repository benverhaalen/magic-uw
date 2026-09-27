import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HEADLESS_DOCUMENT,
  handleOpenDocument,
  insideFolder,
  isDocumentUrl,
  navigationDecision,
  ssoTracker,
} from "../apps/desktop/src/doc-window-policy";

test("document allowlist: Word/Office online and Google Docs over https only", () => {
  for (const url of [
    "https://word-edit.officeapps.live.com/we/wordeditorframe.aspx?ui=en-US",
    "https://www.office.com/launch/word",
    "https://word.cloud.microsoft/open/onedrive/?docId=1",
    "https://uwprod.sharepoint.com/sites/course/Shared%20Documents/notes.docx",
    "https://uwprod-my.sharepoint.com/:w:/g/personal/student_wisc_edu/abc",
    "https://onedrive.live.com/edit?id=1",
    "https://docs.google.com/document/d/abc/edit",
    "https://drive.google.com/file/d/abc/view",
  ])
    assert.equal(isDocumentUrl(url), true, url);
  for (const url of [
    "http://docs.google.com/document/d/abc/edit",
    "https://user:pw@docs.google.com/document/d/abc",
    "https://docs.google.com.evil.example/document",
    "https://evilsharepoint.com/x",
    "https://sharepoint.com.evil.example/x",
    "https://canvas.wisc.edu/courses/1",
    "https://login.wisc.edu/idp/profile/SAML2/Redirect/SSO",
    "javascript:alert(1)",
    "file:///C:/Windows/notepad.exe",
    "not a url",
    `https://docs.google.com/${"a".repeat(4001)}`,
    42,
  ])
    assert.equal(isDocumentUrl(url), false, String(url).slice(0, 60));
});

test("navigation guard: document and sign-in hosts stay in the window", () => {
  for (const url of [
    "https://docs.google.com/document/d/abc/edit",
    "https://uwprod-my.sharepoint.com/:w:/g/personal/x",
    "https://login.wisc.edu/idp/profile/SAML2/POST/SSO",
    "https://api-1234.duosecurity.com/frame/v4/auth/prompt",
    "https://login.microsoftonline.com/common/oauth2/authorize",
    "https://accounts.google.com/ServiceLogin",
    "https://www.google.com/a/wisc.edu/acs",
  ]) {
    assert.equal(navigationDecision(url, "navigate"), "allow", url);
    assert.equal(navigationDecision(url, "redirect"), "allow", url);
  }
});

test("navigation guard: a redirect to a login host is allowed, a redirect elsewhere is blocked", () => {
  // Word online → Microsoft login → UW's IdP: every hop is on the allowlist.
  assert.equal(navigationDecision("https://login.microsoftonline.com/wisc.edu/saml2", "redirect"), "allow");
  assert.equal(navigationDecision("https://login.wisc.edu/idp/profile/SAML2/Redirect/SSO?SAMLRequest=x", "redirect"), "allow");
  // Off the allowlist: nothing opens (a redirect URL can carry sign-in state).
  assert.equal(navigationDecision("https://evil.example/collect?SAMLResponse=x", "redirect"), "block");
  assert.equal(navigationDecision("https://www.google.com/search?q=x", "redirect"), "block");
  assert.equal(navigationDecision("http://docs.google.com/document/d/abc", "redirect"), "block");
});

test("navigation guard: a link elsewhere opens in the default browser; odd schemes open nothing", () => {
  assert.equal(navigationDecision("https://en.wikipedia.org/wiki/Canvas", "navigate"), "external");
  assert.equal(navigationDecision("http://example.com/", "navigate"), "external");
  assert.equal(navigationDecision("file:///C:/Windows/notepad.exe", "navigate"), "block");
  assert.equal(navigationDecision("javascript:alert(1)", "navigate"), "block");
  assert.equal(navigationDecision("https://user:pw@example.com/", "navigate"), "block");
});

test("popups: document hosts open another document window, everything else the browser", () => {
  assert.equal(navigationDecision("https://docs.google.com/document/d/other/edit", "window-open"), "allow");
  assert.equal(navigationDecision("https://accounts.google.com/ServiceLogin", "window-open"), "external");
  assert.equal(navigationDecision("https://example.com/", "window-open"), "external");
  assert.equal(navigationDecision("ms-word:ofe|u|https://x.sharepoint.com/a.docx", "window-open"), "block");
});

test("magic:open-document: a document link opens the window", async () => {
  const opened: string[] = [],
    external: string[] = [];
  const result = await handleOpenDocument("https://docs.google.com/document/d/abc/edit", {
    headless: false,
    openWindow: (url) => opened.push(url),
    openExternal: async (url) => void external.push(url),
  });
  assert.deepEqual(result, { opened: "window" });
  assert.deepEqual(opened, ["https://docs.google.com/document/d/abc/edit"]);
  assert.deepEqual(external, []);
});

test("magic:open-document: a non-document link falls back to openExternal", async () => {
  const opened: string[] = [],
    external: string[] = [];
  const deps = {
    headless: false,
    openWindow: (url: string) => void opened.push(url),
    openExternal: async (url: string) => void external.push(url),
  };
  assert.deepEqual(await handleOpenDocument("https://canvas.wisc.edu/courses/1", deps), { opened: "browser" });
  assert.deepEqual(await handleOpenDocument("http://docs.google.com/document/d/abc", deps), { opened: "browser" });
  assert.deepEqual(external, ["https://canvas.wisc.edu/courses/1", "http://docs.google.com/document/d/abc"]);
  assert.deepEqual(opened, []);
  await assert.rejects(handleOpenDocument("file:///C:/Windows/notepad.exe", deps), /ordinary web links/);
  await assert.rejects(handleOpenDocument(42, deps), /Invalid link/);
  assert.equal(external.length, 2);
});

test("magic:open-document: headless opens nothing", async () => {
  let calls = 0;
  await assert.rejects(
    handleOpenDocument("https://docs.google.com/document/d/abc", {
      headless: true,
      openWindow: () => void calls++,
      openExternal: async () => void calls++,
    }),
    new RegExp(HEADLESS_DOCUMENT),
  );
  assert.equal(calls, 0);
});

test("downloads: only inside the Downloads folder", () => {
  assert.equal(insideFolder("C:\\Users\\s\\Downloads\\notes.docx", "C:\\Users\\s\\Downloads", "win32"), true);
  assert.equal(insideFolder("c:\\users\\s\\downloads\\sub\\a.pdf", "C:\\Users\\s\\Downloads", "win32"), true);
  assert.equal(insideFolder("C:\\Users\\s\\Desktop\\notes.docx", "C:\\Users\\s\\Downloads", "win32"), false);
  assert.equal(insideFolder("C:\\Users\\s\\Downloads", "C:\\Users\\s\\Downloads", "win32"), false);
  assert.equal(insideFolder("C:\\Users\\s\\Downloads\\..\\x.exe", "C:\\Users\\s\\Downloads", "win32"), false);
  assert.equal(insideFolder("D:\\x.docx", "C:\\Users\\s\\Downloads", "win32"), false);
  assert.equal(insideFolder("", "C:\\Users\\s\\Downloads", "win32"), false);
});

test("SSO carry-through: a quick login bounce then the document reports true", async () => {
  const reports: boolean[] = [];
  let interactive = 0;
  const sso = ssoTracker({ idleMs: 30, report: (c) => reports.push(c), onInteractive: () => interactive++ });
  sso.loaded("https://login.wisc.edu/idp/profile/SAML2/POST/SSO");
  sso.navigating();
  sso.loaded("https://docs.google.com/document/d/abc/edit");
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(reports, [true]);
  assert.equal(interactive, 0);
  sso.dispose();
});

test("SSO carry-through: a login page left waiting reports false once and offers the bar", async () => {
  const reports: boolean[] = [];
  let interactive = 0;
  const sso = ssoTracker({ idleMs: 20, report: (c) => reports.push(c), onInteractive: () => interactive++ });
  sso.loaded("https://login.microsoftonline.com/common/oauth2/authorize?client_id=x");
  await new Promise((r) => setTimeout(r, 50));
  // The student signs in by hand afterwards: already decided, still false.
  sso.loaded("https://uwprod-my.sharepoint.com/:w:/g/personal/x");
  assert.deepEqual(reports, [false]);
  assert.equal(interactive, 1);
  sso.dispose();
});

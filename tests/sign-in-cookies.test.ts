import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearUwLoginCookies, isUwLoginCookie } from "../apps/desktop/src/sign-in-cookies";
import { parseSessionSettings, readSessionSettings, writeSessionSettings } from "../apps/desktop/src/keep-signed-in";

// Cookie names and domains as a browser session would hold them after UW sign-ins. Values never matter.
const jar = () => [
  { name: "shib_idp_session", domain: "login.wisc.edu", path: "/idp" },
  { name: "JSESSIONID", domain: ".login.wisc.edu", path: "/idp" },
  { name: "_shibstate_123", domain: "login.wisc.edu", path: "/" },
  { name: "_canvas_session", domain: "canvas.wisc.edu", path: "/" },
  { name: "df|remember", domain: "api-f4b22b08.duosecurity.com", path: "/" },
  { name: "wisc_shared", domain: ".wisc.edu", path: "/" },
  { name: "fake", domain: "login.wisc.edu.example.com", path: "/" },
];
function store(initial = jar()) {
  let cookies = [...initial];
  const removed: string[] = [];
  return {
    removed,
    cookies: () => cookies,
    api: {
      get: async () => cookies,
      remove: async (url: string, name: string) => {
        removed.push(`${url} ${name}`);
        cookies = cookies.filter((c) => !(c.name === name && url.includes(c.domain.replace(/^\./, ""))));
      },
    },
  };
}

test("only UW login-page cookies are selected; Duo, Canvas and other wisc.edu cookies are kept", () => {
  assert.deepEqual(jar().filter(isUwLoginCookie).map((c) => c.name), ["shib_idp_session", "JSESSIONID", "_shibstate_123"]);
});

test("clearing removes exactly the UW login cookies, at their own paths", async () => {
  const s = store();
  assert.equal(await clearUwLoginCookies(s.api), 3);
  assert.deepEqual(s.removed.sort(), [
    "https://login.wisc.edu/ _shibstate_123",
    "https://login.wisc.edu/idp JSESSIONID",
    "https://login.wisc.edu/idp shib_idp_session",
  ]);
  assert.deepEqual(s.cookies().map((c) => c.name).sort(), ["_canvas_session", "df|remember", "fake", "wisc_shared"]);
});

test("nothing to clear is a no-op", async () => {
  const s = store([{ name: "_canvas_session", domain: "canvas.wisc.edu", path: "/" }]);
  assert.equal(await clearUwLoginCookies(s.api), 0);
  assert.deepEqual(s.removed, []);
});

test("the 'last sign-in did not finish' flag defaults off and survives a restart", async () => {
  assert.equal(parseSessionSettings({}).loginUnfinished, undefined, "absent means off");
  assert.equal(parseSessionSettings({ loginUnfinished: "yes" }).loginUnfinished, undefined, "only a real true counts");
  assert.equal(parseSessionSettings({ loginUnfinished: true }).loginUnfinished, true);
  const dir = await mkdtemp(join(tmpdir(), "magic-session-"));
  try {
    const path = join(dir, "session-settings.json");
    await writeSessionSettings(path, { ...parseSessionSettings({}), loginUnfinished: true });
    assert.equal((await readSessionSettings(path)).loginUnfinished, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

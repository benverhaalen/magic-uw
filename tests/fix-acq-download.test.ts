// owner: acquisition. RC3: the download host allowlist, main's redirect follower and the causes.
import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticSchema } from "@magic/contracts";
import {
  canvasFileHost,
  createPublicClient,
  MaterialReadError,
} from "../packages/connectors/src/network";
import {
  canvasFileDownloadUrl,
  causeHeaders,
  fetchCanvasFile,
  throwIfCause,
} from "../packages/connectors/src/canvas-file-download";
import { CanvasFailure } from "../packages/connectors/src/canvas-http";
import {
  causeDiagnostic,
  causeFromError,
  causeFromExtraction,
  documentTrialEvent,
} from "../packages/connectors/src/document-causes";

const origin = "https://canvas.wisc.edu";

test("allowed file hosts: the Canvas origin and Instructure's file hosts only", () => {
  const allowed: [string, string][] = [
    [`${origin}/courses/1/files/2/download`, "canvas"],
    ["https://a12-345.cluster7.canvas-user-content.com/files/2/download?sf_verifier=x", "files_domain"],
    ["https://canvas.canvas-user-content.com/files/2", "files_domain"],
    ["https://inst-fs-iad-prod.inscloudgate.net/files/u/name.pdf?token=t", "inst_fs"],
    ["https://inst-fs-pdx-beta.inscloudgate.net/files/u/n", "inst_fs"],
    ["https://instructure-uploads.s3.amazonaws.com/account_1/attachments/2/n.pdf", "s3_legacy"],
  ];
  for (const [url, kind] of allowed) assert.equal(canvasFileHost(url, origin), kind, url);
  const refused = [
    "http://inst-fs-iad-prod.inscloudgate.net/files/u/n", // not https
    "https://inst-fs-iad-prod.inscloudgate.net.evil.test/files/u", // suffix trick
    "https://evil-inst-fs-iad-prod.inscloudgate.net/files/u",
    "https://inscloudgate.net/files/u",
    "https://canvas-user-content.com.evil.test/files/2",
    "https://canvas-user-content.com/files/2", // no subdomain
    "https://other-bucket.s3.amazonaws.com/x",
    "https://canvas.wisc.edu:8443/files/2",
    "https://user:pw@canvas.wisc.edu/files/2",
    "https://canvas.instructure.com/files/2", // another Canvas origin
    "https://drive.google.com/file/d/x",
  ];
  for (const url of refused) assert.equal(canvasFileHost(url, origin), undefined, url);
});

test("only the course file download path is a session file read", () => {
  assert.ok(canvasFileDownloadUrl(`${origin}/courses/101/files/9/download?download_frd=1`, origin));
  for (const url of [
    `${origin}/courses/101/files/9/download?verifier=secret`,
    `${origin}/files/9/download`,
    `${origin}/courses/101/files/9`,
    `${origin}/courses/101/files/9/download/..%2f`,
    `https://evil.test/courses/101/files/9/download`,
  ])
    assert.equal(canvasFileDownloadUrl(url, origin), undefined, url);
});

function chain(steps: Record<string, Response | (() => Response)>) {
  const calls: { url: string; via: "session" | "plain"; credentials?: RequestCredentials }[] = [];
  const answer = (via: "session" | "plain") => async (url: string, init: RequestInit) => {
    calls.push({ url, via, ...(init.credentials ? { credentials: init.credentials } : {}) });
    assert.equal(init.redirect, "manual");
    const key = Object.keys(steps).find((prefix) => url.startsWith(prefix));
    if (!key) return new Response("", { status: 404 });
    const step = steps[key]!;
    return typeof step === "function" ? step() : step.clone();
  };
  return { calls, session: answer("session"), plain: answer("plain") };
}
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

test("the session carries only the Canvas hop; inst-fs is fetched without cookies", async () => {
  const fake = chain({
    [`${origin}/courses/101/files/9/download`]: redirect(
      "https://a1-9.cluster1.canvas-user-content.com/files/9/download?sf_verifier=v",
    ),
    "https://a1-9.cluster1.canvas-user-content.com/": redirect(
      "https://inst-fs-iad-prod.inscloudgate.net/files/u-9/reading.pdf?download=1&token=jwt",
    ),
    "https://inst-fs-iad-prod.inscloudgate.net/": new Response("%PDF-1.4 bytes", {
      headers: { "content-type": "application/pdf" },
    }),
  });
  const result = await fetchCanvasFile(`${origin}/courses/101/files/9/download?download_frd=1`, {
    origin,
    session: fake.session,
    plain: fake.plain,
  });
  assert.equal(result.hostClass, "inst_fs");
  assert.equal(result.hops, 2);
  assert.equal(await result.response.text(), "%PDF-1.4 bytes");
  assert.deepEqual(
    fake.calls.map((c) => [c.via, new URL(c.url).hostname, c.credentials]),
    [
      ["session", "canvas.wisc.edu", "include"],
      ["plain", "a1-9.cluster1.canvas-user-content.com", "omit"],
      ["plain", "inst-fs-iad-prod.inscloudgate.net", "omit"],
    ],
  );
});

test("a refused host stops the chain with redirect_blocked and the host only", async () => {
  const fake = chain({
    [`${origin}/courses/101/files/9/download`]: redirect(
      "https://files.unlisted-cdn.example/secret/path.pdf?token=abc",
    ),
  });
  await assert.rejects(
    fetchCanvasFile(`${origin}/courses/101/files/9/download?download_frd=1`, { origin, ...fake }),
    (error: unknown) => {
      assert.ok(error instanceof MaterialReadError);
      assert.equal(error.code, "redirect_blocked");
      assert.deepEqual(error.detail, { host: "files.unlisted-cdn.example" });
      const headers = causeHeaders(error);
      assert.deepEqual(headers, {
        "x-magic-cause": "redirect_blocked",
        "x-magic-cause-host": "files.unlisted-cdn.example",
      });
      assert.ok(!JSON.stringify(headers).includes("token"));
      return true;
    },
  );
  assert.equal(fake.calls.length, 1, "the refused host is never contacted");
});

test("a file host never redirects back into the Canvas session", async () => {
  const fake = chain({
    [`${origin}/courses/101/files/9/download`]: redirect("https://inst-fs-iad-prod.inscloudgate.net/files/u/x?token=t"),
    "https://inst-fs-iad-prod.inscloudgate.net/": redirect(`${origin}/api/v1/users/self`),
  });
  await assert.rejects(
    fetchCanvasFile(`${origin}/courses/101/files/9/download?download_frd=1`, { origin, ...fake }),
    (error: unknown) => error instanceof MaterialReadError && error.code === "redirect_blocked",
  );
  assert.equal(fake.calls.filter((c) => c.via === "session").length, 1);
});

test("Canvas's login redirect is a sign-in state; a file host 404 is http_404", async () => {
  const login = chain({ [`${origin}/courses/101/files/9/download`]: redirect(`${origin}/login/saml`) });
  await assert.rejects(
    fetchCanvasFile(`${origin}/courses/101/files/9/download?download_frd=1`, { origin, ...login }),
    (error: unknown) => causeFromError(error).cause === "needs_sign_in",
  );
  const gone = chain({
    [`${origin}/courses/101/files/9/download`]: redirect("https://inst-fs-iad-prod.inscloudgate.net/files/u/x?token=t"),
  });
  await assert.rejects(
    fetchCanvasFile(`${origin}/courses/101/files/9/download?download_frd=1`, { origin, ...gone }),
    (error: unknown) => {
      assert.deepEqual(causeFromError(error), { cause: "http_404" });
      return true;
    },
  );
});

test("main's cause headers become the same error in the worker", () => {
  const response = new Response("", {
    status: 502,
    headers: causeHeaders(new MaterialReadError("secret_origin_blocked", { host: "x.example" })),
  });
  assert.throws(() => throwIfCause(response), (error: unknown) => {
    assert.deepEqual(causeFromError(error), { cause: "secret_origin_blocked", host: "x.example" });
    return true;
  });
  assert.doesNotThrow(() => throwIfCause(new Response("ok")));
});

test("the earlier signed path reports the blocked inst-fs host, not a catch-all", async () => {
  const client = createPublicClient({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async ({ url }) =>
      url.origin === origin
        ? redirect("https://inst-fs-iad-prod.inscloudgate.net/files/u/x.pdf?token=jwt")
        : new Response("bytes"),
  });
  await assert.rejects(
    client.signedDownload(`${origin}/files/9/download?download_frd=1&verifier=v`, [origin]),
    (error: unknown) => {
      assert.deepEqual(causeFromError(error), {
        cause: "secret_origin_blocked",
        host: "inst-fs-iad-prod.inscloudgate.net",
      });
      return true;
    },
  );
});

test("every cause is a valid diagnostic with no URL; extraction outcomes are specific", () => {
  const outcomes = [
    causeFromError(new MaterialReadError("redirect_blocked", { host: "inst-fs-iad-prod.inscloudgate.net" })),
    causeFromError(new MaterialReadError("secret_origin_blocked", { host: "a.example" })),
    causeFromError(new MaterialReadError("http_error", { status: 500, host: "a.example" })),
    causeFromError(new MaterialReadError("byte_limit")),
    causeFromError(new CanvasFailure("inaccessible", "not_authorized")),
    causeFromError(new CanvasFailure("inaccessible", "file_locked")),
    causeFromError(new CanvasFailure("needs_sign_in")),
    causeFromExtraction({ status: "needs_ocr", diagnostics: ["textless_page"] }, "pdf"),
    causeFromExtraction({ status: "unsupported", diagnostics: ["format_unsupported"] }, "text"),
    causeFromExtraction({ status: "error", diagnostics: ["extraction_failed"] }, "office"),
    causeFromExtraction({ status: "partial", diagnostics: ["page_limit"] }, "pdf"),
  ];
  assert.deepEqual(
    outcomes.map((o) => causeDiagnostic(o).code),
    [
      "redirect_blocked",
      "secret_origin_blocked",
      "http_500",
      "too_large",
      "http_403",
      "locked",
      "needs_sign_in",
      "needs_ocr",
      "unsupported_type",
      "extract_failed.office",
      "too_large",
    ],
  );
  for (const outcome of outcomes) {
    const diagnostic = causeDiagnostic(outcome);
    diagnosticSchema.parse(diagnostic);
    const event = JSON.stringify(documentTrialEvent(outcome, { hostClass: "inst_fs", status: "failed", bytes: 10 }));
    assert.ok(!/https?:|token|verifier|\?/.test(event), event);
  }
  assert.deepEqual(causeDiagnostic(outcomes[0]!).path, ["host", "inst-fs-iad-prod.inscloudgate.net"]);
});

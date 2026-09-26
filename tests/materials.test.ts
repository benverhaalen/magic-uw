import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import {
  createPublicClient,
  isPublicAddress,
  type PinnedRequest,
} from "../packages/connectors/src/network.ts";
import {
  externalCourseConnector,
  extractLinkedText,
  robotsAllows,
} from "../packages/connectors/src/external.ts";
import {
  calendarConnector,
  parseCalendar,
} from "../packages/connectors/src/calendar.ts";
import {
  createDocumentManager,
  createLocalDocumentExtractor,
  createLocalOcrAdapter,
} from "../packages/connectors/src/documents.ts";
import {
  gitlabConnector,
  listGitlabProjects,
} from "../packages/connectors/src/gitlab.ts";
import {
  resourceInputSchema,
  type CaptureBatch,
} from "../packages/contracts/src/index.ts";

const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const plain = (text: string, status = 200, type = "text/plain") =>
  new Response(text, { status, headers: { "content-type": type } });
const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
  });
const collect = async (input: AsyncIterable<CaptureBatch>) => {
  const batches: CaptureBatch[] = [];
  for await (const item of input) batches.push(item);
  return batches;
};
const course = {
  accountScope: "synthetic-student",
  courseId: "42",
  courseName: "Synthetic History 101",
};
function publicClient(
  route: (request: PinnedRequest) => Response | Promise<Response>,
) {
  return createPublicClient({
    lookup,
    transport: async (input) => route(input),
  });
}
const calendarOptions = { ...course, canvasOrigin: "https://canvas.wisc.edu" };
const ics = (events: string) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events}\r\nEND:VCALENDAR\r\n`;

test("external transport pins public DNS, rejects private answers and strips access capabilities", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.2",
    "169.254.169.254",
    "192.168.1.1",
    "100.64.0.2",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "2001:db8::1",
    "2002:7f00:1::",
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  const requests: PinnedRequest[] = [];
  const client = publicClient((input) => {
    requests.push(input);
    return plain("course");
  });
  assert.equal(
    (await client.text("https://course.example.edu/spec")).text,
    "course",
  );
  assert.equal(requests[0]!.address.address, "93.184.216.34");
  assert.equal(
    Object.keys(requests[0]!.headers).some((name) =>
      /cookie|auth|token/i.test(name),
    ),
    false,
  );
  for (const url of [
    "https://user:pass@course.example.edu/",
    "https://course.example.edu/?token=secret",
    "https://course.example.edu/?X-Amz-Signature=secret",
    "https://canvas.wisc.edu/courses/42",
  ])
    await assert.rejects(client.get(url));
  const bad = createPublicClient({
    lookup: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
    transport: async () => {
      assert.fail("No request may start");
    },
  });
  await assert.rejects(
    bad.get("https://course.example.edu/"),
    /non_public_address/,
  );
});

test("redirects repeat public DNS validation and never forward capabilities", async () => {
  let calls = 0;
  const client = createPublicClient({
    lookup: async (host) => [
      {
        address: host === "private.example" ? "10.0.0.1" : "93.184.216.34",
        family: 4,
      },
    ],
    transport: async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { location: "https://private.example/course" },
      });
    },
  });
  await assert.rejects(
    client.get("https://course.example.edu/"),
    /non_public_address/,
  );
  assert.equal(calls, 1);
  const signed = publicClient((input) =>
    input.url.hostname === "canvas.wisc.edu"
      ? new Response(null, {
          status: 302,
          headers: {
            location:
              "https://instructure-uploads.s3.amazonaws.com/file?X-Amz-Signature=synthetic",
          },
        })
      : plain("file"),
  );
  assert.equal(
    await (
      await signed.signedDownload(
        "https://canvas.wisc.edu/files/1/download?verifier=synthetic",
        [
          "https://canvas.wisc.edu",
          "https://instructure-uploads.s3.amazonaws.com",
        ],
      )
    ).response.text(),
    "file",
  );
  await assert.rejects(
    signed.signedDownload(
      "https://canvas.wisc.edu/files/1/download?verifier=synthetic",
      ["https://canvas.wisc.edu"],
    ),
    /secret_origin_blocked/,
  );
});

test("shared external transport caps a host at two active response streams", async () => {
  let active = 0,
    peak = 0;
  const finish: (() => void)[] = [];
  const client = publicClient(() => {
    active++;
    peak = Math.max(peak, active);
    return new Response(
      new ReadableStream({
        start(controller) {
          finish.push(() => {
            active--;
            controller.enqueue(new TextEncoder().encode("ok"));
            controller.close();
          });
        },
      }),
    );
  });
  const reads = [1, 2, 3, 4].map((i) =>
    client.text(`https://course.example.edu/${i}`),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(finish.length, 2);
  finish.splice(0).forEach((done) => done());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(finish.length, 2);
  finish.splice(0).forEach((done) => done());
  await Promise.all(reads);
  assert.equal(peak, 2);
});

test("crawler expands redirected course folder, reads embedded schedule JSON, routes Canvas, obeys robots", async () => {
  const visited: string[] = [];
  const canvas: string[] = [];
  const client = publicClient(({ url }) => {
    visited.push(url.href);
    if (url.pathname === "/robots.txt")
      return plain("User-agent: *\nDisallow: /new/private\n");
    if (url.hostname === "www.course.example.edu")
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://pages.course.example.edu/new/index.html",
        },
      });
    if (url.pathname === "/new/index.html")
      return plain(
        '<title>History</title><p>Loading schedule</p><script type="application/json">{"week":"Read Chapter 1","url":"week.json"}</script><a href="https://canvas.wisc.edu/courses/42/assignments/9">Canvas</a><a href="private/spec">Private</a><a href="/other/site">Other course</a>',
        200,
        "text/html",
      );
    if (url.pathname === "/new/week.json")
      return plain(
        '{"reading":"Read Chapter 2","url":"https://pages.course.example.edu/new/notes.txt"}',
        200,
        "application/json",
      );
    if (url.pathname === "/new/notes.txt") return plain("Review the dates");
    throw new Error("unexpected request");
  });
  const [batch] = await collect(
    externalCourseConnector({
      ...course,
      seeds: ["https://www.course.example.edu/old/index.html"],
      client,
      onCanvasLink: (url) => {
        canvas.push(url);
      },
    }).pull(),
  );
  assert.equal(batch!.status, "partial");
  assert.equal(batch!.resources.length, 3);
  assert.match(batch!.resources[0]!.text, /Read Chapter 1/);
  assert.equal(canvas.length, 1);
  assert.equal(
    visited.some(
      (url) => url.includes("private/spec") || url.includes("/other/site"),
    ),
    false,
  );
  assert.equal(
    batch!.diagnostics?.some((item) => item.code === "robots_disallowed"),
    true,
  );
});

test("external capture removes capability URLs from markup, prose and embedded JSON while preserving ordinary links", async () => {
  const secrets = [
    "HTML_SIGNATURE_SECRET",
    "CALENDAR_SECRET",
    "RELATIVE_SECRET",
    "JSON_SECRET",
    "ENCODED_SECRET",
    "FRAGMENT_SECRET",
    "MARKDOWN_SECRET",
  ];
  const html = `<title>History readings</title><p><strong>Read Chapter 2</strong></p>
    <a href="https://files.example.edu/book.pdf?X-Amz-Signature=${secrets[0]}">Signed reading</a>
    <p>https://canvas.wisc.edu/feeds/calendars/course_${secrets[1]}.ics</p>
    <a href="download.pdf?foo=1&amp;sig=${secrets[2]}">Temporary file</a>
    <script type="application/json">{"week":"Review the dates","url":"https:\\/\\/files.example.edu\\/notes?token=${secrets[3]}"}</script>
    <p>${encodeURIComponent(`https://files.example.edu/notes?token=${secrets[4]}`)}</p>
    <p>https://files.example.edu/notes#access_token=${secrets[5]}</p>
    <a href="https://library.example.edu/readings">Library</a><a href="instructions.md">Instructions</a>`;
  const visited: string[] = [];
  const client = publicClient(({ url }) => {
    visited.push(url.href);
    if (url.pathname === "/robots.txt") return plain("");
    if (url.pathname.endsWith("index.html"))
      return plain(html, 200, "text/html");
    if (url.pathname.endsWith("instructions.md"))
      return plain(
        `## Requirements\n[Reading](https://files.example.edu/readme?verifier=${secrets[6]})\n[Public guide](https://library.example.edu/guide)\nKeep this paragraph.`,
      );
    throw new Error("Unexpected URL must not be fetched");
  });
  const batches = await collect(
    externalCourseConnector({
      ...course,
      seeds: ["https://course.example.edu/class/index.html"],
      client,
    }).pull(),
  );
  assert.ok(batches.every((batch) => batch.complete));
  const stored = JSON.stringify(batches);
  for (const secret of secrets) assert.ok(!stored.includes(secret), secret);
  const page = batches[0]!.resources.find((resource) => resource.rawHtml)!;
  assert.match(page.rawHtml!, /<strong>Read Chapter 2<\/strong>/);
  assert.match(page.text, /Review the dates/);
  assert.ok(page.links!.includes("https://library.example.edu/readings"));
  const markdown = batches[0]!.resources.find((resource) =>
    resource.url.endsWith("instructions.md"),
  )!;
  assert.match(markdown.text, /Keep this paragraph/);
  assert.ok(markdown.links!.includes("https://library.example.edu/guide"));
  assert.equal(visited.filter((url) => !url.endsWith("robots.txt")).length, 2);
  const cached = await collect(
    externalCourseConnector({
      ...course,
      seeds: ["https://course.example.edu/class/index.html"],
      client,
      previous: [
        {
          ...page,
          text: `Old https://files.example.edu/?token=${secrets[0]}`,
          rawHtml: html,
        },
      ],
    }).pull(),
  );
  for (const secret of secrets)
    assert.ok(!JSON.stringify(cached).includes(secret), `cache ${secret}`);
});

test("external limits and broken robots never report complete; prior good content survives shape loss", async () => {
  const client = publicClient(({ url }) =>
    url.pathname === "/robots.txt"
      ? plain("", 404)
      : plain(
          '<title>Course</title><a href="next.html">Next</a>',
          200,
          "text/html",
        ),
  );
  const [limited] = await collect(
    externalCourseConnector({
      ...course,
      seeds: ["https://course.example.edu/class/index.html"],
      client,
      maxPages: 1,
    }).pull(),
  );
  assert.equal(limited!.complete, false);
  assert.equal(
    limited!.diagnostics?.some((item) => item.code === "page_limit"),
    true,
  );
  const denied = publicClient(() => plain("failure", 503));
  const [unread] = await collect(
    externalCourseConnector({
      ...course,
      seeds: ["https://course.example.edu/class/index.html"],
      client: denied,
    }).pull(),
  );
  assert.equal(unread!.complete, false);
  assert.equal(unread!.resources.length, 0);
  const old = resourceInputSchema.parse({
    externalId: "old",
    kind: "material",
    courseId: course.courseId,
    courseName: course.courseName,
    url: "https://course.example.edu/class/index.html",
    title: "Good",
    text: "Requirements ".repeat(100),
    crawl: { observedAt: "2025-01-01T00:00:00Z" },
  });
  const [drift] = await collect(
    externalCourseConnector({
      ...course,
      seeds: [old.url],
      client,
      previous: [old],
      force: true,
    }).pull(),
  );
  assert.equal(drift!.status, "needs_attention");
  assert.equal(drift!.resources[0]!.text, old.text);
});

test("six-hour cached stored resources do not refetch or fail on runtime fields", async () => {
  const previous = {
    ...resourceInputSchema.parse({
      externalId: "old",
      kind: "material",
      courseId: course.courseId,
      courseName: course.courseName,
      url: "https://course.example.edu/class/index.html",
      title: "Good",
      text: "Requirements",
      crawl: { observedAt: "2026-09-26T10:00:00Z" },
    }),
    id: "runtime-id",
    version: 3,
  };
  let pageCalls = 0;
  const client = publicClient(({ url }) => {
    if (url.pathname === "/robots.txt") return plain("", 404);
    pageCalls++;
    return plain("bad");
  });
  const [batch] = await collect(
    externalCourseConnector({
      ...course,
      seeds: [previous.url],
      client,
      previous: [previous],
      now: () => new Date("2026-09-26T12:00:00Z"),
    }).pull(),
  );
  assert.equal(batch!.complete, true);
  assert.equal(pageCalls, 0);
  assert.equal(batch!.resources[0]!.text, "Requirements");
});

test("link parser never executes scripts and robots longest allow wins", () => {
  const parsed = extractLinkedText(
    '<h1>Readings</h1><script>globalThis.compromised=true</script><a href="spec.pdf?token=secret">Bad</a><a href="./week.md">Good</a>',
    "https://course.example.edu/term/index.html",
  );
  assert.equal(parsed.links.length, 1);
  assert.equal(parsed.text.includes("compromised"), false);
  assert.equal(
    robotsAllows(
      "User-agent: *\nDisallow: /class/*\nAllow: /class/public$",
      "https://course.example.edu/class/public",
    ),
    true,
  );
  assert.equal(
    robotsAllows(
      "User-agent: *\nDisallow: /class/*\nAllow: /class/public$",
      "https://course.example.edu/class/private",
    ),
    false,
  );
  assert.equal(
    robotsAllows(
      "User-agent: *\nDisallow: /class/private",
      "https://course.example.edu/class/%70rivate",
    ),
    false,
  );
  const notebook = extractLinkedText(
    JSON.stringify({
      cells: [
        {
          source: ["Read [spec](spec.md).\n", "data = 'table.csv'"],
          outputs: [{ text: "Discard output" }],
        },
      ],
    }),
    "https://course.example.edu/class/lab.ipynb",
    false,
  );
  assert.equal(notebook.text.includes("Discard output"), false);
  assert.equal(
    notebook.links.includes("https://course.example.edu/class/spec.md"),
    true,
  );
  assert.equal(
    notebook.links.includes("https://course.example.edu/class/table.csv"),
    true,
  );
});

test("calendar RFC folded lines, timezone, UID, modification and date-only end stay distinct", async () => {
  const parsed = await parseCalendar(
    ics(
      "BEGIN:VEVENT\r\nUID:assignment-9\r\nSUMMARY:Long title\r\n continued\r\nDTSTART;TZID=America/Chicago:20261001T170000\r\nDTEND;TZID=America/Chicago:20261001T173000\r\nLAST-MODIFIED:20260926T120000Z\r\nURL:https://canvas.wisc.edu/courses/42/assignments/9\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:reading-day\r\nSUMMARY:Reading day\r\nDTSTART;VALUE=DATE:20261002\r\nDTEND;VALUE=DATE:20261003\r\nEND:VEVENT",
    ),
    calendarOptions,
  );
  assert.equal(parsed.diagnostics.length, 0);
  assert.equal(parsed.resources.length, 2);
  const timed = parsed.resources.find(
    (item) => item.calendar?.uid === "assignment-9",
  )!;
  assert.equal(timed.title, "Long titlecontinued");
  assert.equal(timed.calendar!.start, "2026-10-01T22:00:00.000Z");
  assert.equal(timed.calendar!.assignmentExternalId, "9");
  assert.equal(timed.deadlines[0]!.kind, "due");
  const day = parsed.resources.find(
    (item) => item.calendar?.uid === "reading-day",
  )!;
  assert.equal(day.calendar!.start, "2026-10-02");
  assert.equal(day.calendar!.end, "2026-10-03");
  assert.equal(day.deadlines.length, 0);
  assert.equal(day.kind, "event");
});

test("calendar transport protects feed secret, blocks redirects, and never accepts login or ambiguous time", async () => {
  const secret =
    "https://canvas.wisc.edu/feeds/calendars/course_synthetic-secret.ics";
  const requests: PinnedRequest[] = [];
  const client = publicClient((input) => {
    requests.push(input);
    return plain(
      ics(
        "BEGIN:VEVENT\r\nUID:local\r\nSUMMARY:Unknown timezone\r\nDTSTART:20261001T170000\r\nEND:VEVENT",
      ),
      200,
      "text/calendar",
    );
  });
  const [batch] = await collect(
    calendarConnector({ ...calendarOptions, client, feedUrl: secret }).pull(),
  );
  assert.equal(batch!.complete, false);
  assert.equal(batch!.resources.length, 0);
  assert.equal(JSON.stringify(batch).includes("synthetic-secret"), false);
  assert.equal(
    Object.keys(requests[0]!.headers).some((key) =>
      /cookie|token|auth/i.test(key),
    ),
    false,
  );
  const redirect = publicClient(
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://outside.example/feed" },
      }),
  );
  await assert.rejects(
    redirect.feed(secret, calendarOptions.canvasOrigin),
    /redirect_blocked/,
  );
  const html = publicClient(() =>
    plain("<html>login</html>", 200, "text/html"),
  );
  const [failed] = await collect(
    calendarConnector({
      ...calendarOptions,
      client: html,
      feedUrl: secret,
    }).pull(),
  );
  assert.equal(failed!.resources.length, 0);
  assert.equal(failed!.complete, false);
});

test("cancelled calendar events retain evidence without an active due claim", async () => {
  const result = await parseCalendar(
    ics(
      "BEGIN:VEVENT\r\nUID:cancelled\r\nSUMMARY:Cancelled assignment\r\nDTSTART:20261001T170000Z\r\nSTATUS:CANCELLED\r\nURL:https://canvas.wisc.edu/courses/42/assignments/9\r\nEND:VEVENT",
    ),
    calendarOptions,
  );
  assert.equal(result.resources[0]!.workflowState, "CANCELLED");
  assert.equal(result.resources[0]!.deadlines.length, 0);
});

function simplePdf(text: string): Uint8Array {
  const stream = text ? `BT /F1 12 Tf 72 700 Td (${text}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

test("file manager streams hashes, omits signed URL, skips matching update, and removes over-limit temporary file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magic-material-test-"));
  let downloads = 0;
  try {
    const client = publicClient(() => {
      downloads++;
      return plain("Synthetic course specification");
    });
    let extractions = 0;
    const extractor = createLocalDocumentExtractor();
    const manager = createDocumentManager({
      directory,
      client,
      extractor: {
        async extract(file, options) {
          extractions++;
          return extractor.extract(file, options);
        },
      },
    });
    const input = {
      id: "file-9",
      sourceUrl: "https://canvas.wisc.edu/courses/42/files/9",
      downloadUrl:
        "https://instructure-uploads.s3.amazonaws.com/spec?X-Amz-Signature=synthetic-secret",
      allowedDownloadOrigins: ["https://instructure-uploads.s3.amazonaws.com"],
      filename: "spec.txt",
      updatedAt: "2026-09-26T00:00:00Z",
    };
    const first = await manager.capture(input);
    assert.equal(first.status, "ok");
    assert.equal(first.text, "Synthetic course specification");
    assert.equal(first.document.sha256?.length, 64);
    assert.equal(JSON.stringify(first).includes("synthetic-secret"), false);
    const second = await manager.capture({
      ...input,
      previous: first.document,
      cached: first,
    });
    assert.equal(second.skipped, true);
    assert.equal(downloads, 1);
    assert.equal(extractions, 1);
    assert.deepEqual(second.parts, first.parts);
    const short = createDocumentManager({
      directory: join(directory, "limit"),
      client,
      maxBytes: 5,
    });
    await assert.rejects(
      short.capture({ ...input, id: "too-big" }),
      /byte_limit/,
    );
    assert.deepEqual(await readdir(join(directory, "limit")), []);
    const login = createDocumentManager({
      directory: join(directory, "login"),
      client: publicClient(() =>
        plain(
          '<html><title>Sign in</title><input type="password"></html>',
          200,
          "application/pdf",
        ),
      ),
    });
    await assert.rejects(
      login.capture({ ...input, id: "login-page" }),
      /login_page/,
    );
    assert.deepEqual(await readdir(join(directory, "login")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real local PDF text extraction retains pages, and OCR only runs for textless urgent/open pages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magic-pdf-test-"));
  let ocrCalls = 0;
  try {
    const textFile = join(directory, "text.pdf");
    const emptyFile = join(directory, "scan.pdf");
    await writeFile(textFile, simplePdf("Synthetic requirement"));
    await writeFile(emptyFile, simplePdf(""));
    const extractor = createLocalDocumentExtractor({
      ocr: {
        async page() {
          ocrCalls++;
          return "OCR synthetic text";
        },
      },
    });
    const text = await extractor.extract(textFile, { dueSoon: true });
    assert.equal(text.status, "ok");
    assert.match(text.text, /Synthetic requirement/);
    assert.equal(text.pages[0]!.anchor, "#page=1");
    assert.equal(ocrCalls, 0);
    const pending = await extractor.extract(emptyFile, {});
    assert.equal(pending.status, "needs_ocr");
    assert.equal(ocrCalls, 0);
    const opened = await extractor.extract(emptyFile, { opened: true });
    assert.equal(opened.text, "OCR synthetic text");
    assert.equal(ocrCalls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local Office converter retains slide anchors, resolves worksheet shared strings, and extracts DOCX text", async () => {
  const { zipSync } = createRequire(
    new URL("../packages/connectors/package.json", import.meta.url),
  )("fflate") as { zipSync(input: Record<string, Uint8Array>): Uint8Array };
  const directory = await mkdtemp(join(tmpdir(), "magic-office-test-"));
  const extractor = createLocalDocumentExtractor();
  try {
    for (const [name, entries, expected] of [
      [
        "slides.pptx",
        {
          "ppt/slides/slide2.xml":
            "<p:sld><a:p><a:t>Second slide</a:t></a:p></p:sld>",
          "ppt/slides/slide1.xml":
            "<p:sld><a:p><a:t>First slide</a:t></a:p></p:sld>",
        },
        "First slide",
      ],
      [
        "spec.docx",
        {
          "word/document.xml":
            "<w:document><w:p><w:t>Write an essay</w:t></w:p></w:document>",
        },
        "Write an essay",
      ],
      [
        "data.xlsx",
        {
          "xl/sharedStrings.xml": "<sst><si><t>Population</t></si></sst>",
          "xl/worksheets/sheet1.xml":
            '<worksheet><c r="A1" t="s"><v>0</v></c></worksheet>',
        },
        "A1: Population",
      ],
    ] as const) {
      const file = join(directory, name);
      await writeFile(
        file,
        zipSync(
          Object.fromEntries(
            Object.entries(entries).map(([key, value]) => [
              key,
              new TextEncoder().encode(value),
            ]),
          ),
        ),
      );
      const result = await extractor.extract(file, {});
      assert.equal(result.status, "ok");
      assert.match(result.text, new RegExp(expected));
      if (name.endsWith("pptx"))
        assert.deepEqual(
          result.parts.map((part) => part.slide),
          [1, 2],
        );
    }
    assert.throws(
      () =>
        createLocalOcrAdapter({
          pdftoppmPath: "pdftoppm",
          tesseractPath: "tesseract",
          tessdataDirectory: "data",
        }),
      /absolute_paths/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("GitLab uses only fixed origin GET and token remains transient across paged scopes", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path === "/api/v4/projects/7")
      return json({
        id: 7,
        name: "Project spec",
        web_url: "https://git.doit.wisc.edu/class/project",
        default_branch: "main",
      });
    if (path.endsWith("/repository/tree"))
      return json([
        { id: "blob1", type: "blob", name: "README.md", path: "README.md" },
        { id: "blob1", type: "blob", name: "spec.md", path: "spec.md" },
      ]);
    if (path.endsWith("/repository/commits"))
      return json([
        {
          id: "abc123",
          title: "Work saved",
          message: "Work saved",
          web_url: "https://git.doit.wisc.edu/class/project/-/commit/abc123",
          committed_date: "2026-09-26T12:00:00Z",
        },
      ]);
    if (path.includes("/repository/files/")) {
      const content = "## Course requirements";
      return json({
        file_path: decodeURIComponent(path.split("/repository/files/")[1]!),
        encoding: "base64",
        content: Buffer.from(content).toString("base64"),
        size: content.length,
        last_commit_id: "real-commit-sha",
      });
    }
    if (path.endsWith("/issues") && parsed.searchParams.get("page") === "1")
      return json(
        [
          {
            id: 4,
            title: "Clarification",
            web_url: "https://git.doit.wisc.edu/class/project/-/issues/1",
            description: "Question",
          },
        ],
        { "x-next-page": "2" },
      );
    if (path.endsWith("/merge_requests"))
      return json([
        {
          id: 5,
          title: "Attempt",
          state: "merged",
          web_url: "https://git.doit.wisc.edu/class/project/-/merge_requests/1",
        },
      ]);
    if (path.endsWith("/wikis"))
      return json([{ slug: "home", title: "Course instructions" }]);
    if (path.endsWith("/wikis/home"))
      return json({ content: "Wiki specification" });
    return json([]);
  };
  const batches = await collect(
    gitlabConnector({
      fetch,
      token: "synthetic-gitlab-token",
      accountScope: course.accountScope,
      courses: [{ ...course, projectId: "7" }],
    }).pull(),
  );
  assert.equal(batches.length, 8);
  assert.equal(
    batches.every((batch) => batch.complete),
    true,
  );
  assert.equal(
    JSON.stringify(batches).includes("synthetic-gitlab-token"),
    false,
  );
  assert.equal(
    requests.every(
      (request) =>
        new URL(request.url).origin === "https://git.doit.wisc.edu" &&
        request.init?.method === "GET" &&
        request.init.redirect === "manual" &&
        request.init.credentials === "omit",
    ),
    true,
  );
  const commit = batches
    .flatMap((batch) => batch.resources)
    .find((resource) => resource.gitlab?.evidenceKind === "commit")!;
  assert.equal(commit.submitted, null);
  assert.equal(commit.gitlab!.submissionEvidence, true);
  assert.equal(
    batches
      .flatMap((batch) => batch.resources)
      .some((resource) => resource.text === "## Course requirements"),
    true,
  );
  const tree = batches.find(
    (batch) => batch.source.scope === "gitlab:tree",
  )!.resources;
  assert.equal(tree.length, 2);
  assert.notEqual(tree[0]!.externalId, tree[1]!.externalId);
  assert.equal(tree[0]!.gitlab!.blobSha, "blob1");
  assert.equal(tree[0]!.gitlab!.commitSha, undefined);
  assert.equal(
    batches.find((batch) => batch.source.scope === "gitlab:instruction_files")!
      .resources[0]!.gitlab!.commitSha,
    "real-commit-sha",
  );
});

test("GitLab HTML and Markdown instruction captures remove capability URLs without losing public instructions", async () => {
  const contents: Record<string, string> = {
    "spec.html":
      '<h1>Project requirements</h1><a href="https://files.example.edu/spec?Signature=GITLAB_HTML_SECRET">Spec</a><p>https://canvas.wisc.edu/feeds/calendars/course_GITLAB_CALENDAR_SECRET.ics</p><a href="https://docs.example.edu/reference">Public reference</a>',
    "README.md":
      "# Build the project\n[Download](https://files.example.edu/spec?verifier=GITLAB_MARKDOWN_SECRET)\nUse https://docs.example.edu/guide for details.",
  };
  const fetch = async (input: string) => {
    const path = new URL(input).pathname;
    if (path === "/api/v4/projects/7")
      return json({
        id: 7,
        name: "Project",
        web_url: "https://git.doit.wisc.edu/class/project",
        default_branch: "main",
        description:
          "Project notes https://files.example.edu/?token=GITLAB_DESCRIPTION_SECRET",
      });
    if (path.endsWith("/repository/tree"))
      return json(
        Object.keys(contents).map((path, index) => ({
          id: `blob${index}`,
          type: "blob",
          name: path,
          path,
        })),
      );
    if (path.includes("/repository/files/")) {
      const file_path = decodeURIComponent(
          path.split("/repository/files/")[1]!,
        ),
        content = contents[file_path]!;
      return json({
        file_path,
        encoding: "base64",
        content: Buffer.from(content).toString("base64"),
        size: Buffer.byteLength(content),
      });
    }
    return json([]);
  };
  const batches = await collect(
    gitlabConnector({
      fetch,
      accountScope: course.accountScope,
      courses: [{ ...course, projectId: "7" }],
    }).pull(),
  );
  assert.ok(batches.every((batch) => batch.complete));
  assert.ok(
    !/GITLAB_(?:HTML|CALENDAR|MARKDOWN|DESCRIPTION)_SECRET/.test(
      JSON.stringify(batches),
    ),
  );
  const files = batches.find(
    (batch) => batch.source.scope === "gitlab:instruction_files",
  )!.resources;
  assert.equal(files.length, 2);
  assert.match(files[0]!.rawHtml!, /<h1>Project requirements<\/h1>/);
  assert.match(files[1]!.text, /# Build the project/);
  assert.ok(files[0]!.links!.includes("https://docs.example.edu/reference"));
  assert.ok(files[1]!.links!.includes("https://docs.example.edu/guide"));
});

test("GitLab untrusted pagination/login keeps prior records and incomplete tree cannot delete instruction files", async () => {
  const projects = await listGitlabProjects({
    accountScope: course.accountScope,
    fetch: async () =>
      json(
        [{ id: 1, name: "A", web_url: "https://git.doit.wisc.edu/class/a" }],
        { link: '<https://evil.example/api/v4/projects?page=2>; rel="next"' },
      ),
  });
  assert.equal(projects.complete, false);
  assert.equal(projects.projects.length, 1);
  const fetch = async (url: string) =>
    new URL(url).pathname === "/api/v4/projects/7"
      ? json({
          id: 7,
          name: "Project",
          web_url: "https://git.doit.wisc.edu/class/a",
          default_branch: "main",
        })
      : new URL(url).pathname.endsWith("/repository/tree")
        ? plain("<html>login</html>", 200, "text/html")
        : json([]);
  const batches = await collect(
    gitlabConnector({
      fetch,
      accountScope: course.accountScope,
      courses: [{ ...course, projectId: "7" }],
    }).pull(),
  );
  assert.equal(
    batches.find((batch) => batch.source.scope === "gitlab:tree")!.status,
    "needs_sign_in",
  );
  assert.equal(
    batches.find((batch) => batch.source.scope === "gitlab:instruction_files")!
      .complete,
    false,
  );
});

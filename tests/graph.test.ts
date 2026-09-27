/**
 * T30: Outlook, OneNote and OneDrive through Microsoft Graph. A fake Graph answers every request;
 * nothing here opens a socket.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import {
  captureBatchSchema,
  OUTLOOK_CALENDAR_COURSE_ID,
  OUTLOOK_MAIL_COURSE_ID,
  UNMAPPED_COURSE_ID,
} from "@magic/contracts";
import fixture from "../fixtures/course.json";
import {
  appFolderDelta,
  appFolderGet,
  appFolderPut,
  categorizeMail,
  checkedGraphUrl,
  courseAliases,
  findJoinLink,
  graphEventKey,
  graphSourceIds,
  oneNoteText,
  streamsFor,
  syncGraph,
  type DeltaState,
  type GraphRequest,
  type GraphResponse,
  type MailContext,
} from "../packages/connectors/src/graph";
import { outlookCalendarConnector, calendarPublishGuide } from "../packages/connectors/src/calendar";
import { createPublicClient, type PublicClient } from "../packages/connectors/src/network";

const G = "https://graph.microsoft.com/v1.0";
const NOW = new Date("2026-09-26T15:00:00.000Z");
const ok = (value: unknown, headers: Record<string, string> = {}): GraphResponse => ({
  status: 200,
  headers,
  body: typeof value === "string" ? value : JSON.stringify(value),
});
function memoryState(initial: Record<string, string> = {}): DeltaState & { values: Record<string, string> } {
  const values = { ...initial };
  return {
    values,
    async get(key) {
      return values[key] || undefined;
    },
    async set(key, value) {
      if (value === null) delete values[key];
      else values[key] = value;
    },
  };
}
function fakeGraph(route: (request: GraphRequest) => GraphResponse | undefined) {
  const log: GraphRequest[] = [];
  return {
    log,
    transport: async (request: GraphRequest) => {
      log.push(request);
      checkedGraphUrl(request.url, request.method ?? "GET"); // the worker only asks for allowlisted URLs
      const answer = route(request);
      if (!answer) throw new Error(`unexpected ${request.url}`);
      return answer;
    },
  };
}
const context: MailContext = {
  courses: [
    { courseId: "400", accountScope: "uw", courseName: "Programming III", courseCode: "COMP SCI 400: Programming III (001) FA26" },
    { courseId: "240", accountScope: "uw", courseName: "Introduction to Discrete Mathematics", courseCode: "MATH 240", staffEmails: ["ta240@wisc.edu"] },
  ],
  advisorNames: ["Jordan Rivera"],
  canvasOrigin: "https://canvas.wisc.edu",
};
function message(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    conversationId: `c-${id}`,
    subject: `Subject ${id}`,
    bodyPreview: `Preview ${id}`,
    receivedDateTime: "2026-09-25T12:00:00Z",
    from: { emailAddress: { name: "Someone", address: "someone@gmail.com" } },
    importance: "normal",
    hasAttachments: false,
    webLink: `https://outlook.office365.com/owa/?ItemID=${id}&exvsurl=1&viewmodel=ReadMessageItem`,
    isRead: false,
    ...extra,
  };
}
function event(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    iCalUId: `uid-${id}`,
    subject: `Event ${id}`,
    start: { dateTime: "2026-09-27T15:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-09-27T16:00:00.0000000", timeZone: "UTC" },
    isAllDay: false,
    webLink: `https://outlook.office365.com/owa/?itemid=${id}&exvsurl=1&path=/calendar/item`,
    ...extra,
  };
}
const mailDelta = (n: number) => `${G}/me/mailFolders('inbox')/messages/delta?$deltatoken=m${n}`;
const calDelta = (n: number) => `${G}/me/calendarView/delta?$deltatoken=c${n}`;

test("first sync reads every page; a check with nothing new costs one request per folder", async () => {
  const state = memoryState();
  let round = 1;
  const graph = fakeGraph(({ url }) => {
    if (url.includes("/mailFolders/inbox/messages/delta"))
      return ok({ value: [message("m1")], "@odata.nextLink": `${G}/me/mailFolders('inbox')/messages/delta?$skiptoken=p2` });
    if (url.includes("$skiptoken=p2")) return ok({ value: [message("m2")], "@odata.deltaLink": mailDelta(1) });
    if (url.includes("/calendarView/delta?startDateTime")) return ok({ value: [event("e1")], "@odata.deltaLink": calDelta(1) });
    if (url === mailDelta(round)) return ok({ value: [], "@odata.deltaLink": mailDelta(round + 1) });
    if (url === calDelta(round)) return ok({ value: [], "@odata.deltaLink": calDelta(round + 1) });
    return undefined;
  });
  const run = () =>
    syncGraph({ transport: graph.transport, state, accountScope: "local", previous: () => [], context, now: () => NOW });
  const first = await run();
  assert.equal(first.requests, 3);
  assert.equal(first.batches.length, 2);
  const mail = first.batches.find((b) => b.source.kind === "mail")!;
  assert.equal(mail.resources.length, 2);
  assert.equal(mail.source.courseId, OUTLOOK_MAIL_COURSE_ID);
  // $select limits the fields; the page size is asked for.
  assert.match(
    graph.log[0]!.url,
    /\?\$select=id,conversationId,from,.*&\$filter=receivedDateTime%20ge%202026-08-12T15%3A00%3A00\.000Z$/,
  );
  assert.equal(graph.log[0]!.prefer, "odata.maxpagesize=100");
  assert.match(graph.log.find((r) => r.url.includes("calendarView"))!.prefer!, /outlook\.timezone="UTC"/);
  // Nothing advances until the batches are saved.
  assert.equal(state.values["graph:delta:mail:inbox"], undefined);
  await first.commit();
  assert.equal(state.values["graph:delta:mail:inbox"], mailDelta(1));
  const second = await run();
  assert.equal(second.requests, 2, "one request per stream (inbox, calendar)");
  assert.equal(second.batches.length, 0, "nothing new: no store work");
  assert.equal(second.changed, false);
});

test("410 restarts the stream with a full sync; 429/503 wait Retry-After; 401 refreshes once", async () => {
  const state = memoryState({ "graph:delta:mail:inbox": mailDelta(7) });
  const slept: number[] = [];
  let throttled = 0;
  const graph = fakeGraph(({ url, forceRefresh }) => {
    if (url === mailDelta(7)) return { status: 410, headers: {}, body: "" };
    if (url.includes("/mailFolders/inbox/messages/delta")) {
      if (throttled++ < 1) return { status: 429, headers: { "retry-after": "2" }, body: "" };
      return ok({ value: [message("fresh")], "@odata.deltaLink": mailDelta(8) });
    }
    if (url.includes("calendarView")) {
      if (!forceRefresh) return { status: 401, headers: {}, body: "" };
      return ok({ value: [], "@odata.deltaLink": calDelta(1) });
    }
    return undefined;
  });
  const result = await syncGraph({
    transport: graph.transport,
    state,
    accountScope: "local",
    previous: () => [],
    context,
    now: () => NOW,
    sleep: async (ms) => void slept.push(ms),
  });
  assert.deepEqual(slept, [2000]);
  assert.deepEqual(result.failures, {});
  const mail = result.batches.find((b) => b.source.kind === "mail")!;
  assert.deepEqual(mail.resources.map((r) => r.mail!.messageId), ["fresh"], "a resync replaces, not merges");
  const refreshed = graph.log.filter((r) => r.url.includes("calendarView"));
  assert.equal(refreshed.length, 2);
  assert.equal(refreshed[1]!.forceRefresh, true);
  await result.commit();
  assert.equal(state.values["graph:delta:mail:inbox"], mailDelta(8));
});

test("a 401 after the silent refresh is 'unauthorized' and writes nothing", async () => {
  const graph = fakeGraph(() => ({ status: 401, headers: {}, body: "" }));
  const result = await syncGraph({ transport: graph.transport, state: memoryState(), accountScope: "local", previous: () => [], context, now: () => NOW });
  assert.equal(result.failures.mail, "unauthorized");
  assert.equal(result.batches.length, 0);
  assert.equal(graph.log.length, 2, "one refresh, one retry, then stop: no loop");
});

test("course matching is code with a reason: staff, course code, course name, Canvas notification", () => {
  const facts = (over: Partial<Parameters<typeof categorizeMail>[0]>) => categorizeMail({ subject: "", preview: "", ...over }, context);
  const staff = facts({ fromAddress: "TA240@wisc.edu", subject: "office hours" });
  assert.equal(staff.category, "course");
  assert.equal(staff.courseId, "240");
  assert.match(staff.reason, /course staff/);
  for (const subject of ["CS400 exam room", "COMP SCI 400 exam room", "[COMPSCI 400] project", "cs 400 due"]) {
    const m = facts({ fromAddress: "prof@cs.wisc.edu", subject });
    assert.equal(m.courseId, "400", subject);
    assert.match(m.reason, /course code/);
  }
  assert.equal(facts({ fromAddress: "x@gmail.com", subject: "CS4000 is not a course here" }).category, "general");
  const byName = facts({ fromAddress: "x@gmail.com", subject: "Notes for Introduction to Discrete Mathematics" });
  assert.equal(byName.courseId, "240");
  const canvas = facts({
    fromAddress: "notifications@instructure.com",
    subject: "Assignment Created - Homework 3",
    preview: "A new assignment: https://canvas.wisc.edu/courses/400/assignments/9876 due soon",
  });
  assert.equal(canvas.category, "course");
  assert.equal(canvas.courseId, "400");
  assert.equal(canvas.canvasLink, "https://canvas.wisc.edu/courses/400/assignments/9876");
  assert.deepEqual(courseAliases("COMP SCI 400").map((r) => r.test("CS400")), [false, true]);
});

test("advisor (local names only), office, org and meeting categories; everything else is general", () => {
  const c = (over: Partial<Parameters<typeof categorizeMail>[0]>) => categorizeMail({ subject: "hi", preview: "", ...over }, context);
  const advisor = c({ fromName: "Rivera, Jordan", fromAddress: "jrivera@wisc.edu" });
  assert.equal(advisor.category, "advisor");
  assert.doesNotMatch(advisor.reason, /Jordan|Rivera/, "the advisor's name is never written into a stored field");
  assert.equal(c({ fromAddress: "registrar@wisc.edu" }).category, "admin");
  assert.equal(c({ fromAddress: "noreply@doit.wisc.edu" }).category, "admin");
  const list = c({ fromAddress: "climb@wisc.edu", listId: '"Hoofers Climbing" <climbing.lists.wisc.edu>' });
  assert.equal(list.category, "org");
  assert.equal(list.org, "Hoofers Climbing");
  assert.equal(c({ fromAddress: "club@lists.wisc.edu", fromName: "Chess Club" }).org, "Chess Club");
  const known = categorizeMail(
    { subject: "meeting", preview: "", fromAddress: "pres@gmail.com" },
    { ...context, knownLists: new Map([["pres@gmail.com", { listId: "<ski.lists.wisc.edu>", org: "Ski Club" }]]) },
  );
  assert.equal(known.org, "Ski Club");
  assert.equal(c({ odataType: "#microsoft.graph.eventMessageRequest", meetingMessageType: "meetingRequest" }).category, "meeting");
  assert.equal(c({ fromAddress: "friend@gmail.com" }).category, "general");
});

test("no body is ever stored: only the preview, bounded to 255 characters", async () => {
  const secret = "FULL BODY SECRET TEXT";
  const graph = fakeGraph(({ url }) => {
    if (url.includes("messages/delta"))
      return ok({
        value: [message("b1", { body: { contentType: "html", content: secret }, uniqueBody: { content: secret }, bodyPreview: "x".repeat(400) })],
        "@odata.deltaLink": mailDelta(1),
      });
    if (url.includes("calendarView")) return ok({ value: [], "@odata.deltaLink": calDelta(1) });
    return undefined;
  });
  const result = await syncGraph({ transport: graph.transport, state: memoryState(), accountScope: "local", previous: () => [], context, now: () => NOW });
  const store = createStore(":memory:");
  for (const batch of result.batches) store.ingest(batch);
  const stored = JSON.stringify(store.resources());
  assert.equal(stored.includes(secret), false);
  const mail = store.resources().find((r) => r.kind === "message")!;
  assert.equal(mail.mail!.preview.length, 255);
  assert.equal(mail.text, mail.mail!.preview);
  assert.deepEqual(Object.keys(mail.mail!).sort(), [
    "category", "categoryReason", "conversationId", "folder", "fromAddress", "fromName", "hasAttachments",
    "importance", "isRead", "messageId", "preview", "receivedAt",
  ]);
});

test("a meeting invite from mail and the calendar's tentative event are one agenda entry; a cancellation removes it", async () => {
  const state = memoryState();
  const invite = event("ev-9", {
    iCalUId: "uid-meet",
    onlineMeeting: { joinUrl: "https://uwmadison.zoom.us/j/93812345678?pwd=SECRETPASS" },
    organizer: { emailAddress: { name: "Prof Ada", address: "ada@wisc.edu" } },
    responseStatus: { response: "tentativelyAccepted" },
    attendees: [{}],
  });
  let phase = 1;
  const graph = fakeGraph(({ url }) => {
    if (url.includes("messages/delta") || url.startsWith(mailDelta(1)))
      return ok({
        value:
          phase === 1
            ? [message("inv", { "@odata.type": "#microsoft.graph.eventMessageRequest", subject: "Invitation: Project sync" })]
            : [message("cxl", { "@odata.type": "#microsoft.graph.eventMessage", subject: "Canceled: Project sync" })],
        "@odata.deltaLink": mailDelta(1),
      });
    if (url.includes("/me/messages/inv?")) return ok({ meetingMessageType: "meetingRequest", event: invite });
    if (url.includes("/me/messages/cxl?")) return ok({ meetingMessageType: "meetingCancelled", event: invite });
    if (url.includes("calendarView")) return ok({ value: phase === 1 ? [invite] : [], "@odata.deltaLink": calDelta(1) });
    return undefined;
  });
  const store = createStore(":memory:");
  const ids = graphSourceIds("local");
  const previous = (sourceId: string) =>
    store.resources().filter((r) => r.sourceId === sourceId && !r.deleted).map((r) => ({ ...r, deadlines: r.deadlines })) as never;
  const one = await syncGraph({ transport: graph.transport, state, accountScope: "local", previous, context, now: () => NOW });
  for (const b of one.batches) store.ingest(b);
  await one.commit();
  const entries = store.resources().filter((r) => r.sourceId === ids.calendar && !r.deleted);
  assert.equal(entries.length, 1, "deduplicated by iCalUId / event id");
  const entry = entries[0]!;
  assert.equal(entry.courseId, OUTLOOK_CALENDAR_COURSE_ID);
  assert.equal(entry.calendar!.entryKind, "meeting");
  assert.equal(entry.calendar!.joinUrl, "https://uwmadison.zoom.us/j/93812345678", "origin and path only: no passcode");
  assert.equal(entry.calendar!.onlineMeeting, "zoom");
  assert.equal(entry.calendar!.organizer, "Prof Ada");
  assert.equal(entry.calendar!.sourceMailId, "inv");
  assert.equal(entry.externalId, graphEventKey("ev-9"));
  const inviteMail = store.resources().find((r) => r.mail?.messageId === "inv")!;
  assert.equal(inviteMail.mail!.category, "meeting");
  assert.equal(inviteMail.mail!.meetingMessageType, "meetingRequest");
  phase = 2;
  const two = await syncGraph({ transport: graph.transport, state, accountScope: "local", previous, context, now: () => new Date(NOW.getTime() + 60_000) });
  for (const b of two.batches) store.ingest({ ...b, observedAt: new Date(NOW.getTime() + 60_000).toISOString() });
  assert.equal(store.resources().filter((r) => r.sourceId === ids.calendar && !r.deleted).length, 0, "cancelled");
});

test("join links are found in code for Zoom, Teams, Webex and Meet, without query strings", () => {
  assert.deepEqual(findJoinLink("Join https://zoom.us/j/123456789?pwd=abc now"), { service: "zoom", url: "https://zoom.us/j/123456789" });
  assert.equal(findJoinLink("https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d")!.service, "teams");
  assert.equal(findJoinLink("https://uwmadison.webex.com/meet/jdoe")!.url, "https://uwmadison.webex.com/meet/jdoe");
  assert.equal(findJoinLink("https://meet.google.com/abc-defg-hij?authuser=0")!.url, "https://meet.google.com/abc-defg-hij");
  assert.equal(findJoinLink("no link here"), undefined);
});

test("purge and the Graph disconnect remove every Graph record and nothing else", async () => {
  const graph = fakeGraph(({ url }) => {
    if (url.includes("messages/delta")) return ok({ value: [1, 2, 3, 4, 5, 6].map((n) => message(`p${n}`)), "@odata.deltaLink": mailDelta(1) });
    if (url.includes("calendarView")) return ok({ value: [event("e1")], "@odata.deltaLink": calDelta(1) });
    return undefined;
  });
  const store = createStore(":memory:");
  const core = createCore(store, { fixture: captureBatchSchema.parse(fixture) });
  await core.execute({ type: "fixture" });
  const coursework = store.resources().filter((r) => !r.deleted).length;
  const result = await syncGraph({ transport: graph.transport, state: memoryState(), accountScope: "local", previous: () => [], context, now: () => NOW });
  for (const b of result.batches) store.ingest(b);
  assert.equal(store.resources().filter((r) => r.kind === "message" && !r.deleted).length, 6);
  await core.execute({ type: "outlook-disconnect-graph" });
  assert.equal(store.sources().some((s) => s.scope.startsWith("graph_")), false);
  assert.equal(store.resources().filter((r) => !r.deleted).length, coursework, "coursework untouched");
  for (const b of result.batches) store.ingest({ ...b, observedAt: new Date(NOW.getTime() + 1000).toISOString() });
  await core.execute({ type: "purge", confirmation: "DELETE LOCAL DATA" });
  assert.equal(store.resources().length, 0);
  assert.equal(store.sources().length, 0);
  await core.close();
});

test("a mail drop from Microsoft's own delta is real, not held back by the drift guard", async () => {
  let n = 8;
  const graph = fakeGraph(({ url }) => {
    if (url.includes("messages/delta") || url.startsWith(mailDelta(1)))
      return ok({ value: Array.from({ length: n }, (_, i) => message(`d${i}`)), "@odata.deltaLink": mailDelta(1) });
    if (url.includes("calendarView") || url.startsWith(calDelta(1))) return ok({ value: [], "@odata.deltaLink": calDelta(1) });
    return undefined;
  });
  const store = createStore(":memory:");
  const first = await syncGraph({ transport: graph.transport, state: memoryState(), accountScope: "local", previous: () => [], context, now: () => NOW });
  for (const b of first.batches) store.ingest(b);
  n = 1; // a fresh sync (no delta link) that now finds one message: the student archived the rest
  const second = await syncGraph({ transport: graph.transport, state: memoryState(), accountScope: "local", previous: () => [], context, now: () => new Date(NOW.getTime() + 1000) });
  for (const b of second.batches) store.ingest({ ...b, observedAt: new Date(NOW.getTime() + 1000).toISOString() });
  const mailSource = store.sources().find((s) => s.kind === "mail")!;
  assert.equal(mailSource.status, "ok");
  assert.equal(store.resources().filter((r) => r.kind === "message" && !r.deleted).length, 1);
});

test("the ICS fallback: a 304 does no work, and the conditional headers are sent", async () => {
  const LINK = "https://outlook.office365.com/owa/calendar/a@wisc.edu/b/calendar.ics";
  const seen: Record<string, string>[] = [];
  const client = createPublicClient({
    lookup: async () => [{ address: "52.96.0.1", family: 4 }],
    transport: async (request) => {
      seen.push({ ...request.headers });
      if (request.headers["If-None-Match"] === '"v1"') return new Response(null, { status: 304 });
      return new Response("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n", {
        status: 200,
        headers: { etag: '"v1"', "last-modified": "Sat, 26 Sep 2026 12:00:00 GMT" },
      });
    },
  });
  let validators: { etag?: string; lastModified?: string } | undefined;
  const connector = () =>
    outlookCalendarConnector({
      feedUrl: LINK,
      accountScope: "local",
      client,
      now: () => NOW,
      validators: { get: () => validators, set: (v) => void (validators = v) },
    });
  const first: unknown[] = [];
  for await (const b of connector().pull()) first.push(b);
  assert.equal(first.length, 1);
  assert.deepEqual(validators, { etag: '"v1"', lastModified: "Sat, 26 Sep 2026 12:00:00 GMT" });
  const second: unknown[] = [];
  for await (const b of connector().pull()) second.push(b);
  assert.equal(second.length, 0, "304: no batch, no parse, no store work");
  assert.equal(seen[1]!["If-None-Match"], '"v1"');
  assert.equal(seen[1]!["If-Modified-Since"], "Sat, 26 Sep 2026 12:00:00 GMT");
  assert.match(calendarPublishGuide().url, /^https:\/\/outlook\.office\.com\/calendar\/options\/calendar\/SharedCalendars$/);
});

test("main's allowlist: Graph /me GET paths only; one PUT, into the app folder", () => {
  for (const good of [
    `${G}/me/mailFolders/inbox/messages/delta?$select=id`,
    `${G}/me/mailFolders('inbox')/messages/delta?$deltatoken=abc`,
    `${G}/me/calendarView/delta?startDateTime=2026-01-01T00:00:00Z&endDateTime=2026-02-01T00:00:00Z`,
    `${G}/me/messages/AAMk%3D%3D?$select=body`,
    `${G}/me/onenote/pages?$select=id&$top=100`,
    `${G}/me/onenote/pages/0-abc!1-def/content`,
    `${G}/me/drive/root/delta?token=abc`,
    `${G}/me/drive/items/01ABC!12/content`,
  ])
    assert.doesNotThrow(() => checkedGraphUrl(good), good);
  for (const bad of [
    "https://graph.microsoft.com/v1.0/users/someone/messages",
    "https://graph.microsoft.com/beta/me/messages/x",
    "https://evil.example.com/v1.0/me/messages/x",
    `${G}/me/sendMail`,
    `${G}/me/events/x/accept`,
    `${G}/me/messages/x?$search=secret`,
    `${G}/me/messages/x#frag`,
  ])
    assert.throws(() => checkedGraphUrl(bad), bad);
  assert.throws(() => checkedGraphUrl(`${G}/me/messages/x`, "PUT"));
  assert.throws(() => checkedGraphUrl(`${G}/me/drive/root:/notes.docx:/content`, "PUT"));
  assert.doesNotThrow(() => checkedGraphUrl(`${G}/me/drive/special/approot:/lectures/week1.docx:/content`, "PUT"));
  assert.throws(() => checkedGraphUrl(`${G}/me/drive/special/approot:/../x.docx:/content`, "PUT"));
});

test("partial grant: notes and files granted, mail and calendar blocked; each reader stands alone", async () => {
  assert.deepEqual(streamsFor(["offline_access", "User.Read", "Notes.Read", "Files.Read"]), ["onenote", "drive"]);
  const graph = fakeGraph(({ url }) => {
    if (url.includes("messages/delta")) return { status: 403, headers: {}, body: "" };
    if (url.includes("/onenote/pages?"))
      return ok({ value: [{ id: "pg1", title: "Lecture 1", lastModifiedDateTime: "2026-09-20T10:00:00Z", parentNotebook: { id: "nb1", displayName: "CS 400" }, parentSection: { displayName: "Week 1" }, links: { oneNoteWebUrl: { href: "https://onedrive.live.com/view.aspx?resid=1" } } }] });
    if (url.includes("/onenote/pages/pg1/content")) return ok("<html><body><h1>Heaps</h1><p>A heap is a tree.</p></body></html>");
    return undefined;
  });
  // Scopes say mail was not granted: no mail request at all.
  const partial = await syncGraph({
    transport: graph.transport, state: memoryState(), accountScope: "local", previous: () => [], context, now: () => NOW,
    streams: streamsFor(["Notes.Read"]),
  });
  assert.equal(graph.log.some((r) => r.url.includes("messages")), false);
  assert.equal(partial.batches.length, 1);
  // Mail asked for but refused (403): the notes reader still runs and saves.
  const refused = await syncGraph({
    transport: graph.transport, state: memoryState(), accountScope: "local", previous: () => [], context, now: () => NOW,
    streams: ["mail", "onenote"],
  });
  assert.equal(refused.failures.mail, "consent");
  assert.equal(refused.batches.length, 1);
  const page = refused.batches[0]!.resources[0]!;
  assert.equal(refused.batches[0]!.source.kind, "notes");
  assert.equal(page.courseId, UNMAPPED_COURSE_ID);
  assert.equal(page.kind, "material");
  assert.deepEqual(page.notes, { sourceSubtype: "onenote", itemId: "pg1", notebook: "CS 400", section: "Week 1", lastModified: "2026-09-20T10:00:00.000Z" });
  assert.equal(page.text, "Heaps\nA heap is a tree.");
});

test("OneNote: the notebook watermark; only a new or changed page's content is read again", async () => {
  const state = memoryState();
  let modified = "2026-09-20T10:00:00Z";
  const pages = () => [
    { id: "pg1", title: "Lecture 1", lastModifiedDateTime: modified, parentNotebook: { id: "nb1", displayName: "CS 400" } },
    { id: "pg2", title: "Lecture 2", lastModifiedDateTime: "2026-09-21T10:00:00Z", parentNotebook: { id: "nb1", displayName: "CS 400" } },
  ];
  const graph = fakeGraph(({ url }) => {
    if (url.includes("/onenote/pages?")) return ok({ value: pages() });
    const m = url.match(/\/onenote\/pages\/(pg\d)\/content/);
    if (m) return ok(`<p>${m[1]} at ${modified}</p>`);
    return undefined;
  });
  const store = createStore(":memory:");
  const previous = (id: string) => store.resources().filter((r) => r.sourceId === id && !r.deleted) as never;
  const sync = async (at: Date) => {
    const r = await syncGraph({ transport: graph.transport, state, accountScope: "local", previous, context, now: () => at, streams: ["onenote"] });
    for (const b of r.batches) store.ingest({ ...b, observedAt: at.toISOString() });
    await r.commit();
    return r;
  };
  const contentReads = () => graph.log.filter((r) => r.url.includes("/content")).length;
  const one = await sync(NOW);
  assert.equal(contentReads(), 2);
  assert.equal(one.batches.length, 1);
  assert.ok(Object.keys(state.values).some((k) => k.startsWith("graph:at:onenote:")), "per-notebook watermark kept");
  const two = await sync(new Date(NOW.getTime() + 60_000));
  assert.equal(contentReads(), 2, "nothing changed: no page content read");
  assert.equal(two.batches.length, 0);
  modified = "2026-09-26T14:00:00Z";
  await sync(new Date(NOW.getTime() + 120_000));
  assert.equal(contentReads(), 3, "only the changed page");
  assert.match(store.resources().find((r) => r.notes?.itemId === "pg1" && !r.deleted)!.text, /2026-09-26T14/);
});

test("OneDrive: drive delta keeps Office, PDF and Markdown ≤25 MB; content only when new or changed", async () => {
  const state = memoryState();
  const items = (tag: string) => [
    { id: "f1", name: "Notes.docx", file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, size: 1000, cTag: tag, parentReference: { path: "/drive/root:/CS400" }, webUrl: "https://uwmadison-my.sharepoint.com/personal/x/Documents/CS400/Notes.docx", lastModifiedDateTime: "2026-09-20T10:00:00Z" },
    { id: "f2", name: "photo.jpg", file: { mimeType: "image/jpeg" }, size: 10 },
    { id: "f3", name: "readme.md", file: { mimeType: "application/octet-stream" }, size: 10, cTag: "m1", webUrl: "https://uwmadison-my.sharepoint.com/personal/x/Documents/readme.md" },
    { id: "f4", name: "huge.pdf", file: { mimeType: "application/pdf" }, size: 30 * 1024 * 1024, cTag: "h1", webUrl: "https://uwmadison-my.sharepoint.com/personal/x/Documents/huge.pdf" },
    { id: "d1", name: "CS400", folder: { childCount: 1 } },
  ];
  let tag = "c1";
  let round = 0;
  const graph = fakeGraph(({ url, binary }) => {
    if (url.includes("/drive/root/delta")) {
      round++;
      if (round === 2) return ok({ value: [], "@odata.deltaLink": `${G}/me/drive/root/delta?token=t${round}` });
      return ok({ value: items(tag), "@odata.deltaLink": `${G}/me/drive/root/delta?token=t${round}` });
    }
    const m = url.match(/\/drive\/items\/(f\d)\/content/);
    if (m && binary) return { status: 200, headers: {}, body: Buffer.from(`bytes of ${m[1]} ${tag}`).toString("base64") };
    return undefined;
  });
  const extracted: string[] = [];
  const store = createStore(":memory:");
  const previous = (id: string) => store.resources().filter((r) => r.sourceId === id && !r.deleted) as never;
  const sync = async (at: Date) => {
    const r = await syncGraph({
      transport: graph.transport, state, accountScope: "local", previous, context, now: () => at, streams: ["drive"],
      extract: async ({ itemId, bytes }) => {
        extracted.push(itemId);
        return { text: bytes.toString("utf8") };
      },
    });
    for (const b of r.batches) store.ingest({ ...b, observedAt: at.toISOString() });
    await r.commit();
    return r;
  };
  await sync(NOW);
  const files = () => store.resources().filter((r) => r.notes?.sourceSubtype === "onedrive" && !r.deleted);
  assert.deepEqual(files().map((r) => r.title).sort(), ["Notes.docx", "huge.pdf", "readme.md"]);
  assert.deepEqual(extracted.sort(), ["f1", "f3"], "the 30 MB PDF is listed, never downloaded");
  assert.equal(files().find((r) => r.title === "Notes.docx")!.courseId, UNMAPPED_COURSE_ID);
  assert.equal(files().find((r) => r.title === "Notes.docx")!.notes!.path, "/CS400");
  await sync(new Date(NOW.getTime() + 1000));
  assert.equal(extracted.length, 2, "no change: no download");
  tag = "c2";
  await sync(new Date(NOW.getTime() + 2000));
  assert.deepEqual(extracted.slice(2), ["f1"], "only the file whose cTag moved");
  assert.match(files().find((r) => r.title === "Notes.docx")!.text, /c2/);
});

test("the app folder API: put, conditional get (304), delta; every call through the proxy transport", async () => {
  const graph = fakeGraph((request) => {
    if (request.method === "PUT") {
      assert.equal(request.contentType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      assert.equal(Buffer.from(request.bodyBase64!, "base64").toString(), "docx bytes");
      return ok({ id: "app1", webUrl: "https://uwmadison-my.sharepoint.com/personal/x/Documents/Apps/Magic/w1.docx", eTag: '"e1"' });
    }
    if (request.url.endsWith("/drive/items/app1/content"))
      return request.ifNoneMatch === '"e1"'
        ? { status: 304, headers: {}, body: "" }
        : { status: 200, headers: { etag: '"e2"' }, body: Buffer.from("edited").toString("base64") };
    if (request.url.includes("/drive/special/approot/delta"))
      return ok({ value: [{ id: "app1", name: "w1.docx", eTag: '"e2"' }, { id: "gone", deleted: { state: "deleted" } }], "@odata.deltaLink": `${G}/me/drive/special/approot/delta(token='z')` });
    return undefined;
  });
  const put = await appFolderPut(graph.transport, "lectures/w1.docx", Buffer.from("docx bytes"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.deepEqual(put, { id: "app1", webUrl: "https://uwmadison-my.sharepoint.com/personal/x/Documents/Apps/Magic/w1.docx", eTag: '"e1"' });
  assert.deepEqual(await appFolderGet(graph.transport, "app1", '"e1"'), { status: 304 });
  const edited = await appFolderGet(graph.transport, "app1", '"old"');
  assert.equal(edited.status, 200);
  assert.equal(edited.status === 200 && edited.bytes.toString(), "edited");
  const delta = await appFolderDelta(graph.transport);
  assert.deepEqual(delta.items.map((i) => [i.id, i.deleted]), [["app1", false], ["gone", true]]);
  await assert.rejects(appFolderPut(graph.transport, "../escape.docx", Buffer.from("x"), "text/plain"));
  await assert.rejects(appFolderPut(graph.transport, "x.exe", Buffer.from("x"), "application/octet-stream"));
});

test("OneNote HTML becomes plain text in code", () => {
  assert.equal(oneNoteText("<div><p>One &amp; two</p><script>x()</script><p>Three</p></div>"), "One & two\nThree");
});

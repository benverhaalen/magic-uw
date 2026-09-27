import assert from "node:assert/strict";
import test from "node:test";
import { resourceInputSchema, type ResourceInput } from "@magic/contracts";
import { externalCourseConnector } from "../packages/connectors/src/external";
import type { PublicClient } from "../packages/connectors/src/network";

const at = "2026-09-26T12:00:00.000Z";
const root = "https://course.example.edu/course/index.html";
const url = (name: string) => new URL(name, root).href;
function saved(name: string, links: string[]): ResourceInput {
  return resourceInputSchema.parse({
    externalId: name,
    kind: "material",
    courseId: "1",
    courseName: "Course",
    title: name,
    url: url(name),
    text: "Previously saved course instructions.",
    links,
    crawl: { depth: 0, discoveredFrom: root, observedAt: at },
  });
}
function client(read: (input: string) => Response): PublicClient {
  return {
    isCanvas: () => false,
    async get(input) {
      return { url: input, redirects: [], response: read(input) };
    },
    async text(input) {
      return {
        url: input,
        redirects: [],
        response: new Response(""),
        text: "",
      };
    },
    async feed() {
      throw new Error("Unused feed");
    },
    async signedDownload() {
      throw new Error("Unused download");
    },
  };
}
async function capture(
  previous: ResourceInput[],
  maxPages: number,
  transport: PublicClient,
) {
  const batches = [];
  for await (const batch of externalCourseConnector({
    accountScope: "a",
    courseId: "1",
    courseName: "Course",
    seeds: [root],
    previous,
    maxPages,
    client: transport,
    now: () => new Date(at),
  }).pull())
    batches.push(batch);
  assert.equal(batches.length, 1);
  return batches[0]!;
}

test("continuation reaches new material beyond 600 cached ancestors at the default page budget", async () => {
  const branches = Array.from({ length: 601 }, (_, i) => `branch-${i}.html`);
  const previous = [
    saved("index.html", branches.map(url)),
    ...branches.map((name) => saved(name, [url("new.html")])),
  ];
  const requests: string[] = [];
  const batch = await capture(
    previous,
    300,
    client((input) => {
      requests.push(input);
      return new Response("Newly discovered course instructions", {
        headers: { "content-type": "text/plain" },
      });
    }),
  );
  assert.deepEqual(requests, [url("new.html")]);
  assert.equal(batch.status, "ok");
  assert.equal(batch.resources.length, previous.length + 1);
  assert.ok(batch.resources.some((row) => row.url === url("new.html")));
});

test("page ceiling remains 1000 while cached traversal is free", async () => {
  const links = Array.from({ length: 1002 }, (_, i) => url(`new-${i}.txt`));
  let requests = 0;
  const batch = await capture(
    [saved("index.html", links)],
    5000,
    client(() => {
      requests++;
      return new Response("New course instructions", {
        headers: { "content-type": "text/plain" },
      });
    }),
  );
  assert.equal(requests, 1000);
  assert.equal(batch.resources.length, 1001);
  assert.ok(batch.diagnostics?.some((d) => d.code === "page_limit"));
});

test("failed new requests consume the attempt budget and duplicate links are not retried", async () => {
  const links = Array.from({ length: 10 }, (_, i) => url(`failed-${i}.txt`));
  const requests: string[] = [];
  const batch = await capture(
    [saved("index.html", [...links, ...links])],
    2,
    client((input) => {
      requests.push(input);
      throw new Error("Unavailable");
    }),
  );
  assert.equal(requests.length, 4);
  assert.equal(new Set(requests).size, 4);
  assert.ok(batch.diagnostics?.some((d) => d.code === "attempt_limit"));
  assert.equal(batch.resources.length, 1);
});

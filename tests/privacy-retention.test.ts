/**
 * Understanding retention (the operator's correction, September 27: "be careful with stripping so
 * much"). Teaching material must reach the model as written, apart from people and credentials.
 * Measured over the synthetic fixtures plus, when present on this machine, the local OCW corpus
 * (~/buildfest-corpus/ocw, CC BY-NC-SA; read here, never committed or copied):
 * - the share of characters changed in teaching material (target <= 0.5%);
 * - replacements of non-person kinds (IP, address, card, SSN, date of birth, campus ID) in teaching
 *   material (target 0);
 * - planted canaries in personal content (target 0 leaks).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import fixture from "../fixtures/course.json";
import { rosterFor } from "../packages/core/src/identity";
import { protectText } from "../packages/core/src/privacy/protect";
import { pseudonymSession } from "../packages/core/src/privacy/pseudonyms";

const NON_PERSON = new Set(["ip", "address", "card", "ssn", "dob", "campus_id"]);

/** Synthetic teaching text written to look like personal data: every number here is content. */
const SYNTHETIC_TEACHING = [
  "Lab 3: configure the router at 192.168.1.1, the DNS server at 8.8.8.8 and the host 10.0.0.7/24; IPv6 uses 2001:0db8:85a3:0000:0000:8a2e:0370:7334.",
  "Luhn exercise: verify that 4111 1111 1111 1111 passes and 4111 1111 1111 1112 fails. The sample SSN 123-45-6789 is fictional; so is 078-05-1120.",
  "Civics reading: the White House is at 1600 Pennsylvania Avenue NW, and the Wisconsin State Capitol at 2 East Main Street.",
  "History: Alan Turing was born on June 23, 1912; Ada Lovelace was born on December 10, 1815. Keynes (1936) and Smith (1776) are cited.",
  "Statistics: the sample of 1695734400 seconds, the ISBN 0262033844, and Section 1.2.3.4 of the text. Compute 3.14159 x 100.",
  "Will this be on the exam? Grace periods apply to late work; Mark your answers clearly. Professor Ada Lovelace holds office hours.",
];

function htmlText(html: string): string {
  return html
    .replace(/<(script|style|nav|header|footer)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
function ocwTexts(): string[] {
  const root = join(homedir(), "buildfest-corpus", "ocw");
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".html")) files.push(path);
    }
  };
  walk(root);
  // Boilerplate (menus, footers) repeats on every page; count each distinct sentence once.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of files) {
    const kept = htmlText(readFileSync(file, "utf8"))
      .split(/(?<=[.!?])\s+/)
      .filter((s) => s.length > 20 && !seen.has(s) && (seen.add(s), true));
    if (kept.length) out.push(kept.join(" "));
  }
  return out;
}

test("teaching material keeps its content: <= 0.5% of characters changed, 0 non-person replacements; personal canaries 0 leaks", (t) => {
  const store = createStore(":memory:");
  // A realistic roster: the student, classmates, and teachers who must be kept.
  store.recordAutoIdentity({ accountScope: "acct", self: { names: ["Quentin Zabrowski"], emails: ["qzab@wisc.edu"], netIds: ["qzab"], studentIds: [] } });
  store.recordAutoIdentity({ accountScope: "acct", courseId: "c", authors: ["Ottoline Brackenridge", "Will Hart", "Grace Lim", "Mark Chen"] });
  const roster = rosterFor(store, "c", "acct");
  const fixtureTeaching = (fixture as { resources: { kind: string; text?: string }[] }).resources
    .filter((r) => r.kind === "material" || r.kind === "assignment")
    .map((r) => r.text ?? "");
  const ocw = ocwTexts();
  const corpus = [...SYNTHETIC_TEACHING, ...fixtureTeaching, ...ocw];
  let chars = 0, changed = 0;
  const byKind: Record<string, number> = {};
  const session = pseudonymSession("retention");
  for (const text of corpus) {
    const r = protectText(text, roster, session, "teaching");
    chars += text.length;
    for (const s of r.spans) {
      changed += s.originalEnd - s.originalStart;
      byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
    }
  }
  const share = chars ? changed / chars : 0;
  const nonPerson = Object.entries(byKind).filter(([k]) => NON_PERSON.has(k)).reduce((n, [, v]) => n + v, 0);
  t.diagnostic(`teaching corpus: ${corpus.length} texts (${ocw.length} OCW pages), ${chars} characters`);
  t.diagnostic(`changed: ${changed} characters = ${(share * 100).toFixed(4)}%; replacements by kind: ${JSON.stringify(byKind)}`);
  t.diagnostic(`non-person replacements in teaching material: ${nonPerson}`);
  assert.ok(share <= 0.005, `changed ${(share * 100).toFixed(3)}% of teaching characters`);
  assert.equal(nonPerson, 0);
  for (const kept of ["192.168.1.1", "4111 1111 1111 1111", "123-45-6789", "1600 Pennsylvania Avenue", "June 23, 1912", "Will this be on the exam?", "Professor Ada Lovelace", "Keynes (1936)"])
    assert.ok(protectText(SYNTHETIC_TEACHING.join(" "), roster, session, "teaching").text.includes(kept), kept);

  // Personal content: planted canaries all go.
  const personal = [
    "Hi Quentin Zabrowski, it's Ottoline Brackenridge (obrack@wisc.edu). Call me at (608) 555-0142.",
    "My card is 5555 5555 5555 4444 and my SSN is 219-09-9999. I live at 1234 Canaryhill Street. My DOB: 03/14/2004.",
    "Student ID: 9081234567. My IP is 128.104.1.20. Profile https://canvas.wisc.edu/courses/5/users/4455667 and https://x.test/f?token=CANARYTOKEN9.",
  ];
  const canaries = ["Quentin", "Zabrowski", "Ottoline", "Brackenridge", "obrack", "555-0142", "5555 5555 5555 4444", "219-09-9999", "Canaryhill", "03/14/2004", "9081234567", "128.104.1.20", "4455667", "CANARYTOKEN9"];
  const out = personal.map((p) => protectText(p, roster, session, "personal").text).join(" ");
  const leaks = canaries.filter((c) => out.includes(c));
  t.diagnostic(`personal canaries: ${canaries.length} planted, ${leaks.length} leaked`);
  assert.deepEqual(leaks, []);
  store.close();
});

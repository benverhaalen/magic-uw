import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { rosterFor } from "../packages/core/src/identity";
import { detect, luhn, resolveDetections } from "../packages/core/src/privacy/detectors";
import { protectText, protectionCounts, describeProtection } from "../packages/core/src/privacy/protect";
import { configurePseudonymKey, pseudonymSession } from "../packages/core/src/privacy/pseudonyms";

const kinds = (text: string) => resolveDetections(detect(text)).map((d) => [d.kind, text.slice(d.start, d.end)]);

test("each detector finds its value and only the value", () => {
  const cases: [string, string, string][] = [
    ["email", "Write to quentin.z+cs@alumni.example.co.uk today.", "quentin.z+cs@alumni.example.co.uk"],
    ["phone", "Call (608) 555-0142 after class.", "(608) 555-0142"],
    ["phone", "Office line +44 20 7946 0958.", "+44 20 7946 0958"],
    ["student_id", "My student ID: 9081234567 is on file.", "9081234567"],
    ["campus_id", "Wiscard number 6008 1234 5678 9012 3 lost.", "6008 1234 5678 9012 3"],
    ["address", "I live at 1234 W Johnson St, Apt 4B near campus.", "1234 W Johnson St, Apt 4B"],
    ["dob", "DOB: 03/14/2004 per the form.", "03/14/2004"],
    ["dob", "She was born on March 14, 2004 in Madison.", "March 14, 2004"],
    ["secret_url", "Open https://canvas.wisc.edu/files/77/download?download_frd=1&verifier=AbC123xyz.", "https://canvas.wisc.edu/files/77/download?download_frd=1&verifier=AbC123xyz"],
    ["secret_url", "S3: https://b.s3.amazonaws.com/x.pdf?X-Amz-Credential=a&X-Amz-Signature=beef", "https://b.s3.amazonaws.com/x.pdf?X-Amz-Credential=a&X-Amz-Signature=beef"],
    ["ip", "Login from 128.104.1.20 was flagged.", "128.104.1.20"],
    ["ip", "Server at 2001:0db8:85a3:0000:0000:8a2e:0370:7334 responded.", "2001:0db8:85a3:0000:0000:8a2e:0370:7334"],
    ["canvas_user", "See https://canvas.wisc.edu/courses/1/users/4455667 for details.", "4455667"],
    ["card", "Card 4111 1111 1111 1111 was charged.", "4111 1111 1111 1111"],
    ["ssn", "SSN 123-45-6789 on the form.", "123-45-6789"],
    ["netid", "My NetID is qzabrowski.", "qzabrowski"],
  ];
  for (const [kind, text, value] of cases) assert.deepEqual(kinds(text), [[kind, value]], `${kind}: ${text}`);
});

test("precision guards: ordinary course text is left alone", () => {
  for (const text of [
    "Timestamp 1695734400 marks the epoch second.", // bare 10 digits, no context word
    "ISBN 0262033844 is the textbook.",
    "See Section 1.2.3.4 and version 2.0.1.3 of the spec.",
    "The ratio was 3.14159 over 100 trials in 2024.",
    "Numbers 4111 1111 1111 1112 fail the Luhn check.",
    "Room 000-12-3456 and 666-12-3456 and 912-34-5678 are invalid SSNs.",
    "Read chapter 12 by Friday; 45 minutes each.",
    "https://canvas.wisc.edu/courses/1/pages/week-3?module_item_id=77",
    "Call signs like the Main St rule are not addresses without a number.",
    "The C++ std::vector and a::b are not IPv6.",
  ])
    assert.deepEqual(kinds(text), [], text);
  assert.equal(luhn("4111111111111111"), true);
  assert.equal(luhn("4111111111111112"), false);
});

test("sentence-start first names that are common words survive; real uses are still scrubbed", () => {
  const store = createStore(":memory:");
  store.recordAutoIdentity({ accountScope: "a", courseId: "c", authors: ["Will Hart", "Grace Lim"] });
  const roster = rosterFor(store, "c", "a");
  const s = pseudonymSession("t");
  assert.equal(protectText("Will this be on the exam? Grace periods apply.", roster, s).text, "Will this be on the exam? Grace periods apply.");
  assert.match(protectText("Will said the exam moved.", roster, s).text, /^\[STUDENT_\d\] said/);
  assert.match(protectText("I asked Will about it. Will this be graded?", roster, s).text, /asked \[STUDENT_\d\].*\[STUDENT_\d\] this/);
  assert.match(protectText("Will Hart wrote the lab.", roster, s).text, /^\[STUDENT_\d\] wrote/);
  store.close();
});

test("a bare 10-digit number needs a context word; a roster student ID is always replaced", () => {
  const store = createStore(":memory:");
  store.setIdentityRoster({ peers: [{ names: ["Quinn Vale"], emails: [], netIds: [], studentIds: ["9087654321"] }], retain: [] });
  const roster = rosterFor(store, "c");
  const s = pseudonymSession("t");
  assert.equal(protectText("Unix time 1695734400 was logged.", roster, s).text, "Unix time 1695734400 was logged.");
  assert.equal(protectText("Grader note: 9087654321 resubmitted.", roster, s).text, "Grader note: [STUDENT_ID_1] resubmitted.");
  store.close();
});

test("pseudonyms: stable within a request and a context, different across installs and contexts", () => {
  const store = createStore(":memory:");
  const roster = rosterFor(store, "c");
  const text = "Mail a@x.edu, b@x.edu, c@x.edu and d@x.edu; a@x.edu again.";
  configurePseudonymKey(Buffer.alloc(32, 1));
  const prime = (ctx: string) => {
    const s = pseudonymSession(ctx);
    s.prime(["a@x.edu", "b@x.edu", "c@x.edu", "d@x.edu"].map((key) => ({ kind: "email", key })));
    return protectText(text, roster, s).text;
  };
  const one = prime("pack:a:c");
  assert.equal(one.match(/\[EMAIL_\d\]/g)!.length, 5);
  assert.equal(new Set(one.match(/\[EMAIL_\d\]/g)).size, 4);
  const first = one.match(/\[EMAIL_\d\]/)![0];
  assert.ok(one.endsWith(`${first} again.`), "same value, same placeholder within the request");
  assert.equal(prime("pack:a:c"), one, "same context and key: same placeholders (cache stays warm)");
  const orders = new Set<string>();
  for (let i = 0; i < 8; i++) orders.add(prime(`pack:a:c${i}`));
  assert.ok(orders.size > 1, "another context ranks differently");
  configurePseudonymKey(Buffer.alloc(32, 2));
  assert.notEqual(prime("pack:a:c"), one, "another install key ranks differently");
  const s = pseudonymSession("x");
  s.placeholder("email", "a@x.edu");
  assert.deepEqual([...s.reverse()], [["[EMAIL_1]", { kind: "email", key: "a@x.edu" }]]);
  configurePseudonymKey(null);
  store.close();
});

test("receipt counts come from the payload's placeholders, never its values", () => {
  const counts = protectionCounts({ input: "[STUDENT_1] and [STUDENT_SELF] mailed [EMAIL_1] from [PHONE_2]; [STUDENT_ID_1]" });
  assert.deepEqual(counts, { student_name: 2, email: 1, phone: 1, student_id: 1 });
  assert.equal(describeProtection(counts), "2 names, 1 email, 1 phone, 1 student ID replaced");
});

// Run: node scripts/gen-sample-courses.mjs fixtures/sample-courses.json
// Generates fixtures/sample-courses.json: three invented courses as one fixture batch each.
// Every name, instructor and text below is invented for the sample. Times are America/Chicago (CDT, UTC-5).
import { writeFileSync } from "node:fs";

const OBSERVED = "2026-09-27T14:00:00Z"; // Sunday Sep 27, 9:00 AM Central
const ct = (date, time = "23:59") => new Date(`${date}T${time}:00-05:00`).toISOString().replace(".000Z", "Z");
const policy = { mode: "coaching", evidence: "AI may explain concepts, quiz you and check your reasoning, but must not write work you submit." };

function course(c) {
  const base = { courseId: c.id, courseName: c.name, policy };
  const url = (path) => `https://example.org/${c.slug}/${path}`;
  const resources = [];
  const add = (r) => resources.push({ ...base, deadlines: [], points: null, submitted: null, ...r });
  add({
    externalId: `${c.slug}-course`, kind: "course", title: c.name, url: url("home"), text: c.about,
    course: { courseCode: c.code, termName: "Fall 2026", workflowState: "available", instructors: [c.instructor],
      selection: { score: 1, included: true, reasons: ["Synthetic sample course"] } },
  });
  const material = (externalId, title, text, extra = {}) =>
    add({ externalId, kind: "material", title, url: url(`materials/${externalId}`), text, contentType: "text/plain", updatedAt: extra.updatedAt ?? ct("2026-09-21", "08:00"), ...extra });
  (c.groups ?? []).forEach(([id, title, weight], position) =>
    add({ externalId: id, kind: "material", title, url: url(`assignments/groups/${id}`), text: "", assignmentGroup: { weight, position: position + 1 } }));
  const groupOf = (title) => (c.groups ?? []).find(([, , , pattern]) => pattern.test(title))?.[0];
  const assignment = (externalId, title, text, due, points, extra = {}) =>
    add({ externalId, kind: "assignment", ...(groupOf(title) ? { assignmentGroupId: groupOf(title) } : {}), title, url: url(`assignments/${externalId}`), text, dueAt: ct(...due), points,
      deadlines: [{ value: ct(...due), kind: "due", quote: `due_at: ${ct(...due)}`, authority: "structured", scopeConfirmed: true }],
      submitted: extra.submission ? true : false, ...extra });
  const graded = (score, date, time = "20:15") => ({ submission: { workflowState: "graded", submittedAt: ct(date, time), score } });
  const event = (externalId, title, start, end, location, text = "") =>
    add({ externalId, kind: "event", title, url: url(`calendar/${externalId}`), text,
      deadlines: [{ value: ct(...start), kind: "event", quote: `DTSTART: ${ct(...start)}`, authority: "structured", scopeConfirmed: true }],
      calendar: { uid: `${externalId}@example.org`, start: ct(...start), end: ct(...end), allDay: false, timezone: "America/Chicago", location } });
  const message = (externalId, title, text, at) =>
    add({ externalId, kind: "message", title, url: url(`announcements/${externalId}`), text, createdAt: ct(...at), updatedAt: ct(...at) });
  c.build({ material, assignment, graded, event, message, url });
  return {
    source: { id: `sample-${c.slug}`, label: `${c.code} · synthetic sample`, kind: "fixture", accountScope: "synthetic", courseId: c.id, scope: "assignments" },
    observedAt: OBSERVED, complete: true, status: "ok", resources,
  };
}

const math = course({
  id: "math-240", slug: "math240", code: "MATH 240", name: "MATH 240: Introduction to Discrete Mathematics",
  instructor: "Prof. Lena Marsh (fictional)",
  groups: [["math240-g-ps", "Problem sets", 30, /^Problem Set/], ["math240-g-quiz", "Quizzes", 15, /^Quiz/], ["math240-g-mid1", "Midterm 1", 15, /^Midterm 1/], ["math240-g-mid2", "Midterm 2", 15, /^Midterm 2/], ["math240-g-final", "Final exam", 25, /^Final/]],
  about: "MATH 240 Introduction to Discrete Mathematics (synthetic sample course). Logic, proofs, induction, sets, functions, counting and graphs. Lectures Monday, Wednesday and Friday at 11:00 AM in Room 210 Sample Hall.",
  build({ material, assignment, graded, event, message, url }) {
    material("syllabus", "Syllabus", [
      "MATH 240 Introduction to Discrete Mathematics: Syllabus (synthetic sample)",
      "Instructor: Prof. Lena Marsh (fictional). Office hours Tuesday 2:00 to 3:30 PM in Room 318 Sample Hall.",
      "Grading: Problem sets 30%, Quizzes 15%, Midterm 1 15%, Midterm 2 15%, Final exam 25%.",
      "Letter grades: A 93 to 100, AB 88 to 92.9, B 83 to 87.9, BC 78 to 82.9, C 70 to 77.9, D 60 to 69.9, F below 60.",
      "Quiz 2 covers Lecture 5 and Lecture 6: propositional logic, predicates and quantifiers.",
      "Midterm 1 covers Lectures 5 through 8: logic, quantifiers, mathematical induction and strong induction.",
      "Midterm 1 is a 50-minute exam with short proofs and true or false questions. It is held in Room 210 Sample Hall.",
      "Problem sets are due Tuesdays at 11:59 PM on the course site. You may discuss problems with classmates, but you must write your own solutions.",
    ].join("\n"));
    material("math240-l5", "Lecture 5 notes: Propositional logic", [
      "Lecture 5: Propositional logic",
      "Propositions",
      "A proposition is a declarative sentence that is either true or false, but not both. \"7 is prime\" is a proposition; \"Is 7 prime?\" is not.",
      "Connectives",
      "The connectives are negation (not p), conjunction (p and q), disjunction (p or q), the conditional (if p then q) and the biconditional (p if and only if q).",
      "The conditional p -> q is false only when p is true and q is false. When p is false, the conditional is vacuously true.",
      "Converse, inverse and contrapositive",
      "The contrapositive of p -> q is not q -> not p, and it is logically equivalent to p -> q. The converse q -> p and the inverse not p -> not q are not equivalent to the original conditional.",
      "Truth tables and equivalence",
      "Two compound propositions are logically equivalent when they have the same truth value in every row of their truth table. De Morgan's laws state that not (p and q) is equivalent to (not p) or (not q), and not (p or q) is equivalent to (not p) and (not q).",
      "A tautology is true in every row; a contradiction is false in every row.",
    ].join("\n"), { updatedAt: ct("2026-09-14", "12:10") });
    material("math240-l6", "Lecture 6 notes: Predicates and quantifiers", [
      "Lecture 6: Predicates and quantifiers",
      "Predicates",
      "A predicate P(x) becomes a proposition once a value from the domain is substituted for x. The domain must always be stated.",
      "The universal quantifier",
      "The statement \"for all x, P(x)\" is true when P(x) is true for every x in the domain. A single counterexample shows that a universal statement is false.",
      "The existential quantifier",
      "The statement \"there exists x such that P(x)\" is true when P(x) is true for at least one x in the domain.",
      "Negating quantifiers",
      "The negation of \"for all x, P(x)\" is \"there exists x such that not P(x)\". The negation of \"there exists x such that P(x)\" is \"for all x, not P(x)\".",
      "Nested quantifiers",
      "The order of nested quantifiers matters. \"For every x there exists y with x + y = 0\" is true over the integers, but \"there exists y such that for every x, x + y = 0\" is false.",
    ].join("\n"), { updatedAt: ct("2026-09-16", "12:10") });
    material("math240-l7-slides", "Lecture 7 slides: Mathematical induction", [
      "Lecture 7: Mathematical induction",
      "The principle of induction",
      "To prove that P(n) holds for every integer n >= 1, prove the base case P(1) and the inductive step: for every k >= 1, if P(k) is true then P(k + 1) is true.",
      "The assumption that P(k) is true is called the inductive hypothesis. The inductive step must use it.",
      "Worked example: a sum formula",
      "Claim: 1 + 2 + ... + n = n(n + 1)/2 for every n >= 1. Base case: when n = 1 both sides equal 1. Inductive step: assume 1 + 2 + ... + k = k(k + 1)/2. Adding k + 1 to both sides gives k(k + 1)/2 + (k + 1) = (k + 1)(k + 2)/2, which is the formula for n = k + 1.",
      "Worked example: divisibility",
      "Claim: 3 divides n^3 - n for every n >= 0. Base case: 0^3 - 0 = 0 is divisible by 3. Inductive step: (k + 1)^3 - (k + 1) = (k^3 - k) + 3(k^2 + k), and both terms are divisible by 3.",
      "Common mistakes",
      "Forgetting the base case, assuming the statement you are trying to prove for k + 1, and proving the step only for one particular k are the three most common errors on induction proofs.",
    ].join("\n"), { updatedAt: ct("2026-09-21", "12:10") });
    material("math240-reading4", "Reading 4: Strong induction and well-ordering", [
      "Reading 4: Strong induction and well-ordering",
      "Strong induction",
      "In strong induction the inductive step assumes P(1), P(2), ..., P(k) are all true and proves P(k + 1). Strong induction is useful when the case k + 1 depends on a case smaller than k.",
      "Example: every integer n >= 2 is a product of primes. If k + 1 is prime we are done. Otherwise k + 1 = ab with 2 <= a, b <= k, and by the strong inductive hypothesis both a and b are products of primes.",
      "Several base cases",
      "When the inductive step reaches back more than one case, prove enough base cases to start it. To show every amount of postage of 12 cents or more can be formed from 4-cent and 5-cent stamps, check 12, 13, 14 and 15, then add a 4-cent stamp to the amount for k - 3.",
      "The well-ordering principle",
      "Every nonempty set of nonnegative integers has a least element. Well-ordering, ordinary induction and strong induction are equivalent: a proof written in one form can be rewritten in the others.",
      "Choosing a method",
      "Use ordinary induction when P(k + 1) follows from P(k) alone. Use strong induction when it follows from an earlier case, as in factorization or recurrences like the Fibonacci numbers.",
    ].join("\n"), { updatedAt: ct("2026-09-23", "09:00") });
    material("math240-l8", "Lecture 8 notes: Recursive definitions", [
      "Lecture 8: Recursive definitions",
      "Recursively defined sequences",
      "A sequence is defined recursively by giving its first terms and a rule for later terms from earlier ones. The Fibonacci numbers satisfy f(0) = 0, f(1) = 1 and f(n) = f(n - 1) + f(n - 2) for n >= 2.",
      "Proving facts about recursive sequences",
      "Facts about a recursively defined sequence are usually proved by strong induction, because each term depends on the two terms before it. For example, f(n) < 2^n for every n >= 0.",
    ].join("\n"), { updatedAt: ct("2026-09-25", "12:10") });
    assignment("math240-ps1", "Problem Set 1: Propositions", "Problem Set 1 covers propositions and connectives. Submit one PDF with your work.", ["2026-09-08"], 20, { submissionTypes: ["online_upload"], ...graded(17, "2026-09-08") });
    assignment("math240-ps2", "Problem Set 2: Truth tables", "Problem Set 2 covers truth tables and logical equivalence. Submit one PDF with your work.", ["2026-09-15"], 20, { submissionTypes: ["online_upload"], ...graded(19, "2026-09-15") });
    assignment("math240-ps3", "Problem Set 3: Quantifiers", "Problem Set 3 covers predicates, quantifiers and their negations. Submit one PDF with your work.", ["2026-09-22"], 20, { submissionTypes: ["online_upload"], ...graded(16, "2026-09-22") });
    assignment("math240-quiz1", "Quiz 1: Propositions", "Quiz 1 covers propositions and connectives. Taken in class.", ["2026-09-18", "11:00"], 10, { submissionTypes: ["on_paper"], ...graded(9, "2026-09-18", "11:45") });
    assignment("math240-ps4", "Problem Set 4: Induction", [
      "Problem Set 4 practises mathematical induction and strong induction.",
      "Before you start, read Lecture 7 slides: Mathematical induction and Reading 4: Strong induction and well-ordering.",
      "1. Prove by induction that 1 + 3 + 5 + ... + (2n - 1) = n^2 for every n >= 1.",
      "2. Prove that 6 divides n^3 - n for every integer n >= 0.",
      "3. Use strong induction to show that every amount of postage of 18 cents or more can be formed from 4-cent and 7-cent stamps.",
      "4. Prove that the Fibonacci numbers satisfy f(n) < 2^n for every n >= 0.",
      "Submit one PDF with your typed or neatly handwritten proofs. State the base case and the inductive hypothesis in every proof.",
    ].join("\n"), ["2026-09-29"], 20, {
      submissionTypes: ["online_upload"],
      links: [
        { url: url("materials/math240-l7-slides"), text: "Lecture 7 slides: Mathematical induction" },
        { url: url("materials/math240-reading4"), text: "Reading 4: Strong induction and well-ordering" },
        { url: url("materials/math240-l8"), text: "Lecture 8 notes: Recursive definitions" },
      ],
      rubric: [
        { id: "ps4-base", description: "Base cases", points: 4, longDescription: "Every proof states and checks the base case or cases it needs." },
        { id: "ps4-step", description: "Inductive step", points: 10, longDescription: "The inductive hypothesis is stated and used to reach the next case." },
        { id: "ps4-write", description: "Clear writing", points: 6, longDescription: "Each step follows from the one before it, in full sentences." },
      ],
    });
    assignment("math240-quiz2", "Quiz 2: Logic and quantifiers", "Quiz 2 covers propositional logic, predicates and quantifiers from Lecture 5 and Lecture 6. 20 minutes, taken in class. Review Lecture 5 notes: Propositional logic and Lecture 6 notes: Predicates and quantifiers.", ["2026-10-05", "11:00"], 10, {
      submissionTypes: ["on_paper"],
      links: [
        { url: url("materials/math240-l5"), text: "Lecture 5 notes: Propositional logic" },
        { url: url("materials/math240-l6"), text: "Lecture 6 notes: Predicates and quantifiers" },
      ],
    });
    assignment("math240-ps5", "Problem Set 5: Recursion", "Problem Set 5 covers recursive definitions and structural induction. Submit one PDF with your work.", ["2026-10-06"], 20, { submissionTypes: ["online_upload"] });
    assignment("math240-midterm1", "Midterm 1", "Midterm 1 covers Lectures 5 through 8: logic, quantifiers, mathematical induction and strong induction. Taken in class in Room 210 Sample Hall. Bring a pencil; no calculators.", ["2026-10-14", "11:00"], 100, { submissionTypes: ["on_paper"] });
    for (const [date, n] of [["2026-09-28", 9], ["2026-09-30", 10], ["2026-10-02", 11]])
      event(`math240-lec-${date}`, `MATH 240 · Lecture ${n}`, [date, "11:00"], [date, "11:50"], "Room 210 Sample Hall");
    event("math240-help-0927", "MATH 240 · Problem Set 4 help session", ["2026-09-27", "16:00"], ["2026-09-27", "17:00"], "Room 318 Sample Hall");
    event("math240-oh-0929", "MATH 240 · Office hours", ["2026-09-29", "14:00"], ["2026-09-29", "15:30"], "Room 318 Sample Hall");
    message("math240-ann-oh", "Office hours before Problem Set 4", "Office hours this week are moved to Tuesday from 2:00 to 3:30 PM in Room 318 Sample Hall, the afternoon Problem Set 4 is due. Bring the induction proofs you are unsure about.", ["2026-09-26", "10:00"]);
  },
});

const cs = course({
  id: "compsci-300", slug: "cs300", code: "COMPSCI 300", name: "COMPSCI 300: Programming II",
  instructor: "Prof. Dev Okafor (fictional)",
  groups: [["cs300-g-proj", "Programming projects", 40, /^Project/], ["cs300-g-lab", "Labs", 15, /^Lab/], ["cs300-g-quiz", "Quizzes", 10, /^Quiz/], ["cs300-g-mid", "Midterm", 15, /^Midterm/], ["cs300-g-final", "Final exam", 20, /^Final/]],
  about: "COMPSCI 300 Programming II (synthetic sample course). Object-oriented design, data structures and testing in Java. Lectures Tuesday and Thursday at 1:00 PM.",
  build({ material, assignment, graded, event, message, url }) {
    material("syllabus", "Syllabus", [
      "COMPSCI 300 Programming II: Syllabus (synthetic sample)",
      "Instructor: Prof. Dev Okafor (fictional).",
      "Grading: Programming projects 40%, Labs 15%, Quizzes 10%, Midterm 15%, Final exam 20%.",
      "Quiz 3 covers Lecture 9 and Lecture 10: hash tables and collision resolution.",
      "Projects are individual work. You may ask course staff and AI tutors to explain concepts, but you must write your own code.",
    ].join("\n"));
    material("cs300-l9", "Lecture 9 notes: Hash tables", [
      "Lecture 9: Hash tables",
      "Hashing",
      "A hash table stores key-value pairs in an array. A hash function maps each key to an index, and a good hash function spreads keys evenly across the array.",
      "Load factor",
      "The load factor is the number of stored entries divided by the array capacity. When the load factor passes a threshold such as 0.75, the table grows and every entry is rehashed into the larger array.",
      "Expected cost",
      "With a good hash function and a bounded load factor, insert, lookup and remove take constant expected time.",
    ].join("\n"), { updatedAt: ct("2026-09-22", "14:15") });
    material("cs300-l10", "Lecture 10 notes: Collision resolution", [
      "Lecture 10: Collision resolution",
      "Chaining",
      "With separate chaining, each array slot holds a list of the entries whose keys hash to that index.",
      "Open addressing",
      "With linear probing, a collision moves to the next slot until an empty one is found. Removing an entry leaves a marker so later lookups keep probing past it.",
    ].join("\n"), { updatedAt: ct("2026-09-24", "14:15") });
    material("cs300-p2-spec", "P2 starter guide: HashTableMap", "The starter code gives the MapADT interface and a skeleton HashTableMap class. Implement put, get, remove, containsKey and size with separate chaining. Grow the table when the load factor reaches 0.75.", { updatedAt: ct("2026-09-17", "09:00") });
    assignment("cs300-lab2", "Lab 2: Exceptions", "Lab 2 practises checked and unchecked exceptions. Submit Parser.java.", ["2026-09-16"], 10, { submissionTypes: ["online_upload"], ...graded(9, "2026-09-16") });
    assignment("cs300-quiz2", "Quiz 2: Generics", "Quiz 2 covers generic classes and interfaces. 15 minutes, taken on the course site.", ["2026-09-18", "17:00"], 10, { submissionTypes: ["online_quiz"], ...graded(8, "2026-09-18", "16:40") });
    assignment("cs300-lab3", "Lab 3: Linked lists", "Lab 3 practises singly linked lists. Submit LinkedList.java.", ["2026-09-23"], 10, { submissionTypes: ["online_upload"], ...graded(10, "2026-09-23") });
    assignment("cs300-p1", "Project 1: Inventory Tracker", "Submit your implementation and your test code.", ["2026-09-17"], 50, { submissionTypes: ["online_upload"], ...graded(44, "2026-09-17", "22:40") });
    assignment("cs300-lab4", "Lab 4: Iterators", "Lab 4 practises the Iterator interface. Implement an iterator for your linked list and submit LinkedListIterator.java.", ["2026-09-30"], 10, { submissionTypes: ["online_upload"] });
    assignment("cs300-p2", "Project 2: Hash Table Dictionary", [
      "Project 2 builds a dictionary backed by your own hash table.",
      "Submit your implementation in HashTableMap.java and a one-page report on how the load factor changed your lookup times.",
      "Include your JUnit test code for put, get, remove and resizing.",
      "Use the P2 starter guide: HashTableMap for the interface you must implement.",
    ].join("\n"), ["2026-10-01"], 50, {
      submissionTypes: ["online_upload"],
      links: [
        { url: url("materials/cs300-p2-spec"), text: "P2 starter guide: HashTableMap" },
        { url: url("materials/cs300-l9"), text: "Lecture 9 notes: Hash tables" },
      ],
    });
    assignment("cs300-quiz3", "Quiz 3: Hashing", "Quiz 3 covers hash tables and collision resolution. 15 minutes, taken on the course site.", ["2026-10-02", "17:00"], 10, { submissionTypes: ["online_quiz"] });
    for (const [date, n] of [["2026-09-29", 11], ["2026-10-01", 12]])
      event(`cs300-lec-${date}`, `COMPSCI 300 · Lecture ${n}`, [date, "13:00"], [date, "14:15"], "Room 1240 Sample Center");
    message("cs300-ann-p2", "Project 2 tests posted", "The Project 2 public tests are posted with the starter code. Run them before you submit; the hidden tests check resizing and remove.", ["2026-09-25", "16:00"]);
  },
});

const bio = course({
  id: "biology-151", slug: "bio151", code: "BIOLOGY 151", name: "BIOLOGY 151: Introductory Biology",
  instructor: "Dr. Ana Reyes (fictional)",
  groups: [["bio151-g-lab", "Lab reports", 30, /^Lab report/], ["bio151-g-quiz", "Quizzes and reading checks", 15, /quiz|Reading check/i], ["bio151-g-exam", "Exams", 55, /^Exam/]],
  about: "BIOLOGY 151 Introductory Biology (synthetic sample course). Cells, energy, genetics and evolution, with a weekly lab.",
  build({ material, assignment, graded, event, message, url }) {
    material("reading-1", "Reading: Enzymes and activation energy", [
      "Enzymes and activation energy",
      "Enzymes are proteins that speed up chemical reactions by lowering the activation energy. The substrate binds at the active site, and the enzyme is not used up by the reaction.",
      "Temperature and pH",
      "Each enzyme has an optimal temperature and pH. Above the optimum the enzyme denatures and its activity drops sharply.",
    ].join("\n"), { updatedAt: ct("2026-09-20", "08:00") });
    material("bio151-l8", "Lecture 8 notes: Cellular respiration", [
      "Lecture 8: Cellular respiration",
      "Glycolysis splits glucose into two pyruvate molecules in the cytoplasm and yields a small amount of ATP.",
      "The citric acid cycle and oxidative phosphorylation take place in the mitochondria and produce most of the cell's ATP.",
    ].join("\n"), { updatedAt: ct("2026-09-23", "10:00") });
    assignment("bio151-prelab2", "Pre-lab quiz 2", "Pre-lab quiz 2 covers microscope use. Taken on the course site.", ["2026-09-17", "08:00"], 5, { submissionTypes: ["online_quiz"], ...graded(4, "2026-09-16", "20:30") });
    assignment("bio151-lab2", "Lab report: Cell membranes", "Write a lab report on the osmosis experiment from Lab 2. Submit a PDF of 2 to 3 pages.", ["2026-09-16"], 30, { submissionTypes: ["online_upload"], ...graded(26, "2026-09-16", "22:10") });
    assignment("bio151-rc5", "Reading check 5: Cellular respiration", "Reading check 5 covers Lecture 8 on cellular respiration. Five questions on the course site; it closes at 11:59 PM.", ["2026-09-27"], 5, { submissionTypes: ["online_quiz"] });
    assignment("bio151-prelab3", "Pre-lab quiz 3", "Pre-lab quiz 3 covers the enzyme lab safety and procedure. Taken on the course site.", ["2026-09-24", "08:00"], 5, { submissionTypes: ["online_quiz"], ...graded(5, "2026-09-23", "21:00") });
    assignment("essay-1", "Lab report: Enzyme activity", "Write a lab report on how temperature changed catalase activity in Lab 3. Cite the enzyme reading in your discussion. Submit a PDF of 2 to 3 pages. AI may explain concepts, but must not write the submission.", ["2026-09-30"], 30, {
      submissionTypes: ["online_upload"],
      links: [{ url: url("materials/reading-1"), text: "Reading: Enzymes and activation energy" }],
    });
    assignment("bio151-prelab4", "Pre-lab quiz 4", "Pre-lab quiz 4 covers the respiration lab procedure. Taken on the course site.", ["2026-10-02", "08:00"], 5, { submissionTypes: ["online_quiz"] });
    assignment("bio151-exam1", "Exam 1", "Exam 1 covers cells, enzymes and cellular respiration. Taken in the evening exam room.", ["2026-10-08", "19:15"], 100, { submissionTypes: ["on_paper"] });
    event("bio151-lab-0930", "BIOLOGY 151 · Lab section", ["2026-09-30", "14:25"], ["2026-09-30", "16:20"], "Room 1117 Sample Labs");
    message("bio151-ann-lab", "Lab section moved this week", "This week's lab section is moved to Room 1117 Sample Labs. Bring your lab notebook and closed-toe shoes.", ["2026-09-25", "12:00"]);
  },
});

const out = [math, cs, bio];
writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n");
console.log(out.map((b) => `${b.source.id}: ${b.resources.length}`).join("\n"));

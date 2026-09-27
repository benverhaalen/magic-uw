import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "@magic/storage";
import { porterStem, queryTerms } from "@magic/retrieval";
import type { CaptureBatch, ResourceInput } from "@magic/contracts";
import { syntheticCorpus, COURSES } from "../evals/perf/synthetic";

// Synthetic data only: the MT1 corpus plus invented facts.
const t = (s: number) => new Date(Date.UTC(2099, 0, 1, 0, 0, s)).toISOString();

/** [planted fact, a student's question about it]. Questions paraphrase; they share only some words. */
const PLANTED: [string, string][] = [
  ["The Krebs cycle takes place in the mitochondrial matrix of eukaryotic cells.", "Where does the Krebs cycle take place?"],
  ["Professor Okonkwo holds office hours in Van Vleck Hall room B130 on Wednesdays.", "When are Professor Okonkwo's office hours?"],
  ["Late homework is accepted up to 48 hours after the deadline with a 15 percent penalty.", "What is the penalty for late homework?"],
  ["Dijkstra's algorithm fails when the graph contains negative edge weights.", "Why does Dijkstra's algorithm fail with negative edge weights?"],
  ["The Treaty of Westphalia in 1648 established the principle of state sovereignty.", "What principle did the Treaty of Westphalia establish?"],
  ["Le Chatelier's principle predicts how an equilibrium shifts when the concentration of a reactant changes.", "What does Le Chatelier's principle predict?"],
  ["The final exam will be held in Bascom Hall on December 17 at 7:25 pm.", "Where is the final exam held?"],
  ["Gram-Schmidt orthogonalization converts any basis into an orthonormal basis.", "What does Gram-Schmidt orthogonalization convert a basis into?"],
  ["A thesis statement should be arguable, specific, and placed at the end of the introduction.", "Where should the thesis statement be placed?"],
  ["Photosynthesis converts light energy into chemical energy stored in glucose.", "What does photosynthesis convert light energy into?"],
  ["The Meiji Restoration of 1868 ended the Tokugawa shogunate and restored imperial rule in Japan.", "What did the Meiji Restoration end?"],
  ["Quicksort has a worst-case running time of quadratic order when the pivot is always the smallest element.", "What is the worst-case running time of quicksort?"],
  ["Avogadro's number is approximately 6.022 times ten to the twenty-third per mole.", "What is the value of Avogadro's number?"],
  ["The determinant of a triangular matrix equals the product of its diagonal entries.", "How do you compute the determinant of a triangular matrix?"],
  ["Group project proposals must be emailed to the teaching assistant Priya Raman by March 3.", "Who receives the group project proposals?"],
  ["Mitosis produces two genetically identical daughter cells, while meiosis produces four haploid gametes.", "How many gametes does meiosis produce?"],
  ["The Haber process synthesizes ammonia from nitrogen and hydrogen using an iron catalyst.", "Which catalyst does the Haber process use?"],
  ["A heap supports extracting the minimum element in logarithmic time.", "How fast can a heap extract the minimum element?"],
  ["The Congress of Vienna redrew the map of Europe after the defeat of Napoleon in 1815.", "What did the Congress of Vienna do after Napoleon's defeat?"],
  ["Rhetorical appeals include ethos, pathos, and logos, as described by Aristotle.", "Which rhetorical appeals did Aristotle describe?"],
  ["The eigenvalues of a symmetric matrix are always real numbers.", "Are the eigenvalues of a symmetric matrix real?"],
  ["Lab safety goggles must be worn at all times in the Mendota chemistry laboratory.", "When must safety goggles be worn in the laboratory?"],
  ["Recursion requires a base case to guarantee that the function terminates.", "Why does recursion need a base case?"],
  ["The Bretton Woods agreement pegged currencies to the United States dollar after 1944.", "What did the Bretton Woods agreement peg currencies to?"],
  ["The enthalpy of vaporization for water is about 40.7 kilojoules per mole at its boiling point.", "What is the enthalpy of vaporization for water?"],
  ["Peer review drafts are due in the discussion board forty-eight hours before the workshop.", "When are peer review drafts due before the workshop?"],
  ["The rank-nullity theorem states that rank plus nullity equals the number of columns.", "What does the rank-nullity theorem state?"],
  ["Breadth-first search finds shortest paths in unweighted graphs using a queue.", "Which data structure does breadth-first search use?"],
  ["The Suez Crisis of 1956 marked the decline of British influence in the Middle East.", "What did the Suez Crisis mark?"],
  ["Oxidation is the loss of electrons, and reduction is the gain of electrons.", "Is oxidation the loss or gain of electrons?"],
  ["Chicago style footnotes place the full citation at the bottom of the page on first reference.", "Where do Chicago style footnotes place the citation?"],
  ["The midterm covers modules one through five, including hash tables and binary search trees.", "Which modules does the midterm cover?"],
  ["An orthogonal projection onto a subspace minimizes the distance to that subspace.", "What does an orthogonal projection onto a subspace minimize?"],
  ["The Scramble for Africa intensified after the Berlin Conference of 1884.", "What intensified after the Berlin Conference?"],
  ["A buffer solution resists changes in pH when small amounts of acid or base are added.", "What does a buffer solution resist?"],
  ["Counterarguments should be acknowledged and rebutted to strengthen a persuasive essay.", "How should counterarguments be handled in a persuasive essay?"],
  ["Kruskal's algorithm builds a minimum spanning tree by adding the lightest edges that avoid cycles.", "How does Kruskal's algorithm build a minimum spanning tree?"],
  ["The Industrial Revolution began in Britain because of abundant coal and colonial markets.", "Why did the Industrial Revolution begin in Britain?"],
  ["Attendance at Friday discussion sections counts for ten percent of the course grade.", "How much does attendance at discussion sections count?"],
  ["Least squares regression minimizes the sum of squared residuals.", "What does least squares regression minimize?"],
  ["Catalysts lower the activation energy of a reaction without being consumed.", "How do catalysts affect activation energy?"],
  ["Memoization stores the results of expensive function calls to avoid recomputation.", "What does memoization store?"],
  ["The Zollverein customs union prepared the economic unification of Germany.", "What did the Zollverein customs union prepare?"],
  ["Students may drop the lowest two quiz scores from the final average.", "How many quiz scores can students drop?"],
  ["A primary source is an original document created during the period being studied.", "What counts as a primary source document?"],
  ["The ideal gas law relates pressure, volume, temperature, and the number of moles.", "What does the ideal gas law relate?"],
  ["The inverse of a matrix exists only when its determinant is nonzero.", "When does the inverse of a matrix exist?"],
  ["Topological sorting orders the vertices of a directed acyclic graph so every edge points forward.", "What does topological sorting do to a directed acyclic graph?"],
  ["Regrade requests must be submitted through Gradescope within seven days of grades being released.", "How do I submit a regrade request?"],
  ["Nationalism in the nineteenth century fueled the unification of Italy under Cavour and Garibaldi.", "Who led the unification of Italy?"],
  ["Electronegativity increases across a period and decreases down a group of the periodic table.", "How does electronegativity change across a period?"],
  ["The writing center in Helen C. White Hall offers thirty-minute consultations by appointment.", "Where is the writing center?"],
];
/** Nothing in the materials answers these; the right answer is "not in your materials". */
const UNANSWERABLE = [
  "What is the capital of Mongolia?",
  "Who painted the Sistine Chapel ceiling?",
  "How do I reset my NetID password?",
  "What is the parking policy for Lot 60?",
  "Does the course use Piazza for discussions?",
  "When does the natatorium swimming pool open?",
  "What is the airspeed velocity of an unladen swallow?",
  "How many credits is the organic chemistry sequence?",
  "Who teaches the quantum mechanics recitation?",
  "What is the recipe for sourdough bread?",
  "What time does the bookstore close on Sundays?",
  "Which symphony did Beethoven write in 1824?",
  "What is the formula for the volume of a torus?",
  "How is the Mandarin tone sandhi rule applied?",
  "What are the side effects of ibuprofen?",
  "Who won the 1998 World Cup?",
  "What is the melting point of tungsten?",
  "How do volcanoes form island arcs?",
  "What is the rent for graduate housing in Eagle Heights?",
  "Which language is spoken in Andorra?",
  "How do I appeal a parking ticket?",
  "What is the tuition refund deadline?",
  "Explain the plot of Moby Dick.",
  "What vaccine schedule do infants follow?",
  "How does CRISPR gene editing work?",
  "What questions will be on the practice exam about volcanoes?",
];

/** The MT1 corpus at 1,000 resources with one fact planted mid-text in each of 52 materials. */
function plantedStore() {
  const corpus = syntheticCorpus(1000);
  const materials = corpus.batches.flatMap((b) => b.resources.filter((r) => r.kind === "material").map((r) => ({ b, r })));
  const planted: { externalId: string; courseId: string; fact: string; question: string }[] = [];
  PLANTED.forEach(([fact, question], i) => {
    const { r } = materials[i * 7]!;
    const middle = r.text.indexOf(". ", Math.floor(r.text.length / 2));
    r.text = `${r.text.slice(0, middle + 2)}${fact} ${r.text.slice(middle + 2)}`;
    planted.push({ externalId: r.externalId, courseId: r.courseId, fact, question });
  });
  const store = createStore(":memory:");
  for (const b of corpus.batches) store.ingest(b);
  const byExternal = new Map(store.resources().map((r) => [r.externalId, r]));
  return { store, planted, byExternal };
}

test("planted questions: recall@5 ≥ 0.90 on 52 answerable, ≥ 0.80 correct not-found on 26 unanswerable", () => {
  const { store, planted, byExternal } = plantedStore();
  try {
    let recalled = 0;
    let answeredAsFound = 0;
    const misses: string[] = [];
    for (const p of planted) {
      const resource = byExternal.get(p.externalId)!;
      const start = resource.text.indexOf(p.fact);
      const result = store.searchPassages({ query: p.question, k: 5 });
      const hit = result.hits.find((h) => h.resourceId === resource.id && h.start < start + p.fact.length && h.end > start);
      if (hit) recalled++;
      else misses.push(p.question);
      if (!result.notFound) answeredAsFound++;
      for (const h of result.hits) assert.ok(h.excerpt.length <= 240);
    }
    let correctNotFound = 0;
    const falseFound: string[] = [];
    for (const q of UNANSWERABLE) {
      const result = store.searchPassages({ query: q, k: 5 });
      if (result.notFound) correctNotFound++;
      else falseFound.push(`${q} (${result.coverage.toFixed(2)})`);
    }
    const recall = recalled / planted.length;
    const notFound = correctNotFound / UNANSWERABLE.length;
    const answerable = answeredAsFound / planted.length;
    console.log(
      `passages eval: recall@5 ${recall.toFixed(3)} (${recalled}/${planted.length}); answerable marked found ${answerable.toFixed(3)}; ` +
        `not-found ${notFound.toFixed(3)} (${correctNotFound}/${UNANSWERABLE.length}); misses: ${JSON.stringify(misses)}; false found: ${JSON.stringify(falseFound)}`,
    );
    assert.ok(PLANTED.length >= 50 && UNANSWERABLE.length >= 20);
    assert.ok(recall >= 0.9, `recall@5 ${recall}`);
    assert.ok(notFound >= 0.8, `not-found ${notFound}`);
    assert.ok(answerable >= 0.9, `answerable questions pass the gate: ${answerable}`);
  } finally {
    store.close();
  }
});

test("course-scoped search returns only that course's passages with offsets that slice the version text", () => {
  const { store, planted, byExternal } = plantedStore();
  try {
    const p = planted[0]!;
    const own = store.searchPassages({ query: p.question, courses: [{ accountScope: "perf-synthetic", courseId: p.courseId }] });
    assert.ok(own.hits.length > 0);
    assert.ok(own.hits.every((h) => h.courseId === p.courseId));
    const other = COURSES.find((c) => c.id !== p.courseId)!.id;
    const elsewhere = store.searchPassages({ query: p.question, courses: [{ accountScope: "perf-synthetic", courseId: other }] });
    assert.ok(elsewhere.hits.every((h) => h.courseId === other));
    assert.equal(elsewhere.hits.some((h) => h.resourceId === byExternal.get(p.externalId)!.id), false);
    assert.deepEqual(store.searchPassages({ query: p.question, courses: [] }).hits, []);
    for (const h of own.hits) {
      const text = store.passage(h.pid)!;
      assert.equal(text.text, store.resource(h.resourceId)!.text.slice(h.start, h.end));
      assert.ok(h.excerpt.length <= 240);
      assert.ok(text.text.replace(/\s+/g, " ").startsWith(h.excerpt.replace(/…$/, "")));
    }
  } finally {
    store.close();
  }
});

const source = { id: "canvas-course-1", label: "Canvas", kind: "canvas" as const, accountScope: "student-1", courseId: "course-1", scope: "pages" };
const page = (text: string, extra: Partial<ResourceInput> = {}): ResourceInput => ({
  externalId: "p1",
  kind: "material",
  courseId: "course-1",
  courseName: "Example Biology",
  title: "Week 2 notes",
  url: "https://canvas.example.test/pages/p1",
  text,
  deadlines: [],
  points: null,
  submitted: null,
  policy: { mode: "unknown", evidence: "" },
  ...extra,
});
const capture = (s: number, resources: ResourceInput[]): CaptureBatch => ({ source, observedAt: t(s), complete: true, status: "ok", resources });

test("passages are rebuilt per version; an old version is never searchable; a deleted item leaves the index", () => {
  const store = createStore(":memory:");
  try {
    store.ingest(capture(0, [page("Zygomorphic flowers have bilateral symmetry.\n\nActinomorphic flowers are radial.")]))
    const id = store.resources()[0]!.id;
    assert.equal(store.searchPassages({ query: "zygomorphic flowers" }).hits[0]!.resourceId, id);
    store.ingest(capture(1, [page("Pollinators prefer bright petals.")]));
    assert.equal(store.searchPassages({ query: "zygomorphic flowers" }).hits.length, 0, "the old version is gone");
    assert.equal(store.searchPassages({ query: "zygomorphic" }).notFound, true);
    assert.ok(store.passages(id).every((p) => p.version === 2));
    assert.equal(store.searchPassages({ query: "pollinators petals" }).hits[0]!.version, 2);
    assert.deepEqual(store.resources("zygomorphic"), []);
    assert.equal(store.resources("pollinators")[0]!.id, id);
    store.ingest(capture(2, []));
    assert.equal(store.searchPassages({ query: "pollinators petals" }).hits.length, 0, "deleted item unsearchable");
    assert.deepEqual(store.passages(id), []);
  } finally {
    store.close();
  }
});

test("parts are followed: a PDF page stays a passage boundary and carries its page number", () => {
  const store = createStore(":memory:");
  try {
    const pages = ["Chapter one introduces membranes.", "Chapter two covers osmotic pressure in detail."];
    store.ingest(capture(0, [page(pages.join("\n\n"), { parts: pages.map((text, i) => ({ page: i + 1, text })) })]));
    const hit = store.searchPassages({ query: "osmotic pressure" }).hits[0]!;
    assert.equal(hit.page, 2);
    assert.equal(store.passage(hit.pid)!.text, pages[1]);
  } finally {
    store.close();
  }
});

test("lookup mode matches every term as typed (prefix); question mode needs content words", () => {
  const store = createStore(":memory:");
  try {
    store.ingest(capture(0, [page("Membrane transport: diffusion and osmosis."), page("Cell division overview.", { externalId: "p2", title: "Mitosis" })]));
    assert.equal(store.searchPassages({ query: "memb osmo", mode: "lookup" }).hits.length, 1);
    assert.equal(store.searchPassages({ query: "memb mitosis", mode: "lookup" }).notFound, true);
    assert.equal(store.searchPassages({ query: "???" }).notFound, true);
    assert.doesNotThrow(() => store.searchPassages({ query: '" OR * NEAR(x) - : {ctx}' }));
    assert.equal(store.searchPassages({ query: "mitosis" }).hits[0]!.title, "Mitosis", "titles are searchable");
  } finally {
    store.close();
  }
});

test("the JS Porter stemmer agrees with FTS5's porter tokenizer on the corpus vocabulary", () => {
  const corpus = syntheticCorpus(200);
  const words = new Set<string>();
  for (const b of corpus.batches) for (const r of b.resources) for (const w of queryTerms(`${r.title} ${r.text}`).terms) words.add(w);
  for (const [fact, question] of PLANTED) for (const w of queryTerms(`${fact} ${question}`).terms) words.add(w);
  const list = [...words].filter((w) => /^[a-z]+$/.test(w));
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE f USING fts5(w, tokenize='porter unicode61 remove_diacritics 2'); CREATE VIRTUAL TABLE v USING fts5vocab(f, 'instance');");
  const insert = db.prepare("INSERT INTO f(rowid, w) VALUES (?, ?)");
  list.forEach((w, i) => insert.run(i + 1, w));
  const stems = new Map((db.prepare("SELECT doc, term FROM v").all() as { doc: number; term: string }[]).map((r) => [Number(r.doc), r.term]));
  const mismatches = list.filter((w, i) => porterStem(w) !== stems.get(i + 1));
  db.close();
  assert.ok(list.length > 300);
  assert.deepEqual(mismatches.map((w) => `${w}: js ${porterStem(w)} fts ${stems.get(list.indexOf(w) + 1)}`), []);
});

test("exact selected resources are constrained inside shared FTS before top-k", () => {
  const {store,planted,byExternal}=plantedStore();
  try {
    const target=byExternal.get(planted[0]!.externalId)!;
    const course=store.sources().find(s=>s.id===target.sourceId)!;
    const hits=store.searchPassages({query:"Krebs cycle",courses:[{accountScope:course.accountScope,courseId:target.courseId}],resourceIds:[target.id],k:1}).hits;
    assert.equal(hits.length,1);
    assert.equal(hits[0]!.resourceId,target.id);
    assert.deepEqual(store.searchPassages({query:"Krebs cycle",resourceIds:[],k:5}).hits,[]);
  } finally { store.close(); }
});

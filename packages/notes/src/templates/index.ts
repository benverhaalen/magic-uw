/**
 * Note templates (typed block schemas) and the code rules that suggest one (plan D35: the subject
 * family is code-derived from the UW subject code, then the course title). 0 tokens.
 */
import type {
  NoteBlock,
  NoteBlockKind,
  NoteTemplateId,
  NoteTemplateInfo,
  SessionType,
} from "../../../contracts/src/notes";

export type SubjectFamily =
  | "languages"
  | "math"
  | "physical_science"
  | "life_science"
  | "engineering"
  | "computing"
  | "humanities"
  | "social_science"
  | "business"
  | "arts"
  | "unknown";

interface BlockSpec {
  id: string;
  kind: NoteBlockKind;
  heading: string;
  hint: string;
}
interface TemplateSpec {
  id: NoteTemplateId;
  name: string;
  description: string;
  blocks: BlockSpec[];
}
const b = (id: string, kind: NoteBlockKind, heading: string, hint: string): BlockSpec => ({ id, kind, heading, hint });

/** The scaffold's shared head: code fills these from the schedule and materials. */
export const SCAFFOLD_BLOCKS: BlockSpec[] = [
  b("context", "context", "Session", "Date, time, module and section."),
  b("sources", "sources", "Slides and readings", "This session's materials."),
  b("terms", "terms", "Key terms", "Terms from this session's materials."),
  b("due", "due", "Due next", "What's due next in this course."),
];

export const TEMPLATES: Record<NoteTemplateId, TemplateSpec> = {
  cornell: {
    id: "cornell",
    name: "Cornell",
    description: "Notes beside a cue column, closed by a summary. For lectures in the humanities, social and life sciences.",
    blocks: [
      b("cues", "cues", "Cues and questions", "Questions and keywords that recall each note."),
      b("notes", "section", "Notes", "Main ideas, evidence and examples as the lecture goes."),
      b("summary", "summary", "Summary", "Two or three sentences in your own words."),
    ],
  },
  "worked-problem": {
    id: "worked-problem",
    name: "Worked problems",
    description: "Ideas and formulas, then problems worked step by step. For math, physics and engineering.",
    blocks: [
      b("ideas", "section", "Key ideas and formulas", "Definitions, theorems and formulas, with when they apply."),
      b("problems", "problems", "Worked problems", "Each problem: setup, steps, answer, check."),
      b("pitfalls", "pitfalls", "Mistakes to avoid", "Where a step usually goes wrong."),
      b("summary", "summary", "Summary", "What you can now solve."),
    ],
  },
  "concept-code-pitfalls": {
    id: "concept-code-pitfalls",
    name: "Concept, code, pitfalls",
    description: "Each concept with the code that shows it and the bugs it invites. For computing courses.",
    blocks: [
      b("concepts", "section", "Concepts", "The idea in a sentence, and why it matters."),
      b("code", "code", "Code", "A small example that shows it."),
      b("pitfalls", "pitfalls", "Pitfalls", "Bugs, edge cases and complexity traps."),
      b("questions", "questions", "Questions to try", "What to test or ask in office hours."),
    ],
  },
  "lab-notebook": {
    id: "lab-notebook",
    name: "Lab notebook",
    description: "Objective, procedure, data and results. For lab sections.",
    blocks: [
      b("objective", "section", "Objective", "What this lab measures or builds."),
      b("procedure", "procedure", "Procedure", "Steps as you did them, with changes."),
      b("data", "data", "Data and observations", "Measurements, outputs and anything unexpected."),
      b("results", "summary", "Results and conclusions", "What the data shows and its uncertainty."),
      b("questions", "questions", "Questions", "Anything to ask the TA or check in the report."),
    ],
  },
  "vocab-grammar": {
    id: "vocab-grammar",
    name: "Vocabulary and grammar",
    description: "New words, grammar points and example sentences. For language courses.",
    blocks: [
      b("vocabulary", "vocabulary", "Vocabulary", "Word, meaning, and an example."),
      b("grammar", "grammar", "Grammar", "The rule, its exceptions, and a model sentence."),
      b("phrases", "section", "Phrases and examples", "Sentences from class worth reusing."),
      b("practice", "questions", "Practice", "Sentences to write or say before next class."),
    ],
  },
  "reading-response": {
    id: "reading-response",
    name: "Reading response",
    description: "The reading's claims, your response, and questions to bring. For humanities discussion sections.",
    blocks: [
      b("claims", "section", "The reading's claims", "Main argument and key passages (with page)."),
      b("response", "section", "My response", "Where you agree, disagree, or see a connection."),
      b("questions", "questions", "Questions for discussion", "Two or three to raise in section."),
      b("takeaways", "summary", "Takeaways from discussion", "What changed your reading."),
    ],
  },
  "discussion-prep": {
    id: "discussion-prep",
    name: "Discussion prep",
    description: "What to bring to section and what came out of it.",
    blocks: [
      b("prep", "section", "Before section", "Points and problems to bring."),
      b("questions", "questions", "Questions", "What's still unclear."),
      b("notes", "section", "During section", "Answers, examples and hints from the TA."),
      b("takeaways", "summary", "Takeaways", "What to review before the next assignment."),
    ],
  },
  "case-method": {
    id: "case-method",
    name: "Case method",
    description: "Facts, problem, analysis, options and a recommendation. For business courses.",
    blocks: [
      b("facts", "section", "Case facts", "Who, what, the numbers that matter."),
      b("problem", "section", "The decision", "The problem or decision to make."),
      b("analysis", "section", "Analysis", "Frameworks applied and what they show."),
      b("options", "section", "Options", "Alternatives with pros and cons."),
      b("recommendation", "summary", "Recommendation and lessons", "Your call, and what generalizes."),
    ],
  },
  outline: {
    id: "outline",
    name: "Outline",
    description: "A plain outline and a summary.",
    blocks: [
      b("outline", "section", "Outline", "Headings and points as they come."),
      b("summary", "summary", "Summary", "The session in a few sentences."),
    ],
  },
};

export function templateInfo(): NoteTemplateInfo[] {
  return Object.values(TEMPLATES).map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    blocks: [...SCAFFOLD_BLOCKS, ...t.blocks].map(({ kind, heading, hint }) => ({ kind, heading, hint })),
  }));
}

/** Empty student blocks of a template (the scaffold's head blocks come from `scaffold`). */
export function templateBlocks(template: NoteTemplateId): NoteBlock[] {
  return TEMPLATES[template].blocks.map((s) => ({ id: s.id, kind: s.kind, heading: s.heading, hint: s.hint, items: [] }));
}

// UW–Madison subject codes (short names as Canvas and the Guide print them), by family.
const SUBJECTS: Record<Exclude<SubjectFamily, "unknown">, string[]> = {
  languages: [
    "SPANISH", "FRENCH", "GERMAN", "ITALIAN", "PORTUG", "CHINESE", "JAPANESE", "KOREAN", "ARABIC", "HEBREW",
    "HEBR-MOD", "RUSSIAN", "POLISH", "LATIN", "GREEK", "HINDI", "SWAHILI", "SCAND ST", "DANISH", "NORWEG",
    "SWEDISH", "FINNISH", "LITHUAN", "PERSIAN", "TURKISH", "HMONG", "YIDDISH", "ASIALANG", "AFRICAN", "ASL", "UKRAINE",
  ],
  math: ["MATH", "STAT", "ACT SCI"],
  physical_science: ["PHYSICS", "CHEM", "ASTRON", "ATM OCN", "GEOSCI", "MEDPHYS"],
  life_science: [
    "BIOLOGY", "BIOCHEM", "ZOOLOGY", "BOTANY", "GENETICS", "MICROBIO", "ANATOMY", "PHYSIOL", "NEUROSCI", "INTEGBIO",
    "BIOCORE", "BMOLCHEM", "ONCOLOGY", "PATH", "PHM SCI", "NUTR SCI", "ENTOM", "PL PATH", "AN SCI", "FOOD SCI", "KINES",
    "NURSING", "PHARMACY", "ENVIR ST", "F&W ECOL", "SOIL SCI", "AGRONOMY", "HORT", "DY SCI",
  ],
  engineering: [
    "ECE", "E C E", "ME", "M E", "CBE", "C B E", "CIV ENGR", "CIV ENG", "BME", "B M E", "EMA", "E M A", "EP", "E P",
    "I SY E", "ISYE", "MS&E", "M S & E", "NE", "N E", "INTEREGR", "INTER-EG", "GLE", "G L E", "BSE", "B S E", "EPD", "ENGR",
  ],
  computing: ["COMPSCI", "COMP SCI", "CS", "LIS"],
  humanities: [
    "ENGL", "ENGLISH", "PHILOS", "HISTORY", "HIST SCI", "LITTRANS", "CLASSICS", "RELIG ST", "ART HIST", "COM ARTS",
    "COMP LIT", "FOLKLORE", "GEN&WS", "JEWISH", "MEDIEVAL", "AFROAMER", "AMER IND", "ASIAN AM", "CHICLA", "LCA",
  ],
  social_science: [
    "PSYCH", "SOC", "ECON", "POLI SCI", "ANTHRO", "GEOG", "JOURN", "COMMUNICATIONS", "PUB AFFR", "ED POL", "ED PSYCH",
    "CURRIC", "HDFS", "CNSR SCI", "INTL ST", "LEGAL ST", "URB R PL", "SOC WORK", "COUN PSY", "RP & SE", "ELPA", "AAE",
  ],
  business: ["ACCT I S", "FINANCE", "MARKETNG", "MHR", "OTM", "GEN BUS", "REAL EST", "RM & I", "RMI", "INFO SYS", "BUS", "ISOM"],
  arts: ["ART", "MUSIC", "MUS PERF", "THEATRE", "DANCE", "DS", "LAND ARC", "ART ED"],
};
const SUBJECT_FAMILY = new Map<string, SubjectFamily>();
for (const [family, codes] of Object.entries(SUBJECTS) as [SubjectFamily, string[]][])
  for (const code of codes) if (!SUBJECT_FAMILY.has(compact(code))) SUBJECT_FAMILY.set(compact(code), family);
function compact(value: string): string {
  return value.toUpperCase().replace(/[^A-Z&]/g, "");
}
const TITLE_RULES: [RegExp, SubjectFamily][] = [
  [/\b(spanish|french|german|italian|portuguese|chinese|japanese|korean|arabic|hebrew|russian|latin|greek|language)\b/i, "languages"],
  [/\b(mathemat\w*|calculus|algebra|statistic\w*|probability|geometry)\b/i, "math"],
  [/\b(programming|software|computer|algorithms?|data structures?|machine learning)\b/i, "computing"],
  [/\b(physics|chemistry|astronomy|mechanics)\b/i, "physical_science"],
  [/\b(biology|genetics|ecology|physiology|anatomy|neuroscience)\b/i, "life_science"],
  [/\b(signals?|circuits?|engineering|thermodynamics|materials)\b/i, "engineering"],
  [/\b(accounting|finance|marketing|management|business)\b/i, "business"],
  [/\b(psychology|sociology|economics|political|anthropology)\b/i, "social_science"],
  [/\b(literature|philosophy|history|religion|culture|writing)\b/i, "humanities"],
  [/\b(music|art|theatre|theater|dance|design)\b/i, "arts"],
];

export interface CourseLike {
  courseName: string;
  /** Canvas's course code, for example "FA26 COMPSCI 400 001". */
  courseCode?: string | null;
}
/** The course's UW subject short name and catalog number, when code can read them. */
export function subjectOf(course: CourseLike): { subject: string; catalog: string } | null {
  for (const raw of [course.courseCode ?? "", course.courseName]) {
    const value = raw.replace(/^(?:FA|SP|SU)\d{2}[\s:_-]+/i, "").trim();
    const m = /^([A-Z][A-Z &-]{0,14}?)\s*(\d{3}[A-Z]?)\b/.exec(value.toUpperCase());
    if (m) return { subject: m[1]!.trim(), catalog: m[2]! };
  }
  return null;
}
function titleOf(course: CourseLike): string {
  const name = course.courseName.replace(/\([^)]*\)/g, " ").replace(/\b(?:FA|SP|SU)\d{2}\b/g, " ");
  const colon = name.indexOf(":");
  return (colon >= 0 ? name.slice(colon + 1) : name).trim();
}

/**
 * The subject family, by code: the UW subject code first, then course-title keywords. A
 * computing course whose title is mathematics (for example Discrete Mathematics) reads as math.
 */
export function subjectFamily(course: CourseLike): { family: SubjectFamily; reason: string } {
  const subject = subjectOf(course);
  const title = titleOf(course);
  const byTitle = TITLE_RULES.find(([re]) => re.test(title));
  const known = subject ? SUBJECT_FAMILY.get(compact(subject.subject)) : undefined;
  if (known) {
    if (known === "computing" && byTitle?.[1] === "math")
      return { family: "math", reason: `${subject!.subject} is computing, but the title "${title}" is mathematics` };
    return { family: known, reason: `subject ${subject!.subject}` };
  }
  if (byTitle) return { family: byTitle[1], reason: `title "${title}"` };
  return { family: "unknown", reason: subject ? `subject ${subject.subject} is not in the table` : "no subject code" };
}

const LECTURE: Record<SubjectFamily, NoteTemplateId> = {
  languages: "vocab-grammar",
  math: "worked-problem",
  physical_science: "worked-problem",
  engineering: "worked-problem",
  computing: "concept-code-pitfalls",
  life_science: "cornell",
  humanities: "cornell",
  social_science: "cornell",
  arts: "cornell",
  business: "case-method",
  unknown: "outline",
};
const DISCUSSION: Record<SubjectFamily, NoteTemplateId> = {
  languages: "vocab-grammar",
  math: "worked-problem",
  physical_science: "worked-problem",
  engineering: "worked-problem",
  computing: "concept-code-pitfalls",
  life_science: "discussion-prep",
  humanities: "reading-response",
  social_science: "discussion-prep",
  arts: "reading-response",
  business: "case-method",
  unknown: "discussion-prep",
};

/**
 * The suggested template for a session, by code: labs get the lab notebook (language labs keep
 * vocabulary and grammar); lectures and discussions follow the subject family. The student's
 * remembered choice for the course and session type wins over this (the service applies it).
 */
export function suggestTemplate(
  course: CourseLike,
  session: { type: SessionType },
): { template: NoteTemplateId; family: SubjectFamily; reason: string } {
  const { family, reason } = subjectFamily(course);
  if (session.type === "lab")
    return family === "languages"
      ? { template: "vocab-grammar", family, reason: `language lab (${reason})` }
      : { template: "lab-notebook", family, reason: `lab session (${reason})` };
  const table = session.type === "discussion" ? DISCUSSION : LECTURE;
  const template = session.type === "other" && family === "unknown" ? "outline" : table[family];
  return { template, family, reason: `${session.type} in ${family.replace("_", " ")} (${reason})` };
}

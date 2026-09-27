/**
 * The original Porter (1980) stemmer, as FTS5's `porter` tokenizer applies it to lowercase ASCII
 * tokens of three or more characters. Used only to look a query term up in the FTS5 vocabulary
 * (document frequency); if it ever disagrees with FTS5, the lookup misses and the term is kept.
 */
const isConsonant = (w: string, i: number): boolean => {
  const c = w[i]!;
  if ("aeiou".includes(c)) return false;
  if (c === "y") return i === 0 ? true : !isConsonant(w, i - 1);
  return true;
};
/** m(): the number of VC sequences in w[0..end). */
function measure(w: string, end: number): number {
  let n = 0;
  let i = 0;
  while (i < end && isConsonant(w, i)) i++;
  while (i < end) {
    while (i < end && !isConsonant(w, i)) i++;
    if (i >= end) break;
    n++;
    while (i < end && isConsonant(w, i)) i++;
  }
  return n;
}
const hasVowel = (w: string, end: number) => {
  for (let i = 0; i < end; i++) if (!isConsonant(w, i)) return true;
  return false;
};
const doubleConsonant = (w: string) =>
  w.length >= 2 && w[w.length - 1] === w[w.length - 2] && isConsonant(w, w.length - 1);
/** *o: stem ends cvc, where the second c is not w, x or y. */
const cvc = (w: string, end: number) =>
  end >= 3 &&
  isConsonant(w, end - 3) &&
  !isConsonant(w, end - 2) &&
  isConsonant(w, end - 1) &&
  !"wxy".includes(w[end - 1]!);

function replace(w: string, suffix: string, to: string, minMeasure: number): string | undefined {
  if (!w.endsWith(suffix)) return undefined;
  const stem = w.length - suffix.length;
  return measure(w, stem) > minMeasure ? w.slice(0, stem) + to : w;
}

const STEP2: [string, string][] = [
  ["ational", "ate"], ["tional", "tion"], ["enci", "ence"], ["anci", "ance"], ["izer", "ize"],
  ["abli", "able"], ["alli", "al"], ["entli", "ent"], ["eli", "e"], ["ousli", "ous"],
  ["ization", "ize"], ["ation", "ate"], ["ator", "ate"], ["alism", "al"], ["iveness", "ive"],
  ["fulness", "ful"], ["ousness", "ous"], ["aliti", "al"], ["iviti", "ive"], ["biliti", "ble"],
];
const STEP3: [string, string][] = [
  ["icate", "ic"], ["ative", ""], ["alize", "al"], ["iciti", "ic"], ["ical", "ic"], ["ful", ""], ["ness", ""],
];
const STEP4 = [
  "al", "ance", "ence", "er", "ic", "able", "ible", "ant", "ement", "ment", "ent", "ion", "ou",
  "ism", "ate", "iti", "ous", "ive", "ize",
];

export function porterStem(word: string): string {
  let w = word;
  if (w.length < 3 || !/^[a-z]+$/.test(w)) return w;
  // Step 1a
  if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ies")) w = w.slice(0, -2);
  else if (!w.endsWith("ss") && w.endsWith("s")) w = w.slice(0, -1);
  // Step 1b
  let extra = false;
  if (w.endsWith("eed")) {
    if (measure(w, w.length - 3) > 0) w = w.slice(0, -1);
  } else if (w.endsWith("ed") && hasVowel(w, w.length - 2)) {
    w = w.slice(0, -2);
    extra = true;
  } else if (w.endsWith("ing") && hasVowel(w, w.length - 3)) {
    w = w.slice(0, -3);
    extra = true;
  }
  if (extra) {
    if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) w += "e";
    else if (doubleConsonant(w) && !"lsz".includes(w[w.length - 1]!)) w = w.slice(0, -1);
    else if (measure(w, w.length) === 1 && cvc(w, w.length)) w += "e";
  }
  // Step 1c
  if (w.endsWith("y") && hasVowel(w, w.length - 1)) w = w.slice(0, -1) + "i";
  // Step 2
  for (const [s, r] of STEP2) {
    const out = replace(w, s, r, 0);
    if (out !== undefined) {
      w = out;
      break;
    }
  }
  // Step 3
  for (const [s, r] of STEP3) {
    const out = replace(w, s, r, 0);
    if (out !== undefined) {
      w = out;
      break;
    }
  }
  // Step 4
  for (const s of STEP4) {
    if (!w.endsWith(s)) continue;
    const stem = w.length - s.length;
    if (measure(w, stem) > 1 && (s !== "ion" || "st".includes(w[stem - 1] ?? ""))) w = w.slice(0, stem);
    break;
  }
  // Step 5a
  if (w.endsWith("e")) {
    const m = measure(w, w.length - 1);
    if (m > 1 || (m === 1 && !cvc(w, w.length - 1))) w = w.slice(0, -1);
  }
  // Step 5b
  if (measure(w, w.length) > 1 && doubleConsonant(w) && w.endsWith("l")) w = w.slice(0, -1);
  return w;
}

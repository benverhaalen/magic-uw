/**
 * Course corpora for the item-quality harness.
 *
 * - `synthetic`: the frozen cases in evals/items/cases (four subject families), committed.
 * - `ocw`: MIT OpenCourseWare course text read from a local download (default
 *   ~/buildfest-corpus/ocw; CC BY-NC-SA). Read in memory only: never copied into the repo,
 *   and runs over it write only to the gitignored .data folder.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { captureBatchSchema, type CaptureBatch } from "@magic/contracts";
import { subjectFamily } from "../../packages/notes/src/templates/index";
import type { CourseCase, GoldTopic } from "./harness";

export const CASES_DIR = join(import.meta.dirname, "cases");
export const SYNTHETIC_FAMILIES = ["languages", "math", "computing", "humanities"] as const;
export const DEFAULT_OCW_DIR = join(homedir(), "buildfest-corpus", "ocw");

export function familyOf(batch: CaptureBatch): string {
  const course = batch.resources.find((r) => r.kind === "course") ?? batch.resources[0]!;
  return subjectFamily({ courseName: course.courseName, courseCode: course.course?.courseCode ?? null }).family;
}

export function syntheticCourses(only?: readonly string[]): CourseCase[] {
  return SYNTHETIC_FAMILIES.filter((f) => !only || only.includes(f)).map((f) => {
    const doc = JSON.parse(readFileSync(join(CASES_DIR, `${f}.json`), "utf8")) as { family: string; batch: unknown; gold: GoldTopic[] };
    const batch = captureBatchSchema.parse(doc.batch);
    const family = familyOf(batch);
    if (family !== doc.family) throw new Error(`${f}.json: code reads the subject family as ${family}, the case says ${doc.family}`);
    return { id: batch.source.courseId ?? f, family, tier: "synthetic" as const, batch, gold: doc.gold };
  });
}

/** SubRip/WebVTT captions to plain text: no cue numbers, timestamps or sound tags. */
export function captionText(raw: string): string {
  return raw
    .replace(/^﻿?WEBVTT.*$/m, "")
    .split(/\r?\n/)
    .filter((l) => !/^\d+$/.test(l.trim()) && !/-->/.test(l) && !/^(NOTE|STYLE)\b/.test(l.trim()))
    .join(" ")
    .replace(/\[[A-Z ]+\]/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const OCW_COURSES: { dir: RegExp; courseId: string; courseName: string; ext: string[] }[] = [
  { dir: /^6-006-/, courseId: "OCW-6.006", courseName: "6.006 Introduction to Algorithms (MIT OCW, Spring 2020)", ext: [".srt"] },
  { dir: /^6-042j-/, courseId: "OCW-6.042J", courseName: "6.042J Mathematics for Computer Science (MIT OCW, Fall 2010)", ext: [".srt"] },
  { dir: /^18-05-/, courseId: "OCW-18.05", courseName: "18.05 Introduction to Probability and Statistics (MIT OCW, Spring 2022)", ext: [".txt"] },
];

/**
 * Up to `perCourse` text files per OCW course (captions for 6.006 and 6.042J, class plans for
 * 18.05), each capped at `maxChars` so one call's passage budget covers a spread of them.
 * Returns [] when the corpus is not on this machine.
 */
export function ocwCourses(dir = DEFAULT_OCW_DIR, perCourse = 3, maxChars = 6000): CourseCase[] {
  if (!existsSync(dir)) return [];
  const out: CourseCase[] = [];
  for (const spec of OCW_COURSES) {
    const course = readdirSync(dir).find((d) => spec.dir.test(d));
    if (!course) continue;
    const res = join(dir, course, "static_resources");
    if (!existsSync(res)) continue;
    const files = readdirSync(res)
      .filter((f) => spec.ext.some((e) => f.toLowerCase().endsWith(e)) && !/data\.txt$|robots\.txt$/i.test(f))
      .filter((f) => statSync(join(res, f)).size > 2000)
      .sort()
      .slice(0, perCourse);
    const resources: Record<string, unknown>[] = [
      {
        externalId: `${spec.courseId}-course`,
        kind: "course",
        courseId: spec.courseId,
        courseName: spec.courseName,
        title: spec.courseName,
        url: "https://ocw.mit.edu/",
        text: "",
        deadlines: [],
        points: null,
        submitted: null,
      },
      ...files.map((f, i) => {
        const raw = readFileSync(join(res, f), "utf8");
        const text = (f.endsWith(".srt") || f.endsWith(".vtt") ? captionText(raw) : raw.replace(/^#.*$/gm, "").replace(/[ \t]+/g, " ").trim()).slice(0, maxChars);
        return {
          externalId: `${spec.courseId}-r${i + 1}`,
          kind: "material",
          courseId: spec.courseId,
          courseName: spec.courseName,
          title: `${spec.courseName}: ${f.replace(/^[0-9a-f]{32}_/, "")}`,
          url: "https://ocw.mit.edu/",
          text,
          deadlines: [],
          points: null,
          submitted: null,
          policy: { mode: "coaching", evidence: "Public MIT OpenCourseWare material used for a local benchmark run." },
        };
      }),
    ];
    const batch = captureBatchSchema.parse({
      source: { id: `${spec.courseId}-source`, kind: "canvas", accountScope: "ocw", courseId: spec.courseId, scope: "course", label: `${spec.courseName} (local OCW copy)` },
      observedAt: "2026-09-27T00:00:00.000Z",
      complete: true,
      status: "ok",
      resources,
    });
    out.push({ id: spec.courseId, family: familyOf(batch), tier: "ocw", batch, gold: [] });
  }
  return out;
}

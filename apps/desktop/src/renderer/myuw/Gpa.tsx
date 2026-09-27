import { useState } from "react";
import type { PlanningCourseHistory, UwGpaGrade } from "@magic/contracts";
import { UW_GRADE_POINTS } from "../../../../../packages/domain/src/planning";
import { gpaBySemester, gradesNeeded, whatIfGpa } from "../../../../../packages/domain/src/gpa";
import { Disclosure } from "../../../../../packages/ui/src";
import type { MyUwModel } from "./model";

/**
 * owner: gpa. GPA by semester, this term's what-if grades and a target, computed in code from the
 * saved course history (packages/domain/src/gpa.ts). Restored onto the designed My UW page after
 * the page replacement dropped the earlier panel (docs/notes/regressions-2026-09-27.md).
 */
export function GpaSection({ model }: { model: MyUwModel }) {
  const [grades, setGrades] = useState<Record<string, UwGpaGrade | "">>({});
  const [credits, setCredits] = useState<Record<string, string>>({});
  const [target, setTarget] = useState("");
  // The domain functions validate the plain contract shape; drop the storage-only fields.
  const history: PlanningCourseHistory[] = model.history.map((r) => ({
    id: r.id, kind: "course_history", provenance: r.provenance, courseKey: r.courseKey,
    termCode: r.termCode, state: r.state, credits: r.credits, grade: r.grade, gpaEligible: r.gpaEligible,
  }));
  const semesters = gpaBySemester(history);
  const current = model.thisTerm?.courses ?? [];
  if (!semesters.length && !current.length) return null;
  const reported = model.summary?.cumulativeGpa ?? null;
  const computed = semesters.at(-1)?.cumulativeGpa ?? null;
  const creditsFor = (courseKey: string): number | null => {
    const typed = credits[courseKey]?.trim();
    if (typed) { const n = Number(typed); return Number.isFinite(n) && n > 0 ? n : null; }
    const row = model.catalog.find((c) => c.courseKey === courseKey && c.creditMin !== null && c.creditMin === c.creditMax);
    return row ? row.creditMin : null;
  };
  const picked = current.flatMap(({ record }) => {
    const grade = grades[record.courseKey], n = creditsFor(record.courseKey);
    return grade && n !== null ? [{ courseKey: record.courseKey, credits: n, grade }] : [];
  });
  const whatIf = whatIfGpa(history, picked);
  const goal = target.trim() !== "" ? Number(target) : null;
  const needed = goal !== null && Number.isFinite(goal)
    ? gradesNeeded(history, current.map(({ record }) => ({ courseKey: record.courseKey, credits: creditsFor(record.courseKey) ?? Number.NaN })), goal)
    : null;
  const fixed = (n: number | null) => (n === null ? "—" : n.toFixed(3));

  return <section className="myuw-section" id="myuw-gpa" aria-labelledby="myuw-gpa-title">
    <div className="myuw-section-head"><h2 id="myuw-gpa-title" tabIndex={-1}>GPA</h2></div>
    {semesters.length ? <>
      <p className="myuw-note">Cumulative {fixed(computed)}{reported === null ? "" : Math.abs((computed ?? -1) - reported) < 0.0005 ? ` · matches your student record` : ` · your student record reports ${reported.toFixed(3)}`}</p>
      <Disclosure label={`GPA by semester (${semesters.length})`}>
        {semesters.map((t) => <article className="myuw-row" key={t.termCode}>
          <strong>{t.label}</strong>
          <span className="myuw-note">{t.termCredits} credits · term {t.termGpa === null ? "not enough graded credits" : t.termGpa.toFixed(3)} · cumulative {fixed(t.cumulativeGpa)}{t.cumulativeHasUnknowns ? " · some attempts unresolved" : ""}</span>
        </article>)}
      </Disclosure>
    </> : <p className="myuw-note">Your course history appears here after Course Search & Enroll is connected.</p>}
    {current.length ? <Disclosure label="What if, this term">
      {current.map(({ record, label }) => <article className="myuw-row" key={record.localId}>
        <strong>{label}</strong>
        <label className="myuw-note">Grade <select value={grades[record.courseKey] ?? ""} onChange={(e) => setGrades((p) => ({ ...p, [record.courseKey]: e.target.value as UwGpaGrade | "" }))}>
          <option value="">Choose</option>{(Object.keys(UW_GRADE_POINTS) as UwGpaGrade[]).map((g) => <option key={g} value={g}>{g}</option>)}
        </select></label>
        {creditsFor(record.courseKey) === null ? <label className="myuw-note">Credits <input type="number" min={0} max={12} step={0.5} value={credits[record.courseKey] ?? ""} onChange={(e) => setCredits((p) => ({ ...p, [record.courseKey]: e.target.value }))} /></label> : null}
      </article>)}
      <p className="myuw-note">Projected term {fixed(whatIf.term.gpa)} · cumulative {fixed(whatIf.cumulative.gpa)}{whatIf.term.unknownCount ? " · some classes still need a grade or credits" : ""}</p>
      <label className="myuw-note">Target cumulative <input type="number" min={0} max={4} step={0.01} value={target} onChange={(e) => setTarget(e.target.value)} /></label>
      {needed ? <p className="myuw-note">{needed.status === "unknown" ? needed.reason
        : needed.status === "already_met" ? `Already reached: ${needed.achievableCumulative.toFixed(3)} even with an F this term.`
        : needed.status === "reachable" ? `Needs at least ${needed.neededGrade} in every class this term.`
        : `Not reachable this term; the best is ${needed.bestAchievableCumulative.toFixed(3)}.`}</p> : null}
    </Disclosure> : null}
  </section>;
}

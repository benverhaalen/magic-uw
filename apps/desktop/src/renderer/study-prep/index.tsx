// owner: study-prep. The entry the pages mount: the component, the course page's entries, and a
// modal host for them. KaTeX's stylesheet and fonts are bundled from node_modules by Vite (local
// files; the renderer's CSP allows only 'self').
import { useEffect, useRef, useState } from "react";
import "katex/dist/katex.min.css";
import "./study-prep.css";
import { StudyPrep, StudyPrepEntries } from "./StudyPrep";
import { Icon } from "./icons";

export { StudyPrep, StudyPrepEntries };

/** The course page's mount: upcoming exams and quizzes, each opening Study prep in a modal. */
export function CourseStudyPrep({ courseId }: { courseId: string }) {
  const [open, setOpen] = useState<{ id: string; title: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (open && d && !d.open) d.showModal?.();
  }, [open]);
  return (
    <>
      <StudyPrepEntries courseId={courseId} onOpen={(id, title) => setOpen({ id, title })} />
      {open ? (
        <dialog ref={dialog} className="sp-dialog" aria-label={`Study prep: ${open.title}`} onClose={() => setOpen(null)}>
          <button className="sp-icon-button sp-dialog-close" aria-label="Close study prep" title="Close (Esc)" onClick={() => dialog.current?.close()}>
            <Icon name="x" />
          </button>
          <StudyPrep courseId={courseId} assessmentId={open.id} />
        </dialog>
      ) : null}
    </>
  );
}

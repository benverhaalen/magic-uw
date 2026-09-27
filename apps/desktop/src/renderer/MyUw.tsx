import { decodeUwTerm } from "../../../../packages/domain/src/planning";
import type { Snapshot, StoredPlanningRecord } from "@magic/contracts";
import { MyUwPage, type MyUwProps } from "./myuw/MyUwPage";
import { attentionNeedsVerification, visibleRecords } from "./myuw/model";

type Props = MyUwProps;
const time = (value: string | null) => value ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "Not checked";
function Evidence({ record, snapshot, open }: { record: StoredPlanningRecord; snapshot: Snapshot; open: Props["open"] }) {
  return <div className="planning-evidence"><button className="subtle-button" onClick={() => open(record.provenance.sourceUrl)}>Source ↗</button><span>{time(record.provenance.observedAt)}{attentionNeedsVerification(record, snapshot.planning?.sources ?? [], Date.now()) ? " · Needs verification" : ""}</span></div>;
}

/** Home's compact holds and enrollment windows. Exported contract: snapshot, open, optional onPlanning. */
export function PlanningAlerts({ snapshot, open, onPlanning }: Pick<Props, "snapshot" | "open"> & { onPlanning?: () => void }) {
  const alerts = visibleRecords(snapshot).filter((record) => record.kind === "hold" || (record.kind === "appointment" && (!record.endsAt || Date.parse(record.endsAt) >= Date.now())));
  if (!alerts.length) return null;
  return <section className="planning-alerts" aria-label="Enrollment and holds">
    <div className="planning-section-title"><h2>Enrollment & holds</h2>{onPlanning ? <button className="subtle-button" onClick={onPlanning}>My UW →</button> : null}</div>
    {alerts.map((record) => <article key={record.localId} className="planning-row">
      {record.kind === "hold" ? <><strong>{record.title}</strong><p>{record.description}</p><span className="badge">{record.blocksEnrollment === true ? "Blocks enrollment" : record.blocksEnrollment === false ? "Does not block enrollment" : "Enrollment impact unknown"}</span>{record.resolutionUrl ? <button className="subtle-button" onClick={() => open(record.resolutionUrl!)}>How to resolve ↗</button> : null}</> : record.kind === "appointment" ? <><strong>Enrollment window · {decodeUwTerm(record.termCode).label}</strong><p>{record.startsAt ? time(record.startsAt) : "Opening time unavailable"}{record.endsAt ? ` – ${time(record.endsAt)}` : ""}</p></> : null}
      <Evidence record={record} snapshot={snapshot} open={open} />
    </article>)}
  </section>;
}

export function MyUw(props: Props) {
  return <MyUwPage {...props} />;
}

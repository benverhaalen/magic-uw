// owner: benchmarks. Settings → Local benchmarks: the measured full runs this computer banked.
// Reads the bank through window.magic.benchmarks only when this section is on screen (never
// through the 2-second snapshot). Course labels come from the workspace already on screen.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BenchmarkRun,
  BenchmarkStatus,
  BenchmarkStatusNow,
  BenchmarkSummary,
  BenchmarkTrigger,
  Snapshot,
} from "@magic/contracts";
import "./benchmarks.css";

export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1) return "under 1 ms";
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
}
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
const count = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString());
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const TRIGGER: Record<BenchmarkTrigger, string> = {
  benchmark: "Benchmark",
  manual: "Refresh",
  background: "Scheduled full read",
  planning: "My UW planning",
};
const STATUS: Record<BenchmarkStatus, { label: string; icon: "ok" | "partial" | "signin" | "stopped" }> = {
  ok: { label: "Complete", icon: "ok" },
  partial: { label: "Partly read", icon: "partial" },
  needs_sign_in: { label: "Needed sign-in", icon: "signin" },
  failed: { label: "Stopped", icon: "stopped" },
  cancelled: { label: "Cancelled", icon: "stopped" },
};
const PHASE: Record<string, string> = {
  "canvas-lists": "Canvas course areas",
  "canvas-pages": "Canvas pages",
  documents: "Course files",
  websites: "Course websites",
  "access-checks": "Linked-space checks",
  gitlab: "UW GitLab",
  calendar: "Calendar feeds",
  planning: "My UW planning",
};

// Lucide v0.468.0 (ISC): circle-check, circle-alert, log-in, circle-x.
function StatusIcon({ name }: { name: "ok" | "partial" | "signin" | "stopped" }) {
  const paths = {
    ok: <><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></>,
    partial: <><circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line x1="12" x2="12.01" y1="16" y2="16" /></>,
    signin: <><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><polyline points="10 17 15 12 10 7" /><line x1="15" x2="3" y1="12" y2="12" /></>,
    stopped: <><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6" /><path d="m9 9 6 6" /></>,
  };
  return (
    <svg className={`bench-status-icon is-${name}`} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}
function StatusLabel({ status }: { status: BenchmarkStatus }) {
  const s = STATUS[status];
  return (
    <span className="bench-status">
      <StatusIcon name={s.icon} />
      {s.label}
    </span>
  );
}

/** Change against the median of earlier comparable runs; lower is better for every timing here. */
function Delta({ value, baseline }: { value: number | null; baseline: number | null }) {
  if (value == null || baseline == null || baseline <= 0) return <span className="bench-delta">No earlier run to compare</span>;
  const change = (value - baseline) / baseline;
  // Under 5% or half a second either way is noise on a laptop, not a change.
  if (Math.abs(change) < 0.05 || Math.abs(value - baseline) < 500) return <span className="bench-delta">About the same as usual</span>;
  return (
    <span className={`bench-delta ${change < 0 ? "is-better" : "is-worse"}`}>
      {change < 0 ? "▼" : "▲"} {Math.abs(Math.round(change * 100))}% vs usual ({formatMs(baseline)})
    </span>
  );
}

function Stat({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="bench-stat">
      <div className="bench-stat-label">{label}</div>
      <div className="bench-stat-value">{value}</div>
      {children}
    </div>
  );
}

/** Full-sync time across the banked runs: one series, one hue, hover names the run. */
function SyncTrend({ runs, selected, onSelect }: { runs: BenchmarkSummary[]; selected: string | null; onSelect(id: string): void }) {
  const [hover, setHover] = useState<number | null>(null);
  const points = runs.filter((r) => r.trigger !== "planning" && r.wallMs != null).slice(0, 24).reverse();
  if (points.length < 2) return null;
  const width = 560, height = 96, top = 8, bottom = 18, gap = 2;
  const max = Math.max(...points.map((p) => p.wallMs!));
  const slot = width / points.length;
  const bar = Math.min(24, slot - gap);
  const y = (v: number) => top + (height - top - bottom) * (1 - v / max);
  const shown = hover != null ? points[hover]! : null;
  return (
    <figure className="bench-trend">
      <figcaption>Full sync time, last {points.length} measured runs</figcaption>
      <div className="bench-trend-plot">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Full sync time for the last ${points.length} runs; longest ${formatMs(max)}`} onMouseLeave={() => setHover(null)}>
          <line x1="0" x2={width} y1={height - bottom} y2={height - bottom} className="bench-axis" />
          <text x="0" y={top + 2} className="bench-tick">{formatMs(max)}</text>
          {points.map((p, i) => {
            const x = i * slot + (slot - bar) / 2;
            const h = Math.max(2, height - bottom - y(p.wallMs!));
            const r = Math.min(4, h / 2, bar / 2);
            const yTop = height - bottom - h;
            // 4px rounded data end, square at the baseline.
            const d = `M${x},${height - bottom} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + bar - r} Q${x + bar},${yTop} ${x + bar},${yTop + r} V${height - bottom} Z`;
            return (
              <g key={p.id}>
                <path d={d} className={`bench-bar ${p.id === selected ? "is-selected" : ""} ${hover === i ? "is-hover" : ""}`} />
                <rect
                  x={i * slot}
                  y={0}
                  width={slot}
                  height={height}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onClick={() => onSelect(p.id)}
                  tabIndex={0}
                  role="button"
                  aria-label={`${new Date(p.startedAt).toLocaleString()}: ${formatMs(p.wallMs)}`}
                  onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && onSelect(p.id)}
                />
              </g>
            );
          })}
        </svg>
        {shown && (
          <div className="bench-tooltip" style={{ left: `${((hover! + 0.5) / points.length) * 100}%` }} role="status">
            <strong>{formatMs(shown.wallMs)}</strong>
            <span>{new Date(shown.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {TRIGGER[shown.trigger]}</span>
            <span>{count(shown.requests)} requests · {STATUS[shown.status].label}</span>
          </div>
        )}
      </div>
    </figure>
  );
}

function Phases({ run }: { run: BenchmarkRun }) {
  const phases = run.sync?.phases ?? [];
  if (!phases.length) return <p className="bench-muted">No phase activity was recorded.</p>;
  const end = Math.max(run.sync!.wallMs, ...phases.map((p) => p.lastMs), 1);
  return (
    <div className="bench-phases" role="table" aria-label="Phases of the run">
      {phases.map((p) => (
        <div className="bench-phase" role="row" key={p.phase}>
          <span role="cell" className="bench-phase-name">{PHASE[p.phase] ?? p.phase}</span>
          <span role="cell" className="bench-phase-track" aria-hidden="true">
            <span className="bench-phase-span" style={{ left: `${(p.firstMs / end) * 100}%`, width: `${Math.max(0.6, ((p.lastMs - p.firstMs) / end) * 100)}%` }} />
          </span>
          <span role="cell" className="bench-phase-figures">
            {formatMs(p.lastMs - p.firstMs)} · {count(p.requests)} req · {formatBytes(p.bytes)}
          </span>
        </div>
      ))}
      <p className="bench-note">Each bar spans a phase's first to last activity; phases overlap.</p>
    </div>
  );
}

function RunDetail({ id, labels }: { id: string; labels: Map<string, string> }) {
  const [run, setRun] = useState<BenchmarkRun | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    window.magic.benchmarks!.get(id).then((value) => live && setRun(value), () => live && setRun(null));
    return () => {
      live = false;
    };
  }, [id]);
  if (run === undefined) return <p className="bench-muted">Loading the measurement…</p>;
  if (!run) return <p className="bench-muted">This measurement could not be read.</p>;
  const req = run.sync?.requests;
  const jobs = Object.entries(run.pipeline?.jobs ?? {});
  return (
    <div className="bench-detail">
      {run.sync && (
        <>
          <h3>Where the time went</h3>
          <Phases run={run} />
        </>
      )}
      {run.planning && (
        <p>
          My UW planning read in {formatMs(run.planning.wallMs)}: {count(run.planning.requests)} requests, {formatBytes(run.planning.bytes)}.
          {run.planning.failed.length ? ` Not read: ${run.planning.failed.join(", ")}.` : ""}
        </p>
      )}
      <div className="bench-detail-grid">
        {req && (
          <div>
            <h3>Requests</h3>
            <dl>
              <dt>Total</dt><dd>{count(req.total)} ({count(req.failed)} failed)</dd>
              <dt>Data</dt><dd>{formatBytes(req.bytes)}</dd>
              <dt>Latency</dt><dd>p50 {formatMs(req.p50Ms)} · p95 {formatMs(req.p95Ms)}</dd>
              {Object.entries(req.byService).map(([service, s]) => (
                <div className="bench-dl-row" key={service}><dt>{service}</dt><dd>{count(s.requests)} · {formatBytes(s.bytes)}{s.failed ? ` · ${s.failed} failed` : ""}</dd></div>
              ))}
              <dt>Statuses</dt><dd>{Object.entries(req.byStatus).sort().map(([k, v]) => `${k} ×${v}`).join(", ")}</dd>
            </dl>
          </div>
        )}
        {run.pipeline && (
          <div>
            <h3>Material pipeline</h3>
            <dl>
              <dt>Caught up</dt><dd>{run.pipeline.drained ? `after ${formatMs(run.pipeline.waitedMs)}` : `not within ${formatMs(run.pipeline.waitedMs)}`}</dd>
              <dt>Jobs run</dt><dd>{count(run.pipeline.done)} done, {count(run.pipeline.failed)} failed</dd>
              {run.pipeline.unavailablePending > 0 && <><dt>Waiting</dt><dd>{count(run.pipeline.unavailablePending)} need a service that is off here</dd></>}
              {run.pipeline.syncsDuringWait > 0 && <><dt>Paused by</dt><dd>{run.pipeline.syncsDuringWait} sync{run.pipeline.syncsDuringWait === 1 ? "" : "s"}</dd></>}
              {jobs.map(([kind, statuses]) => (
                <div className="bench-dl-row" key={kind}><dt>{kind}</dt><dd>{Object.entries(statuses).map(([k, v]) => `${k} ${v}`).join(" · ")}</dd></div>
              ))}
            </dl>
          </div>
        )}
        {run.outcome && (
          <div>
            <h3>Stored afterwards</h3>
            <dl>
              <dt>Courses</dt><dd>{count(run.outcome.courses)}</dd>
              <dt>Records</dt><dd>{count(run.outcome.resources)}</dd>
              <dt>Documents</dt><dd>{count(run.outcome.documents)} ({count(run.outcome.documentsWithText)} with text)</dd>
              <dt>Web pages</dt><dd>{count(run.outcome.webPages)}</dd>
              <dt>Passages</dt><dd>{count(run.outcome.passages)} · facts {count(run.outcome.facts)} · links {count(run.outcome.links)}</dd>
              <dt>Database</dt><dd>{formatBytes(run.outcome.dbBytes + run.outcome.walBytes)}</dd>
              {run.query && <><dt>Search</dt><dd>p95 {formatMs(run.query.p95Ms)}{run.query.passageP95Ms != null ? ` · passages p95 ${formatMs(run.query.passageP95Ms)}` : ""}</dd></>}
            </dl>
          </div>
        )}
      </div>
      {!!run.sync?.courses.length && (
        <>
          <h3>By course</h3>
          <table className="bench-table">
            <thead>
              <tr><th scope="col">Course</th><th scope="col">Requests</th><th scope="col">Data</th><th scope="col">Records</th><th scope="col">Documents</th><th scope="col">Website crawl</th></tr>
            </thead>
            <tbody>
              {[...run.sync.courses].sort((a, b) => b.requests - a.requests || b.records - a.records).map((c) => (
                <tr key={c.courseId}>
                  <th scope="row">{labels.get(c.courseId) ?? `Course ${c.courseId}`}</th>
                  <td>{count(c.requests)}</td>
                  <td>{formatBytes(c.bytes)}</td>
                  <td>{count(c.records)}</td>
                  <td>{count(c.documents)}</td>
                  <td>{c.crawl ? `${count(c.crawl.pages)} pages, ${formatMs(c.crawl.durationMs)}${Object.keys(c.crawl.codes).length ? ` · ${Object.entries(c.crawl.codes).map(([k, v]) => `${k.replaceAll("_", " ")} ×${v}`).join(", ")}` : ""}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <p className="bench-note">
        {run.machine.platform} {run.machine.arch} · {run.machine.cpu} · {run.machine.cores} cores · {run.machine.memoryGb} GB · app {run.machine.appVersion ?? "dev"} · store v{run.machine.schemaVersion}
      </p>
    </div>
  );
}

const PHASE_NOW: Record<string, string> = { ...PHASE, pipeline: "Waiting for the material pipeline" };

export function LocalBenchmarks({ snapshot }: { snapshot: Snapshot }) {
  const bridge = window.magic.benchmarks;
  const [runs, setRuns] = useState<BenchmarkSummary[] | null>(null);
  const [now, setNow] = useState<BenchmarkStatusNow | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [starting, setStarting] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const labels = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of snapshot.resources)
      if (r.kind === "course" && !map.has(r.courseId)) map.set(r.courseId, r.course?.courseCode || r.courseName);
    return map;
  }, [snapshot.resources]);
  const refresh = useCallback(async () => {
    if (!bridge) return;
    try {
      const [list, status] = await Promise.all([bridge.list(), bridge.status()]);
      setRuns(list);
      setNow(status);
    } catch {
      setMessage("Local benchmarks could not be read.");
    }
  }, [bridge]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Live status while a measured run is going (a benchmark, or a full read started elsewhere).
  const running = starting || Boolean(now?.running);
  useEffect(() => {
    if (!running || !bridge) return;
    const timer = setInterval(() => void bridge.status().then(setNow, () => {}), 1000);
    return () => clearInterval(timer);
  }, [running, bridge]);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) void refresh();
    wasRunning.current = running;
  }, [running, refresh]);

  if (!bridge)
    return (
      <section className="settings-section bench-section" aria-labelledby="bench-heading">
        <h2 id="bench-heading">Local benchmarks</h2>
        <p>Local benchmarks are measured by the desktop app. They aren't available in this view.</p>
      </section>
    );

  const start = async () => {
    setStarting(true);
    setMessage(null);
    setNow({ running: true, trigger: "benchmark", phase: null, elapsedMs: 0, requests: 0, saves: 0 });
    try {
      const run = await bridge.run();
      setMessage(
        !run
          ? "A sync had just finished, so no new run started. Try again in a minute."
          : run.status === "needs_sign_in"
            ? "The run needed a UW sign-in, so it measured only what it could. Sign in and run it again."
            : `Measured: full sync ${formatMs(run.sync?.wallMs)}, material pipeline ${run.pipeline?.drained ? formatMs(run.pipeline.waitedMs) : "still working"}.`,
      );
      if (run) setOpen(run.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The benchmark stopped.");
    } finally {
      setStarting(false);
      await refresh();
    }
  };
  const clear = async () => {
    await bridge.clear();
    setConfirmClear(false);
    setOpen(null);
    setMessage("Measurements deleted from this computer.");
    await refresh();
  };

  const syncRuns = (runs ?? []).filter((r) => r.trigger !== "planning");
  const latest = syncRuns[0] ?? null;
  const earlier = syncRuns.slice(1, 11);
  const base = (pick: (r: BenchmarkSummary) => number | null) => median(earlier.map(pick).filter((v): v is number => v != null));

  return (
    <section className="settings-section bench-section" aria-labelledby="bench-heading">
      <div className="bench-heading">
        <div>
          <h2 id="bench-heading">Local benchmarks</h2>
          <p>
            How long this app's full syncs take on this computer, measured from its own runs. Every full sync is kept: a sign-in, a Refresh, the scheduled full read, a My UW refresh, or a benchmark you start here. Counts and timings only; nothing leaves this device.
          </p>
        </div>
        <button className="button primary" onClick={() => void start()} disabled={running} aria-describedby="bench-run-note">
          {running ? "Measuring…" : "Run benchmark"}
        </button>
      </div>
      <p id="bench-run-note" className="setting-note">
        A benchmark is a full Canvas sync, like Refresh, then a wait until the material pipeline has caught up (up to 15 minutes). Reading Canvas can register page views, as any sync does.
      </p>
      {running && now && (
        <div className="bench-live" role="status" aria-live="polite">
          <span className="bench-live-dot" aria-hidden="true" />
          {now.phase ? PHASE_NOW[now.phase] ?? now.phase : "Starting"} · {formatMs(now.elapsedMs)} · {count(now.requests)} requests
        </div>
      )}
      {message && <p className="bench-message" role="status">{message}</p>}
      {runs === null ? (
        <p className="bench-muted">Loading measurements…</p>
      ) : !runs.length ? (
        <div className="no-activity">No full runs measured yet. Your next sign-in, Refresh or benchmark is measured automatically.</div>
      ) : (
        <>
          {latest && (
            <div className="bench-stats" aria-label="Latest full sync">
              <Stat label="Full sync" value={formatMs(latest.wallMs)}>
                <Delta value={latest.wallMs} baseline={base((r) => r.wallMs)} />
              </Stat>
              <Stat label="Pipeline caught up" value={formatMs(latest.pipelineMs)}>
                <Delta value={latest.pipelineMs} baseline={base((r) => r.pipelineMs)} />
              </Stat>
              <Stat label="Requests" value={count(latest.requests)}>
                <span className="bench-delta">{count(latest.courses)} courses · {count(latest.resources)} records</span>
              </Stat>
            </div>
          )}
          <SyncTrend runs={runs} selected={open} onSelect={(id) => {
            setOpen(id);
            listRef.current?.querySelector<HTMLElement>(`[data-run="${id}"] summary`)?.focus();
          }} />
          <ol className="bench-runs" ref={listRef}>
            {runs.map((r) => (
              <li key={r.id} data-run={r.id}>
                <details open={open === r.id} onToggle={(event) => {
                  const isOpen = (event.target as HTMLDetailsElement).open;
                  if (isOpen) setOpen(r.id);
                  else if (open === r.id) setOpen(null);
                }}>
                  <summary>
                    <span className="bench-run-when">{new Date(r.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                    <span className="bench-run-kind">{TRIGGER[r.trigger]}</span>
                    <StatusLabel status={r.status} />
                    <span className="bench-run-figure">{formatMs(r.wallMs)}</span>
                    <span className="bench-run-figure">{r.requests == null ? "—" : `${count(r.requests)} req`}</span>
                    <span className="bench-run-figure">{r.pipelineMs == null ? "—" : `pipeline ${formatMs(r.pipelineMs)}`}</span>
                  </summary>
                  {open === r.id && <RunDetail id={r.id} labels={labels} />}
                </details>
              </li>
            ))}
          </ol>
          <div className="bench-clear">
            {!confirmClear ? (
              <button className="subtle-button" onClick={() => setConfirmClear(true)}>Delete measurements…</button>
            ) : (
              <span>
                Delete all {runs.length} measurements from this computer?{" "}
                <button className="button danger-button" onClick={() => void clear()}>Delete</button>{" "}
                <button className="button" onClick={() => setConfirmClear(false)}>Keep</button>
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

import { useState } from "react";
import {
  defaultIngestionSettings,
  type Command,
  type CommandResult,
  type Snapshot,
  type McpGrant,
} from "@magic/contracts";
type Run = (
  command: Command,
  message?: string,
) => Promise<CommandResult | undefined>;
export function IngestionControls({
  snapshot,
  busy,
  run,
}: {
  snapshot: Snapshot;
  busy: boolean;
  run: Run;
}) {
  const [sourceError, setSourceError] = useState("");
  const settings = snapshot.ingestionSettings ?? defaultIngestionSettings;
  const sources = new Map(snapshot.sources.map((s) => [s.id, s]));
  const courses = snapshot.resources.filter(
    (r) =>
      r.kind === "course" &&
      r.course &&
      !r.deleted &&
      sources.get(r.sourceId)?.scope === "course",
  );
  const terms = [
    ...new Set(
      courses.map((r) => r.course?.termName).filter((t): t is string => !!t),
    ),
  ].sort();
  const update = (patch: Partial<typeof settings>) =>
    void run(
      { type: "ingestion-settings", value: { ...settings, ...patch } },
      "Refresh settings saved.",
    );
  return (
    <section className="settings-section ingestion-controls">
      <h2>Courses & refresh</h2>
      {snapshot.sources.some(
        (s) => s.kind === "gitlab" && s.status === "needs_sign_in",
      ) && (
        <p>
          <button
            className="button"
            disabled={busy || !window.magic.signInUW}
            onClick={() => {
              setSourceError("");
              void window.magic
                .signInUW?.("gitlab")
                .then(() => window.magic.syncCanvas?.())
                .catch(() =>
                  setSourceError(
                    "GitLab could not reconnect. Your saved coursework is still available.",
                  ),
                );
            }}
          >
            Connect course GitLab
          </button>{" "}
          <span className="small muted">
            Opens the app’s GitLab browser. UW may request sign-in again.
          </span>
        </p>
      )}
      {sourceError && <p role="alert">{sourceError}</p>}
      <label className="field-label">
        Term{" "}
        <select
          disabled={busy}
          value={settings.selectedTerm ?? ""}
          onChange={(e) => update({ selectedTerm: e.target.value || null })}
        >
          <option value="">Current academic courses</option>
          {terms.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      <p className="small muted">
        Excluded sites stay visible here. They are left out of Today and AI
        context. Refresh after changing a term or including a course.
      </p>
      {courses.length > 0 && (
        <details>
          <summary>{courses.length} course sites · review inclusion</summary>
          <div className="course-choices">
            {courses.map((course) => {
              const source = sources.get(course.sourceId)!;
              const override = snapshot.courseOverrides?.find(
                (o) =>
                  o.accountScope === source.accountScope &&
                  o.courseId === course.courseId,
              );
              const included =
                override?.included ??
                course.course?.selection?.included ??
                false;
              return (
                <label key={course.id} className="setting-toggle">
                  <input
                    type="checkbox"
                    checked={included}
                    disabled={busy}
                    onChange={(e) =>
                      void run(
                        {
                          type: "course-override",
                          value: {
                            accountScope: source.accountScope,
                            courseId: course.courseId,
                            included: e.target.checked,
                          },
                        },
                        "Course preference saved. Refresh to fetch newly included material.",
                      )
                    }
                  />
                  <span>
                    <strong>{course.title}</strong>
                    <span className="small muted">
                      {course.course?.termName ?? "No term"} ·{" "}
                      {override?.included != null
                        ? "Your choice"
                        : course.course?.selection?.reasons.join(" · ")}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </details>
      )}
      <label className="setting-toggle">
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={busy}
          onChange={(e) => update({ enabled: e.target.checked })}
        />
        <span>Refresh while this app is open</span>
      </label>
      <details>
        <summary>Refresh details</summary>
        <div className="inline-actions">
          <label>
            Minutes between checks{" "}
            <input
              aria-label="Minutes between checks"
              type="number"
              min="1"
              max="1440"
              defaultValue={settings.intervalMinutes}
              disabled={busy}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (n >= 1 && n <= 1440) update({ intervalMinutes: n });
              }}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.quietHours.enabled}
              disabled={busy}
              onChange={(e) =>
                update({
                  quietHours: {
                    ...settings.quietHours,
                    enabled: e.target.checked,
                  },
                })
              }
            />{" "}
            Quiet hours
          </label>
          <label>
            From{" "}
            <input
              aria-label="Quiet hours start"
              type="number"
              min="0"
              max="23"
              defaultValue={settings.quietHours.start}
              disabled={busy}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 0 && n < 24)
                  update({ quietHours: { ...settings.quietHours, start: n } });
              }}
            />
          </label>
          <label>
            Until{" "}
            <input
              aria-label="Quiet hours end"
              type="number"
              min="0"
              max="23"
              defaultValue={settings.quietHours.end}
              disabled={busy}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 0 && n < 24)
                  update({ quietHours: { ...settings.quietHours, end: n } });
              }}
            />
          </label>
          <label>
            Parallel metadata reads{" "}
            <input
              aria-label="Parallel metadata reads"
              type="number"
              min="1"
              max="16"
              defaultValue={settings.metadataConcurrency}
              disabled={busy}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 1 && n <= 16)
                  update({ metadataConcurrency: n });
              }}
            />
          </label>
          <label>
            Parallel downloads{" "}
            <input
              aria-label="Parallel downloads"
              type="number"
              min="1"
              max="8"
              defaultValue={settings.downloadConcurrency}
              disabled={busy}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 1 && n <= 8)
                  update({ downloadConcurrency: n });
              }}
            />
          </label>
        </div>
        <p className="small muted">
          Checks vary slightly to avoid request bursts. Sleeping laptops are
          never woken. An expired Canvas session pauses its reads; calendar
          feeds keep their own status.
        </p>
      </details>
      <label className="setting-toggle">
        <input
          type="checkbox"
          checked={settings.collectComments}
          disabled={busy}
          onChange={(e) => update({ collectComments: e.target.checked })}
        />
        <span>
          <strong>Keep grader feedback locally</strong>
          <span className="small muted">
            Collected by default. Cloud sharing is a separate setting in Data &
            AI. Disabling collection stops future reads; existing comments
            remain until local data is deleted.
          </span>
        </span>
      </label>
      {!!snapshot.syncRuns?.length && (
        <details>
          <summary>Recent refreshes</summary>
          {snapshot.syncRuns.slice(0, 5).map((run) => (
            <p className="small" key={run.id}>
              {new Date(run.finishedAt).toLocaleString()} · {run.status} ·{" "}
              {run.sourceCount ?? 0} scopes ·{" "}
              {Math.round((run.stats?.durationMs ?? 0) / 1000)}s
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
export function McpConnections({
  snapshot,
  busy,
  run,
}: {
  snapshot: Snapshot;
  busy: boolean;
  run: Run;
}) {
  const [recipient, setRecipient] = useState<McpGrant["recipient"]>("local"),
    [selected, setSelected] = useState<string[]>([]),
    [config, setConfig] = useState(""),
    [error, setError] = useState("");
  const sources = new Map(snapshot.sources.map((s) => [s.id, s]));
  const courses = [
    ...new Map(
      snapshot.resources
        .filter((r) => !r.deleted)
        .map((r) => {
          const s = sources.get(r.sourceId)!;
          return [
            `${s.accountScope}:${r.courseId}`,
            {
              key: `${s.accountScope}:${r.courseId}`,
              accountScope: s.accountScope,
              courseId: r.courseId,
              name: r.courseName,
            },
          ] as const;
        }),
    ).values(),
  ];
  async function add() {
    setError("");
    const grant: McpGrant = {
      id: crypto.randomUUID(),
      label: `${recipient} course access`,
      recipient,
      enabled: true,
      categories: ["course_text"],
      courses: courses
        .filter((c) => selected.includes(c.key))
        .map(({ accountScope, courseId }) => ({ accountScope, courseId })),
    };
    await run(
      { type: "mcp-grant", value: grant },
      "Connection saved. Export its local configuration to connect a compatible MCP client.",
    );
  }
  async function exportConfig(id: string) {
    setError("");
    try {
      if (!window.magic.exportMcp)
        throw new Error(
          "Configuration export is available in the desktop app.",
        );
      setConfig(await window.magic.exportMcp(id));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Connection could not be exported.",
      );
    }
  }
  return (
    <section className="settings-section ingestion-controls">
      <h2>Connect an AI with MCP</h2>
      <p>
        Read-only access to the courses and categories you allow. Hosted
        connections also obey your cloud settings above. Requires a client that
        supports a local stdio MCP server; account and app support varies.
      </p>
      <details>
        <summary>New connection</summary>
        <label className="field-label">
          Destination{" "}
          <select
            value={recipient}
            disabled={busy}
            onChange={(e) =>
              setRecipient(e.target.value as McpGrant["recipient"])
            }
          >
            <option value="local">Local model</option>
            <option value="chatgpt">ChatGPT</option>
            <option value="claude">Claude</option>
          </select>
        </label>
        <p className="small muted">
          Choose the actual destination, including hosted AI reached through a
          local client. Course text starts as the only permitted category.
        </p>
        {courses.map((c) => (
          <label className="setting-toggle" key={c.key}>
            <input
              type="checkbox"
              checked={selected.includes(c.key)}
              onChange={(e) =>
                setSelected((prev) =>
                  e.target.checked
                    ? [...prev, c.key]
                    : prev.filter((k) => k !== c.key),
                )
              }
            />
            <span>{c.name}</span>
          </label>
        ))}
        <button
          className="button"
          disabled={busy || !selected.length}
          onClick={() => void add()}
        >
          Create connection
        </button>
      </details>
      {snapshot.mcpGrants?.map((grant) => (
        <details key={grant.id}>
          <summary>
            {grant.label} · {grant.enabled ? "Enabled" : "Revoked"}
          </summary>
          <p className="small">
            {grant.courses.length} courses. Access is rechecked on every read.
          </p>
          {(
            [
              "course_text",
              "student_work",
              "grades",
              "comments",
              "communications",
            ] as const
          ).map((category) => (
            <label className="setting-toggle" key={category}>
              <input
                type="checkbox"
                disabled={busy}
                checked={grant.categories.includes(category)}
                onChange={(e) =>
                  void run({
                    type: "mcp-grant",
                    value: {
                      ...grant,
                      categories: e.target.checked
                        ? [...grant.categories, category]
                        : grant.categories.filter((c) => c !== category),
                    },
                  })
                }
              />
              <span>{category.replaceAll("_", " ")}</span>
            </label>
          ))}
          <div className="inline-actions">
            <button
              className="button"
              disabled={busy || !grant.enabled}
              onClick={() => void exportConfig(grant.id)}
            >
              Export local configuration
            </button>
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                void run({
                  type: "mcp-grant",
                  value: { ...grant, enabled: !grant.enabled },
                })
              }
            >
              {grant.enabled ? "Revoke" : "Enable"}
            </button>
          </div>
        </details>
      ))}
      {error && <p role="alert">{error}</p>}
      {config && (
        <>
          <label className="field-label" htmlFor="mcp-config">
            Local MCP configuration
          </label>
          <textarea id="mcp-config" readOnly rows={8} value={config} />
          <p className="small muted">
            Keep this configuration on your device: it points to a private
            access file. Exporting again replaces the credential for this
            connection.
          </p>
        </>
      )}
    </section>
  );
}

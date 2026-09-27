import { z } from "zod";
import {
  captureBatchSchema,
  resourceInputSchema,
  type CaptureBatch,
  type Connector,
  type ResourceInput,
} from "@magic/contracts";
import {
  contentHash,
  extractLinkedText,
  sanitizeMaterialContent,
} from "./external.ts";
import { MaterialReadError, publicUrl, readBounded } from "./network.ts";

export const UW_GITLAB_ORIGIN = "https://git.doit.wisc.edu";
export interface GitlabAccess {
  /** An explicitly approved, GitLab-owned session. Never pass the Canvas session here. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Explicit user-provided GitLab token from encrypted storage, transient in memory. */
  token?: string;
  accountScope: string;
  now?: () => Date;
  maxPages?: number;
}
export interface GitlabCourse {
  courseId: string;
  courseName: string;
  projectId: string;
}
export interface GitlabConnectorOptions extends GitlabAccess {
  courses: GitlabCourse[];
}
const identifier = z
  .union([z.number().int().positive().safe(), z.string().regex(/^\d+$/)])
  .transform(String);
const projectSchema = z.object({
  id: identifier,
  name: z.string().min(1).max(500),
  web_url: z.string().url(),
  default_branch: z.string().max(300).nullable().optional(),
  description: z.string().max(200000).nullable().optional(),
  last_activity_at: z.iso.datetime({ offset: true }).optional(),
});
export interface GitlabProject {
  id: string;
  name: string;
  url: string;
  defaultBranch?: string;
}
class GitlabFailure extends Error {
  constructor(
    readonly status: CaptureBatch["status"],
    readonly code: string,
  ) {
    super(code);
  }
}
function apiUrl(input: string, path?: string): URL {
  const url = publicUrl(new URL(input, UW_GITLAB_ORIGIN).href);
  if (
    url.origin !== UW_GITLAB_ORIGIN ||
    !/^\/api\/v4\/projects(?:\/|$)/.test(url.pathname) ||
    (path && url.pathname !== path)
  )
    throw new GitlabFailure("partial", "unsafe_gitlab_url");
  return url;
}
function evidenceUrl(input: string): string {
  const url = publicUrl(input);
  if (url.origin !== UW_GITLAB_ORIGIN)
    throw new GitlabFailure("partial", "gitlab_origin_mismatch");
  return url.href;
}
function access(options: GitlabAccess) {
  if (options.token && /[\r\n]/.test(options.token))
    throw new GitlabFailure("error", "invalid_gitlab_credential");
  const transport = options.fetch ?? globalThis.fetch;
  async function request(
    input: string,
    signal?: AbortSignal,
  ): Promise<{ data: unknown; response: Response; url: URL }> {
    const url = apiUrl(input);
    const combined = AbortSignal.any([
      AbortSignal.timeout(20000),
      ...(signal ? [signal] : []),
    ]);
    let response: Response;
    try {
      response = await transport(url.href, {
        method: "GET",
        redirect: "manual",
        credentials: options.token
          ? "omit"
          : options.fetch
            ? "include"
            : "omit",
        headers: {
          Accept: "application/json",
          ...(options.token ? { "PRIVATE-TOKEN": options.token } : {}),
        },
        signal: combined,
      });
    } catch {
      throw new GitlabFailure("error", "gitlab_network_failed");
    }
    if (
      response.status === 401 ||
      (response.status >= 300 && response.status < 400) ||
      response.redirected ||
      (response.url && new URL(response.url).href !== url.href)
    ) {
      await response.body?.cancel();
      throw new GitlabFailure("needs_sign_in", "gitlab_sign_in_required");
    }
    if (response.status === 403 || response.status === 404) {
      await response.body?.cancel();
      throw new GitlabFailure("inaccessible", "gitlab_inaccessible");
    }
    if (response.status === 429) {
      await response.body?.cancel();
      throw new GitlabFailure("partial", "gitlab_rate_limited");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new GitlabFailure("error", "gitlab_http_error");
    }
    const type = response.headers.get("content-type") ?? "";
    if (/html/i.test(type)) {
      await response.body?.cancel();
      throw new GitlabFailure("needs_sign_in", "gitlab_login_page");
    }
    if (!/application\/(?:[\w.-]+\+)?json/i.test(type)) {
      await response.body?.cancel();
      throw new GitlabFailure("partial", "gitlab_invalid_type");
    }
    const body = await readBounded(response, 8 * 1024 * 1024, combined);
    if (/^\s*</.test(body))
      throw new GitlabFailure("needs_sign_in", "gitlab_login_page");
    try {
      return { data: JSON.parse(body), response, url };
    } catch {
      throw new GitlabFailure("partial", "gitlab_invalid_json");
    }
  }
  async function list(
    input: string,
    signal?: AbortSignal,
  ): Promise<{
    items: unknown[];
    complete: boolean;
    status: CaptureBatch["status"];
    diagnostics: NonNullable<CaptureBatch["diagnostics"]>;
  }> {
    const items: unknown[] = [];
    const seen = new Set<string>();
    let next: string | null = input;
    try {
      for (
        let page = 0;
        next && page < Math.min(options.maxPages ?? 20, 20);
        page++
      ) {
        if (seen.has(next))
          throw new GitlabFailure("partial", "gitlab_page_loop");
        seen.add(next);
        const { data, response, url } = await request(next, signal);
        if (!Array.isArray(data))
          throw new GitlabFailure("partial", "gitlab_list_invalid");
        if (items.length + data.length > 2000)
          throw new GitlabFailure("partial", "gitlab_record_limit");
        items.push(...data);
        const header = response.headers.get("x-next-page");
        const link = response.headers.get("link");
        const nextLinks = link
          ? [...link.matchAll(/<([^>]+)>\s*;\s*rel="?next"?/g)]
          : [];
        if (nextLinks.length > 1)
          throw new GitlabFailure("partial", "gitlab_pagination_invalid");
        next = null;
        if (nextLinks[0]) {
          const target = apiUrl(nextLinks[0][1]!, url.pathname);
          const oldParams = new URLSearchParams(url.search);
          const newParams = new URLSearchParams(target.search);
          for (const params of [oldParams, newParams]) {
            params.delete("page");
            params.delete("id_after");
            params.delete("pagination");
            params.sort();
          }
          if (oldParams.toString() !== newParams.toString())
            throw new GitlabFailure("partial", "gitlab_pagination_scope");
          next = target.href;
        } else if (header) {
          if (
            !/^\d+$/.test(header) ||
            Number(header) <= Number(url.searchParams.get("page") ?? 1)
          )
            throw new GitlabFailure("partial", "gitlab_pagination_invalid");
          url.searchParams.set("page", header);
          next = url.href;
        } else if (header === null && !link && data.length === 100)
          throw new GitlabFailure("partial", "gitlab_pagination_missing");
      }
      if (next) throw new GitlabFailure("partial", "gitlab_page_limit");
      return { items, complete: true, status: "ok", diagnostics: [] };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        items,
        complete: false,
        status:
          error instanceof GitlabFailure
            ? error.status
            : items.length
              ? "partial"
              : "error",
        diagnostics: [
          {
            code:
              error instanceof GitlabFailure
                ? error.code
                : "gitlab_read_failed",
            path: [],
            severity: "warning",
          },
        ],
      };
    }
  }
  return { request, list };
}
export function gitlabProjectFromUrl(input: string): string | undefined {
  try {
    const url = publicUrl(input);
    if (url.origin !== UW_GITLAB_ORIGIN) return undefined;
    const path = url.pathname.split("/-/")[0]!.replace(/^\/+|\/+$/g, "");
    if (
      path.split("/").length < 2 ||
      path.startsWith("users/") ||
      path.startsWith("api/")
    )
      return undefined;
    return path;
  } catch {
    return undefined;
  }
}
export async function listGitlabProjects(
  options: GitlabAccess,
  signal?: AbortSignal,
): Promise<{
  projects: GitlabProject[];
  complete: boolean;
  status: CaptureBatch["status"];
  diagnostics: NonNullable<CaptureBatch["diagnostics"]>;
}> {
  const result = await access(options).list(
    `${UW_GITLAB_ORIGIN}/api/v4/projects?membership=true&simple=true&per_page=100`,
    signal,
  );
  const projects: GitlabProject[] = [];
  for (const item of result.items) {
    try {
      const value = projectSchema.parse(item);
      projects.push({
        id: value.id,
        name: value.name,
        url: evidenceUrl(value.web_url),
        ...(value.default_branch
          ? { defaultBranch: value.default_branch }
          : {}),
      });
    } catch {
      result.complete = false;
      result.status = "partial";
      result.diagnostics.push({
        code: "gitlab_project_invalid",
        path: [],
        severity: "warning",
      });
    }
  }
  return {
    projects,
    complete: result.complete,
    status: result.status,
    diagnostics: result.diagnostics,
  };
}
export function gitlabConnector(options: GitlabConnectorOptions): Connector {
  const client = access(options);
  const id = `gitlab:${contentHash(options.accountScope).slice(0, 24)}`;
  return {
    id,
    async *pull(signal) {
      for (const course of options.courses) {
        const base = `${UW_GITLAB_ORIGIN}/api/v4/projects/${encodeURIComponent(course.projectId)}`;
        let project: z.infer<typeof projectSchema> | undefined;
        const batch = (
          scope: string,
          resources: ResourceInput[],
          complete: boolean,
          status: CaptureBatch["status"],
          diagnostics: CaptureBatch["diagnostics"] = [],
        ) =>
          captureBatchSchema.parse({
            source: {
              id: `${id}:${contentHash(`${course.courseId}:${course.projectId}:${scope}`).slice(0, 24)}`,
              label: `${course.courseName} GitLab ${scope}`,
              kind: "gitlab",
              accountScope: options.accountScope,
              courseId: course.courseId,
              scope: `gitlab:${scope}`,
            },
            observedAt: (options.now ?? (() => new Date()))().toISOString(),
            resources,
            complete,
            status,
            diagnostics,
          });
        const resource = (
          externalId: string,
          title: string,
          url: string,
          text: string,
          gitlab: NonNullable<ResourceInput["gitlab"]>,
          extra: Partial<ResourceInput> = {},
        ) =>
          resourceInputSchema.parse({
            externalId,
            kind: "material",
            courseId: course.courseId,
            courseName: course.courseName,
            title: sanitizeMaterialContent(title, url),
            url: evidenceUrl(url),
            text: sanitizeMaterialContent(text, url),
            submitted: null,
            gitlab,
            ...extra,
            ...(extra.rawHtml !== undefined
              ? { rawHtml: sanitizeMaterialContent(extra.rawHtml, url) }
              : {}),
          });
        try {
          project = projectSchema.parse(
            (await client.request(base, signal)).data,
          );
          yield batch(
            "project",
            [
              resource(
                project.id,
                project.name,
                project.web_url,
                project.description ?? "",
                {
                  projectId: project.id,
                  defaultBranch: project.default_branch ?? undefined,
                  evidenceKind: "project",
                },
                { updatedAt: project.last_activity_at },
              ),
            ],
            true,
            "ok",
          );
        } catch (error) {
          if (signal?.aborted) throw error;
          yield batch(
            "project",
            [],
            false,
            error instanceof GitlabFailure ? error.status : "partial",
            [
              {
                code:
                  error instanceof GitlabFailure
                    ? error.code
                    : "gitlab_project_invalid",
                path: [],
              },
            ],
          );
          continue;
        }
        const projectId = project.id;
        const branch = project.default_branch;
        const projectWeb = evidenceUrl(project.web_url);
        const scopes = [
          { scope: "issues", path: "issues", kind: "issue" as const },
          {
            scope: "merge_requests",
            path: "merge_requests",
            kind: "merge_request" as const,
          },
          { scope: "pipelines", path: "pipelines", kind: "pipeline" as const },
          { scope: "wikis", path: "wikis", kind: "wiki" as const },
          ...(branch
            ? [
                {
                  scope: "tree",
                  path: `repository/tree?recursive=true&ref=${encodeURIComponent(branch)}`,
                  kind: "tree" as const,
                },
                {
                  scope: "latest_commit",
                  path: `repository/commits?ref_name=${encodeURIComponent(branch)}&per_page=1`,
                  kind: "commit" as const,
                },
              ]
            : []),
        ];
        const documents: { path: string; sha: string }[] = [];
        let treeComplete = false;
        for (const endpoint of scopes) {
          const url = `${base}/${endpoint.path}${endpoint.path.includes("?") ? "&" : "?"}${endpoint.kind === "commit" ? "" : "per_page=100&"}page=1`;
          // Latest commit is deliberately a one-record scope, not an incomplete commit history.
          const result =
            endpoint.kind === "commit"
              ? await (async () => {
                  try {
                    const read = await client.request(url, signal);
                    if (!Array.isArray(read.data))
                      throw new GitlabFailure("partial", "gitlab_list_invalid");
                    return {
                      items: read.data.slice(0, 1),
                      complete: true,
                      status: "ok" as CaptureBatch["status"],
                      diagnostics: [] as NonNullable<
                        CaptureBatch["diagnostics"]
                      >,
                    };
                  } catch (error) {
                    return {
                      items: [],
                      complete: false,
                      status:
                        error instanceof GitlabFailure
                          ? error.status
                          : ("error" as CaptureBatch["status"]),
                      diagnostics: [{ code: "gitlab_commit_failed", path: [] }],
                    };
                  }
                })()
              : await client.list(url, signal);
          const resources: ResourceInput[] = [];
          for (const raw of result.items) {
            try {
              const item = z.record(z.string(), z.unknown()).parse(raw);
              const itemId =
                typeof item.id === "string" || typeof item.id === "number"
                  ? String(item.id)
                  : typeof item.slug === "string"
                    ? item.slug
                    : "";
              if (!itemId) throw new Error();
              const title =
                typeof item.title === "string"
                  ? item.title
                  : typeof item.name === "string"
                    ? item.name
                    : endpoint.kind === "pipeline"
                      ? `Pipeline ${itemId}`
                      : typeof item.message === "string"
                        ? item.message.split("\n")[0]!
                        : itemId;
              let text =
                typeof item.description === "string"
                  ? item.description
                  : typeof item.message === "string"
                    ? item.message
                    : "";
              let url =
                typeof item.web_url === "string" ? item.web_url : projectWeb;
              const path =
                typeof item.path === "string" ? item.path : undefined;
              if (endpoint.kind === "tree") {
                if (!path || typeof item.type !== "string") throw new Error();
                text = `${item.type}: ${path}`;
                url = `${projectWeb}/-/${item.type === "tree" ? "tree" : "blob"}/${encodeURIComponent(branch!)}/${path.split("/").map(encodeURIComponent).join("/")}`;
                if (
                  item.type === "blob" &&
                  /(?:^|\/)(?:readme|spec(?:ification)?|instructions|requirements|assignment|project|lab|hw)[^/]*\.(?:md|txt|rst|html?|ipynb|json)$/i.test(
                    path,
                  )
                )
                  documents.push({ path, sha: itemId });
              }
              if (endpoint.kind === "wiki") {
                const slug = String(item.slug);
                const detail = (
                  await client.request(
                    `${base}/wikis/${encodeURIComponent(slug)}`,
                    signal,
                  )
                ).data as Record<string, unknown>;
                if (typeof detail.content !== "string") throw new Error();
                text = detail.content;
                url = `${projectWeb}/-/wikis/${encodeURIComponent(slug)}`;
              }
              resources.push(
                resource(
                  endpoint.kind === "commit"
                    ? "latest"
                    : endpoint.kind === "tree"
                      ? contentHash(path!)
                      : itemId,
                  title,
                  url,
                  text,
                  {
                    projectId,
                    defaultBranch: branch ?? undefined,
                    evidenceKind: endpoint.kind,
                    blobSha: endpoint.kind === "tree" ? itemId : undefined,
                    commitSha:
                      endpoint.kind === "commit"
                        ? itemId
                        : typeof item.sha === "string"
                          ? item.sha
                          : undefined,
                    state:
                      typeof item.state === "string"
                        ? item.state
                        : typeof item.status === "string"
                          ? item.status
                          : undefined,
                    path,
                    submissionEvidence:
                      endpoint.kind === "commit" ||
                      endpoint.kind === "merge_request",
                  },
                  {
                    kind:
                      endpoint.kind === "issue" ||
                      endpoint.kind === "merge_request"
                        ? "message"
                        : "material",
                    updatedAt:
                      typeof item.updated_at === "string"
                        ? item.updated_at
                        : typeof item.committed_date === "string"
                          ? item.committed_date
                          : undefined,
                  },
                ),
              );
            } catch {
              result.complete = false;
              result.status = "partial";
              result.diagnostics.push({
                code: "gitlab_record_invalid",
                path: [],
                severity: "warning",
              });
            }
          }
          if (endpoint.kind === "tree") treeComplete = result.complete;
          yield batch(
            endpoint.scope,
            resources,
            result.complete,
            result.status,
            result.diagnostics,
          );
        }
        const files: ResourceInput[] = [];
        const diagnostics: NonNullable<CaptureBatch["diagnostics"]> = [];
        for (const file of documents.slice(0, 100)) {
          try {
            const raw = (
              await client.request(
                `${base}/repository/files/${encodeURIComponent(file.path)}?ref=${encodeURIComponent(branch!)}`,
                signal,
              )
            ).data;
            const value = z
              .object({
                file_path: z.string(),
                encoding: z.literal("base64"),
                content: z.string().max(2_000_000),
                size: z.number().max(1_000_000),
                content_sha256: z.string().optional(),
                last_commit_id: z.string().optional(),
              })
              .parse(raw);
            if (value.file_path !== file.path) throw new Error();
            const text = Buffer.from(value.content, "base64").toString("utf8");
            if (Buffer.byteLength(text) !== value.size) throw new Error();
            const url = `${projectWeb}/-/blob/${encodeURIComponent(branch!)}/${file.path.split("/").map(encodeURIComponent).join("/")}`;
            const parsed = extractLinkedText(
              text,
              url,
              /\.html?$/i.test(file.path),
            );
            files.push(
              resource(
                contentHash(file.path),
                file.path,
                url,
                parsed.text,
                {
                  projectId,
                  defaultBranch: branch!,
                  evidenceKind: "file",
                  path: file.path,
                  blobSha: file.sha,
                  commitSha: value.last_commit_id,
                },
                {
                  links: parsed.links,
                  ...(/\.html?$/i.test(file.path) ? { rawHtml: text } : {}),
                },
              ),
            );
          } catch {
            diagnostics.push({
              code: "gitlab_file_failed",
              path: [],
              severity: "warning",
            });
          }
        }
        if (documents.length > 100)
          diagnostics.push({ code: "gitlab_file_limit", path: [] });
        if (!treeComplete)
          diagnostics.push({ code: "gitlab_tree_incomplete", path: [] });
        yield batch(
          "instruction_files",
          files,
          !diagnostics.length,
          diagnostics.length ? "partial" : "ok",
          diagnostics,
        );
      }
    },
  };
}

/**
 * The GitLab projects a refresh reads for one course: those Canvas material links to, plus any
 * the student linked by hand for that exact account and course. Each project once, sorted.
 */
export function gitlabProjectsForCourse(
  links: string[],
  manual: { accountScope: string; courseId: string; projectPath: string }[],
  course: { accountScope: string; courseId: string },
): string[] {
  const found = links.map(gitlabProjectFromUrl).filter((v): v is string => !!v);
  const linked = manual
    .filter((m) => m.accountScope === course.accountScope && m.courseId === course.courseId)
    .map((m) => m.projectPath);
  return [...new Set([...found, ...linked])].sort();
}

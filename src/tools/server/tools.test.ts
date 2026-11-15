import { afterEach, describe, expect, it, vi } from "vitest";
import { toolManifests } from "../registry.js";
import type { ToolManifest } from "../registry.js";
import { envelope, makeServerCtx } from "../../../test/test-helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function find(name: string): ToolManifest {
  const manifest = toolManifests.find((m) => m.name === name);
  if (!manifest) throw new Error(`manifest not found: ${name}`);
  return manifest;
}

const PR = {
  id: 101,
  title: "Add pagination helper",
  state: "OPEN",
  createdDate: 1_700_000_000_000,
  updatedDate: 1_700_100_000_000,
  author: { user: { name: "dev1", displayName: "Dev One" } },
  fromRef: { displayId: "feature/x", latestCommit: "abc123", repository: { slug: "api", project: { key: "PLAT" } } },
  toRef: { displayId: "main", repository: { slug: "api", project: { key: "PLAT" } } },
};

describe("bb_get_projects", () => {
  it("lists projects as compact cards", async () => {
    const { ctx, captured, restore } = makeServerCtx(() => ({
      body: envelope([
        { key: "PLAT", id: 1, name: "Platform", description: "Core platform", public: false },
      ]),
    }));
    try {
      const result = (await find("bb_get_projects").handler({ limit: 25, start: 0 }, ctx)) as {
        items: unknown[];
        page: { isLastPage: boolean };
      };
      expect(result.items[0]).toEqual({
        key: "PLAT",
        id: 1,
        name: "Platform",
        description: "Core platform",
        public: false,
      });
      expect(result.page.isLastPage).toBe(true);
      expect(captured[0].url.pathname).toBe("/rest/api/1.0/projects");
      expect(JSON.stringify(result)).not.toContain("links");
    } finally {
      restore();
    }
  });

  it("propagates 404s as RestError", async () => {
    const { ctx, restore } = makeServerCtx(() => ({ status: 404, body: { errors: [{ message: "not found" }] } }));
    try {
      await expect(find("bb_get_projects").handler({ limit: 25, start: 0 }, ctx)).rejects.toMatchObject({
        status: 404,
        code: "NOT_FOUND",
      });
    } finally {
      restore();
    }
  });
});

describe("bb_get_repositories", () => {
  it("includes the HTTP clone URL in repo cards", async () => {
    const { ctx, restore } = makeServerCtx(() => ({
      body: envelope([
        {
          slug: "api",
          id: 5,
          name: "API",
          description: "Service API",
          project: { key: "PLAT" },
          public: false,
          links: { clone: [{ name: "http", href: "https://bitbucket.example.com/scm/plat/api.git" }] },
        },
      ]),
    }));
    try {
      const result = (await find("bb_get_repositories").handler({ projectKey: "PLAT", limit: 25, start: 0 }, ctx)) as {
        items: Record<string, unknown>[];
      };
      expect(result.items[0]).toMatchObject({ slug: "api", project: "PLAT", httpCloneUrl: "https://bitbucket.example.com/scm/plat/api.git" });
    } finally {
      restore();
    }
  });

  it("fails with VALIDATION for a missing project", async () => {
    const { ctx, restore } = makeServerCtx(() => ({ status: 404, body: {} }));
    try {
      await expect(find("bb_get_repositories").handler({ projectKey: "NOPE", limit: 25, start: 0 }, ctx)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    } finally {
      restore();
    }
  });
});

describe("bb_get_file_content", () => {
  it("returns truncated raw content with statistics", async () => {
    const { ctx, captured, restore } = makeServerCtx(() => ({ body: "line1\nline2" }));
    try {
      const result = (await find("bb_get_file_content").handler(
        { projectKey: "PLAT", repositorySlug: "api", path: "README.md", maxChars: 200 },
        ctx,
      )) as { content: string; truncated: boolean };
      expect(result.content).toBe("line1\nline2");
      expect(result.truncated).toBe(false);
      expect(captured[0].url.pathname).toBe("/rest/api/1.0/projects/PLAT/repos/api/raw/README.md");
    } finally {
      restore();
    }
  });

  it("truncates oversized files", async () => {
    const { ctx, restore } = makeServerCtx(() => ({ body: "x".repeat(1000) }));
    try {
      const result = (await find("bb_get_file_content").handler(
        { projectKey: "PLAT", repositorySlug: "api", path: "big.txt", maxChars: 200 },
        ctx,
      )) as { truncated: boolean; totalChars: number };
      expect(result.truncated).toBe(true);
      expect(result.totalChars).toBe(1000);
    } finally {
      restore();
    }
  });
});

describe("bb_browse_repository", () => {
  it("lists directory entries with names and types", async () => {
    const { ctx, captured, restore } = makeServerCtx(() => ({
      body: {
        path: { components: [], toString: "" },
        children: envelope([
          { path: { components: ["src"], toString: "src" }, type: "DIRECTORY" },
          { path: { components: ["README.md"], toString: "README.md" }, type: "FILE" },
        ]),
      },
    }));    try {
      const result = (await find("bb_browse_repository").handler({ projectKey: "PLAT", repositorySlug: "api", limit: 25, start: 0 }, ctx)) as {
        type: string;
        items: Record<string, unknown>[];
      };
      expect(result.type).toBe("directory");
      expect(result.items[0]).toEqual({ name: "src", path: "src", type: "DIRECTORY" });
      expect(captured[0].url.pathname).toBe("/rest/api/1.0/projects/PLAT/repos/api/browse");
    } finally {
      restore();
    }
  });

  it("surfaces not-found for an invalid path", async () => {
    const { ctx, restore } = makeServerCtx(() => ({ status: 404, body: {} }));
    try {
      await expect(
        find("bb_browse_repository").handler({ projectKey: "PLAT", repositorySlug: "api", path: "nope/nope", limit: 25, start: 0 }, ctx),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      restore();
    }
  });
});

describe("PR tools", () => {
  it("bb_list_pull_requests filters by author client-side and keeps page meta", async () => {
    const { ctx, captured, restore } = makeServerCtx(() => ({
      body: envelope([PR, { ...PR, id: 102, author: { user: { name: "other", displayName: "Other" } } }], {
        size: 2,
        isLastPage: false,
        nextPageStart: 25,
      }),
    }));
    try {
      const result = (await find("bb_list_pull_requests").handler(
        { projectKey: "PLAT", repositorySlug: "api", state: "OPEN", direction: "INCOMING", author: "dev1", limit: 25, start: 0 },
        ctx,
      )) as { items: Record<string, unknown>[]; page: { size: number; nextPageStart: number | null } };
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ id: 101, author: "Dev One", fromBranch: "feature/x" });
      expect(result.page.size).toBe(2); // unfiltered envelope size
      expect(result.page.nextPageStart).toBe(25);
      expect(String(result.page.warning)).toContain("client-side");
      expect(captured[0].url.searchParams.get("state")).toBe("OPEN");
      expect(captured[0].url.searchParams.get("direction")).toBe("INCOMING");
    } finally {
      restore();
    }
  });

  it("bb_get_pull_request returns reviewers and truncated description", async () => {
    const { ctx, captured, restore } = makeServerCtx(() => ({
      body: {
        ...PR,
        description: "y".repeat(2000),
        reviewers: [{ user: { name: "rev1", displayName: "Reviewer One" }, status: "APPROVED", approved: true }],
      },
    }));
    try {
      const result = (await find("bb_get_pull_request").handler(
        { projectKey: "PLAT", repositorySlug: "api", pullRequestId: 101, maxDescriptionChars: 50 },
        ctx,
      )) as { description: string; reviewers: Record<string, unknown>[] };
      expect(result.description.length).toBe(50);
      expect(result.reviewers[0]).toMatchObject({ username: "rev1", approved: true });
      expect(captured[0].url.pathname).toBe("/rest/api/1.0/projects/PLAT/repos/api/pull-requests/101");
    } finally {
      restore();
    }
  });

  it("bb_get_pull_request_changes projects file cards", async () => {
    const { ctx, restore } = makeServerCtx(() => ({
      body: envelope([{ path: { components: ["src", "a.ts"], toString: "src/a.ts" }, type: "MODIFY" }]),
    }));
    try {
      const result = (await find("bb_get_pull_request_changes").handler(
        { projectKey: "PLAT", repositorySlug: "api", pullRequestId: 101, limit: 25, start: 0 },
        ctx,
      )) as { items: Record<string, unknown>[] };
      expect(result.items[0]).toEqual({ path: "src/a.ts", changeType: "MODIFY" });
    } finally {
      restore();
    }
  });

  it("bb_get_pull_request_diff truncates large files with stats", async () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ line: i + 1, content: `line-${i}` }));
    const { ctx, restore } = makeServerCtx(() => ({
      body: {
        diffs: [
          {
            source: { toString: "src/a.ts" },
            destination: { toString: "src/a.ts" },
            changeType: "MODIFY",
            hunks: [
              {
                segments: [
                  { type: "ADDED", lines: lines(100) },
                  { type: "REMOVED", lines: lines(50) },
                ],
              },
            ],
          },
        ],
        truncated: false,
      },
    }));
    try {
      const result = (await find("bb_get_pull_request_diff").handler(
        { projectKey: "PLAT", repositorySlug: "api", pullRequestId: 101, maxCharsPerFile: 400 },
        ctx,
      )) as { files: Record<string, unknown>[] };
      const file = result.files[0];
      expect(file).toMatchObject({ destination: "src/a.ts", addedLines: 100, removedLines: 50, truncated: true });
      expect(String(file["preview"])).toContain("omitted");
      expect(String(file["preview"]).length).toBeLessThanOrEqual(410);
    } finally {
      restore();
    }
  });

  it("bb_get_pull_request_builds resolves the head commit and maps build cards", async () => {
    const { ctx, captured, restore } = makeServerCtx((url) => {
      if (url.pathname.endsWith("/pull-requests/101")) {
        return { body: PR };
      }
      return { body: envelope([{ state: "SUCCESS", key: "JOB-1", name: "build", url: "https://ci.example.com/1", dateAdded: 1_700_000_000_000 }]) };
    });
    try {
      const result = (await find("bb_get_pull_request_builds").handler(
        { projectKey: "PLAT", repositorySlug: "api", pullRequestId: 101, limit: 25, start: 0 },
        ctx,
      )) as { headCommit: string; items: Record<string, unknown>[] };
      expect(result.headCommit).toBe("abc123");
      expect(result.items[0]).toMatchObject({ state: "SUCCESS", name: "build" });
      expect(captured[1].url.pathname).toBe("/rest/build-status/1.0/commits/abc123");
    } finally {
      restore();
    }
  });

  it("bb_get_pull_request_builds answers gracefully when no head commit exists", async () => {
    const { ctx, restore } = makeServerCtx(() => ({ body: { ...PR, fromRef: { displayId: "feature/x" } } }));
    try {
      const result = (await find("bb_get_pull_request_builds").handler(
        { projectKey: "PLAT", repositorySlug: "api", pullRequestId: 101, limit: 25, start: 0 },
        ctx,
      )) as { headCommit: null; items: unknown[] };
      expect(result.headCommit).toBeNull();
      expect(result.items).toEqual([]);
    } finally {
      restore();
    }
  });

  it("rejects invalid pull request ids", async () => {
    const { ctx, restore } = makeServerCtx(() => ({ body: {} }));
    try {
      await expect(
        find("bb_get_pull_request").handler({ projectKey: "PLAT", repositorySlug: "api", pullRequestId: -3 }, ctx),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    } finally {
      restore();
    }
  });
});

describe("bb_search_code", () => {
  it("builds the Lucene query with modifiers", async () => {
    const { ctx, captured, restore } = makeServerCtx(() => ({
      body: {
        searchResults: {
          size: 1,
          limit: 25,
          start: 0,
          total: 42,
          isLastPage: false,
          nextPageStart: 25,
          results: [{ path: { toString: "src/core/restClient.ts" }, repository: { slug: "api", project: { key: "PLAT" } } }],
        },
      },
    }));
    try {
      const result = (await find("bb_search_code").handler(
        { query: "RestClient", project: "PLAT", repo: "PLAT/api", ext: "ts", limit: 25, start: 0 },
        ctx,
      )) as { items: Record<string, unknown>[]; page: { nextPageStart: number | null } };
      const q = captured[0].url.searchParams.get("q");
      expect(q).toContain("RestClient");
      expect(q).toContain("project:PLAT");
      expect(q).toContain("repo:PLAT/api");
      expect(q).toContain("ext:ts");
      expect(result.items[0]).toEqual({ path: "src/core/restClient.ts", project: "PLAT", repo: "api", type: "ts" });
      expect(result.page.nextPageStart).toBe(25);
    } finally {
      restore();
    }
  });

  it("maps upstream errors", async () => {
    const { ctx, restore } = makeServerCtx(() => ({ status: 400, body: { errors: [{ message: "search unavailable" }] } }));
    try {
      await expect(find("bb_search_code").handler({ query: "x", limit: 25, start: 0 }, ctx)).rejects.toMatchObject({
        code: "VALIDATION",
      });
    } finally {
      restore();
    }
  });
});

describe("bb_get_pr_comments_and_actions", () => {
  function comment(id: number, extra: Record<string, unknown>): Record<string, unknown> {
    return { comment: { id, text: `c${id}`, author: { displayName: "Dev" }, severity: "NORMAL", state: "OPEN", ...extra } };
  }

  it("hides resolved threads by default and reports severity/tasks", async () => {
    const { ctx, restore } = makeServerCtx(() => ({
      body: envelope([
        comment(1, { severity: "BLOCKER", tasks: [{ id: 9, text: "fix it", state: "OPEN" }] }),
        comment(2, { state: "RESOLVED" }),
        comment(3, { parent: { id: 1 }, text: "reply" }),
      ]),
    }));
    try {
      const result = (await find("bb_get_pr_comments_and_actions").handler(
        { projectKey: "PLAT", repositorySlug: "api", pullRequestId: 101, severity: "ALL", includeResolved: false, includeReplies: true, limit: 100, start: 0 },
        ctx,
      )) as { summary: Record<string, unknown>; items: Record<string, unknown>[] };
      expect(result.summary).toEqual({ threads: 1, blockers: 1, openTasks: 1 });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]["id"]).toBe(1);
      expect((result.items[0]["replies"] as unknown[])).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("includes resolved threads and filters by severity when asked", async () => {
    const { ctx, restore } = makeServerCtx(() => ({
      body: envelope([
        comment(1, { severity: "NORMAL" }),
        comment(2, { severity: "BLOCKER", state: "OPEN" }),
      ]),
    }));
    try {
      const all = (await find("bb_get_pr_comments_and_actions").handler(
        { projectKey: "PLAT", repositorySlug: "api", pullRequestId: 101, severity: "ALL", includeResolved: true, limit: 100, start: 0 },
        ctx,
      )) as { summary: { threads: number } };
      expect(all.summary.threads).toBe(2);

      const blockers = (await find("bb_get_pr_comments_and_actions").handler(
        { projectKey: "PLAT", repositorySlug: "api", pullRequestId: 101, severity: "BLOCKER", includeResolved: true, limit: 100, start: 0 },
        ctx,
      )) as { summary: { threads: number; blockers: number } };
      expect(blockers.summary).toEqual({ threads: 1, blockers: 1, openTasks: 0 });
    } finally {
      restore();
    }
  });

  it("maps upstream errors", async () => {
    const { ctx, restore } = makeServerCtx(() => ({ status: 404, body: {} }));
    try {
      await expect(
        find("bb_get_pr_comments_and_actions").handler({ projectKey: "PLAT", repositorySlug: "api", pullRequestId: 999, limit: 100, start: 0 }, ctx),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      restore();
    }
  });
});

describe("dashboard tools", () => {
  it("bb_get_dashboard_pull_requests sends role and state", async () => {
    const { ctx, captured, restore } = makeServerCtx(() => ({
      body: envelope([{ pullRequest: PR }]),
    }));
    try {
      const result = (await find("bb_get_dashboard_pull_requests").handler(
        { role: "AUTHOR", state: "OPEN", limit: 25, start: 0 },
        ctx,
      )) as { items: Record<string, unknown>[] };
      expect(result.items[0]).toMatchObject({ id: 101, project: "PLAT" });
      expect(captured[0].url.searchParams.get("role")).toBe("AUTHOR");
      expect(captured[0].url.pathname).toBe("/rest/api/1.0/dashboard/pull-requests");
    } finally {
      restore();
    }
  });

  it("bb_get_inbox_pull_requests reads the inbox envelope", async () => {
    const { ctx, captured, restore } = makeServerCtx(() => ({
      body: envelope([{ pullRequest: PR }]),
    }));
    try {
      const result = (await find("bb_get_inbox_pull_requests").handler({ limit: 25, start: 0 }, ctx)) as {
        items: Record<string, unknown>[];
      };
      expect(result.items[0]).toMatchObject({ id: 101, title: "Add pagination helper" });
      expect(captured[0].url.pathname).toBe("/rest/api/1.0/inbox/pull-requests");
    } finally {
      restore();
    }
  });

  it("maps upstream errors on the dashboard", async () => {
    const { ctx, restore } = makeServerCtx(() => ({ status: 403, body: {} }));
    try {
      await expect(
        find("bb_get_dashboard_pull_requests").handler({ role: "AUTHOR", state: "OPEN", limit: 25, start: 0 }, ctx),
      ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    } finally {
      restore();
    }
  });
});

describe("bb_get_user", () => {
  it("looks up by slug", async () => {
    const { ctx, captured, restore } = makeServerCtx(() => ({
      body: { name: "dev1", displayName: "Dev One", emailAddress: "dev1@example.com", active: true },
    }));
    try {
      const result = (await find("bb_get_user").handler({ userSlug: "dev1" }, ctx)) as Record<string, unknown>;
      expect(result).toMatchObject({ name: "dev1", displayName: "Dev One" });
      expect(captured[0].url.pathname).toBe("/rest/api/1.0/users/dev1");
    } finally {
      restore();
    }
  });

  it("searches by filter", async () => {
    const { ctx, captured, restore } = makeServerCtx(() => ({
      body: envelope([{ name: "dev1", displayName: "Dev One", emailAddress: "dev1@example.com" }]),
    }));
    try {
      const result = (await find("bb_get_user").handler({ filter: "dev" }, ctx)) as { items: unknown[] };
      expect(result.items).toHaveLength(1);
      expect(captured[0].url.searchParams.get("filter")).toBe("dev");
    } finally {
      restore();
    }
  });

  it("requires at least one selector", async () => {
    const { ctx, restore } = makeServerCtx(() => ({ body: {} }));
    try {
      await expect(find("bb_get_user").handler({}, ctx)).rejects.toMatchObject({ code: "VALIDATION" });
    } finally {
      restore();
    }
  });
});

describe("branch and commit tools", () => {
  it("bb_list_branches flags the default branch", async () => {
    const { ctx, restore } = makeServerCtx(() => ({
      body: envelope([
        { displayId: "main", type: "BRANCH", isDefault: true, metadata: { commitId: "abc123" } },
        { displayId: "feature/x", type: "BRANCH", isDefault: false },
      ]),
    }));
    try {
      const result = (await find("bb_list_branches").handler(
        { projectKey: "PLAT", repositorySlug: "api", limit: 25, start: 0 },
        ctx,
      )) as { items: Record<string, unknown>[] };
      const main = result.items.find((b) => b["displayId"] === "main");
      expect(main).toMatchObject({ isDefault: true, latestCommit: "abc123" });
      expect(result.items.find((b) => b["displayId"] === "feature/x")?.["isDefault"]).toBe(false);
    } finally {
      restore();
    }
  });

  it("bb_list_commits filters by author client-side", async () => {
    const commit = (id: string, name: string) => ({
      displayId: id,
      author: { name, emailAddress: `${name}@example.com` },
      authorTimestamp: 1_700_000_000_000,
      message: `commit ${id}`,
    });
    const { ctx, captured, restore } = makeServerCtx(() => ({
      body: envelope([commit("aaa", "dev1"), commit("bbb", "other")], { size: 2 }),
    }));
    try {
      const result = (await find("bb_list_commits").handler(
        { projectKey: "PLAT", repositorySlug: "api", author: "dev1", limit: 25, start: 0 },
        ctx,
      )) as { items: Record<string, unknown>[] };
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ displayId: "aaa", author: "dev1" });
      expect(String((result.page as { warning?: string }).warning)).toContain("client-side");
      expect(captured[0].url.searchParams.get("withMessages")).toBe("true");
    } finally {
      restore();
    }
  });

  it("bb_list_commits maps upstream errors", async () => {
    const { ctx, restore } = makeServerCtx(() => ({ status: 404, body: {} }));
    try {
      await expect(
        find("bb_list_commits").handler({ projectKey: "PLAT", repositorySlug: "missing", limit: 25, start: 0 }, ctx),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      restore();
    }
  });
});

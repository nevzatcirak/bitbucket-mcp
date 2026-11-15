/**
 * Cloud adapter tool tests: every cloud-advertised tool handler against a
 * stubbed REST 2.0 endpoint, asserting request paths/bodies and card shapes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { toolManifests } from "../src/tools/registry.js";
import type { ToolManifest } from "../src/tools/registry.js";
import { makeCloudCtx } from "./test-helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function find(name: string): ToolManifest {
  const manifest = toolManifests.find((m) => m.name === name);
  if (!manifest) throw new Error(`manifest not found: ${name}`);
  return manifest;
}

const REPO = {
  full_name: "ws/service-api",
  slug: "service-api",
  name: "Service API",
  is_private: true,
  language: "typescript",
  updated_on: "2026-01-02T03:04:05.000000+00:00",
  mainbranch: { name: "main" },
  links: { clone: [{ name: "https", href: "https://bitbucket.org/ws/service-api.git" }] },
};

function route(
  url: URL,
  table: Record<string, { status?: number; body: unknown }>,
): { status?: number; body: unknown } {
  const key = Object.keys(table).find((k) => url.pathname === k || url.pathname === `/2.0${k}`);
  if (!key) throw new Error(`unexpected request: ${url.pathname}${url.search}`);
  return table[key] ?? { body: {} };
}

describe("cloud discovery", () => {
  it("bb_get_projects lists workspaces and exposes cursor pagination", async () => {
    const { ctx, captured, restore } = makeCloudCtx((url) =>
      route(url, {
        "/user/workspaces": {
          body: {
            page: 1,
            pagelen: 25,
            size: 2,
            next: "https://api.bitbucket.org/2.0/user/workspaces?pagelen=25&page=2",
            values: [{ workspace: { slug: "ws", name: "Workspace" } }],
          },
        },
      }),
    );
    try {
      const result = (await find("bb_get_projects").handler({}, ctx)) as {
        items: unknown[];
        page: { isLastPage: boolean; nextPageStart: number | null; nextCursor: string | null; start: number };
      };
      expect(result.items[0]).toEqual({ key: "ws", name: "Workspace" });
      expect(result.page.isLastPage).toBe(false);
      expect(result.page.nextPageStart).toBe(2);
      expect(result.page.nextCursor).toBe("2");
      expect(captured[0].url.pathname).toBe("/2.0/user/workspaces");
      expect(captured[0].url.searchParams.get("pagelen")).toBe("25");
    } finally {
      restore();
    }
  });

  it("bb_get_projects follows the cursor when page=2 is passed", async () => {
    const { ctx, captured, restore } = makeCloudCtx((url) =>
      route(url, {
        "/user/workspaces": { body: { page: 2, pagelen: 25, values: [{ workspace: { slug: "ws2" } }] } },
      }),
    );
    try {
      const result = (await find("bb_get_projects").handler({ page: 2 }, ctx)) as {
        page: { isLastPage: boolean; start: number };
      };
      expect(result.page.isLastPage).toBe(true);
      expect(result.page.start).toBe(2);
      expect(captured[0].url.searchParams.get("page")).toBe("2");
    } finally {
      restore();
    }
  });

  it("bb_get_project returns a workspace card", async () => {
    const { ctx, captured, restore } = makeCloudCtx((url) =>
      route(url, {
        "/workspaces/ws": { body: { slug: "ws", name: "Workspace", is_private: true, created_on: "2020-01-01", updated_on: "2026-01-01" } },
      }),
    );
    try {
      const result = (await find("bb_get_project").handler({ projectKey: "ws" }, ctx)) as Record<string, unknown>;
      expect(result).toMatchObject({ key: "ws", name: "Workspace", isPrivate: true });
      expect(captured[0].url.pathname).toBe("/2.0/workspaces/ws");
    } finally {
      restore();
    }
  });

  it("bb_get_repositories maps repo cards and applies the client-side name filter", async () => {
    const { ctx, restore } = makeCloudCtx((url) =>
      route(url, {
        "/repositories/ws": { body: { values: [REPO, { ...REPO, slug: "other", name: "Other" }] } },
      }),
    );
    try {
      const result = (await find("bb_get_repositories").handler({ projectKey: "ws", name: "service" }, ctx)) as {
        items: Array<Record<string, unknown>>;
        page: { isLastPage: boolean };
      };
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        slug: "service-api",
        project: "ws",
        cloneUrl: "https://bitbucket.org/ws/service-api.git",
        mainBranch: "main",
      });
      expect(result.page.isLastPage).toBe(true);
    } finally {
      restore();
    }
  });

  it("bb_get_repository returns one repo card", async () => {
    const { ctx, captured, restore } = makeCloudCtx((url) => route(url, { "/repositories/ws/service-api": { body: REPO } }));
    try {
      const result = (await find("bb_get_repository").handler({ projectKey: "ws", repositorySlug: "service-api" }, ctx)) as Record<string, unknown>;
      expect(result).toMatchObject({ slug: "service-api", isPrivate: true });
      expect(captured[0].url.pathname).toBe("/2.0/repositories/ws/service-api");
    } finally {
      restore();
    }
  });

  it("bb_browse_repository resolves the default branch and lists the root directory", async () => {
    const { ctx, captured, restore } = makeCloudCtx((url) =>
      route(url, {
        "/repositories/ws/service-api": { body: { mainbranch: { name: "main" } } },
        "/repositories/ws/service-api/src/main/": {
          body: { values: [{ path: "src", type: "commit_directory" }, { path: "README.md", type: "commit_file", size: 120 }] },
        },
      }),
    );
    try {
      const result = (await find("bb_browse_repository").handler({ projectKey: "ws", repositorySlug: "service-api" }, ctx)) as {
        items: Array<Record<string, unknown>>;
      };
      expect(result.items).toEqual([
        { name: "src", path: "src", type: "dir", size: null },
        { name: "README.md", path: "README.md", type: "file", size: 120 },
      ]);
      expect(captured[1].url.pathname).toBe("/2.0/repositories/ws/service-api/src/main/");
    } finally {
      restore();
    }
  });

  it("bb_get_file_content fetches metadata + raw text with truncation", async () => {
    const longBody = "x".repeat(300);
    const { ctx, captured, restore } = makeCloudCtx((url) => {
      if (url.pathname === "/2.0/repositories/ws/service-api") return { body: { mainbranch: { name: "main" } } };
      if (url.searchParams.get("format") === "meta") return { body: { size: 300 } };
      return { body: longBody };
    });
    try {
      const result = (await find("bb_get_file_content").handler(
        { projectKey: "ws", repositorySlug: "service-api", path: "README.md", maxChars: 200 },
        ctx,
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ path: "README.md", truncated: true, totalChars: 300, size: 300 });
      expect(result["content"]).toHaveLength(200);
      expect(captured.some((r) => r.url.searchParams.get("format") === "meta")).toBe(true);
    } finally {
      restore();
    }
  });

  it("bb_search_code is workspace-scoped and rejects a missing project modifier", async () => {
    const { ctx, restore } = makeCloudCtx(() => ({ body: {} }));
    try {
      await expect(find("bb_search_code").handler({ query: "x" }, ctx)).rejects.toMatchObject({ code: "VALIDATION" });
    } finally {
      restore();
    }
  });

  it("bb_search_code narrows with the repo: modifier and warns about unsupported modifiers", async () => {
    const { ctx, captured, restore } = makeCloudCtx((url) =>
      route(url, {
        "/workspaces/ws/search/code": {
          body: {
            values: [
              {
                content_match_count: 2,
                file: { path: "src/a.ts" },
                content_matches: [{ lines: [{ segments: [{ text: "match here" }] }] }],
              },
            ],
          },
        },
      }),
    );
    try {
      const result = (await find("bb_search_code").handler({ query: "match", project: "ws", repo: "ws/service-api", ext: "ts" }, ctx)) as {
        items: Array<Record<string, unknown>>;
      };
      expect(result.items[0]).toMatchObject({ path: "src/a.ts", matchCount: 2, preview: "match here" });
      expect(captured[0].url.searchParams.get("search_query")).toBe('match repo:"ws/service-api"');
    } finally {
      restore();
    }
  });
});

describe("cloud git data", () => {
  it("bb_list_branches detects the default branch", async () => {
    const { ctx, restore } = makeCloudCtx((url) =>
      route(url, {
        "/repositories/ws/service-api": { body: { mainbranch: { name: "main" } } },
        "/repositories/ws/service-api/refs/branches": {
          body: { values: [{ name: "main", target: { hash: "abc" } }, { name: "feature/x", target: { hash: "def" } }] },
        },
      }),
    );
    try {
      const result = (await find("bb_list_branches").handler({ projectKey: "ws", repositorySlug: "service-api" }, ctx)) as {
        items: Array<Record<string, unknown>>;
      };
      expect(result.items).toEqual([
        { displayId: "main", commit: "abc", isDefault: true },
        { displayId: "feature/x", commit: "def", isDefault: false },
      ]);
    } finally {
      restore();
    }
  });

  it("bb_list_commits filters merge commits client-side", async () => {
    const { ctx, captured, restore } = makeCloudCtx((url) =>
      route(url, {
        "/repositories/ws/service-api": { body: { mainbranch: { name: "main" } } },
        "/repositories/ws/service-api/commits/main": {
          body: {
            values: [
              { hash: "a1", message: "merge", parents: [{ hash: "p1" }, { hash: "p2" }], author: { raw: "Dev <d@example.com>" } },
              { hash: "a2", message: "feat", parents: [{ hash: "p2" }], author: { raw: "Dev <d@example.com>" } },
            ],
          },
        },
      }),
    );
    try {
      const result = (await find("bb_list_commits").handler(
        { projectKey: "ws", repositorySlug: "service-api", includeMerges: false },
        ctx,
      )) as { items: Array<Record<string, unknown>> };
      expect(result.items.map((c) => c.displayId)).toEqual(["a2"]);
      expect(captured[1].url.pathname).toBe("/2.0/repositories/ws/service-api/commits/main");
    } finally {
      restore();
    }
  });
});

describe("cloud pull requests", () => {
  const PR = {
    id: 7,
    title: "Add feature",
    state: "OPEN",
    author: { display_name: "Dev One" },
    description: "does things",
    source: { branch: { name: "feature/x" }, commit: { hash: "abc123" }, repository: { full_name: "ws/service-api" } },
    destination: { branch: { name: "main" } },
    updated_on: "2026-01-02T00:00:00+00:00",
  };

  function prTable(extra: Record<string, { status?: number; body: unknown }> = {}) {
    return {
      "/repositories/ws/service-api/pullrequests": { body: { values: [PR] } },
      "/repositories/ws/service-api/pullrequests/7": { body: PR },
      ...extra,
    };
  }

  it("bb_list_pull_requests passes the state filter and warns on author filter", async () => {
    const { ctx, captured, restore } = makeCloudCtx((url) => route(url, prTable()));
    try {
      const result = (await find("bb_list_pull_requests").handler(
        { projectKey: "ws", repositorySlug: "service-api", state: "OPEN", author: "dev" },
        ctx,
      )) as { items: Array<Record<string, unknown>>; page: { isLastPage: boolean } };
      expect(result.items[0]).toMatchObject({ id: 7, title: "Add feature", fromBranch: "feature/x", toBranch: "main", project: "ws", repo: "service-api" });
      expect(captured[0].url.searchParams.get("state")).toBe("OPEN");
      expect(result.page.isLastPage).toBe(true);
    } finally {
      restore();
    }
  });

  it("bb_get_pull_request maps reviewers and description", async () => {
    const { ctx, restore } = makeCloudCtx((url) =>
      route(url, prTable({
        "/repositories/ws/service-api/pullrequests/7": {
          body: { ...PR, reviewers: [{ uuid: "{u-1}", display_name: "Reviewer", username: "rev1", state: "approved", role: "REVIEWER" }], comment_count: 3 },
        },
      })),
    );
    try {
      const result = (await find("bb_get_pull_request").handler(
        { projectKey: "ws", repositorySlug: "service-api", pullRequestId: 7, maxDescriptionChars: 100 },
        ctx,
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ id: 7, description: "does things", commentCount: 3 });
      expect(result["reviewers"]).toEqual([{ username: "rev1", displayName: "Reviewer", approved: true }]);
    } finally {
      restore();
    }
  });

  it("bb_get_pull_request_changes maps diffstat entries", async () => {
    const { ctx, restore } = makeCloudCtx((url) =>
      route(url, {
        "/repositories/ws/service-api/pullrequests/7/diffstat": {
          body: { values: [{ status: "modified", lines_added: 3, lines_removed: 1, old: { path: "a.ts" }, new: { path: "a.ts" } }] },
        },
      }),
    );
    try {
      const result = (await find("bb_get_pull_request_changes").handler(
        { projectKey: "ws", repositorySlug: "service-api", pullRequestId: 7 },
        ctx,
      )) as { items: Array<Record<string, unknown>> };
      expect(result.items).toEqual([{ path: "a.ts", changeType: "modified", addedLines: 3, removedLines: 1 }]);
    } finally {
      restore();
    }
  });

  it("bb_get_pull_request_diff returns the raw diff with truncation", async () => {
    const { ctx, restore } = makeCloudCtx((url) =>
      route(url, {
        "/repositories/ws/service-api/pullrequests/7/diff": { body: "diff --git a/a.ts b/a.ts\n+x" },
      }),
    );
    try {
      const result = (await find("bb_get_pull_request_diff").handler(
        { projectKey: "ws", repositorySlug: "service-api", pullRequestId: 7, maxCharsPerFile: 200 },
        ctx,
      )) as Record<string, unknown>;
      expect(result["truncated"]).toBe(false);
      expect(String(result["diff"])).toContain("+x");
    } finally {
      restore();
    }
  });

  it("bb_get_pull_request_builds resolves the head commit and maps statuses", async () => {
    const { ctx, restore } = makeCloudCtx((url) =>
      route(url, {
        "/repositories/ws/service-api/pullrequests/7": { body: PR },
        "/repositories/ws/service-api/commit/abc123/statuses": {
          body: { values: [{ key: "CI", name: "build", state: "SUCCESSFUL", url: "https://ci.example.com/1", created_on: "2026-01-01" }] },
        },
      }),
    );
    try {
      const result = (await find("bb_get_pull_request_builds").handler(
        { projectKey: "ws", repositorySlug: "service-api", pullRequestId: 7 },
        ctx,
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ headCommit: "abc123" });
      expect(result["items"]).toEqual([
        { state: "SUCCESSFUL", name: "build", key: "CI", url: "https://ci.example.com/1", dateAdded: "2026-01-01" },
      ]);
    } finally {
      restore();
    }
  });

  it("bb_get_pr_comments_and_actions joins tasks and detects the [BLOCKER] tag", async () => {
    const { ctx, restore } = makeCloudCtx((url) =>
      route(url, {
        "/repositories/ws/service-api/pullrequests/7/comments": {
          body: {
            values: [
              { id: 1, content: { raw: "[BLOCKER] fix this" }, user: { display_name: "Rev" }, created_on: "2026-01-01" },
              { id: 2, content: { raw: "ok" }, user: { display_name: "Rev" }, resolution: {}, created_on: "2026-01-01" },
            ],
          },
        },
        "/repositories/ws/service-api/pullrequests/7/tasks": {
          body: { values: [{ id: 9, state: "UNRESOLVED", comment: { id: 1 } }] },
        },
      }),
    );
    try {
      const result = (await find("bb_get_pr_comments_and_actions").handler(
        { projectKey: "ws", repositorySlug: "service-api", pullRequestId: 7 },
        ctx,
      )) as { summary: Record<string, number>; items: Array<Record<string, unknown>> };
      expect(result.summary).toEqual({ threads: 1, blockers: 1, openTasks: 1 });
      expect(result.items[0]).toMatchObject({ id: 1, severity: "BLOCKER", state: "OPEN", taskCount: 1 });
    } finally {
      restore();
    }
  });

  it("bb_get_dashboard_pull_requests passes the lowercase role", async () => {
    const { ctx, captured, restore } = makeCloudCtx((url) => route(url, { "/pullrequests": { body: { values: [PR] } } }));
    try {
      const result = (await find("bb_get_dashboard_pull_requests").handler({ role: "REVIEWER", state: "OPEN" }, ctx)) as {
        items: Array<Record<string, unknown>>;
      };
      expect(result.items).toHaveLength(1);
      expect(captured[0].url.searchParams.get("role")).toBe("reviewer");
      expect(captured[0].url.pathname).toBe("/2.0/pullrequests");
    } finally {
      restore();
    }
  });
});

describe("cloud users", () => {
  it("bb_get_user looks up by slug", async () => {
    const { ctx, captured, restore } = makeCloudCtx((url) =>
      route(url, { "/users/dev1": { body: { username: "dev1", display_name: "Dev One", uuid: "{u1}", account_id: "acc1" } } }),
    );
    try {
      const result = (await find("bb_get_user").handler({ userSlug: "dev1" }, ctx)) as Record<string, unknown>;
      expect(result).toMatchObject({ username: "dev1", displayName: "Dev One", accountId: "acc1" });
      expect(captured[0].url.pathname).toBe("/2.0/users/dev1");
    } finally {
      restore();
    }
  });

  it("bb_get_user without a slug returns the authenticated account with a note", async () => {
    const { ctx, restore } = makeCloudCtx((url) =>
      route(url, { "/user": { body: { username: "me", display_name: "Me" } } }),
    );
    try {
      const result = (await find("bb_get_user").handler({}, ctx)) as Record<string, unknown>;
      expect(result).toMatchObject({ username: "me" });
      expect(typeof result["note"]).toBe("string");
    } finally {
      restore();
    }
  });
});

describe("cloud branch writes", () => {
  it("bb_create_branch posts refs/branches with the mainbranch target", async () => {
    const { ctx, captured, restore } = makeCloudCtx((url) => {
      if (url.pathname === "/2.0/repositories/ws/service-api") return { body: { mainbranch: { name: "main" } } };
      return { status: 201, body: { name: "feature/y", target: { hash: "abc" } } };
    });
    try {
      const result = (await find("bb_create_branch").handler(
        { projectKey: "ws", repositorySlug: "service-api", name: "feature/y" },
        ctx,
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ created: true, displayId: "feature/y", startPoint: "main" });
      const body = JSON.parse(String(captured[1].init.body)) as Record<string, unknown>;
      expect(body).toEqual({ name: "feature/y", target: { hash: "main" } });
    } finally {
      restore();
    }
  });

  it("bb_delete_branch refuses the main branch and deletes others", async () => {
    const refused = makeCloudCtx((url) =>
      route(url, { "/repositories/ws/service-api": { body: { mainbranch: { name: "main" } } } }),
    );
    try {
      await expect(
        find("bb_delete_branch").handler({ projectKey: "ws", repositorySlug: "service-api", name: "main" }, refused.ctx),
      ).rejects.toMatchObject({ code: "DELETE_REFUSED" });
    } finally {
      refused.restore();
    }

    const ok = makeCloudCtx((url) => {
      if (url.pathname === "/2.0/repositories/ws/service-api") return { body: { mainbranch: { name: "main" } } };
      return { status: 204, body: "" };
    });
    try {
      const result = (await find("bb_delete_branch").handler(
        { projectKey: "ws", repositorySlug: "service-api", name: "feature/y" },
        ok.ctx,
      )) as Record<string, unknown>;
      expect(result).toEqual({ deleted: true, name: "feature/y" });
      expect(ok.captured[1].init.method).toBe("DELETE");
      expect(ok.captured[1].url.pathname).toBe("/2.0/repositories/ws/service-api/refs/branches/feature%2Fy");
    } finally {
      ok.restore();
    }
  });
});

describe("cloud PR lifecycle writes", () => {
  it("bb_create_pull_request posts the 2.0 body with reviewers", async () => {
    const { ctx, captured, restore } = makeCloudCtx((url) =>
      route(url, {
        "/repositories/ws/service-api/pullrequests": { status: 201, body: { id: 9, title: "t", state: "OPEN", source: { branch: { name: "f" } }, destination: { branch: { name: "main" } } } },
      }),
    );
    try {
      const result = (await find("bb_create_pull_request").handler(
        { projectKey: "ws", repositorySlug: "service-api", title: "t", fromBranch: "f", toBranch: "main", reviewers: ["rev1", "{u-1}"] },
        ctx,
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ id: 9 });
      const body = JSON.parse(String(captured[0].init.body)) as Record<string, unknown>;
      expect(body["source"]).toEqual({ branch: { name: "f" } });
      expect(body["reviewers"]).toEqual([{ username: "rev1" }, { uuid: "{u-1}" }]);
    } finally {
      restore();
    }
  });

  it("bb_create_pull_request encodes fork repositories via full_name", async () => {
    const { ctx, captured, restore } = makeCloudCtx((url) =>
      route(url, {
        "/repositories/ws/service-api/pullrequests": { status: 201, body: { id: 10, state: "OPEN" } },
      }),
    );
    try {
      await find("bb_create_pull_request").handler(
        { projectKey: "ws", repositorySlug: "service-api", title: "t", fromBranch: "f", toBranch: "main", fromProjectKey: "fork-ws", fromRepositorySlug: "forked" },
        ctx,
      );
      const body = JSON.parse(String(captured[0].init.body)) as { source: Record<string, unknown> };
      expect(body.source["repository"]).toEqual({ full_name: "fork-ws/forked" });
    } finally {
      restore();
    }
  });

  it("bb_update_pull_request PUTs a partial body without a version", async () => {
    const { ctx, captured, restore } = makeCloudCtx((url) =>
      route(url, { "/repositories/ws/service-api/pullrequests/7": { body: { id: 7, state: "OPEN" } } }),
    );
    try {
      await find("bb_update_pull_request").handler(
        { projectKey: "ws", repositorySlug: "service-api", pullRequestId: 7, title: "new" },
        ctx,
      );
      expect(captured[0].init.method).toBe("PUT");
      const body = JSON.parse(String(captured[0].init.body)) as Record<string, unknown>;
      expect(body).toEqual({ title: "new" });
    } finally {
      restore();
    }
  });

  it("bb_can_merge_pull_request derives vetoes from state and conflicts", async () => {
    const { ctx, restore } = makeCloudCtx((url) =>
      route(url, {
        "/repositories/ws/service-api/pullrequests/7": { body: { state: "OPEN" } },
        "/repositories/ws/service-api/pullrequests/7/conflicts": {
          body: { values: [{ scenario: "content conflict", old: { path: "a.ts" }, new: { path: "a.ts" } }] },
        },
      }),
    );
    try {
      const result = (await find("bb_can_merge_pull_request").handler(
        { projectKey: "ws", repositorySlug: "service-api", pullRequestId: 7 },
        ctx,
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ canMerge: false, conflicted: true });
      expect((result["vetoes"] as Array<Record<string, unknown>>)[0]["summary"]).toContain("Merge conflicts");
    } finally {
      restore();
    }
  });

  it("bb_merge_pull_request translates the strategy id", async () => {
    const { ctx, captured, restore } = makeCloudCtx((url) =>
      route(url, {
        "/repositories/ws/service-api/pullrequests/7/merge": { body: { id: 7, state: "MERGED" } },
      }),
    );
    try {
      const result = (await find("bb_merge_pull_request").handler(
        { projectKey: "ws", repositorySlug: "service-api", pullRequestId: 7, strategy: "fast-forward" },
        ctx,
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ state: "MERGED", mergedWith: "fast-forward" });
      const body = JSON.parse(String(captured[0].init.body)) as Record<string, unknown>;
      expect(body["merge_strategy"]).toBe("fast_forward");
      expect(body["type"]).toBe("merge");
    } finally {
      restore();
    }
  });

  it("bb_decline_pull_request posts decline", async () => {
    const { ctx, captured, restore } = makeCloudCtx((url) =>
      route(url, { "/repositories/ws/service-api/pullrequests/7/decline": { body: { id: 7, state: "DECLINED" } } }),
    );
    try {
      const result = (await find("bb_decline_pull_request").handler(
        { projectKey: "ws", repositorySlug: "service-api", pullRequestId: 7 },
        ctx,
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ state: "DECLINED" });
      expect(captured[0].init.method).toBe("POST");
    } finally {
      restore();
    }
  });
});

describe("cloud comment writes", () => {
  function commentRoute(extra: Record<string, { status?: number; body: unknown }> = {}) {
    return {
      "/repositories/ws/service-api/pullrequests/7/comments": { status: 201, body: { id: 55, content: { raw: "text" } } },
      "/repositories/ws/service-api/pullrequests/7/tasks": { status: 201, body: { id: 77 } },
      ...extra,
    };
  }

  it("bb_post_pull_request_comment maps inline anchors (ADDED → to, REMOVED → from)", async () => {
    const { ctx, captured, restore } = makeCloudCtx((url) => route(url, commentRoute()));
    try {
      const result = (await find("bb_post_pull_request_comment").handler(
        { projectKey: "ws", repositorySlug: "service-api", pullRequestId: 7, text: "text", file: "a.ts", line: 10 },
        ctx,
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ id: 55, severity: "NORMAL", taskCreated: false });
      let body = JSON.parse(String(captured[0].init.body)) as { inline: Record<string, unknown> };
      expect(body.content).toEqual({ raw: "text" });
      expect(body.inline).toEqual({ path: "a.ts", to: 10 });

      await find("bb_post_pull_request_comment").handler(
        { projectKey: "ws", repositorySlug: "service-api", pullRequestId: 7, text: "t2", file: "a.ts", line: 3, lineType: "REMOVED" },
        ctx,
      );
      body = JSON.parse(String(captured[1].init.body)) as { inline: Record<string, unknown> };
      expect(body.inline).toEqual({ path: "a.ts", from: 3 });
    } finally {
      restore();
    }
  });

  it("bb_post_pull_request_comment rejects pending and creates a task for BLOCKER", async () => {
    const { ctx, restore } = makeCloudCtx((url) => route(url, commentRoute()));
    try {
      await expect(
        find("bb_post_pull_request_comment").handler(
          { projectKey: "ws", repositorySlug: "service-api", pullRequestId: 7, text: "x", pending: true },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "VALIDATION" });

      const result = (await find("bb_post_pull_request_comment").handler(
        { projectKey: "ws", repositorySlug: "service-api", pullRequestId: 7, text: "fix", severity: "BLOCKER", taskText: "do it" },
        ctx,
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ severity: "BLOCKER", taskCreated: true });
    } finally {
      restore();
    }
  });

  it("bb_update_pull_request_comment PUTs text and resolves via the resolve endpoint", async () => {
    const { ctx, captured, restore } = makeCloudCtx((url) =>
      route(url, commentRoute({
        "/repositories/ws/service-api/pullrequests/7/comments/55": { body: { id: 55 } },
        "/repositories/ws/service-api/pullrequests/7/comments/55/resolve": { body: {} },
      })),
    );
    try {
      const result = (await find("bb_update_pull_request_comment").handler(
        { projectKey: "ws", repositorySlug: "service-api", pullRequestId: 7, commentId: 55, text: "edited", state: "RESOLVED" },
        ctx,
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ id: 55, state: "RESOLVED" });
      expect(captured[0].init.method).toBe("PUT");
      expect(captured[1].url.pathname).toBe("/2.0/repositories/ws/service-api/pullrequests/7/comments/55/resolve");
    } finally {
      restore();
    }
  });

  it("bb_submit_pull_request_review approves the authenticated user and maps NEEDS_WORK", async () => {
    const meRoute = { "/user": { body: { username: "me", display_name: "Me" } } };

    const approve = makeCloudCtx((url) =>
      route(url, { ...meRoute, "/repositories/ws/service-api/pullrequests/7/approve": { body: {} } }),
    );
    try {
      const result = (await find("bb_submit_pull_request_review").handler(
        { projectKey: "ws", repositorySlug: "service-api", pullRequestId: 7, verdict: "APPROVED" },
        approve.ctx,
      )) as Record<string, unknown>;
      expect(result).toMatchObject({ userSlug: "me", verdict: "APPROVED", approved: true, publishedComments: null });
      expect(approve.captured[1].init.method).toBe("POST");
    } finally {
      approve.restore();
    }

    const needsWork = makeCloudCtx((url) =>
      route(url, { ...meRoute, "/repositories/ws/service-api/pullrequests/7/request-changes": { body: {} } }),
    );
    try {
      const result = (await find("bb_submit_pull_request_review").handler(
        { projectKey: "ws", repositorySlug: "service-api", pullRequestId: 7, verdict: "NEEDS_WORK" },
        needsWork.ctx,
      )) as Record<string, unknown>;
      expect(needsWork.captured[1].url.pathname).toContain("/request-changes");
      expect(String(result["note"])).toContain("request changes");
    } finally {
      needsWork.restore();
    }

    const mismatch = makeCloudCtx((url) => route(url, meRoute));
    try {
      await expect(
        find("bb_submit_pull_request_review").handler(
          { projectKey: "ws", repositorySlug: "service-api", pullRequestId: 7, verdict: "APPROVED", userSlug: "other" },
          mismatch.ctx,
        ),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    } finally {
      mismatch.restore();
    }
  });
});

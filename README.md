# ⚡ BITBUCKET-MCP

A deployment-agnostic [Model Context Protocol](https://modelcontextprotocol.io) server (stdio) for **Bitbucket Server / Data Center** and **Bitbucket Cloud** (REST 2.0) — compact cards, pagination-aware listings, optimistic-lock-safe writes.

```text
┌─────────────────────────────────────────────────────────┐
│  🔌 One MCP server, two deployment flavors              │
│  📇 Compact-card outputs — raw payloads never reach LLM │
│  🔒 Read-only mode + automatic 409-retry on writes      │
└─────────────────────────────────────────────────────────┘
```

![npm version](https://img.shields.io/npm/v/@nevzatcirak/bitbucket-mcp)
![npm downloads](https://img.shields.io/npm/dm/@nevzatcirak/bitbucket-mcp)
![CI](https://github.com/nevzatcirak/bitbucket-mcp/actions/workflows/ci.yml/badge.svg)
![Publish](https://github.com/nevzatcirak/bitbucket-mcp/actions/workflows/publish.yml/badge.svg)
![node](https://img.shields.io/node/v/%40nevzatcirak/bitbucket-mcp)
![License](https://img.shields.io/npm/l/%40nevzatcirak/bitbucket-mcp)

> **One server, both flavors.** Every tool manifest declares `providers: ["server", "cloud"]`; tools whose manifest does not list the active provider are simply never advertised to the MCP client (Server/DC: 29 tools, Cloud: 27). Where the two APIs diverge (optimistic locks, merge strategies, draft comments, review verdicts), the adapter forks the flow and documents the difference in the tool description and result notes.

---

## 🎯 Why this package

| Pain point | What bitbucket-mcp does |
|---|---|
| Raw REST payloads are huge (links, avatars, HTML) | Every result is projected into a **compact card** — flat JSON, only the fields an agent needs |
| Different pagination per deployment flavor | One convention everywhere: `start`/`limit` in, `isLastPage` + `nextPageStart` out |
| Concurrent writers clobber each other | Write flows go through an **optimistic-lock wrapper**: on `409 Conflict` it re-fetches the current version and retries once, automatically |
| Read-only environments | `BITBUCKET_READ_ONLY=true` hides every write tool from the MCP client |
| Mixed estates | Pick `server` or `cloud` with one env variable; tool availability adapts per provider |

## Atlassian MCP Suite

| Package | Scope |
|---|---|
| [@nevzatcirak/jira-mcp](https://www.npmjs.com/package/@nevzatcirak/jira-mcp) | Jira issues, boards, sprints, worklogs |
| [@nevzatcirak/bitbucket-mcp](https://www.npmjs.com/package/@nevzatcirak/bitbucket-mcp) | Bitbucket Server/DC + Cloud: PRs, reviews, branches, code search |
| [@nevzatcirak/confluence-mcp](https://www.npmjs.com/package/@nevzatcirak/confluence-mcp) | Confluence Server/DC + Cloud: pages, CQL search, labels, markdown round-trip |

Install the other two depending on the client you use: `npx @nevzatcirak/jira-mcp` · `npx @nevzatcirak/confluence-mcp`

## ✨ Features

| Area | What ships |
|---|---|
| 🧩 Tool registry | Manifest-driven registration with per-tool `providers` + `readOnly` flags |
| ⚙️ Config | Full env-based config with structured problems (the server never crashes on bad config) |
| 🌐 REST client | Token/Basic auth, custom headers, timeouts, normalized error codes |
| 📄 Pagination | Normalized `PageMeta` (`isLastPage`, `nextPageStart`, cursor seam for Cloud) |
| 🔁 Writes | Optimistic-locking retry wrapper (re-fetch + 1 retry on `409`) |
| 📇 Output | `compact-card` projection helpers — raw payloads never reach the LLM |
| 🔎 Tools | **27 tools on both providers** (18 read + 11 on Server/DC, 17 read + 10 on Cloud) |

### 🔍 Discovery

| Tool | Purpose | Key parameters |
|---|---|---|
| `bb_get_projects` | List projects | `name?`, `limit`, `start` |
| `bb_get_project` | One project by key | `projectKey` |
| `bb_get_repositories` | List repositories of a project | `projectKey`, `name?`, `limit`, `start` |
| `bb_get_repository` | One repository (+ HTTP clone URL) | `projectKey`, `repositorySlug` |
| `bb_browse_repository` | Browse the file tree | `projectKey`, `repositorySlug`, `path?`, `at?`, `limit`, `start` |
| `bb_get_file_content` | Raw file content, truncated with stats | `projectKey`, `repositorySlug`, `path`, `at?`, `maxChars` |

### 🔎 Code search

| Tool | Purpose | Key parameters |
|---|---|---|
| `bb_search_code` | Lucene code search with modifiers | `query`, `project?`, `repo?`, `path?`, `ext?`, `limit`, `start` |

`query` examples: `"OptimisticLock"`, `"TODO fix path:src/core ext:ts"`, `"retry repo:PLAT/api"`.

### 📖 Pull-request reading

| Tool | Purpose | Key parameters |
|---|---|---|
| `bb_list_pull_requests` | List PRs | `state?` (OPEN\|MERGED\|DECLINED\|ALL), `direction?` (INCOMING\|OUTGOING), `author?` (client-side), `limit`, `start` |
| `bb_get_pull_request` | PR detail with reviewers | `pullRequestId`, `maxDescriptionChars?` |
| `bb_get_pull_request_changes` | File-level changes | `pullRequestId`, `limit`, `start` |
| `bb_get_pull_request_diff` | Per-file diff, smart truncation (head 60% + tail 40% + omission stats) | `pullRequestId`, `path?`, `maxCharsPerFile?` |
| `bb_get_pull_request_builds` | CI build statuses of the source head commit | `pullRequestId`, `limit`, `start` |

### 💬 Review reading

| Tool | Purpose | Key parameters |
|---|---|---|
| `bb_get_pr_comments_and_actions` | Review threads with severity (BLOCKER), tasks and resolution state; resolved threads hidden by default | `pullRequestId`, `severity?` (ALL\|NORMAL\|BLOCKER), `includeResolved?`, `includeReplies?`, `maxTextChars?` |

### 📥 Dashboard

| Tool | Purpose | Key parameters |
|---|---|---|
| `bb_get_dashboard_pull_requests` | Your pull requests by role | `role?` (AUTHOR\|REVIEWER\|PARTICIPANT), `state?` |
| `bb_get_inbox_pull_requests` | Your inbox pull requests | `limit`, `start` |

### 👤 Users, branches, commits

| Tool | Purpose | Key parameters |
|---|---|---|
| `bb_get_user` | User by slug, or name/email search | `userSlug?` or `filter?` |
| `bb_list_branches` | Branches with default-branch detection (`isDefault`) | `projectKey`, `repositorySlug`, `filter?` |
| `bb_list_commits` | Commits with client-side author filter | `since?`, `until?`, `author?`, `includeMerges?` |

All list tools return `{ items: [...], page: { size, limit, start, isLastPage, nextPageStart } }` — pass `start: nextPageStart` to fetch the next page (Server/DC). On Cloud, list tools additionally accept `page` (one-based) and return `page.nextCursor` (a string page number from the API's `next` URL) — pass `page: 2` to continue. When a client-side `author` filter is active, `page.warning` notes that matching items may exist on other pages.

## ✍️ Write tools

All write tools declare `readOnly: false` and vanish from the tool list under `BITBUCKET_READ_ONLY=true`. Errors are structured: `409 → CONFLICT`, `403 → AUTH_FAILED`, `404 → NOT_FOUND`.

### 🌿 Branch writes

| Tool | Purpose | Key parameters |
|---|---|---|
| `bb_create_branch` | Create a branch, optionally from a start point | `projectKey`, `repositorySlug`, `name`, `startPoint?` |
| `bb_delete_branch` | Delete a branch; refuses the default branch with `DELETE_REFUSED` | `projectKey`, `repositorySlug`, `name` |

### 🔀 Pull-request lifecycle

| Tool | Purpose | Key parameters |
|---|---|---|
| `bb_create_pull_request` | Open a PR; supports forks (`fromProjectKey`/`fromRepositorySlug`); pre-fills reviewers from the required-reviewers service when available, otherwise notes that reviewers must be added manually | `projectKey`, `repositorySlug`, `title`, `fromBranch`, `toBranch`, `description?`, `reviewers?` |
| `bb_update_pull_request` | Update title/description/target branch — optimistic locking with one automatic `409` retry | `pullRequestId`, `title?`, `description?`, `toBranch?` |
| `bb_can_merge_pull_request` | Merge veto analysis: `canMerge`, `conflicted`, `vetoes[]` | `pullRequestId` |
| `bb_merge_pull_request` | Merge with message + strategy (`merge-commit` \| `squash` \| `fast-forward`); **never auto-retries** on `409` — re-check `bb_can_merge_pull_request` first | `pullRequestId`, `message?`, `strategy?` |
| `bb_decline_pull_request` | Decline with optional message | `pullRequestId`, `message?` |
| `bb_reopen_pull_request` | Reopen a declined PR — optimistic locking | `pullRequestId` |

### 💬 Review writes

| Tool | Purpose | Key parameters |
|---|---|---|
| `bb_post_pull_request_comment` | PR-level or inline comment (`file`+`line`, `startLine` for multiline suggestion blocks); `severity=BLOCKER` also opens a task; `pending=true` drafts | `pullRequestId`, `text`, `file?`, `line?`, `startLine?`, `severity?`, `taskText?`, `pending?` |
| `bb_update_pull_request_comment` | Edit text/severity, resolve the thread (`state=RESOLVED`), reopen/close a task (`taskId`+`taskState`) — optimistic locking | `pullRequestId`, `commentId`, `text?`, `severity?`, `state?`, `taskId?`, `taskState?` |
| `bb_submit_pull_request_review` | Submit a verdict (`APPROVED` \| `NEEDS_WORK` \| `UNAPPROVED`); best-effort publishes pending draft comments; reviewer identity auto-resolved (userSlug → session user → single participant → `userFilter`) | `pullRequestId`, `verdict`, `userSlug?`, `userFilter?` |

## 📦 Installation

**npx (no install):**

```bash
npx @nevzatcirak/bitbucket-mcp --version
```

**Global install:**

```bash
npm install -g @nevzatcirak/bitbucket-mcp
bitbucket-mcp --version
```

**From source:**

```bash
git clone https://github.com/nevzatcirak/bitbucket-mcp.git
cd bitbucket-mcp
npm install
npm run build && node dist/index.js --version
```

## ⚙️ Configuration

| Variable | Provider | Required | Description |
|---|---|---|---|
| `BITBUCKET_PROVIDER` | both | — | `server` (default, Server/DC) or `cloud` (REST 2.0) |
| `BITBUCKET_URL` | server | ✅ | Base URL, no trailing slash — e.g. `https://bitbucket.example.com` |
| `BITBUCKET_URL` | cloud | — | Optional REST 2.0 base override; defaults to `https://api.bitbucket.org/2.0` |
| `BITBUCKET_TOKEN` | both | A | Token auth → `Authorization: Bearer` (Server/DC PAT, Cloud OAuth/workspace token) |
| `BITBUCKET_USERNAME` | both | B | Credential auth (with `BITBUCKET_PASSWORD`) → `Authorization: Basic` |
| `BITBUCKET_PASSWORD` | both | A or B | See `BITBUCKET_USERNAME` (Cloud: app password) |
| `BITBUCKET_CLOUD_EMAIL` | cloud | A | Atlassian account email (with `BITBUCKET_CLOUD_API_TOKEN`) → `Basic base64(email:token)` |
| `BITBUCKET_CLOUD_API_TOKEN` | cloud | A | [API token](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `BITBUCKET_READ_ONLY` | both | — | `true` hides all write tools from the MCP client |
| `BITBUCKET_CUSTOM_HEADERS` | both | — | Comma-separated `Name: Value` pairs appended to every request |

**Auth matrix (exactly one credential set per provider):**

| Provider | Option A | Option B | Option C |
|---|---|---|---|
| Server / Data Center | `BITBUCKET_TOKEN` (PAT → Bearer) | `BITBUCKET_USERNAME` + `BITBUCKET_PASSWORD` (Basic) | — |
| Cloud | `BITBUCKET_CLOUD_EMAIL` + `BITBUCKET_CLOUD_API_TOKEN` (Basic) | `BITBUCKET_TOKEN` (OAuth/workspace token → Bearer) | `BITBUCKET_USERNAME` + `BITBUCKET_PASSWORD` (app password → Basic) |

Missing configuration never crashes the server: problems are logged at startup and the affected tools answer with a structured `CONFIG_MISSING` error.

### Provider mapping (Cloud)

Tool parameters stay stable across providers — on Cloud the `projectKey` parameter is translated to a **workspace slug**:

- **Pagination:** Cloud uses `pagelen` + one-based `page`; listings return `page.nextCursor` (the follow-up page number from the API's `next` URL). Pass `page: <nextCursor>` to continue.
- **No optimistic lock:** Cloud has no `version` field — `bb_update_pull_request` / comment updates are single partial PUTs (last write wins); the Server/DC 409-retry wrapper is bypassed.
- **Merge strategies:** translated `merge-commit → merge_commit`, `fast-forward → fast_forward` (squash is identical).
- **Mergeability:** Cloud has no veto API — `bb_can_merge_pull_request` derives `canMerge` from the PR state + the conflicts pre-check.
- **Review verdicts:** Cloud approvals always act as the authenticated user; `NEEDS_WORK` maps to the `request-changes` endpoint; `userSlug` must match the configured account.
- **Draft comments:** Cloud has none — `pending: true` is rejected with `VALIDATION`.
- **BLOCKER severity:** Cloud comments have no severity field — the text is prefixed with `[BLOCKER]` (detected back by `bb_get_pr_comments_and_actions`) and a real Cloud task is anchored to the comment.
- **No Cloud equivalent:** `bb_get_inbox_pull_requests` and `bb_reopen_pull_request` (Cloud declined PRs cannot be reopened) stay Server/DC-only; `since`/`until` commit ranges and `direction` on PR lists are ignored on Cloud.

### Tool × provider matrix

| Tool | Server/DC | Cloud |
|---|:-:|:-:|
| `bb_get_projects` | ✅ projects | ✅ workspaces |
| `bb_get_project` | ✅ | ✅ workspace |
| `bb_get_repositories` / `bb_get_repository` | ✅ | ✅ |
| `bb_browse_repository` / `bb_get_file_content` | ✅ | ✅ |
| `bb_search_code` | ✅ Lucene modifiers (`project:` `repo:` `path:` `ext:`) | ✅ workspace-scoped, `repo:` only |
| `bb_list_branches` / `bb_list_commits` | ✅ | ✅ (since/until ignored; merges filtered client-side) |
| `bb_list_pull_requests` / `bb_get_pull_request` | ✅ | ✅ (direction ignored) |
| `bb_get_pull_request_changes` / `bb_get_pull_request_diff` | ✅ per-file compaction | ✅ whole-diff truncation |
| `bb_get_pull_request_builds` | ✅ build-status API | ✅ commit statuses |
| `bb_get_pr_comments_and_actions` | ✅ activities | ✅ comments + tasks (`[BLOCKER]` tag) |
| `bb_get_dashboard_pull_requests` | ✅ | ✅ `GET /pullrequests?role=` |
| `bb_get_inbox_pull_requests` | ✅ | ❌ server-only |
| `bb_get_user` | ✅ slug or filter search | ✅ slug; filter → authenticated account |
| `bb_create_branch` / `bb_delete_branch` | ✅ branch-admin service | ✅ refs/branches |
| `bb_create_pull_request` | ✅ (+ required-reviewers prefill) | ✅ (explicit reviewers only) |
| `bb_update_pull_request` | ✅ optimistic lock | ✅ partial PUT |
| `bb_can_merge_pull_request` | ✅ veto API | ✅ state + conflicts |
| `bb_merge_pull_request` / `bb_decline_pull_request` | ✅ | ✅ |
| `bb_reopen_pull_request` | ✅ | ❌ server-only (no Cloud reopen) |
| `bb_post_pull_request_comment` | ✅ (+ pending drafts) | ✅ (pending rejected) |
| `bb_update_pull_request_comment` | ✅ optimistic lock | ✅ resolve/unresolve + tasks |
| `bb_submit_pull_request_review` | ✅ identity auto-resolved | ✅ self-only; NEEDS_WORK → request-changes |

## 🔌 MCP client configuration

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "bitbucket": {
      "command": "npx",
      "args": ["-y", "@nevzatcirak/bitbucket-mcp"],
      "env": {
        "BITBUCKET_URL": "https://bitbucket.example.com",
        "BITBUCKET_PROVIDER": "server",
        "BITBUCKET_TOKEN": "<your-personal-access-token>",
        "BITBUCKET_READ_ONLY": "false"
      }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "bitbucket": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@nevzatcirak/bitbucket-mcp"],
      "env": {
        "BITBUCKET_URL": "https://bitbucket.example.com",
        "BITBUCKET_PROVIDER": "server",
        "BITBUCKET_USERNAME": "<user>",
        "BITBUCKET_PASSWORD": "<password>"
      }
    }
  }
}
```

**OpenCode** (`opencode.json`):

```json
{
  "mcp": {
    "bitbucket": {
      "type": "local",
      "command": [
        "npx", "-y", "@nevzatcirak/bitbucket-mcp"
      ],
      "environment": {
        "BITBUCKET_URL": "https://bitbucket.example.com",
        "BITBUCKET_PROVIDER": "server",
        "BITBUCKET_TOKEN": "<your-personal-access-token>"
      }
    }
  }
}
```

**Bitbucket Cloud** (Claude Desktop example — no `BITBUCKET_URL` needed):

```json
{
  "mcpServers": {
    "bitbucket-cloud": {
      "command": "npx",
      "args": ["-y", "@nevzatcirak/bitbucket-mcp"],
      "env": {
        "BITBUCKET_PROVIDER": "cloud",
        "BITBUCKET_CLOUD_EMAIL": "<atlassian-account-email>",
        "BITBUCKET_CLOUD_API_TOKEN": "<api-token>",
        "BITBUCKET_READ_ONLY": "false"
      }
    }
  }
}
```

## 🧪 Tool usage examples

```text
▸ "Show the open pull requests on repo 'platform/api', 10 per page"
  → bb_list_pull_requests { projectKey: "PLAT", repositorySlug: "api", state: "OPEN", start: 0, limit: 10 }

  {
    "items": [
      { "id": 101, "title": "Add pagination helper", "state": "OPEN",
        "author": "dev-one", "fromBranch": "feature/x", "toBranch": "main" }
    ],
    "page": { "size": 10, "start": 0, "isLastPage": false, "nextPageStart": 10 }
  }
```

```text
▸ "What did the review say about PR 101?"
  → bb_get_pr_comments_and_actions { projectKey: "PLAT", repositorySlug: "api", pullRequestId: 101 }
  → threads with severity, tasks and replies; resolved threads hidden by default
```

```text
▸ "Show me the diff of PR 101"
  → bb_get_pull_request_diff { projectKey: "PLAT", repositorySlug: "api", pullRequestId: 101 }
  → per-file compact diffs: added/removed counts, head/tail preview, omission stats
```

```text
> "Update the branch restriction to require 2 approvals"   (upcoming write phase)
  → write flow with optimistic locking: fetch version → apply → on 409, re-fetch + retry once
```

## 🚦 Read-only mode

Set `BITBUCKET_READ_ONLY=true` and every write tool disappears from the advertised tool list — not merely errors at call time. Ideal for read-only automation or shared agents.

## 🔒 Optimistic locking

Write flows that target versioned resources use a shared wrapper:

1. Fetch the current resource (including its `version`).
2. Apply the mutation with that version.
3. On `409 Conflict`: re-fetch, re-apply — exactly **one** automatic retry.
4. Any other failure surfaces as a structured error with a stable code (`AUTH_FAILED`, `NOT_FOUND`, `VALIDATION`, `CONFLICT`, `UPSTREAM_ERROR`, …).

## 🗺️ Roadmap

- [x] **Phase 0** — foundation: config, REST client, registry, pagination, compact cards, optimistic-lock wrapper, CI + publish pipelines
- [x] **Phase 1** — Server/DC read tools: repositories, branches, commits, code search, pull requests, reviews, dashboard
- [x] **Phase 2** — Server/DC write tools with optimistic locking (branches, PR lifecycle, comments/tasks, review verdicts)
- [x] **Phase 3** — Cloud adapter (REST 2.0): workspaces/repositories/PRs/branches/comments, cursor pagination, Cloud auth (API token / OAuth / app password)

## 🛠️ Development

```bash
npm install
npm run build      # tsc → dist/
npm test           # vitest (tests are colocated with sources)
npm run lint       # eslint
npm run check:org  # CI guard: rejects real organization references in sources
```

Project layout:

```text
src/
├── index.ts                 # stdio entry point
├── version.ts               # name + version single source
├── core/                    # deployment-agnostic layer
│   ├── config.ts            # env config → { config, problems }
│   ├── restClient.ts        # fetch wrapper + RestError normalization
│   ├── provider.ts          # provider seam + pagination styles
│   ├── pagination.ts        # pageQuery / pageMeta / extractPageItems
│   ├── compactCard.ts       # compact-card projection
│   ├── optimisticLock.ts    # 409 → re-fetch → retry-once wrapper
│   ├── errors.ts            # structured MCP error results
│   └── json.ts              # safe JSON accessors
├── providers/
│   ├── server/              # Server/DC adapter (REST 1.0)
│   └── cloud/               # Cloud adapter (REST 2.0)
└── tools/
    ├── registry.ts          # manifest-driven tool registration
    ├── server/              # shared tool manifests + Server/DC handlers
    └── cloud/               # Cloud handler forks (REST 2.0)
```

## 🚀 Publishing

Publishing is a manual GitHub Actions trigger (**Publish → Run workflow**). The workflow guards the package name, runs the full gate (lint, tests, build, organization-reference guard) and publishes `@nevzatcirak/bitbucket-mcp` to npm with `NPM_TOKEN`.

## 📄 License

MIT — see [LICENSE](LICENSE).

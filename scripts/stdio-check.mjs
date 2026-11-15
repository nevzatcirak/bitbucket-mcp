#!/usr/bin/env node
/**
 * End-to-end stdio check: spawns dist/index.js as a real MCP stdio server and
 * speaks JSON-RPC to it.
 *   run 1 (default env)  : tools/list → 29 tools incl. writes; one read tools/call
 *   run 2 (READ_ONLY=true): tools/list → 18 tools, no write tools
 * Never prints secrets or the host name.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

function loadDotEnv() {
  const raw = readFileSync(new URL("../.env", import.meta.url), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}
loadDotEnv();

function rpcSession(env, requests) {
  return new Promise((resolve, reject) => {
    const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const childStdout = child.stdout;
    const childStdin = child.stdin;
    const rl = createInterface({ input: childStdout });
    const pending = new Map();
    let nextId = 1;

    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    });
    child.stderr.on("data", () => { /* startup logs — ignored */ });
    child.on("error", reject);

    (async () => {
      try {
        const send = (method, params) =>
          new Promise((res, rej) => {
            const id = nextId++;
            const timeout = setTimeout(() => rej(new Error(`timeout on ${method}`)), 30_000);
            pending.set(id, (msg) => {
              clearTimeout(timeout);
              res(msg);
            });
            childStdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
          });

        const results = [];
        for (const r of requests) {
          const msg = await send(r.method, r.params);
          results.push({ label: r.label, msg });
        }
        child.kill();
        resolve(results);
      } catch (err) {
        child.kill();
        reject(err);
      }
    })();
  });
}

const listParams = { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "stdio-check", version: "0.0.0" } };
const WRITE_TOOLS = [
  "bb_create_branch", "bb_delete_branch", "bb_create_pull_request", "bb_update_pull_request",
  "bb_can_merge_pull_request", "bb_merge_pull_request", "bb_decline_pull_request",
  "bb_reopen_pull_request", "bb_post_pull_request_comment", "bb_update_pull_request_comment",
  "bb_submit_pull_request_review",
];

// Run 1: normal mode.
const run1 = await rpcSession({}, [
  { label: "initialize", method: "initialize", params: listParams },
  { label: "initialized", method: "notifications/initialized", params: {} },
  { label: "tools/list", method: "tools/list", params: {} },
  { label: "tools/call list-branches", method: "tools/call", params: { name: "bb_list_branches", arguments: { projectKey: "KAPI", repositorySlug: "kapi-authn", limit: 10, start: 0 } } },
]);
const init1 = run1[0].msg.result ?? {};
const names1 = run1[2].msg.result?.tools?.map((t) => t.name) ?? [];
console.log(`run 1 (read-write): initialize ok=${Boolean(init1.serverInfo)}, tools/list=${names1.length}`);
const writesVisible = WRITE_TOOLS.filter((w) => names1.includes(w));
console.log(`  write tools advertised: ${writesVisible.length}/11`);
const call1 = run1[3].msg.result;
const branches = JSON.parse(call1?.content?.[0]?.text ?? "{}");
console.log(`  tools/call bb_list_branches: ${branches.items?.length ?? "?"} branch(es), isError=${call1?.isError ?? false}`);

// Run 2: read-only mode.
const run2 = await rpcSession({ BITBUCKET_READ_ONLY: "true" }, [
  { label: "initialize", method: "initialize", params: listParams },
  { label: "initialized", method: "notifications/initialized", params: {} },
  { label: "tools/list", method: "tools/list", params: {} },
]);
const names2 = run2[2].msg.result?.tools?.map((t) => t.name) ?? [];
const leaked = WRITE_TOOLS.filter((w) => names2.includes(w));
console.log(`run 2 (BITBUCKET_READ_ONLY=true): tools/list=${names2.length}, write tools leaked=${leaked.length === 0 ? "none" : leaked.join(",")}`);

const ok = names1.length === 29 && writesVisible.length === 11 && names2.length === 18 && leaked.length === 0;
console.log(ok ? "stdio check: PASS" : "stdio check: FAIL");
process.exit(ok ? 0 : 1);

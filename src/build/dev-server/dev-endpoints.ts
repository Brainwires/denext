// Dev-only endpoints and their guards: the cross-origin gate every dev endpoint shares,
// the dev black-box log/state endpoints, the async debounced type-check, and the
// open-in-editor endpoint (in-project files only).

import { basename, fromFileUrl, resolve } from "@std/path";
import { browserLogEvent, type DevEventKind } from "../dev-events.ts";
import { denoExecutable } from "../bundle.ts";
import { isCompat } from "./compat.ts";
import { enrichFrame, pushError } from "./reload.ts";
import type { DevState } from "./state.ts";

/**
 * Is `request` allowed to reach a dev-only endpoint? Defeats a cross-origin page a
 * developer visits from reaching the dev reload/HMR channel — or the editor-launch
 * endpoint — while `deno task dev` runs (cf. CVE-2025-48068).
 *
 * A cross-site request is rejected via `Sec-Fetch-Site` FIRST: a browser stamps every
 * request with it, and crucially a cross-origin **subresource** load (`<img>`, `<script>`,
 * `<link>`) sends `Sec-Fetch-Site: cross-site` but **no `Origin` header** — so the old
 * "missing Origin ⇒ allow" path was bypassable by such a load. Only after that (header
 * absent — curl/tests, or a browser too old to send it) do we fall back to the `Origin`
 * allowlist, still allowing a missing Origin for non-browser clients.
 */
export function devOriginAllowed(request: Request, url: URL, allowed: string[]): boolean {
  // A present Sec-Fetch-Site is authoritative: same-origin allowed, anything else
  // (cross-site/same-site/none) refused — this is what closes the Origin-less
  // cross-site subresource GET that could otherwise reach a state-changing endpoint.
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite) return secFetchSite === "same-origin";
  const origin = request.headers.get("origin");
  if (!origin) return true; // curl / tests / pre-Sec-Fetch browser — no cross-origin risk
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false; // malformed Origin
  }
  if (host === url.host) return true; // same-origin
  const hostname = host.split(":")[0];
  return allowed.some((a) => a === origin || a === host || a === hostname);
}

/**
 * The editor launch command + args for `file:line:column`, or `null` when no editor
 * can be resolved. Honors `DENEXT_EDITOR` / `VISUAL` / `EDITOR` (default: VS Code's
 * `code`), and shapes the args per editor family so the cursor lands on the line.
 * Pure (no spawn) so it's unit-testable.
 */
export function editorCommand(
  file: string,
  line: number,
  column: number,
  env: (k: string) => string | undefined = Deno.env.get,
): { cmd: string; args: string[] } | null {
  const cmd = env("DENEXT_EDITOR") || env("VISUAL") || env("EDITOR") || "code";
  const base = basename(cmd).toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
  if (/^(code|code-insiders|codium|vscodium|cursor|windsurf|positron)$/.test(base)) {
    return { cmd, args: ["--goto", `${file}:${line}:${column}`] };
  }
  if (/^(subl|sublime_text|sublime|atom)$/.test(base)) {
    return { cmd, args: [`${file}:${line}:${column}`] };
  }
  if (/^(webstorm|idea|pycharm|goland|rider|phpstorm|clion|rubymine|fleet)$/.test(base)) {
    return { cmd, args: ["--line", String(line), "--column", String(column), file] };
  }
  if (/^(vim|nvim|nano|hx|helix|kak|micro|emacs|emacsclient)$/.test(base)) {
    return { cmd, args: [`+${line}`, file] }; // terminal editors — best-effort
  }
  return { cmd, args: [file] };
}

/** Whether `p` is `dir` itself or a path under it (both already normalized/absolute). */
function withinDir(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir + "/");
}

/** Launch the editor for `file:line:column`; returns whether the spawn started. */
function spawnEditor(file: string, line: number, column: number): boolean {
  const resolved = editorCommand(file, line, column);
  if (!resolved) return false;
  try {
    new Deno.Command(resolved.cmd, { args: resolved.args, stdout: "null", stderr: "null" }).spawn();
    return true;
  } catch {
    return false;
  }
}

/** POST /_denext/dev-log — record a browser-reported console/error line in the black box. */
export async function devLogResponse(st: DevState, request: Request): Promise<Response> {
  try {
    const event = browserLogEvent(await request.json());
    if (event) st.devEvents.record(event);
  } catch { /* malformed body — ignore */ }
  return new Response(null, { status: 204 });
}

const EVENT_KINDS: readonly DevEventKind[] = ["error", "console", "request", "hmr"];

/** GET /_denext/dev-state — the recent dev events (server errors + browser console). */
export function devStateResponse(st: DevState, url: URL): Response {
  const kindParam = url.searchParams.get("kind") as DevEventKind | null;
  const kind = kindParam && EVENT_KINDS.includes(kindParam) ? kindParam : undefined;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 500);
  return Response.json({
    events: st.devEvents.snapshot({ kind, limit }),
    total: st.devEvents.size,
  });
}

/** Run `deno check` on `files`; the stderr text when it fails, else null (or on spawn failure). */
async function runTypeCheck(st: DevState, files: string[]): Promise<string | null> {
  const args = ["check", "--quiet"];
  if (st.paths.configPath.startsWith(st.paths.projectDir)) {
    args.push("--config", st.paths.configPath);
  }
  // `--` before the file list so a source path beginning with `-` can't be misparsed as a
  // flag (paths are watcher-sourced, not attacker-controlled, but this keeps the spawn robust).
  args.push("--", ...files);
  try {
    const { code, stderr } = await new Deno.Command(denoExecutable(), {
      args,
      cwd: st.paths.projectDir,
      stdout: "null",
      stderr: "piped",
    }).output();
    if (code === 0) return null;
    return new TextDecoder().decode(stderr).trim() || null;
  } catch {
    return null; // couldn't spawn `deno check` — skip silently, never block the loop
  }
}

/**
 * Dev-loop type-checking: `deno check` runs async + debounced off the render path on a
 * source edit; a failure surfaces in the overlay (with a codeframe) instead of reaching the
 * browser silently. A monotonic token drops a stale run when a newer edit lands. Skipped
 * for compat/drop-in apps: `deno check` on the raw npm-React source doesn't match the
 * next-compat build's rewritten module graph, so it would false-positive.
 */
export function typeCheck(st: DevState, changedPaths: string[]): void {
  if (Deno.env.get("DENEXT_DEV_TYPECHECK") === "0") return;
  const files = changedPaths.filter((p) => /\.(ts|tsx)$/.test(p) && !p.includes("/.denext/"));
  if (files.length === 0) return;
  const token = ++st.typeCheckToken;
  void (async () => {
    if (await isCompat(st)) return;
    const text = await runTypeCheck(st, files);
    if (token !== st.typeCheckToken) return; // superseded by a newer edit
    if (text === null) return; // clean — this edit's refresh/reload already cleared any overlay
    pushError(st, {
      title: "Type error",
      message: text.split("\n").slice(0, 24).join("\n"),
      stack: "",
      ...enrichFrame(st, text),
    });
  })();
}

/**
 * Resolve a request's `file` param to an absolute path that is a real file **inside the
 * project**, or `null` when it isn't — never open an arbitrary path on the host. Symlinks
 * are resolved and containment RE-verified against the real project root: an in-project
 * symlink pointing outside (project/x -> /etc/passwd) passes the lexical prefix check but
 * must not be opened.
 */
function resolveInProjectFile(st: DevState, file: string): string | null {
  let abs: string;
  try {
    abs = file.startsWith("file://") ? fromFileUrl(file) : resolve(file);
  } catch {
    return null;
  }
  if (!withinDir(abs, st.paths.projectDir)) return null;
  let real: string, realRoot: string;
  try {
    real = Deno.realPathSync(abs);
    realRoot = Deno.realPathSync(st.paths.projectDir);
  } catch {
    return null; // not found / unreadable
  }
  if (!withinDir(real, realRoot)) return null;
  try {
    return Deno.statSync(real).isFile ? real : null;
  } catch {
    return null;
  }
}

/** Open a source file in the developer's editor (dev-only, in-project paths only). */
export function openInEditorResponse(st: DevState, params: URLSearchParams): Response {
  const abs = resolveInProjectFile(st, params.get("file") ?? "");
  if (!abs) return new Response("bad or out-of-project file", { status: 400 });
  const line = Number(params.get("line") ?? "1") || 1;
  const column = Number(params.get("column") ?? "1") || 1;
  const launched = spawnEditor(abs, line, column);
  return new Response(launched ? "ok" : "no editor", { status: launched ? 200 : 501 });
}

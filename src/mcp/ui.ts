// The `denext ui` tools of `denext mcp`: every UI panel's actions as an MCP tool, run through the
// UI's own server so an agent gets exactly the safety model a browser does.
//
// The bridge starts `denext ui --no-open --port 0 --json` as a CHILD process (the UI never runs
// inside the MCP server, which may have evaluated project code) and talks to its `/api/…` JSON
// twins over 127.0.0.1: it presents the launch token once (the handshake), holds the session
// cookie, and sends every mutation with a same-origin `Origin` and the CSRF token derived from
// that cookie, so the loopback, handshake, origin, CSRF and `--read-only` gates of
// ../ui/security.ts and ../ui/server.ts all apply unchanged.
//
// On top of them, a two-step confirm: a request that changes something (any method but GET) is
// sent only as a preview (`op: "preview"`, which the panels answer with what would change) or
// with `apply: true`. `denext mcp --ui-read-only` starts the UI with `--read-only`, which refuses
// every mutation.

import { denoExecutable } from "../build/deno-executable.ts";
import { cliInvocation } from "../ui/proc.ts";
import { deriveCsrf, UI_COOKIE, UI_CSRF_HEADER } from "../ui/security.ts";
import { panelOf, UI_PANELS, type UiPanel } from "../ui/panels.ts";
import type { Tool } from "./tools.ts";

/** How `denext mcp` launches the UI (`--ui-read-only`, `--ui-offline`). */
export interface UiBridgeOptions {
  /** Start the UI with `--read-only`: every mutation is refused. */
  readonly readOnly?: boolean;
  /** Start the UI with `--offline`. */
  readonly offline?: boolean;
}

/** One request to a panel's JSON twin. */
export interface UiCall {
  /** The UI path (without `/api`): a panel's root or a page under it. */
  readonly path: string;
  /** `GET` (default), `POST` or `DELETE`. */
  readonly method: string;
  /** Query parameters. */
  readonly query?: Readonly<Record<string, string>>;
  /** Form fields of a mutation (a string array repeats the field). */
  readonly fields?: Readonly<Record<string, string | readonly string[]>>;
  /** How long a streamed run (a task, a verb) may take before it is stopped. */
  readonly timeoutMs?: number;
}

/** What a UI call answered. */
export interface UiReply {
  /** The HTTP status. */
  readonly status: number;
  /** The JSON body, or the streamed run's lines joined, or the raw text. */
  readonly text: string;
}

/** The longest a streamed run is read before the MCP stops it. */
const DEFAULT_STREAM_MS = 120_000;
/** The most streamed output kept for the reply. */
const MAX_STREAM_CHARS = 200_000;

/** A running `denext ui` child and the session the bridge holds on it. */
export class UiBridge {
  #child: Deno.ChildProcess | null = null;
  #origin = "";
  #cookie = "";
  #csrf = "";
  #starting: Promise<void> | null = null;

  constructor(
    private readonly dir: string,
    private readonly options: UiBridgeOptions = {},
    private readonly argv: () => string[] = () => [denoExecutable(), ...cliInvocation({ dir })],
  ) {}

  /** The UI's origin once started (`http://127.0.0.1:<port>`). */
  get origin(): string {
    return this.#origin;
  }

  /** Start the child and run the handshake, once. */
  start(): Promise<void> {
    return this.#starting ??= this.#start().catch((error) => {
      this.#starting = null;
      this.stop();
      throw error;
    });
  }

  async #start(): Promise<void> {
    const [command, ...prefix] = this.argv();
    const flags = ["--no-open", "--port", "0", "--json"];
    if (this.options.readOnly) flags.push("--read-only");
    if (this.options.offline) flags.push("--offline");
    this.#child = new Deno.Command(command, {
      args: [...prefix, "ui", this.dir, ...flags],
      cwd: this.dir,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const launch = await firstJsonLine(this.#child.stdout);
    // Keep draining whatever else it prints, so a full pipe never stalls it.
    this.#child.stdout.pipeTo(new WritableStream()).catch(() => {});
    const url = new URL(launch.url);
    if (url.hostname !== "127.0.0.1") throw new Error(`denext ui bound ${url.host}, not loopback`);
    this.#origin = url.origin;
    // The handshake: the launch token, once, for the session cookie (a separate secret).
    const res = await fetch(url, { redirect: "manual" });
    await res.body?.cancel();
    const secret = cookieValue(res.headers.get("set-cookie"), UI_COOKIE);
    if (res.status !== 302 || secret === null) throw new Error("denext ui refused the handshake");
    this.#cookie = `${UI_COOKIE}=${secret}`;
    this.#csrf = await deriveCsrf(secret);
  }

  /**
   * Call a panel's JSON twin.
   *
   * @param call The path, method, query and form fields.
   * @returns The status and the body (a streamed run's lines, joined).
   */
  async request(call: UiCall): Promise<UiReply> {
    await this.start();
    const url = new URL(`/api${call.path}`, this.#origin);
    for (const [k, v] of Object.entries(call.query ?? {})) url.searchParams.set(k, v);
    const mutation = call.method !== "GET";
    const res = await fetch(url, {
      method: call.method,
      headers: this.#headers(mutation),
      body: mutation ? formBody(call.fields) : undefined,
      redirect: "manual",
    });
    return { status: res.status, text: await replyBody(res, call.timeoutMs) };
  }

  /** The session cookie, and for a change the same-origin `Origin` and the CSRF token. */
  #headers(mutation: boolean): Headers {
    const headers = new Headers({ cookie: this.#cookie, accept: "application/json" });
    if (mutation) {
      headers.set("origin", this.#origin);
      headers.set(UI_CSRF_HEADER, this.#csrf);
    }
    return headers;
  }

  /** Stop the child (idempotent). */
  stop(): void {
    try {
      this.#child?.kill("SIGTERM");
    } catch { /* already gone */ }
    this.#child = null;
  }
}

/** A change's form body (a string array repeats the field). */
function formBody(fields: UiCall["fields"]): URLSearchParams {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields ?? {})) {
    for (const item of typeof v === "string" ? [v] : v) body.append(k, item);
  }
  return body;
}

/** A reply's text: a streamed run's lines, a redirect's target, or the body. */
async function replyBody(res: Response, timeoutMs?: number): Promise<string> {
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return await readStream(res, timeoutMs);
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    return `→ ${res.headers.get("location") ?? "(no location)"}`;
  }
  return await res.text();
}

/** The first line of `stream` parsed as the `denext ui --json` launch record. */
async function firstJsonLine(stream: ReadableStream<Uint8Array>): Promise<{ url: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (!buf.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("denext ui exited before it printed its URL");
      buf += decoder.decode(value, { stream: true });
      if (buf.length > 65_536) throw new Error("denext ui printed no launch record");
    }
  } finally {
    reader.releaseLock();
  }
  for (const line of buf.split("\n")) {
    try {
      const record = JSON.parse(line);
      if (typeof record?.url === "string") return record;
    } catch { /* not the record */ }
  }
  throw new Error("denext ui printed no launch record");
}

/** The value of cookie `name` in a `Set-Cookie` header, or null. */
function cookieValue(header: string | null, name: string): string | null {
  const m = new RegExp(`(?:^|,\\s*)${name}=([^;,\\s]+)`).exec(header ?? "");
  return m ? m[1] : null;
}

/** A streamed run's `data:` lines, read until it closes or `timeoutMs` passes (then stopped). */
async function readStream(res: Response, timeoutMs = DEFAULT_STREAM_MS): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const timer = setTimeout(() => reader.cancel().catch(() => {}), timeoutMs);
  let raw = "";
  let stopped = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      if (raw.length > MAX_STREAM_CHARS * 2) raw = raw.slice(-MAX_STREAM_CHARS);
    }
  } catch {
    stopped = true;
  } finally {
    clearTimeout(timer);
  }
  const lines = raw.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
  const closed = lines.at(-1)?.startsWith("— ") === true;
  if (!closed || stopped) lines.push(`— stopped by denext mcp after ${timeoutMs} ms`);
  return lines.join("\n");
}

/**
 * The UI pages whose POST really previews when `op` is not `"apply"` (they write only on
 * `op=apply`). Every other change — a page that ignores `op` (`/tasks/run`), acts at once
 * (`/dev`, `/setup`, `/commands`) or writes on a field of its own (`/docker`'s `confirm`) — needs
 * `apply: true`, whatever `op` it carries.
 */
const PREVIEW_PAGES: ReadonlySet<string> = new Set([
  "/generate",
  "/database/rows",
  "/database/policies",
  "/database/migrations",
  "/database/storage",
  "/database/users",
  "/database/realtime",
]);

/** Whether `call` is a preview its page honours (so it changes nothing). */
function isHonouredPreview(call: UiCall): boolean {
  if (call.method !== "POST" || call.fields?.op !== "preview") return false;
  if (!PREVIEW_PAGES.has(call.path)) return false;
  // Setting a user's password runs at once: its preview would carry the password back.
  return !(call.path === "/database/users" && call.fields?.action === "password");
}

/** Why a call is refused before it is sent, or null when it may go. */
export function uiCallRefusal(
  panel: UiPanel,
  call: UiCall,
  apply: boolean,
): string | null {
  if (!/^\/[A-Za-z0-9/_-]*$/.test(call.path) || call.path.includes("//")) {
    return `path must be a UI path such as ${panel.path} (letters, digits, - _ /)`;
  }
  if (panelOf(call.path)?.path !== panel.path) {
    return `${call.path} is not a page of the ${panel.id} panel (${panel.path}…)`;
  }
  if (!["GET", "POST", "DELETE"].includes(call.method)) return "method must be GET, POST or DELETE";
  if (call.method === "GET" || apply) return null;
  if (isHonouredPreview(call)) return null;
  return `${call.method} ${call.path} changes the project. Send it as a preview first ` +
    `(fields.op = "preview", where the panel offers one: it answers with what would change), ` +
    `then call again with apply: true to make the change.`;
}

/** One bridge per project directory, for the life of the MCP server. */
const bridges = new Map<string, UiBridge>();
let bridgeOptions: UiBridgeOptions = {};

/**
 * Configure how the bridges launch the UI (`denext mcp --ui-read-only` / `--ui-offline`). Applies
 * to bridges started afterwards.
 *
 * @param options The UI launch options.
 */
export function setUiBridgeOptions(options: UiBridgeOptions): void {
  bridgeOptions = options;
}

/** Stop every UI child this server started (the MCP server is exiting). */
export function stopUiBridges(): void {
  for (const bridge of bridges.values()) bridge.stop();
  bridges.clear();
}

/** The bridge for `dir`, started on first use. */
function bridgeFor(dir: string): UiBridge {
  let bridge = bridges.get(dir);
  if (!bridge) {
    bridge = new UiBridge(dir, bridgeOptions);
    bridges.set(dir, bridge);
  }
  return bridge;
}

/** The form fields of a tool call (strings, or arrays of strings). */
function fieldsOf(raw: unknown): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) out[k] = v.map(String);
    else if (v !== undefined && v !== null) out[k] = String(v);
  }
  return out;
}

/** The query parameters of a tool call. */
function queryOf(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) if (v !== undefined && v !== null) out[k] = String(v);
  return out;
}

const CALL_SCHEMA = {
  path: {
    type: "string",
    description: "The page (without /api): the panel's root (default) or a page under it",
  },
  method: { type: "string", enum: ["GET", "POST", "DELETE"], description: "Default GET" },
  query: { type: "object", description: "Query parameters (a GET's filters, a page's state)" },
  fields: {
    type: "object",
    description: "The form fields a POST / DELETE sends, as the panel's form names them " +
      '(`op: "preview"` asks a panel that offers one for the change without making it)',
  },
  apply: {
    type: "boolean",
    description: "Required to send a change that is not a preview",
  },
  timeoutMs: { type: "number", description: "A streamed run's limit (default 120000)" },
  dir: { type: "string", description: "Project directory (default: .)" },
};

/** A tool's reply: the status line, then the body. */
function replyText(call: UiCall, reply: UiReply): { text: string; isError?: boolean } {
  const ok = reply.status < 400;
  return {
    text: `${call.method} ${call.path} → ${reply.status}\n${reply.text}`,
    ...(ok ? {} : { isError: true }),
  };
}

/** The tool for one panel. */
function panelTool(panel: UiPanel, projectDir: (raw: unknown) => string): Tool {
  return {
    name: `denext_ui_${panel.id}`,
    description: `denext ui — ${panel.lead} Calls the panel's JSON twin (/api${panel.path}…) ` +
      "through the running UI's own security chain. GET reads it (and lists what its forms " +
      'take); a change is sent as a preview (fields.op = "preview") or with apply: true.',
    inputSchema: { type: "object", properties: CALL_SCHEMA },
    run: async (args) => {
      const method = typeof args.method === "string" ? args.method.toUpperCase() : "GET";
      const call: UiCall = {
        path: typeof args.path === "string" && args.path ? args.path : panel.path,
        method,
        query: queryOf(args.query),
        fields: fieldsOf(args.fields),
        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
      };
      const refusal = uiCallRefusal(panel, call, args.apply === true);
      if (refusal) return { text: refusal, isError: true };
      return replyText(call, await bridgeFor(projectDir(args.dir)).request(call));
    },
  };
}

/** The overview: the project, the UI's state and every path it serves. */
function overviewTool(projectDir: (raw: unknown) => string): Tool {
  return {
    name: "denext_ui_overview",
    description:
      "denext ui — the project's overview (name, pinned denext, dev server, read-only) " +
      "and every path the UI serves; each panel has its own denext_ui_* tool.",
    inputSchema: {
      type: "object",
      properties: { dir: { type: "string", description: "Project directory (default: .)" } },
    },
    run: async (args) => {
      const call: UiCall = { path: "/overview", method: "GET" };
      return replyText(call, await bridgeFor(projectDir(args.dir)).request(call));
    },
  };
}

/**
 * The `denext ui` tools: the overview, and one per panel (../ui/panels.ts).
 *
 * @param projectDir Resolves the `dir` argument to a project directory.
 * @returns The tools.
 */
export function uiTools(projectDir: (raw: unknown) => string): readonly Tool[] {
  return [overviewTool(projectDir), ...UI_PANELS.map((panel) => panelTool(panel, projectDir))];
}

/** The tool names {@linkcode uiTools} registers (the `ui` group of `--disable`). */
export const UI_TOOL_NAMES: readonly string[] = [
  "denext_ui_overview",
  ...UI_PANELS.map((panel) => `denext_ui_${panel.id}`),
];

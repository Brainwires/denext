// Make Loopy say something: posts to the running app's inbox with the token from its inbox file.
//
//   deno run --allow-read --allow-env --allow-net=127.0.0.1 scripts/loopy-say.ts "Build passed" --mood success
//   … "Deploy now?" --action yes:Deploy --action no:Later --wait     # prints the pressed id
//   echo '{"hook_event_name":"Stop","cwd":"/src/app"}' | … --from-hook  # a Claude Code hook
//
// Flags: --mood neutral|thinking|attention|success, --action <id>:<label> (up to three),
// --timeout <ms> (0: until closed), --wait (hold until a button is pressed; prints its id, or
// nothing), --from-hook (build the message from a Claude Code hook's JSON on stdin),
// --inbox <file> (default: the app's data folder; `LOOPY_INBOX` too). Exits 1 when Loopy isn't
// running or refuses the message, with the reason on stderr.

import { inboxFilePath } from "../inbox/paths.ts";
import { readInbox } from "../inbox/store.ts";
import type { LoopyAction, SayRequest } from "../lib/messages.ts";
import type { LoopyMood } from "../lib/loopy-machine.ts";

/** Parsed command line. */
export interface SayArgs {
  readonly request: SayRequest | null;
  readonly fromHook: boolean;
  readonly inbox: string | null;
}

/** A usage error. */
export class UsageError extends Error {}

/** What the flags have set so far. */
interface Flags {
  mood?: LoopyMood;
  timeoutMs?: number;
  wait: boolean;
  fromHook: boolean;
  inbox: string | null;
  actions: LoopyAction[];
}

/** `<id>:<label>` as an action. */
function action(spec: string): LoopyAction {
  const colon = spec.indexOf(":");
  if (colon <= 0) throw new UsageError("--action takes <id>:<label>");
  return { id: spec.slice(0, colon), label: spec.slice(colon + 1) };
}

/** The flags that take a value, and what each sets. */
const VALUE_FLAGS: Record<string, (f: Flags, v: string) => void> = {
  "--mood": (f, v) => (f.mood = v as LoopyMood),
  "--timeout": (f, v) => (f.timeoutMs = Number(v)),
  "--inbox": (f, v) => (f.inbox = v),
  "--action": (f, v) => f.actions.push(action(v)),
};

/** The switches, and what each sets. */
const SWITCHES: Record<string, (f: Flags) => void> = {
  "--wait": (f) => (f.wait = true),
  "--from-hook": (f) => (f.fromHook = true),
};

/** Apply flag `args[i]` (and its value); the index of the last argument used. */
function applyFlag(f: Flags, args: readonly string[], i: number): number {
  const name = args[i];
  const sw = Object.hasOwn(SWITCHES, name) ? SWITCHES[name] : undefined;
  if (sw) {
    sw(f);
    return i;
  }
  const set = Object.hasOwn(VALUE_FLAGS, name) ? VALUE_FLAGS[name] : undefined;
  if (!set) throw new UsageError(`unknown flag ${name}`);
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${name} needs a value`);
  set(f, value);
  return i + 1;
}

/** The message the flags and words describe. */
function requestOf(text: string, f: Flags): SayRequest {
  return {
    text,
    ...(f.mood ? { mood: f.mood } : {}),
    ...(f.actions.length ? { actions: f.actions } : {}),
    ...(f.timeoutMs !== undefined ? { timeoutMs: f.timeoutMs } : {}),
    ...(f.wait ? { wait: true } : {}),
  };
}

/** Parse the command line (the text may be several words). */
export function parseArgs(args: readonly string[]): SayArgs {
  const words: string[] = [];
  const f: Flags = { wait: false, fromHook: false, inbox: null, actions: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) i = applyFlag(f, args, i);
    else words.push(args[i]);
  }
  const text = words.join(" ").trim();
  if (!text && !f.fromHook) throw new UsageError("say what? (text, or --from-hook)");
  return { request: text ? requestOf(text, f) : null, fromHook: f.fromHook, inbox: f.inbox };
}

/** The last path segment of `dir` (either separator). */
function baseName(dir: string): string {
  return dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? dir;
}

/**
 * The message for a Claude Code hook's input (`hook_event_name` and its fields): a
 * `Notification` (needs approval, or waiting for input) points, a `Stop` (the turn finished)
 * celebrates. `null` for an event Loopy has nothing to say about.
 */
export function hookMessage(input: unknown): SayRequest | null {
  if (typeof input !== "object" || input === null) return null;
  const { hook_event_name: event, message, cwd } = input as Record<string, unknown>;
  const project = typeof cwd === "string" && cwd ? baseName(cwd) : "";
  if (event === "Notification") {
    const text = typeof message === "string" && message.trim()
      ? message.trim()
      : "Claude Code needs you.";
    return { text: (project ? `${project}: ${text}` : text).slice(0, 500), mood: "attention" };
  }
  if (event === "Stop") {
    return { text: `Claude Code finished${project ? ` in ${project}` : ""}.`, mood: "success" };
  }
  return null;
}

/** Send `request` to the inbox in `file`; the response body (or a thrown reason). */
export async function send(
  file: string,
  request: SayRequest,
): Promise<{ id: string; action?: string | null }> {
  const info = await readInbox(file);
  if (!info) throw new Error(`no inbox file at ${file}: is Loopy running?`);
  let res: Response;
  try {
    res = await fetch(`${info.url}/api/loopy/say`, {
      method: "POST",
      headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    throw new Error(`Loopy isn't answering at ${info.url}: is it running?`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Loopy refused (${res.status}): ${body.error ?? res.statusText}`);
  return body;
}

if (import.meta.main) {
  try {
    const args = parseArgs(Deno.args);
    let request = args.request;
    if (args.fromHook) {
      const input = await new Response(Deno.stdin.readable).text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(input);
      } catch { /* not JSON: nothing to say */ }
      request = hookMessage(parsed) ?? request;
    }
    if (request) {
      const out = await send(args.inbox ?? inboxFilePath(), request);
      if (request.wait && out.action) console.log(out.action);
    }
  } catch (e) {
    console.error(`loopy-say: ${e instanceof Error ? e.message : e}`);
    Deno.exit(1);
  }
}

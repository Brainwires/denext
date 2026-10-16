/**
 * Handoff and Spotlight for the `app` capability: the page's current user activity
 * (`Deno.desktop.userActivity`, macOS `NSUserActivity`; runtime 2.9.7-denext.20) and the activities
 * the user continues (Handoff from another device, a Spotlight result). Windows and Linux have
 * none: `setUserActivity` and `clearUserActivity` answer `{ applied: false }` there, as they do
 * under a runtime without the API.
 *
 * Continued activities are PULLED like the app's clicks (an `activity` signal, then
 * `takeActivities`), and kept across page loads until the page takes them: the one that launched
 * the app arrives before any page subscribes.
 *
 * Runtime-only (imported by the `app` capability, never a client bundle).
 *
 * @module
 */

import { type DesktopCapability, DesktopCapError } from "../extension.ts";
import type { DesktopAppApi, DesktopContinuedUserActivity } from "../launch-events.ts";
import { createPullQueue } from "./queue.ts";

/** The longest activity type / title / keyword accepted. */
const MAX_SHORT = 256;
/** The longest URL accepted. */
const MAX_URL = 8 * 1024;
/** The most `userInfo` entries and keywords accepted. */
const MAX_ENTRIES = 64;
/** The longest `userInfo` value accepted. */
const MAX_VALUE = 4096;
/** How many untaken continued activities are kept (oldest dropped past it). */
const MAX_QUEUED = 16;

/** A `validation` error. */
function invalid(message: string): DesktopCapError {
  return new DesktopCapError("validation", `userActivity: ${message}`);
}

/** A bounded string, or a `validation` error. */
function str(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length > max) {
    throw invalid(`${name} must be a string up to ${max} characters`);
  }
  return value;
}

/** An optional boolean. */
function flag(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw invalid(`${name} must be a boolean`);
  return value;
}

/** `userInfo`: string values only, bounded. */
function userInfoOf(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("userInfo must be an object of strings");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ENTRIES) throw invalid(`userInfo has at most ${MAX_ENTRIES} entries`);
  return Object.fromEntries(
    entries.map((
      [k, v],
    ) => [str(k, "a userInfo key", MAX_SHORT), str(v, "a userInfo value", MAX_VALUE)]),
  );
}

/** `keywords`: strings, bounded. */
function keywordsOf(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) {
    throw invalid(`keywords must be an array of at most ${MAX_ENTRIES} strings`);
  }
  return value.map((k) => str(k, "a keyword", MAX_SHORT));
}

/**
 * The page's activity, checked, in the runtime's shape (`Deno.desktop.UserActivity`).
 *
 * @param raw The wire activity.
 * @returns The activity. Throws `validation` for a bad field.
 */
export function userActivityOf(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) throw invalid("activity must be an object");
  const a = raw as Record<string, unknown>;
  const type = str(a.type, "type", MAX_SHORT);
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(type)) {
    throw invalid("type must be reverse-DNS (com.example.app.viewing)");
  }
  const url = a.url === undefined ? undefined : str(a.url, "url", MAX_URL);
  if (url !== undefined && !/^https?:\/\//i.test(url)) throw invalid("url must be http(s)");
  const out: Record<string, unknown> = { type };
  const title = a.title === undefined ? undefined : str(a.title, "title", MAX_SHORT);
  const fields: Record<string, unknown> = {
    title,
    url,
    userInfo: userInfoOf(a.userInfo),
    keywords: keywordsOf(a.keywords),
    handoff: flag(a.handoff, "handoff"),
    searchable: flag(a.searchable, "searchable"),
  };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  return out;
}

/** A continued activity's string `userInfo` values (anything else is dropped), bounded. */
function continuedInfo(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null) return {};
  const entries = Object.entries(raw).slice(0, MAX_ENTRIES);
  return Object.fromEntries(
    entries.filter(([, v]) => typeof v === "string" && v.length <= MAX_VALUE),
  );
}

/** A continued activity as the page takes it (untrusted: the OS hands it to the app). */
function continuedOf(raw: DesktopContinuedUserActivity | null | undefined) {
  const type = raw?.type;
  if (typeof type !== "string" || type === "" || type.length > MAX_SHORT) return undefined;
  const { title, url } = raw!;
  return {
    type,
    title: typeof title === "string" ? title.slice(0, MAX_SHORT) : "",
    url: typeof url === "string" && url.length <= MAX_URL ? url : null,
    userInfo: continuedInfo(raw!.userInfo),
  };
}

/** What {@linkcode createUserActivity} returns. */
export interface UserActivityHandle {
  /** `setUserActivity`, `clearUserActivity` and `takeActivities`. */
  readonly methods: DesktopCapability["methods"];
  /** Listen for continued activities (once). */
  install(): void;
}

/**
 * The `app` capability's user-activity methods and their listener.
 *
 * @param api The runtime's app API (`Deno.desktop`), when it has one.
 * @param emit Push an event to the page (the bridge's `emit`).
 * @returns The methods and their installer.
 */
export function createUserActivity(
  api: DesktopAppApi | undefined,
  emit: (cap: string, event: string, data: unknown) => void,
): UserActivityHandle {
  const queue = createPullQueue<NonNullable<ReturnType<typeof continuedOf>>>(
    () => emit("app", "activity", null),
    MAX_QUEUED,
  );
  let installed = false;
  const ua = () => typeof api?.userActivity?.set === "function" ? api.userActivity : undefined;
  return {
    methods: {
      setUserActivity: {
        handler: (args) => {
          const activity = userActivityOf((args as { activity?: unknown } | null)?.activity);
          const runtime = ua();
          return { applied: runtime ? runtime.set(activity) === true : false };
        },
      },
      clearUserActivity: {
        handler: () => ({ applied: ua()?.clear() === true }),
      },
      takeActivities: { handler: () => queue.take() },
    },
    install: () => {
      if (installed) return;
      installed = true;
      ua()?.onContinue((raw) => {
        const activity = continuedOf(raw);
        if (activity) queue.push(activity);
      });
    },
  };
}

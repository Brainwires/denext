/**
 * iOS Live Activities (ActivityKit) for `denext/mobile`: the web side of the
 * `DenextLiveActivity` plugin that `denext mobile add live-activity --name <Name>` installs.
 * A Live Activity is shown on the Lock Screen and in the Dynamic Island by the UI the generator
 * wrote for its name. It needs iOS 16.1 or later; on Android, on the web and in a shell without
 * the plugin every function rejects with code `unsupported`, except the ones that report
 * "nothing here" instead: {@linkcode liveActivityPushToStartToken} resolves `null`,
 * {@linkcode listLiveActivities} `[]`, and the `on…` listeners are never called.
 *
 * A server can update a running activity through APNs with its push token
 * ({@linkcode liveActivityPushToken}, {@linkcode onLiveActivityPushToken}) and, on iOS 17.2 and
 * later, start one remotely with the app's push-to-start token
 * ({@linkcode liveActivityPushToStartToken}, {@linkcode onLiveActivityPushToStartToken}). Both
 * need the push entitlement (`denext mobile add push`) and an APNs push with
 * `apns-push-type: liveactivity`.
 *
 * Nothing runs at import.
 *
 * @module
 */

import { listenerDisposer, type ListenerHandle, nativePlugin } from "./plugin.ts";

/**
 * The `code` on a Live Activity rejection:
 *
 * - `unsupported`: not iOS 16.1+ with the `DenextLiveActivity` plugin (Android, the web, an
 *   older iOS, or the plugin not installed);
 * - `disabled`: the user turned Live Activities off for the app;
 * - `invalid`: a bad name, attributes or state (not a JSON object);
 * - `not_found`: no running Live Activity has that id;
 * - `timeout`: {@linkcode liveActivityPushToken} or {@linkcode liveActivityPushToStartToken}
 *   got no token in time;
 * - `failed`: ActivityKit refused (too many activities, or no push entitlement for `push`).
 */
export type LiveActivityErrorCode =
  | "unsupported"
  | "disabled"
  | "invalid"
  | "not_found"
  | "timeout"
  | "failed";

/** The `Error` a Live Activity function rejects with. */
export interface LiveActivityError extends Error {
  /** Why it failed. */
  readonly code: LiveActivityErrorCode;
}

/** A JSON object: a Live Activity's attributes or state. */
export type LiveActivityValues = Readonly<Record<string, unknown>>;

/** Options for {@linkcode startLiveActivity}. */
export interface StartLiveActivityOptions {
  /**
   * Ask ActivityKit for a push token, so a server can update the activity through APNs
   * ({@linkcode liveActivityPushToken}). The app needs the push entitlement
   * (`denext mobile add push`); without it the start fails with code `failed`. Default `false`.
   */
  readonly push?: boolean;
}

/** Options for {@linkcode endLiveActivity}. */
export interface EndLiveActivityOptions {
  /** The final state to show while the activity stays on the Lock Screen. */
  readonly state?: LiveActivityValues;
  /**
   * `"immediate"` removes it from the Lock Screen at once; `"default"` (the default) lets iOS
   * keep the final state visible for a while; a `Date` removes it then (iOS caps the wait at
   * four hours).
   */
  readonly dismissal?: "default" | "immediate" | Date;
}

/** Options for {@linkcode liveActivityPushToken} and {@linkcode liveActivityPushToStartToken}. */
export interface LiveActivityTokenOptions {
  /** How long to wait for ActivityKit to issue the token, in milliseconds (default 10 000). */
  readonly timeoutMs?: number;
}

/** A running Live Activity, as {@linkcode listLiveActivities} reports it. */
export interface RunningLiveActivity {
  /** Its id (what {@linkcode startLiveActivity} returned). */
  readonly id: string;
  /** Its Live Activity name (`Delivery`). */
  readonly name: string;
}

/** A push token ActivityKit issued a running Live Activity. */
export interface LiveActivityPushTokenEvent {
  /** The activity's id. */
  readonly id: string;
  /** The token, as hex. */
  readonly token: string;
}

/** A push-to-start token ActivityKit issued the app (iOS 17.2+). */
export interface LiveActivityPushToStartToken {
  /** The token, as hex. */
  readonly token: string;
}

/** The JS face of the native plugin (Capacitor seeds a stub per registered method). */
interface LiveActivityPlugin {
  start(options: {
    name: string;
    attributes: string;
    state: string;
    push: boolean;
  }): Promise<{ id?: unknown } | undefined>;
  update(options: { id: string; state: string }): Promise<unknown>;
  end(
    options: { id: string; state?: string; dismissal: string; dismissalAt?: number },
  ): Promise<unknown>;
  pushToken(options: { id: string; timeoutMs: number }): Promise<{ token?: unknown } | undefined>;
}

/** The methods a plugin installed before push-to-start may lack, and its events. */
interface LiveActivityExtras {
  pushToStartToken(
    options: { timeoutMs: number },
  ): Promise<{ supported?: unknown; token?: unknown } | undefined>;
  list(): Promise<{ activities?: unknown } | undefined>;
  addListener(
    eventName: "pushToken" | "pushToStartToken",
    listener: (event: unknown) => void,
  ): ListenerHandle | Promise<ListenerHandle>;
}

const CODES: readonly string[] = [
  "unsupported",
  "disabled",
  "invalid",
  "not_found",
  "timeout",
  "failed",
] satisfies readonly LiveActivityErrorCode[];

/** Build a {@linkcode LiveActivityError}. */
function liveActivityError(code: LiveActivityErrorCode, message: string): LiveActivityError {
  const err = new Error(message) as Error & { code: LiveActivityErrorCode };
  err.name = "LiveActivityError";
  err.code = code;
  return err;
}

/** The plugin, or a rejection with code `unsupported`. */
function plugin(fn: string): LiveActivityPlugin {
  const found = nativePlugin<LiveActivityPlugin>("DenextLiveActivity", [
    "start",
    "update",
    "end",
    "pushToken",
  ]);
  if (!found) {
    throw liveActivityError(
      "unsupported",
      `${fn}: Live Activities need the iOS app with the DenextLiveActivity plugin ` +
        "(denext mobile add live-activity)",
    );
  }
  return found;
}

/** `value` as JSON text when it is a plain object; throws `invalid` otherwise. */
function objectJson(value: unknown, fn: string, what: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw liveActivityError("invalid", `${fn}: ${what} must be a JSON object`);
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  if (json === undefined) throw liveActivityError("invalid", `${fn}: ${what} is not JSON`);
  return json;
}

/** The plugin's `method` (one a plugin installed before it was added may lack), if present. */
function extra<K extends keyof LiveActivityExtras>(method: K): LiveActivityExtras | undefined {
  return nativePlugin<LiveActivityExtras>("DenextLiveActivity", [method]);
}

/** `options.timeoutMs` (default 10 000), checked. */
function checkTimeout(options: LiveActivityTokenOptions, fn: string): number {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!(timeoutMs >= 0) || !Number.isFinite(timeoutMs)) {
    throw liveActivityError("invalid", `${fn}: timeoutMs must be a non-negative number`);
  }
  return timeoutMs;
}

/** A non-empty string field of `value`. */
function stringField(value: unknown, key: string): string | undefined {
  const field = typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
  return typeof field === "string" && field !== "" ? field : undefined;
}

/** `id`, checked. */
function checkId(id: unknown, fn: string): string {
  if (typeof id !== "string" || id === "") {
    throw liveActivityError("invalid", `${fn}: id must be the id startLiveActivity returned`);
  }
  return id;
}

/** Run a native call, turning its rejection into a {@linkcode LiveActivityError}. */
async function call<T>(fn: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    const message = err instanceof Error ? err.message : String(err);
    throw liveActivityError(
      typeof code === "string" && CODES.includes(code) ? code as LiveActivityErrorCode : "failed",
      `${fn}: ${message}`,
    );
  }
}

/**
 * Start a Live Activity rendered by the UI `denext mobile add live-activity --name <name>`
 * generated (`<name>LiveActivity.swift`, which reads `context.attributes` and `context.state`).
 *
 * @param name The Live Activity name (its `--name`).
 * @param attributes Values fixed for the activity's life (a JSON object).
 * @param state The first dynamic state (a JSON object); an ActivityKit push's `content-state`
 * is the same object.
 * @param options `push` to get a push token.
 * @returns The activity id, for the other functions.
 * @throws {LiveActivityError} `unsupported`, `disabled`, `invalid` or `failed`.
 * @example
 * ```ts
 * import { startLiveActivity, updateLiveActivity } from "denext/mobile";
 *
 * const id = await startLiveActivity("Delivery", { order: "A-42" }, { title: "Packing", progress: 0.2 });
 * await updateLiveActivity(id, { title: "On the way", progress: 0.6 });
 * ```
 */
export async function startLiveActivity(
  name: string,
  attributes: LiveActivityValues,
  state: LiveActivityValues,
  options: StartLiveActivityOptions = {},
): Promise<string> {
  const fn = "startLiveActivity";
  if (typeof name !== "string" || !/^[A-Z][A-Za-z0-9]{0,63}$/.test(name)) {
    throw liveActivityError(
      "invalid",
      `${fn}: name must be a Live Activity name such as "Delivery"`,
    );
  }
  const request = {
    name,
    attributes: objectJson(attributes, fn, "attributes"),
    state: objectJson(state, fn, "state"),
    push: options.push === true,
  };
  const native = plugin(fn);
  const result = await call(fn, () => native.start(request));
  if (typeof result?.id !== "string") throw liveActivityError("failed", `${fn}: no activity id`);
  return result.id;
}

/**
 * Replace a running Live Activity's state.
 *
 * @param id The id {@linkcode startLiveActivity} returned.
 * @param state The new state (a JSON object).
 * @returns A promise that settles once ActivityKit has it.
 * @throws {LiveActivityError} `unsupported`, `invalid` or `not_found`.
 * @example
 * ```ts
 * import { updateLiveActivity } from "denext/mobile";
 *
 * await updateLiveActivity(id, { title: "Delivered", progress: 1 });
 * ```
 */
export async function updateLiveActivity(id: string, state: LiveActivityValues): Promise<void> {
  const fn = "updateLiveActivity";
  const request = { id: checkId(id, fn), state: objectJson(state, fn, "state") };
  const native = plugin(fn);
  await call(fn, () => native.update(request));
}

/**
 * End a Live Activity.
 *
 * @param id The id {@linkcode startLiveActivity} returned.
 * @param options A final state, and how soon it leaves the Lock Screen (or when, as a `Date`).
 * @returns A promise that settles once it has ended.
 * @throws {LiveActivityError} `unsupported`, `invalid` or `not_found`.
 * @example
 * ```ts
 * import { endLiveActivity } from "denext/mobile";
 *
 * await endLiveActivity(id, { state: { title: "Delivered" }, dismissal: "default" });
 * ```
 */
export async function endLiveActivity(
  id: string,
  options: EndLiveActivityOptions = {},
): Promise<void> {
  const fn = "endLiveActivity";
  const { dismissal } = options;
  if (dismissal instanceof Date && Number.isNaN(dismissal.getTime())) {
    throw liveActivityError("invalid", `${fn}: dismissal is an invalid Date`);
  }
  const request = {
    id: checkId(id, fn),
    ...(options.state === undefined ? {} : { state: objectJson(options.state, fn, "state") }),
    ...(dismissal instanceof Date
      ? { dismissal: "after", dismissalAt: dismissal.getTime() }
      : { dismissal: dismissal === "immediate" ? "immediate" : "default" }),
  };
  const native = plugin(fn);
  await call(fn, () => native.end(request));
}

/**
 * The ActivityKit push token of a Live Activity started with `{ push: true }`, as hex, for a
 * server to update it through APNs (`apns-push-type: liveactivity`, with a `content-state` in
 * the shape of the state object). It waits for the token when ActivityKit has not issued it yet.
 *
 * {@linkcode onLiveActivityPushToken} reports it, and every later one, as an event instead.
 *
 * @param id The id {@linkcode startLiveActivity} returned.
 * @param options `timeoutMs`: how long to wait (default 10 000).
 * @returns The token.
 * @throws {LiveActivityError} `unsupported`, `invalid`, `not_found` or `timeout`.
 * @example
 * ```ts
 * import { liveActivityPushToken, startLiveActivity } from "denext/mobile";
 *
 * const id = await startLiveActivity("Delivery", {}, { title: "Packing" }, { push: true });
 * await fetch("/api/live-activity", { method: "POST", body: await liveActivityPushToken(id) });
 * ```
 */
export async function liveActivityPushToken(
  id: string,
  options: LiveActivityTokenOptions = {},
): Promise<string> {
  const fn = "liveActivityPushToken";
  const timeoutMs = checkTimeout(options, fn);
  const request = { id: checkId(id, fn), timeoutMs };
  const native = plugin(fn);
  const result = await call(fn, () => native.pushToken(request));
  if (typeof result?.token !== "string") throw liveActivityError("timeout", `${fn}: no push token`);
  return result.token;
}

/**
 * The app's ActivityKit push-to-start token (iOS 17.2 and later), as hex: a server sends it an
 * APNs push (`apns-push-type: liveactivity`, `"event": "start"`,
 * `"attributes-type": "DenextActivityAttributes"`, `"attributes": { "name": <Live Activity
 * name>, "values": { … } }` and a `content-state` in the shape of the state object) to start a
 * Live Activity while the app is not running. It waits for the token when ActivityKit has not
 * issued it yet; {@linkcode onLiveActivityPushToStartToken} reports later ones. The app needs
 * the push entitlement (`denext mobile add push`), without which no token comes (`timeout`).
 *
 * @param options `timeoutMs`: how long to wait (default 10 000).
 * @returns `{ token }`, or `null` where push-to-start does not exist: below iOS 17.2, on
 * Android, on the web, or without the plugin (or with one installed before push-to-start).
 * @throws {LiveActivityError} `invalid` or `timeout`.
 * @example
 * ```ts
 * import { liveActivityPushToStartToken } from "denext/mobile";
 *
 * const start = await liveActivityPushToStartToken();
 * if (start) await fetch("/api/devices", { method: "POST", body: JSON.stringify(start) });
 * ```
 */
export async function liveActivityPushToStartToken(
  options: LiveActivityTokenOptions = {},
): Promise<LiveActivityPushToStartToken | null> {
  const fn = "liveActivityPushToStartToken";
  const timeoutMs = checkTimeout(options, fn);
  const native = extra("pushToStartToken");
  if (!native) return null;
  const result = await call(fn, () => native.pushToStartToken({ timeoutMs }));
  if (result?.supported === false) return null;
  const token = stringField(result, "token");
  if (token === undefined) throw liveActivityError("timeout", `${fn}: no push-to-start token`);
  return { token };
}

/** Listen to the plugin's `event`, handing each payload `parse` accepts to `callback`. */
function listen<T>(
  event: "pushToken" | "pushToStartToken",
  parse: (raw: unknown) => T | undefined,
  callback: (value: T) => void,
): () => void {
  const native = extra("addListener");
  if (!native) return () => {};
  return listenerDisposer(native.addListener(event, (raw) => {
    const value = parse(raw);
    if (value !== undefined) callback(value);
  }));
}

/**
 * Call `callback` with each push-to-start token ActivityKit issues the app (iOS 17.2 and later),
 * including the current one: a token issued before the first subscriber is kept for it. Send
 * each to your server, which replaces the one it had. Elsewhere it is never called.
 *
 * @param callback Called with `{ token }` (hex).
 * @returns A function that unsubscribes.
 * @example
 * ```ts
 * import { onLiveActivityPushToStartToken } from "denext/mobile";
 *
 * const stop = onLiveActivityPushToStartToken(({ token }) => void registerDevice({ token }));
 * ```
 */
export function onLiveActivityPushToStartToken(
  callback: (token: LiveActivityPushToStartToken) => void,
): () => void {
  return listen("pushToStartToken", (raw) => {
    const token = stringField(raw, "token");
    return token === undefined ? undefined : { token };
  }, callback);
}

/**
 * Call `callback` with each push token ActivityKit issues a running Live Activity: the first
 * one of an activity started with `{ push: true }` (or by a push-to-start push), and every
 * rotation after it. Tokens issued before the first subscriber are kept for it. Elsewhere it is
 * never called.
 *
 * @param callback Called with `{ id, token }` (the activity's id, the hex token).
 * @returns A function that unsubscribes.
 * @example
 * ```ts
 * import { onLiveActivityPushToken } from "denext/mobile";
 *
 * const stop = onLiveActivityPushToken(({ id, token }) => void sendActivityToken(id, token));
 * ```
 */
export function onLiveActivityPushToken(
  callback: (event: LiveActivityPushTokenEvent) => void,
): () => void {
  return listen("pushToken", (raw) => {
    const id = stringField(raw, "id");
    const token = stringField(raw, "token");
    return id === undefined || token === undefined ? undefined : { id, token };
  }, callback);
}

/**
 * The running Live Activities of the app (started here, earlier, or by a push-to-start push).
 *
 * @returns Their ids and names; `[]` on Android, on the web, below iOS 16.1, and without the
 * plugin (or with one installed before this function).
 * @throws {LiveActivityError} `failed` when the plugin errs.
 * @example
 * ```ts
 * import { endLiveActivity, listLiveActivities } from "denext/mobile";
 *
 * for (const { id } of await listLiveActivities()) await endLiveActivity(id);
 * ```
 */
export async function listLiveActivities(): Promise<RunningLiveActivity[]> {
  const native = extra("list");
  if (!native) return [];
  const result = await call("listLiveActivities", () => native.list());
  const items: unknown[] = Array.isArray(result?.activities) ? result.activities : [];
  return items.flatMap((item) => {
    const id = stringField(item, "id");
    const name = stringField(item, "name");
    return id === undefined || name === undefined ? [] : [{ id, name }];
  });
}

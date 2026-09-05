// Typed Server Actions (2.0 DX — the mutation half of network-boundary type safety).
//
// A denext Server Action is a `"use server"` export used as a `<form action>` via
// `useActionState`. By itself it takes raw `FormData` (untyped string blobs) and returns
// whatever — so a missing/mistyped field is a runtime error, and the result type doesn't
// flow to the component. `defineAction` fixes both: it validates `FormData` into a typed
// `input`, runs a typed `handler(input) => Out`, and returns a discriminated
// `ActionResult<Out>` whose `Out` is inferred all the way into `useActionState`.
//
//   // app/actions.ts
//   "use server";
//   import { defineAction } from "denext/server";
//   export const createPost = defineAction({
//     input: (f) => ({ title: String(f.title ?? "").trim() }),   // FormData fields → typed input
//     handler: async ({ title }) => {                            //   title: string
//       if (!title) throw new ActionValidationError("required", { title: "Title is required" });
//       const id = await db.posts.insert({ title });
//       return { id };                                           // Out inferred: { id: string }
//     },
//   });
//
//   // a client component
//   "use client";
//   import { useActionState } from "denext";
//   import { idleActionState } from "denext";
//   import { createPost } from "./actions.ts";
//   const [state, action, pending] = useActionState(createPost, idleActionState<{ id: string }>());
//   // state.ok ? state.data.id  ← typed        : state.fieldErrors?.title  ← typed
//
// `input` may be a plain function over the form fields, or any **Standard Schema**
// (Zod/Valibot/ArkType — `input: z.object({...})`) — zero denext dependency either way.

import { isControlSignal, toClientError } from "./error-boundary.ts";

/** The Standard Schema v1 surface (https://standardschema.dev) — validator-agnostic. */
export interface StandardSchemaV1<Output = unknown> {
  /** The Standard Schema properties: version, vendor, and the `validate` function. */
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardResult<Output> | Promise<StandardResult<Output>>;
  };
}

/** A Standard Schema validation result: a parsed `value`, or a list of `issues`. */
export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> };

/** One Standard Schema issue: a message and an optional path to the offending field. */
export interface StandardIssue {
  /** The human-readable validation message. */
  readonly message: string;
  /** The path to the offending field (its first segment keys `fieldErrors`). */
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

/** The result an action returns: `ok` carries the typed handler output, else an error. */
export type ActionResult<Out> =
  | { readonly ok: true; readonly data: Out }
  | {
    readonly ok: false;
    readonly error: string;
    /** Per-field validation messages, keyed by form field name. */
    readonly fieldErrors?: Readonly<Record<string, string>>;
    /**
     * Set when the handler threw a non-validation error: in production the `error` text is
     * generic and this opaque digest correlates it with the server log line.
     */
    readonly digest?: string;
  };

/** The form fields of a submission as a plain object (the default `input` shape). */
export type FormFields = Record<string, FormDataEntryValue>;

/** How an action validates `FormData` into its typed input: a function or a Standard Schema. */
export type InputSpec<In> =
  | ((fields: FormFields) => In | Promise<In>)
  | StandardSchemaV1<In>;

/** A typed action, shaped for `useActionState(action, initial)`. */
export type TypedAction<Out> = (
  prevState: ActionResult<Out>,
  formData: FormData,
) => Promise<ActionResult<Out>>;

/**
 * Throw this from an `input` parser (or a handler) to return per-field form errors.
 *
 * @param message The overall error message.
 * @param fieldErrors Per-field messages, keyed by form field name.
 */
export class ActionValidationError extends Error {
  /** Per-field messages, keyed by form field name. */
  readonly fieldErrors?: Readonly<Record<string, string>>;
  /**
   * Create a validation error carrying optional per-field messages.
   *
   * @param message The overall error message.
   * @param fieldErrors Per-field messages, keyed by form field name.
   */
  constructor(message: string, fieldErrors?: Record<string, string>) {
    super(message);
    this.name = "ActionValidationError";
    this.fieldErrors = fieldErrors;
  }
}

/** The initial `ActionResult` for `useActionState` — an idle (not-yet-submitted) state. */
export function idleActionState<Out>(): ActionResult<Out> {
  return { ok: false, error: "" };
}

/** Is this a Standard Schema (vs a plain parser function)? */
function isStandardSchema<In>(spec: InputSpec<In>): spec is StandardSchemaV1<In> {
  return typeof spec === "object" && spec !== null && "~standard" in spec;
}

/** Collect a Standard Schema's issues into per-field messages (top-level path key → message). */
function fieldErrorsFrom(issues: ReadonlyArray<StandardIssue>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const first = issue.path?.[0];
    const key = typeof first === "object" && first !== null
      ? String(first.key)
      : String(first ?? "");
    if (key && !(key in out)) out[key] = issue.message;
  }
  return out;
}

/** Validate the submission's fields into the typed input (throws {@link ActionValidationError}). */
async function parseInput<In>(spec: InputSpec<In> | undefined, formData: FormData): Promise<In> {
  const fields = Object.fromEntries(formData) as FormFields;
  if (!spec) return fields as In;
  if (!isStandardSchema(spec)) return await spec(fields);
  const result = await spec["~standard"].validate(fields);
  if (result.issues) {
    throw new ActionValidationError("Validation failed", fieldErrorsFrom(result.issues));
  }
  return result.value;
}

/**
 * Turn a thrown error into a failed {@link ActionResult}. A validation error carries its
 * message + field errors verbatim (they are authored for the user). Any other handler error
 * is REDACTED the way a render error is ({@link toClientError}): the client gets a generic
 * message + digest, the real error is logged server-side — `error.message` of a DB driver
 * or a stack must not reach the browser.
 */
function toFailure<Out>(err: unknown): ActionResult<Out> {
  if (err instanceof ActionValidationError) {
    return { ok: false, error: err.message, fieldErrors: err.fieldErrors };
  }
  const client = toClientError(err);
  return { ok: false, error: client.message, digest: client.digest };
}

/**
 * Define a typed Server Action. Put it in a `"use server"` module and pass it to
 * `useActionState`; denext dispatches the form submission to the server, where this runs.
 *
 * @param config `input` (optional) validates `FormData` into the typed input — a function
 *   over the form fields, or a Standard Schema (Zod/Valibot/…); omit it to receive the raw
 *   fields object. `handler` receives the validated input and returns the typed `Out`.
 * @returns An action `(prevState, formData) => Promise<ActionResult<Out>>` for `useActionState`.
 */
export function defineAction<Out, In = FormFields>(
  config: { input?: InputSpec<In>; handler: (input: In) => Out | Promise<Out> },
): TypedAction<Out> {
  return async (
    prevOrForm: ActionResult<Out> | FormData,
    maybeForm?: FormData,
  ): Promise<ActionResult<Out>> => {
    // Tolerate both call shapes: useActionState's (prevState, formData) and a bare (formData).
    const formData = (maybeForm instanceof FormData ? maybeForm : prevOrForm) as FormData;
    let input: In;
    try {
      input = await parseInput(config.input, formData);
    } catch (err) {
      return toFailure<Out>(err);
    }
    try {
      return { ok: true, data: await config.handler(input) };
    } catch (err) {
      // `redirect()` / `notFound()` / `forbidden()` / `unauthorized()` inside the handler
      // are control flow, not failures: the action pipeline turns them into the redirect /
      // boundary response.
      if (isControlSignal(err)) throw err;
      return toFailure<Out>(err);
    }
  };
}

// A 60-line Standard Schema (https://standardschema.dev) — enough for this demo, zero
// dependencies. Swap in Zod / Valibot / ArkType / TypeBox at will: `defineApi`,
// `defineSubscription`, `defineAction`, and `createChannel` accept any Standard Schema, and
// infer their input/output types through the spec's `types` slot.

import type { StandardIssue, StandardSchemaV1 } from "denext/server";

/** A schema that also carries its type for inference (`SchemaInput` / `SchemaOutput`). */
export type Schema<T> = StandardSchemaV1<T> & {
  "~standard": { types: { input: T; output: T } };
};

type Result<T> = { value: T } | { issues: StandardIssue[] };
type Check<T> = (v: unknown, path: string[]) => Result<T>;

function make<T>(check: Check<T>): Schema<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "typed-api-example",
      validate: (v) => check(v, []),
      types: undefined as unknown as { input: T; output: T },
    },
  };
}

const bad = (message: string, path: string[]): Result<never> => ({
  issues: [{ message, path }],
});

/** A non-empty string. */
export const string = (): Schema<string> =>
  make((v, path) =>
    typeof v === "string" && v.trim().length > 0
      ? { value: v }
      : bad("must be a non-empty string", path)
  );

/** A boolean. */
export const boolean = (): Schema<boolean> =>
  make((v, path) => typeof v === "boolean" ? { value: v } : bad("must be true or false", path));

/** One of the listed literals. */
export const oneOf = <const L extends readonly string[]>(
  ...values: L
): Schema<L[number]> =>
  make((v, path) =>
    typeof v === "string" && values.includes(v)
      ? { value: v as L[number] }
      : bad(`must be one of ${values.join(", ")}`, path)
  );

/** Absent (`undefined`) or valid. */
export const optional = <T>(inner: Schema<T>): Schema<T | undefined> =>
  make<T | undefined>((v, path) => v === undefined ? { value: undefined } : run(inner, v, path));

/** An object with exactly these fields; unknown keys are STRIPPED (a data-leak guard on responses). */
export const object = <F extends Record<string, Schema<unknown>>>(
  fields: F,
): Schema<{ [K in keyof F]: F[K] extends Schema<infer T> ? T : never }> =>
  make((v, path) => {
    if (typeof v !== "object" || v === null) {
      return bad("must be an object", path);
    }
    return collect(fields, v as Record<string, unknown>, path) as Result<never>;
  });

/** Validate each declared field; gather every issue, or build the stripped object. */
function collect(
  fields: Record<string, Schema<unknown>>,
  input: Record<string, unknown>,
  path: string[],
): Result<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const issues: StandardIssue[] = [];
  for (const [key, schema] of Object.entries(fields)) {
    place(out, issues, key, run(schema, input[key], [...path, key]));
  }
  return issues.length ? { issues } : { value: out };
}

/** One field's result: an issue list grows, a present value lands on the output. */
function place(
  out: Record<string, unknown>,
  issues: StandardIssue[],
  key: string,
  r: Result<unknown>,
): void {
  if ("issues" in r) issues.push(...r.issues);
  else if (r.value !== undefined) out[key] = r.value;
}

/** Run a nested schema synchronously (this demo's schemas are all sync), re-rooting its paths. */
function run<T>(schema: Schema<T>, v: unknown, path: string[]): Result<T> {
  const r = schema["~standard"].validate(v) as { value: T } | {
    issues: readonly StandardIssue[];
  };
  if (!("issues" in r)) return r;
  const issues = r.issues.map((i) => ({
    ...i,
    path: [...path, ...(i.path ?? []).map(String)],
  }));
  return { issues };
}

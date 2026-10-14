// `denext db lint`: the Supabase CLI's `db lint` — plpgsql_check over every PL/pgSQL function of
// the schemas when that extension is installed — plus built-in checks in the spirit of
// Supabase's database advisors, which need no extension:
//
//   rls_disabled            error    a table the API roles can reach has row-level security off
//   policy_rls_disabled     error    a table has policies, but RLS is off (they do nothing)
//   rls_no_policy           warning  RLS is on but there is no policy (every row is hidden)
//   function_search_path    warning  a function does not pin its search_path
//   security_definer_view   warning  a view runs as its owner (no security_invoker)
//   table_no_grants         warning  a table neither `anon` nor `authenticated` can reach
//
// `--level` sets the lowest level reported, `--fail-on` the level that exits 1 (default error).

import { type DbActionInput, schemasOf } from "./db-action.ts";

/** One finding. */
interface LintIssue {
  /** `error` or `warning`. */
  level: "error" | "warning";
  /** The check's name. */
  check: string;
  /** What it is about (`schema.table`, `schema.fn(args)`). */
  object: string;
  /** What is wrong, and how to fix it. */
  message: string;
}

const LEVELS = { warning: 1, error: 2 } as const;

/** A query whose rows are `{ object }` findings, with the issue's text. */
interface Check {
  check: string;
  level: LintIssue["level"];
  sql: string;
  message: (object: string) => string;
}

const ROLE_CAN_REACH = `(has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
    OR has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE'))`;

/** The built-in checks; `$1` is the schemas (a JSON array). */
const CHECKS: Check[] = [
  {
    check: "rls_disabled",
    level: "error",
    sql: `SELECT n.nspname || '.' || c.relname AS object FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname IN (SELECT json_array_elements_text($1::json)) AND NOT c.relrowsecurity
        AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated'))
        AND ${ROLE_CAN_REACH}`,
    message: (o) =>
      `${o} is reachable by the API roles with row-level security off: ` +
      `ALTER TABLE ${o} ENABLE ROW LEVEL SECURITY, then add policies`,
  },
  {
    check: "policy_rls_disabled",
    level: "error",
    sql: `SELECT DISTINCT n.nspname || '.' || c.relname AS object FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN (SELECT json_array_elements_text($1::json)) AND NOT c.relrowsecurity`,
    message: (o) => `${o} has policies but row-level security is off, so they do nothing`,
  },
  {
    check: "rls_no_policy",
    level: "warning",
    sql: `SELECT n.nspname || '.' || c.relname AS object FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname IN (SELECT json_array_elements_text($1::json)) AND c.relrowsecurity
        AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)`,
    message: (o) => `${o} has row-level security on and no policy: no row is visible to the API`,
  },
  {
    check: "function_search_path",
    level: "warning",
    sql: `SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid)
        || ')' AS object FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN (SELECT json_array_elements_text($1::json)) AND p.prokind IN ('f', 'p')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
        AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c
          WHERE c LIKE 'search_path=%')`,
    message: (o) =>
      `${o} has a mutable search_path: add SET search_path = '' (and qualify the names it uses)`,
  },
  {
    check: "security_definer_view",
    level: "warning",
    sql: `SELECT n.nspname || '.' || c.relname AS object FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'v' AND n.nspname IN (SELECT json_array_elements_text($1::json))
        AND NOT coalesce(c.reloptions, '{}') && ARRAY['security_invoker=true', 'security_invoker=on']`,
    message: (o) =>
      `${o} runs with its owner's rights, bypassing the caller's RLS: ` +
      `ALTER VIEW ${o} SET (security_invoker = on)`,
  },
  {
    check: "table_no_grants",
    level: "warning",
    sql: `SELECT n.nspname || '.' || c.relname AS object FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm') AND n.nspname IN (SELECT json_array_elements_text($1::json))
        AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated'))
        AND NOT ${ROLE_CAN_REACH}`,
    message: (o) =>
      `${o} has no grants for anon or authenticated, so the API cannot reach it ` +
      `(GRANT SELECT ON ${o} TO authenticated, when it should be)`,
  },
];

/** plpgsql_check over each PL/pgSQL function of the schemas. */
async function plpgsqlCheck(input: DbActionInput, schemas: string[]): Promise<LintIssue[] | null> {
  const installed = await input.sql.unsafe<{ found: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'plpgsql_check') AS found",
  );
  if (!installed[0]?.found) return null;
  const rows = await input.sql.unsafe<{ object: string; level: string; message: string }>(
    `SELECT p.oid::regprocedure::text AS object, r.level, r.message || coalesce(' (' || r.hint || ')', '')
        AS message
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang AND l.lanname = 'plpgsql'
      CROSS JOIN LATERAL plpgsql_check_function_tb(p.oid) r
      WHERE n.nspname IN (SELECT json_array_elements_text($1::json)) AND p.prorettype <> 'trigger'::regtype`,
    [JSON.stringify(schemas)],
  );
  return rows.map((row) => ({
    level: /error/i.test(row.level) ? "error" : "warning",
    check: "plpgsql_check",
    object: row.object,
    message: row.message,
  }));
}

/**
 * Every finding for `schemas`.
 *
 * @param input The action's input.
 * @param schemas The schemas.
 * @returns The findings, and whether plpgsql_check ran.
 */
async function lintDatabase(
  input: DbActionInput,
  schemas: string[],
): Promise<{ issues: LintIssue[]; plpgsqlCheck: boolean }> {
  const issues: LintIssue[] = [];
  const checked = await plpgsqlCheck(input, schemas);
  if (checked) issues.push(...checked);
  for (const check of CHECKS) {
    const rows = await input.sql.unsafe<{ object: string }>(check.sql, [
      JSON.stringify(schemas),
    ]);
    for (const row of rows) {
      issues.push({
        level: check.level,
        check: check.check,
        object: row.object,
        message: check.message(row.object),
      });
    }
  }
  return { issues, plpgsqlCheck: checked !== null };
}

function levelOf(value: unknown, fallback: keyof typeof LEVELS | "none"): number {
  const name = typeof value === "string" && value ? value : fallback;
  if (name === "none") return Infinity;
  if (!(name in LEVELS)) throw new TypeError(`unknown level ${JSON.stringify(name)}`);
  return LEVELS[name as keyof typeof LEVELS];
}

/**
 * `denext db lint`.
 *
 * @param input The action's input.
 */
export async function lintAction(input: DbActionInput): Promise<void> {
  const schemas = schemasOf(input.ctx);
  const min = levelOf(input.ctx.flags.level, "warning");
  const failAt = levelOf(input.ctx.flags["fail-on"], "error");
  const result = await lintDatabase(input, schemas);
  const shown = result.issues.filter((issue) => LEVELS[issue.level] >= min);
  if (input.ctx.global.json) {
    input.io.log(JSON.stringify({ ...result, issues: shown }, null, 2));
  } else {
    if (!result.plpgsqlCheck) {
      input.io.log("(plpgsql_check is not installed: function bodies were not checked)");
    }
    if (!shown.length) input.io.log(`No issues found in ${schemas.join(", ")}.`);
    for (const issue of shown) {
      input.io.log(`  ${issue.level.padEnd(7)} ${issue.check.padEnd(22)} ${issue.message}`);
    }
  }
  if (result.issues.some((issue) => LEVELS[issue.level] >= failAt)) {
    throw new Error(`lint found issues at level ${failAt === 2 ? "error" : "warning"} or above`);
  }
}

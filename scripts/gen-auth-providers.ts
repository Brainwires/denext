/**
 * `deno task gen:auth-providers`: read every provider `@auth/core` ships at the pinned version
 * (`scripts/auth-providers/classify.ts`), turn each OAuth / OIDC one denext doesn't write by
 * hand into data (endpoints, scopes, token-endpoint authentication, and its `profile()` mapping,
 * traced), check the traced mapping against Auth.js's own `profile()` on sample profiles, and
 * write the manifest, the generated modules, the provider list and the `deno.json` exports.
 *
 * Needs the network (it imports `npm:@auth/core@<pinned>`). `--check` writes nothing and fails
 * when a checked-in file differs from what it would write.
 *
 * @module
 */

import { join } from "@std/path";
import {
  AUTHJS_CORE_VERSION,
  HAND_WRITTEN,
  NOT_PROVIDERS,
  type ProfileOverride,
  type ProviderRule,
  RULES,
  UNSUPPORTED,
} from "./auth-providers/classify.ts";
import {
  type ProviderManifest,
  providerModules,
  PROVIDERS_DIR,
  renderAll,
} from "./auth-providers/render.ts";
import {
  type GeneratedOption,
  type GeneratedSpec,
  mapProfile,
  type ProfileExpr,
} from "../src/compat/next-auth/providers/generated.ts";
import { OAUTH_CHECKS } from "../src/server/auth/oauth.ts";
import type { OAuthCheck } from "../src/server/auth/types.ts";

const ROOT = new URL("..", import.meta.url).pathname;
/** The manifest's path, repo-relative. */
export const MANIFEST = "scripts/auth-providers/manifest.json";

// deno-lint-ignore no-explicit-any
type Loose = any;

/** The sentinels the provider factories are called with. */
const SENTINEL = {
  clientId: "SENTINELCLIENTID",
  clientSecret: "SENTINELCLIENTSECRET",
  issuer: "https://sentinel-issuer.invalid",
};
const optionSentinel = (key: string) => `SENTINELOPT${key.toUpperCase()}X`;

/** Top-level keys of a provider definition the generator reads or may ignore. */
const KNOWN_KEYS = new Set([
  "id",
  "name",
  "type",
  "issuer",
  "wellKnown",
  "authorization",
  "token",
  "userinfo",
  "client",
  "checks",
  "idToken",
  "profile",
  "style",
  "options",
]);

/** Why a provider couldn't be generated. */
export class Unexpressible extends Error {}

/** Replace the sentinels in a string with `{issuer}`, `{clientId}` and option names. */
function templated(value: string, options: readonly string[]): string {
  let out = value.split(SENTINEL.issuer).join("{issuer}");
  out = out.split(SENTINEL.clientId).join("{clientId}");
  for (const key of options) out = out.split(optionSentinel(key)).join(`{${key}}`);
  if (out.includes(SENTINEL.clientSecret)) {
    throw new Unexpressible("puts the client secret in a URL or parameter");
  }
  return out;
}

/** An endpoint as `{ url, params }`. */
function endpointOf(value: Loose, what: string): { url?: string; params: Record<string, unknown> } {
  if (value === undefined) return { params: {} };
  if (typeof value === "string") return { url: value, params: {} };
  const fns = Object.keys(value).filter((k) => typeof value[k] === "function");
  if (fns.length) throw new Unexpressible(`${what}.${fns[0]}`);
  return {
    url: value.url === undefined ? undefined : String(value.url),
    params: value.params ?? {},
  };
}

/** Split a URL's query off: the bare URL, and its parameters (`scope` present but empty kept). */
function splitQuery(url: string): { base: string; query: Map<string, string> } {
  const at = url.indexOf("?");
  if (at < 0) return { base: url, query: new Map() };
  return { base: url.slice(0, at), query: new Map(new URLSearchParams(url.slice(at + 1))) };
}

// ---- profile tracing ----------------------------------------------------------------------

const OPEN = "\u0001";
const CLOSE = "\u0002";

/** A traced run: what each field resolved to, and every path read. */
interface Trace {
  fields: Record<string, ProfileExpr | undefined>;
  accessed: Set<string>;
}

/** A traced string as a template: literal text and the paths its tokens name. */
function templateOf(value: string): ProfileExpr {
  const parts: (string | string[])[] = [];
  for (const piece of value.split(new RegExp(`(${OPEN}[^${CLOSE}]*${CLOSE})`))) {
    if (piece.startsWith(OPEN)) parts.push(JSON.parse(piece.slice(1, -1)));
    else if (piece) parts.push(piece);
  }
  return { t: parts };
}

/** Whether `value` is a constant a mapping can carry. */
function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/** A field `profile()` returned, as an expression (`undefined` when it came out undefined). */
function fieldExpr(
  key: string,
  value: unknown,
  proxies: WeakMap<object, string[]>,
): ProfileExpr | undefined {
  const path = (typeof value === "function" || typeof value === "object") && value
    ? proxies.get(value)
    : undefined;
  if (path) return { p: path };
  if (typeof value === "string" && value.includes(OPEN)) return templateOf(value);
  if (value === undefined) return undefined;
  if (isScalar(value)) return { c: value };
  throw new Unexpressible(`profile() returns a non-scalar ${key}`);
}

/** A tracing proxy factory: each property read is a path; a path in `absent` reads `undefined`. */
function tracers(absent: Set<string>) {
  const proxies = new WeakMap<object, string[]>();
  const accessed = new Set<string>();
  const token = (path: string[]) => `${OPEN}${JSON.stringify(path)}${CLOSE}`;
  const primitive = new Set<string | symbol>([Symbol.toPrimitive, "toString", "valueOf"]);
  const tracer = (path: string[]): unknown => {
    const proxy: object = new Proxy(function () {}, {
      get(_, prop) {
        if (primitive.has(prop)) return () => token(path);
        if (typeof prop === "symbol" || prop === "then" || prop === "toJSON") return undefined;
        const next = JSON.stringify([...path, prop]);
        accessed.add(next);
        return absent.has(next) ? undefined : tracer([...path, prop]);
      },
      apply() {
        throw new Unexpressible(`profile() calls a method on ${path.join(".")}`);
      },
    });
    proxies.set(proxy, path);
    return proxy;
  };
  return { tracer, proxies, accessed };
}

/** Run `profile()` over tracing proxies: each field as a path, a template or a constant. */
async function traceOnce(profile: Loose, absent: Set<string>): Promise<Trace> {
  const { tracer, proxies, accessed } = tracers(absent);
  const result = await profile(tracer(["p"]), tracer(["t"]));
  const fields: Record<string, ProfileExpr | undefined> = {};
  for (const [key, value] of Object.entries(result ?? {})) {
    fields[key] = fieldExpr(key, value, proxies);
  }
  return { fields, accessed };
}

/** One field's `??` chain: read the path it resolved to as absent, and run again. */
async function traceChain(
  profile: Loose,
  field: string,
  first: ProfileExpr | undefined,
  accessed: Set<string>,
): Promise<ProfileExpr[]> {
  const chain: ProfileExpr[] = [];
  const absent = new Set<string>();
  let expr = first;
  while (expr && chain.length < 8) {
    chain.push(expr);
    if (!("p" in expr)) break;
    absent.add(JSON.stringify(expr.p));
    let next: Trace;
    try {
      next = await traceOnce(profile, absent);
    } catch (error) {
      if (error instanceof Unexpressible) throw error;
      break; // reading the absent path throws in Auth.js too: the chain ends here
    }
    for (const path of next.accessed) accessed.add(path);
    expr = next.fields[field];
  }
  return chain;
}

/** Trace every field's `??` chain. */
async function traceProfile(
  profile: Loose,
): Promise<{ mapping: Record<string, ProfileExpr[]>; accessed: Set<string> }> {
  const first = await traceOnce(profile, new Set());
  const accessed = new Set(first.accessed);
  const mapping: Record<string, ProfileExpr[]> = {};
  for (const [field, expr] of Object.entries(first.fields)) {
    const chain = await traceChain(profile, field, expr, accessed);
    if (chain.length) mapping[field] = chain;
  }
  return { mapping, accessed };
}

/** A concrete object holding a distinct string at each of `paths` (`["p", …]` / `["t", …]`). */
function sample(paths: string[][]): { p: Record<string, unknown>; t: Record<string, unknown> } {
  const roots = { p: {} as Record<string, unknown>, t: {} as Record<string, unknown> };
  const sorted = [...paths].sort((a, b) => b.length - a.length);
  for (const path of sorted) {
    let node = roots[path[0] as "p" | "t"] as Record<string, unknown>;
    for (const key of path.slice(1, -1)) {
      if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
      node = node[key] as Record<string, unknown>;
    }
    const leaf = path[path.length - 1];
    if (node[leaf] === undefined) node[leaf] = `v:${path.slice(1).join(".")}`;
  }
  return roots;
}

/** The paths that are leaves (not a prefix of another read path). */
function leaves(accessed: Set<string>): string[][] {
  const all = [...accessed].map((s) => JSON.parse(s) as string[]);
  return all.filter((path) =>
    !all.some((other) => other.length > path.length && path.every((key, i) => other[i] === key))
  );
}

/**
 * Check a mapping against Auth.js's `profile()` on sample profiles: every read path present,
 * each one absent in turn, and none present. A variant Auth.js itself throws on is skipped.
 */
async function crossCheck(
  id: string,
  profile: Loose,
  mapping: Record<string, ProfileExpr[]>,
  accessed: Set<string>,
  samples: readonly Record<string, unknown>[],
): Promise<void> {
  const paths = leaves(accessed);
  const variants = [paths, ...paths.map((_, i) => paths.filter((__, j) => j !== i)), []];
  const all = [
    ...variants.map(sample),
    ...samples.map((p) => ({ p: structuredClone(p), t: {} })),
  ];
  for (const roots of all) {
    let expected: Record<string, unknown>;
    try {
      expected = await profile(structuredClone(roots.p), structuredClone(roots.t));
    } catch {
      continue;
    }
    const actual = mapProfile(mapping, roots);
    const clean = (o: Record<string, unknown>) =>
      JSON.stringify(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)));
    if (clean(expected) !== clean(actual)) {
      throw new Error(
        `gen:auth-providers: ${id}'s traced profile mapping disagrees with Auth.js on ` +
          `${JSON.stringify(roots.p)}:\n  Auth.js ${clean(expected)}\n  traced  ${
            clean(actual)
          }\nAdd a profile override in scripts/auth-providers/classify.ts.`,
      );
    }
  }
}

// ---- extraction ---------------------------------------------------------------------------

/** Call the provider factory with sentinel options, recording what it reads. */
function callFactory(
  factory: (options: unknown) => Loose,
  options: Record<string, unknown>,
): { config: Loose; reads: Set<string> } {
  const reads = new Set<string>();
  const proxy = new Proxy({ ...options }, {
    get(target, key) {
      if (typeof key === "string") reads.add(key);
      return (target as Record<string | symbol, unknown>)[key];
    },
  });
  return { config: factory(proxy), reads };
}

/** Check the options a definition read: the credentials, the issuer and the declared ones. */
function checkReads(reads: Set<string>, optionNames: readonly string[]): void {
  for (const key of reads) {
    if (!(key in SENTINEL) && !optionNames.includes(key)) {
      throw new Unexpressible(`reads the \`${key}\` option`);
    }
  }
}

/** Check a definition's shape: OAuth / OIDC, no custom fetch, no key the generator can't read. */
function checkShape(c: Loose, ignore: ReadonlySet<string>): void {
  if (c.type !== "oauth" && c.type !== "oidc") throw new Unexpressible(`type "${c.type}"`);
  if (Object.getOwnPropertySymbols(c).length) throw new Unexpressible("a custom fetch");
  for (const key of Object.keys(c)) {
    if (!KNOWN_KEYS.has(key) && !ignore.has(key)) throw new Unexpressible(`the \`${key}\` key`);
  }
}

/** The token-endpoint authentication: Auth.js's default is HTTP Basic. */
function tokenAuthOf(client: Loose): GeneratedSpec["tokenAuth"] {
  const { token_endpoint_auth_method: method = "client_secret_basic", ...rest } = client ?? {};
  if (Object.keys(rest).length) throw new Unexpressible(`client.${Object.keys(rest)[0]}`);
  if (method !== "client_secret_basic" && method !== "client_secret_post") {
    throw new Unexpressible(`token_endpoint_auth_method "${method}"`);
  }
  return method;
}

/** The definition's own `checks`, when it names them (Auth.js's default otherwise). */
function checksOf(checks: unknown): OAuthCheck[] | undefined {
  if (checks === undefined) return undefined;
  const known = (c: unknown): c is OAuthCheck => OAUTH_CHECKS.includes(c as OAuthCheck);
  if (!Array.isArray(checks) || !checks.every(known)) {
    throw new Unexpressible(`checks ${JSON.stringify(checks)}`);
  }
  return [...checks];
}

/** `value` without the hooks the rules let denext do without (`token.conform`). */
function stripIgnored(value: Loose, what: string, ignore: ReadonlySet<string>): Loose {
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !ignore.has(`${what}.${k}`)));
}

/** One authorization parameter's value, as a template; `undefined` to leave it out. */
function paramValue(
  key: string,
  value: unknown,
  optionNames: readonly string[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Unexpressible(`authorization.params.${key}`);
  if (key === "response_type" && value === "code") return undefined;
  if (key === "response_mode" || key === "response_type") {
    throw new Unexpressible(`authorization.params.${key} "${value}"`);
  }
  return templated(value, optionNames);
}

/** The scopes (Auth.js adds `openid profile email` when the URL names none), and a scope option. */
function scopesOf(
  all: Map<string, unknown>,
  optionNames: readonly string[],
): { scopes: string[]; scopeOption?: string } {
  if (!all.has("scope")) return { scopes: ["openid", "profile", "email"] };
  const scope = all.get("scope");
  all.delete("scope");
  const option = optionNames.find((k) => scope === optionSentinel(k));
  if (option) return { scopes: [], scopeOption: option };
  return { scopes: typeof scope === "string" ? scope.split(" ").filter(Boolean) : [] };
}

/** The authorization endpoint: its bare URL, scopes and the other parameters. */
function authorizationOf(c: Loose, optionNames: readonly string[]) {
  const authorization = endpointOf(c.authorization, "authorization");
  const split = splitQuery(authorization.url ?? "");
  const all = new Map<string, unknown>([...split.query, ...Object.entries(authorization.params)]);
  const scopes = scopesOf(all, optionNames);
  const params: Record<string, string> = {};
  for (const [key, value] of all) {
    const template = paramValue(key, value, optionNames);
    if (template !== undefined) params[key] = template;
  }
  return { url: split.base, params, ...scopes };
}

/** An OAuth provider's endpoints. */
function oauthEndpoints(
  c: Loose,
  base: string,
  ignore: ReadonlySet<string>,
  optionNames: readonly string[],
): Pick<GeneratedSpec, "authorization" | "token" | "userinfo"> {
  const token = endpointOf(stripIgnored(c.token, "token", ignore), "token");
  const userinfo = endpointOf(c.userinfo, "userinfo");
  if (Object.keys(token.params).length) throw new Unexpressible("token.params");
  if (Object.keys(userinfo.params).length) throw new Unexpressible("userinfo.params");
  if (!base || !token.url || !userinfo.url) {
    throw new Unexpressible("an OAuth provider without authorization, token and userinfo URLs");
  }
  return {
    authorization: templated(base, optionNames),
    token: templated(token.url, optionNames),
    userinfo: templated(userinfo.url, optionNames),
  };
}

/**
 * An OIDC provider's issuer: Auth.js discovers from it; a provider that names only its discovery
 * document (`wellKnown`) has its issuer where that document lives.
 */
function oidcIssuer(
  c: Loose,
  optionNames: readonly string[],
): Pick<GeneratedSpec, "issuer" | "profileFromUserinfo"> {
  const wellKnown = typeof c.wellKnown === "string" && !c.issuer
    ? c.wellKnown.replace(/\/\.well-known\/openid-configuration(\?.*)?$/, "")
    : undefined;
  const issuer = templated(String(c.issuer ?? wellKnown ?? SENTINEL.issuer), optionNames);
  return c.idToken === false ? { issuer, profileFromUserinfo: true } : { issuer };
}

/** The rule's options the spec uses (the issuer's only when a template names it). */
function optionsOf(
  spec: GeneratedSpec,
  rule: ProviderRule,
): Record<string, GeneratedOption> | undefined {
  const usesIssuer = JSON.stringify(spec).includes("{issuer}");
  const options = Object.entries(rule.options ?? {}).filter(([k]) => k !== "issuer" || usesIssuer);
  return options.length ? Object.fromEntries(options.map(([k, v]) => [k, { ...v }])) : undefined;
}

/** The profile mapping: traced off `profile()` (plus the rule's overrides), then cross-checked. */
async function profileOf(
  id: string,
  profile: Loose,
  rule: ProviderRule,
): Promise<Record<string, ProfileExpr[]> | undefined> {
  if (typeof profile !== "function") return undefined;
  const traced = rule.trace === false
    ? { mapping: {}, accessed: new Set<string>() }
    : await traceProfile(profile);
  const mapping: Record<string, ProfileExpr[]> = { ...traced.mapping };
  for (const [field, alternatives] of Object.entries(rule.profile ?? {})) {
    mapping[field] = alternatives.map((a: ProfileOverride) => structuredClone(a) as ProfileExpr);
  }
  await crossCheck(id, profile, mapping, traced.accessed, rule.samples ?? []);
  return mapping;
}

/**
 * The spec for one provider, or why it can't be generated (an {@linkcode Unexpressible}).
 *
 * @param id The provider id.
 * @param factory Auth.js's provider factory (its default export).
 * @returns The spec.
 */
export async function extract(
  id: string,
  factory: (options: unknown) => Loose,
): Promise<GeneratedSpec> {
  const rule = RULES[id] ?? {};
  const ignore = new Set(rule.ignore ?? []);
  const optionNames = Object.keys(rule.options ?? {}).filter((k) => k !== "issuer");
  const options: Record<string, unknown> = { ...SENTINEL };
  for (const key of optionNames) options[key] = optionSentinel(key);
  const { config: c, reads } = callFactory(factory, options);
  checkReads(reads, optionNames);
  checkShape(c, ignore);
  // A request / conform hook on any endpoint is a flow the data can't express.
  endpointOf(stripIgnored(c.token, "token", ignore), "token");
  endpointOf(c.userinfo, "userinfo");
  const authorization = authorizationOf(c, optionNames);
  const checks = checksOf(c.checks);
  const spec: GeneratedSpec = {
    id: c.id,
    name: c.name,
    type: c.type,
    scopes: authorization.scopes,
    tokenAuth: tokenAuthOf(c.client),
    ...(checks ? { checks } : {}),
    ...(c.type === "oauth"
      ? oauthEndpoints(c, authorization.url, ignore, optionNames)
      : oidcIssuer(c, optionNames)),
  };
  if (Object.keys(authorization.params).length) spec.params = authorization.params;
  if (authorization.scopeOption) spec.scopeOption = authorization.scopeOption;
  const ruleOptions = optionsOf(spec, rule);
  if (ruleOptions) spec.options = ruleOptions;
  const profile = await profileOf(id, c.profile, rule);
  if (profile) spec.profile = profile;
  return spec;
}

/** Read the pinned `@auth/core` providers and build the manifest. */
async function buildManifest(): Promise<ProviderManifest> {
  const all = await listProviders();
  const handWritten = all.filter((id) => HAND_WRITTEN.includes(id));
  const unsupported: Record<string, string> = {};
  const generated: ProviderManifest["generated"] = {};
  const failures: string[] = [];
  for (const id of all) {
    if (HAND_WRITTEN.includes(id)) continue;
    if (UNSUPPORTED[id]) {
      unsupported[id] = UNSUPPORTED[id];
      continue;
    }
    const mod = await import(`npm:@auth/core@${AUTHJS_CORE_VERSION}/providers/${id}`);
    try {
      generated[id] = { exportName: mod.default.name, spec: await extract(id, mod.default) };
    } catch (error) {
      if (!(error instanceof Unexpressible)) throw error;
      failures.push(`${id}: ${error.message}`);
    }
  }
  if (failures.length) {
    throw new Error(
      "gen:auth-providers: these providers can't be generated; classify them in " +
        `scripts/auth-providers/classify.ts:\n  ${failures.join("\n  ")}`,
    );
  }
  for (const id of [...HAND_WRITTEN, ...Object.keys(UNSUPPORTED)]) {
    if (!all.includes(id)) {
      throw new Error(
        `gen:auth-providers: "${id}" is classified but @auth/core has no such provider`,
      );
    }
  }
  return { authjsCore: AUTHJS_CORE_VERSION, all, handWritten, unsupported, generated };
}

/** The provider ids: the `.js` files of the pinned `@auth/core`'s `providers/` directory. */
async function listProviders(): Promise<string[]> {
  // Load one provider so the package is in Deno's npm cache, then read its export map there.
  await import(`npm:@auth/core@${AUTHJS_CORE_VERSION}/providers/github`);
  const info = await new Deno.Command(Deno.execPath(), { args: ["info", "--json"] }).output();
  const { npmCache } = JSON.parse(new TextDecoder().decode(info.stdout)) as { npmCache: string };
  const dir = join(npmCache, "registry.npmjs.org/@auth/core", AUTHJS_CORE_VERSION, "providers");
  const ids: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const id = /^(.+)\.js$/.exec(entry.name)?.[1];
    if (entry.isFile && id && !NOT_PROVIDERS.includes(id)) ids.push(id);
  }
  return [...new Set(ids)].sort();
}

// ---- deno.json -----------------------------------------------------------------------------

/**
 * `deno.json`'s text with its `next-auth/providers/*` exports and the doc-lint entry list set to
 * `modules` (the block's position and every other line kept).
 *
 * @param text The current `deno.json`.
 * @param modules The provider module names.
 * @returns The new text.
 */
export function patchDenoJson(text: string, modules: readonly string[]): string {
  const lines = text.split("\n");
  const isProvider = (line: string) => /^\s*"\.\/next-auth\/providers\/[^"]+":/.test(line);
  const first = lines.findIndex(isProvider);
  if (first < 0) throw new Error("deno.json has no next-auth/providers exports");
  let last = first;
  while (isProvider(lines[last + 1])) last++;
  const indent = /^\s*/.exec(lines[first])![0];
  const block = modules.map((m) =>
    `${indent}"./next-auth/providers/${m}": "./${PROVIDERS_DIR}/${m}.ts",`
  );
  lines.splice(first, last - first + 1, ...block);
  const docs = modules.map((m) => `${PROVIDERS_DIR}/${m}.ts`).join(" ");
  const docLint = lines.findIndex((line) => /^\s*"doc-lint":/.test(line));
  lines[docLint] = lines[docLint].replace(
    new RegExp(`(?:${PROVIDERS_DIR}/(?!index\\.ts)[\\w-]+\\.ts ?)+`),
    `${docs} `,
  );
  return lines.join("\n");
}

/** Format TypeScript sources with `deno fmt` (in a temp dir, under the repo's config). */
export async function formatSources(files: Map<string, string>): Promise<Map<string, string>> {
  const dir = await Deno.makeTempDir({ dir: ROOT, prefix: ".gen-auth-providers-" });
  try {
    for (const [path, src] of files) {
      await Deno.mkdir(join(dir, path, ".."), { recursive: true });
      await Deno.writeTextFile(join(dir, path), src);
    }
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["fmt", "--quiet", "--config", join(ROOT, "deno.json"), dir],
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    if (!out.success) throw new Error("gen:auth-providers: deno fmt failed");
    const formatted = new Map<string, string>();
    for (const path of files.keys()) formatted.set(path, await Deno.readTextFile(join(dir, path)));
    return formatted;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Every file the generator owns, rendered from `manifest` and formatted. */
export async function expectedFiles(manifest: ProviderManifest): Promise<Map<string, string>> {
  const files = await formatSources(renderAll(manifest));
  files.set(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  const denoJson = await Deno.readTextFile(join(ROOT, "deno.json"));
  files.set("deno.json", patchDenoJson(denoJson, providerModules(manifest)));
  return files;
}

if (import.meta.main) {
  const check = Deno.args.includes("--check");
  const manifest = await buildManifest();
  const files = await expectedFiles(manifest);
  const stale: string[] = [];
  for (const [path, src] of files) {
    const current = await Deno.readTextFile(join(ROOT, path)).catch(() => undefined);
    if (current === src) continue;
    stale.push(path);
    if (!check) await Deno.writeTextFile(join(ROOT, path), src);
  }
  const count = Object.keys(manifest.generated).length;
  if (check && stale.length) {
    console.error(`gen:auth-providers: out of date:\n  ${stale.join("\n  ")}`);
    Deno.exit(1);
  }
  console.log(
    `gen:auth-providers: @auth/core@${manifest.authjsCore}: ${manifest.all.length} providers — ` +
      `${count} generated, ${manifest.handWritten.length} hand-written, ` +
      `${Object.keys(manifest.unsupported).length} unsupported` +
      (check ? "" : `; ${stale.length} file(s) written`),
  );
}

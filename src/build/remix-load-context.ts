// The custom server's `getLoadContext` → `load-context.ts`, for `denext migrate --from remix`.
//
// A Remix app served by Express handed every loader/action a `context` its server computed
// per request from the Express request and response (`getLoadContext(req, res)`). denext
// replaces that server, so each value is re-derived from what denext has per request: the
// Fetch `Request`, the route's params, `denext/server`'s cookies / client address / auth /
// signed session — and an Express middleware's result (`res.locals.x = …`, `req.x = …` in an
// `app.use` callback) is recomputed from that middleware's own expression. A value with no
// equivalent stays an `undefined` property under a `TODO(denext migrate)` note that names
// the file and line it came from and why it could not be carried over.

import { dirname, join, relative } from "@std/path";
import { exists, firstExisting } from "./migrate-fs.ts";
import { mfs } from "./migrate-io.ts";
import {
  declaredNames,
  freeIdentifiers,
  GEN_HEADER,
  parseRouteModule,
  rewriteSpecifiers,
} from "./remix-codegen.ts";
import { applyEdits, type Ctx, type Edit, forEachChild, type Node, walkAst } from "./swc-ast.ts";

/** Where a Remix app's custom server (Express/Hono) lives, most common first. */
const SERVER_ENTRIES = [
  "server/index.ts",
  "server/index.js",
  "server/index.mjs",
  "server.ts",
  "server.js",
  "server.mjs",
  "server/app.ts",
  "server/app.js",
];

/** A `getLoadContext` key with a denext-side equivalent: the expression + why. */
const LOAD_CONTEXT_KEYS: Record<string, { expr: string; note: string; lazy?: true }> = {
  // A getter: the O(routes) synthesize runs only when a loader reads it, and a rejection
  // surfaces where it is awaited instead of as an unhandled promise per request.
  serverBuild: {
    expr: "remixServerBuild()",
    note: "the Remix-shaped route manifest (`.routes`) — what remix-seo's sitemap reads",
    lazy: true,
  },
  build: {
    expr: "remixServerBuild()",
    note: "the Remix-shaped route manifest (`.routes`) — what remix-seo's sitemap reads",
    lazy: true,
  },
  cspNonce: {
    expr: "undefined",
    note: "denext's CSP is hash-based — there is no per-request nonce",
  },
  nonce: {
    expr: "undefined",
    note: "denext's CSP is hash-based — there is no per-request nonce",
  },
};

/** The generated module, and the notes for the migrate report. */
export interface LoadContextModule {
  /** `load-context.ts` at the app root. */
  dest: string;
  code: string;
  /** The server module's directory (its relative imports are re-based from here). */
  srcDir: string;
}

/** What {@link loadContextModule} produced: the module (when any) and the report notes. */
export interface LoadContextResult {
  module: LoadContextModule | null;
  warnings: string[];
}

/** One key of the object `getLoadContext` returns. */
interface ContextKey {
  name: string;
  /** The value node (the spread argument for a spread, the identifier for a shorthand). */
  node: Node | null;
  spread: boolean;
}

/** The request/response parameter names of the function an expression comes from. */
interface Scope {
  req: string | null;
  res: string | null;
}

/** A value an Express middleware set (`res.locals.x = …` / `req.x = …`), and where. */
interface Origin {
  node: Node;
  scope: Scope;
  line: number;
}

/** A translated expression, or why it can't be. */
type Translation = { text: string } | { problem: string };

/** What the generated module needs, collected while translating. */
interface Needs {
  request: boolean;
  url: boolean;
  params: boolean;
  /** `denext/server` bindings (`auth`, `clientIp`, `cookies`, `getSession`). */
  server: Set<string>;
  /** Server-module imports a value uses (local binding names). */
  carried: Set<string>;
  /** The `requestSession()` helper (`req.session`). */
  session: boolean;
  /** The `requestAuth()` helper (`req.user`, `req.isAuthenticated()`). */
  user: boolean;
}

/** Everything known about the server module that values are translated against. */
interface ServerModule {
  ctx: Ctx;
  rel: string;
  /** Local binding → its import declaration. */
  imports: Map<string, Node>;
  /** Top-level declarations (name → line), which a generated module can't reach. */
  topLevel: Map<string, number>;
  /** `req.x = …` in a middleware, by `x`. */
  reqProps: Map<string, Origin>;
  /** `res.locals.x = …` in a middleware, by `x`. */
  locals: Map<string, Origin>;
  /** The secret expression of an `express-session` / `cookie-session` setup, when found. */
  sessionSecret: Node | null;
  /** `getLoadContext`'s own request / response parameters. */
  scope: Scope;
}

/** The name of a property key node (identifier or string), or null when computed. */
function propertyKeyName(key: Node): string | null {
  if (!key) return null;
  if (key.type === "Identifier" || key.type === "StringLiteral") return key.value as string;
  return null;
}

/** The function node bound to `getLoadContext` (an object property, a const, a declaration). */
function findLoadContextFn(items: Node[]): Node | null {
  let found: Node | null = null;
  for (const item of items) {
    walkAst(item, (n) => {
      if (found) return;
      if (n.type === "KeyValueProperty" && propertyKeyName(n.key) === "getLoadContext") {
        found = n.value;
      } else if (n.type === "MethodProperty" && propertyKeyName(n.key) === "getLoadContext") {
        found = n;
      } else if (n.type === "VariableDeclarator" && n.id?.value === "getLoadContext" && n.init) {
        found = n.init;
      } else if (n.type === "FunctionDeclaration" && n.identifier?.value === "getLoadContext") {
        found = n;
      }
    });
    if (found) break;
  }
  return found;
}

const unwrap = (n: Node): Node => (n?.type === "ParenthesisExpression" ? unwrap(n.expression) : n);

/** The object literal a function returns (an arrow's expression body or a `return {…}`). */
function returnedObject(fn: Node): Node | null {
  const body = (fn.function ?? fn).body; // a method carries its body itself (or on `function`)
  if (!body) return null;
  const direct = unwrap(body);
  if (direct?.type === "ObjectExpression") return direct;
  let ret: Node | null = null;
  walkAst(body, (n) => {
    if (!ret && n.type === "ReturnStatement" && unwrap(n.argument)?.type === "ObjectExpression") {
      ret = unwrap(n.argument);
    }
  });
  return ret;
}

/**
 * React Router 7's middleware-mode `getLoadContext`, which returns a `RouterContextProvider`:
 * `return new RouterContextProvider(…)`, or a variable holding one that `.set(key, value)`
 * calls fill before it is returned.
 */
interface ProviderReturn {
  /** The `new …(…)` expression. */
  init: Node;
  /** The `<variable>.set(key, value)` calls, in source order. */
  sets: Array<{ call: Node; key: Node; value: Node }>;
}

/** The provider a function returns (see {@link ProviderReturn}), or null. */
function returnedProvider(fn: Node): ProviderReturn | null {
  const body = (fn.function ?? fn).body;
  const ret = body ? returnedExpression(body) : null;
  if (ret?.type === "NewExpression") return { init: ret, sets: [] };
  return ret?.type === "Identifier" ? providerVariable(body, ret.value as string) : null;
}

/** What a function body returns: an arrow's expression, else the first `return`'s argument. */
function returnedExpression(body: Node): Node | null {
  if (body.type !== "BlockStatement") return unwrap(body);
  let returned: Node | null = null;
  walkAst(body, (n) => {
    if (!returned && n.type === "ReturnStatement" && n.argument) returned = unwrap(n.argument);
  });
  return returned;
}

/** The `new …(…)` a variable `name` holds and the `name.set(key, value)` calls on it. */
function providerVariable(body: Node, name: string): ProviderReturn | null {
  let init: Node | null = null;
  const sets: ProviderReturn["sets"] = [];
  walkAst(body, (n) => {
    if (n.type === "VariableDeclarator" && n.id?.value === name) {
      if (unwrap(n.init)?.type === "NewExpression") init = unwrap(n.init);
    } else if (n.type === "CallExpression" && n.arguments?.length === 2) {
      const chain = n.callee?.type === "MemberExpression" ? memberChain(n.callee) : null;
      if (chain?.root === name && chain.path.length === 1 && chain.path[0] === "set") {
        sets.push({ call: n, key: n.arguments[0].expression, value: n.arguments[1].expression });
      }
    }
  });
  return init ? { init, sets } : null;
}

/** The keys of an object literal. */
function objectKeys(obj: Node): ContextKey[] {
  const keys: ContextKey[] = [];
  for (const p of obj.properties ?? []) {
    if (p.type === "Identifier") keys.push({ name: p.value, node: p, spread: false });
    else if (p.type === "SpreadElement") {
      keys.push({ name: "...", node: p.arguments, spread: true });
    } else {
      const name = propertyKeyName(p.key);
      if (name) keys.push({ name, node: p.value ?? null, spread: false });
    }
  }
  return keys;
}

/** A function node's parameter patterns (arrow, function expression/declaration, method). */
function paramPatterns(fn: Node): Node[] {
  const params = (fn.function ?? fn).params;
  return (params ?? []).map((p: Node) => (p?.type === "Parameter" ? p.pat : p));
}

/** The first two parameters' names when they are plain identifiers (`(req, res)`). */
function scopeOf(fn: Node): Scope {
  const [a, b] = paramPatterns(fn);
  const name = (p: Node) => (p?.type === "Identifier" ? p.value as string : null);
  return { req: name(a), res: name(b) };
}

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);

/** A static member chain rooted at an identifier: `req.headers["x-id"]` → req, [headers, x-id]. */
function memberChain(n: Node): { root: string; path: string[] } | null {
  const path: string[] = [];
  let cur = n;
  while (cur?.type === "MemberExpression") {
    const prop = cur.property;
    if (prop?.type === "Identifier") path.unshift(prop.value);
    else if (prop?.type === "Computed" && prop.expression?.type === "StringLiteral") {
      path.unshift(prop.expression.value);
    } else return null;
    cur = cur.object;
  }
  return cur?.type === "Identifier" && path.length > 0 ? { root: cur.value, path } : null;
}

/** The 1-based line of a node in the server module (the parse marker is line 1). */
function lineOf(ctx: Ctx, n: Node): number {
  const end = n.span.start - ctx.base;
  let line = 0; // the marker's own line is not the module's
  for (let i = 0; i < end; i++) if (ctx.bytes[i] === 0x0a) line++;
  return line;
}

/** The source text of a node, single-line (for a comment). */
function oneLine(ctx: Ctx, n: Node): string {
  return new TextDecoder().decode(
    ctx.bytes.subarray(n.span.start - ctx.base, n.span.end - ctx.base),
  )
    .replace(/\s*\n\s*/g, " ");
}

/**
 * Collect what middlewares set: in every function shaped `(req, res, …)` but `getLoadContext`
 * itself, `<res>.locals.x = expr` and `<req>.x = expr` (the first assignment of each name).
 */
function collectMiddleware(ctx: Ctx, items: Node[], skip: Node): Pick<
  ServerModule,
  "reqProps" | "locals"
> {
  const reqProps = new Map<string, Origin>();
  const locals = new Map<string, Origin>();
  for (const item of items) {
    walkAst(item, (fn) => {
      if (!FUNCTION_TYPES.has(fn.type) || fn === skip) return;
      const scope = scopeOf(fn);
      if (!scope.req || !scope.res) return;
      walkAst(fn.body, (n) => {
        if (n.type !== "AssignmentExpression" || n.operator !== "=") return;
        const chain = memberChain(n.left);
        if (!chain) return;
        const origin = { node: n.right, scope, line: lineOf(ctx, n) };
        if (chain.root === scope.res && chain.path.length === 2 && chain.path[0] === "locals") {
          if (!locals.has(chain.path[1])) locals.set(chain.path[1], origin);
        } else if (chain.root === scope.req && chain.path.length === 1) {
          if (!reqProps.has(chain.path[0])) reqProps.set(chain.path[0], origin);
        }
      });
    });
  }
  return { reqProps, locals };
}

/** The session middlewares whose secret `req.session` is re-signed with. */
const SESSION_PACKAGES = new Set(["express-session", "cookie-session"]);

/** The `secret` (or cookie-session's `keys`) passed to the app's session middleware. */
function findSessionSecret(items: Node[], imports: Map<string, Node>): Node | null {
  const factories = new Set(
    [...imports].filter(([, decl]) => SESSION_PACKAGES.has(decl.source?.value)).map(([n]) => n),
  );
  let secret: Node | null = null;
  for (const item of items) {
    walkAst(item, (n) => {
      if (secret || n.type !== "CallExpression" || n.callee?.type !== "Identifier") return;
      if (!factories.has(n.callee.value)) return;
      const options = unwrap(n.arguments?.[0]?.expression);
      for (const p of options?.properties ?? []) {
        const key = p.type === "KeyValueProperty" ? propertyKeyName(p.key) : null;
        if (key === "secret" || key === "keys") secret = p.value;
      }
    });
  }
  return secret;
}

/** Each value import's local binding → its declaration (type-only imports are skipped). */
function valueImports(items: Node[]): Map<string, Node> {
  const imports = new Map<string, Node>();
  const decls = items.filter((item) => item.type === "ImportDeclaration" && !item.typeOnly);
  for (const decl of decls) {
    for (const s of decl.specifiers ?? []) {
      if (!s.isTypeOnly) imports.set(s.local.value, decl);
    }
  }
  return imports;
}

/** Read the server module: imports, top-level names, middleware results, session secret. */
function analyzeServer(ctx: Ctx, items: Node[], rel: string, fn: Node): ServerModule {
  const imports = valueImports(items);
  const topLevel = new Map<string, number>();
  for (const item of items.filter((i) => i.type !== "ImportDeclaration")) {
    for (const name of declaredNames(item)) topLevel.set(name, lineOf(ctx, item));
  }
  return {
    ctx,
    rel,
    imports,
    topLevel,
    ...collectMiddleware(ctx, items, fn),
    sessionSecret: findSessionSecret(items, imports),
    scope: scopeOf(fn),
  };
}

/** A header read: Express returns `undefined` for a missing header, Fetch `null`. */
const header = (name: string) =>
  `(request.headers.get(${JSON.stringify(name.toLowerCase())}) ?? undefined)`;

/**
 * Translates Express request / response reads into per-request denext expressions, recording
 * what the generated module needs.
 */
class Translator {
  readonly needs: Needs = {
    request: false,
    url: false,
    params: false,
    server: new Set(),
    carried: new Set(),
    session: false,
    user: false,
  };
  /** The Express fields read whose trust of a proxy's headers changes (`ip`, `secure`, …). */
  readonly proxyTrust = new Set<string>();

  constructor(private readonly server: ServerModule) {}

  /** Translate `node`, read in a function whose request/response are `scope`. */
  translate(node: Node, scope: Scope, depth = 0): Translation {
    const { ctx } = this.server;
    const edits: Edit[] = [];
    let problem: string | null = null;
    const start = node.span.start - ctx.base;
    const visit = (n: Node): void => {
      if (problem !== null || !n || typeof n !== "object") return;
      const matched = this.match(n, scope, depth);
      if (matched !== null) {
        if ("problem" in matched) problem = matched.problem;
        else {
          edits.push({
            start: n.span.start - ctx.base - start,
            end: n.span.end - ctx.base - start,
            text: matched.text,
          });
        }
        return;
      }
      if (n.type === "Identifier" && (n.value === scope.req || n.value === scope.res)) {
        problem = `passes \`${n.value}\` itself on — only its fields have denext equivalents`;
        return;
      }
      if (n.type === "MemberExpression") {
        visit(n.object);
        if (n.property?.type === "Computed") visit(n.property);
        return;
      }
      if (n.type === "KeyValueProperty") {
        if (n.key?.type === "Computed") visit(n.key);
        visit(n.value);
        return;
      }
      forEachChild(n, visit);
    };
    const before = this.snapshot();
    visit(node);
    problem ??= this.checkScope(node, scope);
    if (problem !== null) {
      // A value left as a TODO must not leave imports or helpers behind in the module.
      this.restore(before);
      return { problem };
    }
    const bytes = ctx.bytes.subarray(start, node.span.end - ctx.base);
    return { text: applyEdits(bytes, edits) };
  }

  /** A copy of {@link needs}, to undo what a failed translation recorded. */
  private snapshot(): Needs {
    const n = this.needs;
    return { ...n, server: new Set(n.server), carried: new Set(n.carried) };
  }

  /** Put {@link needs} back to `saved`. */
  private restore(saved: Needs): void {
    Object.assign(this.needs, saved);
  }

  /** Every identifier `node` reads must be an import (carried), a global, or a translated read. */
  private checkScope(node: Node, scope: Scope): string | null {
    const { imports, topLevel, rel } = this.server;
    for (const id of freeIdentifiers(node)) {
      if (id === scope.req || id === scope.res) continue;
      if (imports.has(id)) {
        this.needs.carried.add(id);
      } else if (topLevel.has(id)) {
        return `uses \`${id}\`, declared in ${rel}:${topLevel.get(id)} — move it to a module ` +
          "both can import";
      } else if (!(id in globalThis)) {
        return `uses \`${id}\`, which only exists inside the server's own code`;
      }
    }
    return null;
  }

  /** A denext expression for an Express read at `n`, a reason it has none, or null (no read). */
  private match(n: Node, scope: Scope, depth: number): Translation | null {
    if (n.type === "CallExpression") return this.matchCall(n, scope);
    if (n.type !== "MemberExpression") return null;
    const chain = memberChain(n);
    if (!chain) return null;
    if (chain.root === scope.req && scope.req !== null) {
      return this.matchRequest(chain.path, depth);
    }
    if (chain.root === scope.res && scope.res !== null) {
      return this.matchResponse(chain.path, depth);
    }
    return null;
  }

  /** `req.get("x")` / `req.header("x")` / `req.isAuthenticated()`. */
  private matchCall(n: Node, scope: Scope): Translation | null {
    const chain = n.callee?.type === "MemberExpression" ? memberChain(n.callee) : null;
    if (!chain || chain.root !== scope.req || chain.path.length !== 1) return null;
    const arg = n.arguments?.[0]?.expression;
    if ((chain.path[0] === "get" || chain.path[0] === "header") && arg?.type === "StringLiteral") {
      return this.header(arg.value);
    }
    if (chain.path[0] === "isAuthenticated" && !n.arguments?.length) {
      this.needs.user = true;
      this.needs.server.add("auth").add("AuthPluginMissingError");
      return { text: "((await requestAuth()) !== null)" };
    }
    return null;
  }

  /** A request header (`Host` is the URL's: a Fetch request may not carry the header). */
  private header(name: string): Translation {
    if (name.toLowerCase() === "host") {
      this.needs.url = true;
      return { text: "requestUrl.host" };
    }
    this.needs.request = true;
    return { text: header(name) };
  }

  /** A read of the Express request's `path` (`req.headers.host` → [headers, host]). */
  private matchRequest(path: string[], depth: number): Translation | null {
    const [field, key] = path;
    if (path.length === 1) {
      const origin = this.server.reqProps.get(field);
      if (origin) return this.fromMiddleware(origin, depth);
    }
    if (path.length === 2) return this.matchRequestKey(field, key);
    if (path.length !== 1) return null; // a longer chain: its prefix is matched further in
    const direct = this.requestField(field);
    return direct ?? {
      problem: `has no denext equivalent, and no middleware in ${this.server.rel} sets it`,
    };
  }

  /** `req.headers.x`, `req.query.x`, `req.cookies.x`. */
  private matchRequestKey(field: string, key: string): Translation | null {
    if (field === "headers") return this.header(key);
    if (field === "query") {
      this.needs.url = true;
      return { text: `(requestUrl.searchParams.get(${JSON.stringify(key)}) ?? undefined)` };
    }
    if (field === "cookies") {
      this.needs.server.add("cookies");
      return { text: `cookies().get(${JSON.stringify(key)})?.value` };
    }
    return null;
  }

  /** A whole field of the Express request. */
  private requestField(field: string): Translation | null {
    const url = (text: string) => {
      this.needs.url = true;
      return { text };
    };
    const request = (text: string) => {
      this.needs.request = true;
      return { text };
    };
    const server = (name: string, text: string) => {
      this.needs.server.add(name);
      return { text };
    };
    switch (field) {
      case "headers":
        return request("Object.fromEntries(request.headers)");
      case "method":
        return request("request.method");
      case "url":
      case "originalUrl":
        return url("(requestUrl.pathname + requestUrl.search)");
      case "path":
        return url("requestUrl.pathname");
      case "hostname":
        this.proxyTrust.add("hostname");
        return url("requestUrl.hostname");
      case "protocol":
        this.proxyTrust.add("protocol");
        return url("requestUrl.protocol.slice(0, -1)");
      case "secure":
        this.proxyTrust.add("secure");
        return url('(requestUrl.protocol === "https:")');
      case "query":
        return url("Object.fromEntries(requestUrl.searchParams)");
      case "params":
        this.needs.params = true;
        return { text: "params" };
      case "ip":
        this.proxyTrust.add("ip");
        return server("clientIp", "clientIp()");
      case "cookies":
        return server(
          "cookies",
          "Object.fromEntries(cookies().getAll().map((c) => [c.name, c.value]))",
        );
      case "user":
        this.needs.user = true;
        this.needs.server.add("AuthPluginMissingError");
        return server("auth", "(await requestAuth())?.user");
      case "session":
        this.needs.session = true;
        this.needs.server.add("getSession");
        return { text: "(await requestSession())" };
    }
    return null;
  }

  /** A read of the Express response: only `res.locals.x` a middleware set carries over. */
  private matchResponse(path: string[], depth: number): Translation | null {
    if (path[0] !== "locals" || path.length > 2) return null;
    if (path.length === 1) {
      return { problem: "has no denext equivalent as a whole — read its fields" };
    }
    const origin = this.server.locals.get(path[1]);
    if (origin) return this.fromMiddleware(origin, depth);
    const known = LOAD_CONTEXT_KEYS[path[1]];
    if (known && !known.lazy) return { text: known.expr };
    return { problem: `is never set in ${this.server.rel}` };
  }

  /** Recompute a middleware's value from its own expression (per request, as it ran). */
  private fromMiddleware(origin: Origin, depth: number): Translation {
    const where = `${this.server.rel}:${origin.line}`;
    if (depth >= 4) return { problem: `is set at ${where} from a chain of values too deep` };
    const inner = this.translate(origin.node, origin.scope, depth + 1);
    if ("problem" in inner) {
      return { problem: `is set at ${where}, which ${inner.problem}` };
    }
    return { text: `(${inner.text})` };
  }
}

/** One generated property of `load-context.ts` for a `getLoadContext` key. */
function keyProperty(
  key: ContextKey,
  server: ServerModule,
  translator: Translator,
  indent: string,
): { code: string; todo: string | null } {
  const { ctx, rel } = server;
  const source = key.node ? oneLine(ctx, key.node) : "<method>";
  const at = key.node ? `${rel}:${lineOf(ctx, key.node)}` : rel;
  const name = /^[A-Za-z_$][\w$]*$/.test(key.name) ? key.name : JSON.stringify(key.name);
  const known = key.spread ? undefined : LOAD_CONTEXT_KEYS[key.name];
  if (known?.lazy) {
    return {
      code: `${indent}// was: ${source} — ${known.note}\n${indent}get ${name}() {\n` +
        `${indent}  return ${known.expr};\n${indent}},\n`,
      todo: null,
    };
  }
  if (known) {
    return {
      code: `${indent}// was: ${source} — ${known.note}\n${indent}${name}: ${known.expr},\n`,
      todo: null,
    };
  }
  const result: Translation = key.node
    ? translator.translate(key.node, server.scope)
    : { problem: "is a method — port it by hand" };
  if ("problem" in result) {
    const note = `${indent}// TODO(denext migrate): \`${
      key.spread ? "..." : ""
    }${source}\` (${at}) ${result.problem}\n`;
    return { code: key.spread ? note : `${note}${indent}${name}: undefined,\n`, todo: at };
  }
  const was = result.text === source ? "" : `${indent}// was: ${source} (${at})\n`;
  const value = key.spread ? `...${result.text}` : `${name}: ${result.text}`;
  return { code: `${was}${indent}${value},\n`, todo: null };
}

/** The statements of a provider-returning `getLoadContext` (see {@link ProviderReturn}). */
function providerStatements(
  provider: ProviderReturn,
  server: ServerModule,
  translator: Translator,
): { code: string; todos: string[]; summary: string[]; fallback: boolean } {
  const { ctx, rel } = server;
  const at = (n: Node) => `${rel}:${lineOf(ctx, n)}`;
  const todos: string[] = [];
  const summary: string[] = [];
  const lines: string[] = [];
  const init = translator.translate(provider.init, server.scope);
  let fallback = false;
  if ("problem" in init) {
    lines.push(
      `  // TODO(denext migrate): \`${oneLine(ctx, provider.init)}\` (${
        at(provider.init)
      }) ${init.problem}`,
    );
    todos.push(at(provider.init));
    fallback = true;
  }
  lines.push(`  const context = ${"text" in init ? init.text : "new RouterContextProvider()"};`);
  for (const set of provider.sets) {
    const key = translator.translate(set.key, server.scope);
    const value = "problem" in key ? key : translator.translate(set.value, server.scope);
    const keyText = oneLine(ctx, set.key);
    if ("problem" in value) {
      lines.push(
        `  // TODO(denext migrate): \`${oneLine(ctx, set.call)}\` (${
          at(set.call)
        }) ${value.problem}`,
      );
      todos.push(at(set.call));
      summary.push(`${keyText} → TODO`);
      continue;
    }
    const translatedKey = "text" in key ? key.text : keyText;
    lines.push(`  context.set(${translatedKey}, ${value.text});`);
    summary.push(`${keyText} → wired`);
  }
  lines.push("  return context;");
  return { code: lines.join("\n") + "\n", todos, summary, fallback };
}

/** One import specifier as a pruned import writes it (`a`, `b as c`, `* as ns`, a default). */
function specifierText(s: Node): string {
  const local = s.local.value as string;
  if (s.type === "ImportDefaultSpecifier") return local;
  if (s.type === "ImportNamespaceSpecifier") return `* as ${local}`;
  const imported = s.imported ? propertyKeyName(s.imported) : null;
  return imported && imported !== local ? `${imported} as ${local}` : local;
}

/** An import declaration with only `used` bindings (null when none is used). */
function prunedImport(decl: Node, used: Set<string>): string | null {
  const kept: Node[] = (decl.specifiers ?? []).filter((s: Node) =>
    used.has(s.local.value) && !s.isTypeOnly
  );
  if (kept.length === 0) return null;
  const named = kept.filter((s) => s.type === "ImportSpecifier").map(specifierText);
  const parts = [
    ...kept.filter((s) => s.type !== "ImportSpecifier").map(specifierText),
    ...(named.length ? [`{ ${named.join(", ")} }`] : []),
  ];
  return `import ${parts.join(", ")} from ${JSON.stringify(decl.source.value)};`;
}

/** The `requestSession()` helper `req.session` reads become. */
function sessionHelper(server: ServerModule, translator: Translator): string {
  const { ctx, rel, sessionSecret } = server;
  const secret = sessionSecret
    ? translator.translate(sessionSecret, { req: null, res: null })
    : null;
  const expr = secret && "text" in secret ? secret.text : 'Deno.env.get("SESSION_SECRET") ?? ""';
  const from = sessionSecret && secret && "text" in secret
    ? `the secret ${rel}:${lineOf(ctx, sessionSecret)} gave the session middleware`
    : "SESSION_SECRET (at least 32 characters)";
  return `
/**
 * \`req.session\`: denext's signed-cookie session, signed with
 * ${from}.
 * Its fields are the session's \`data\`; write them with \`getSession({ secret }).set(…)\` in an
 * action. Sessions the old server's store held do not carry over.
 */
async function requestSession(): Promise<Record<string, unknown>> {
  const session = await getSession<Record<string, unknown>>({ secret: ${expr} });
  return session.data ?? {};
}
`;
}

/**
 * The `requestAuth()` helper `req.user` / `req.isAuthenticated()` read: denext's auth session,
 * signed out (`null`) while no `denextAuth()` plugin is configured, as the old server's were
 * without its auth middleware.
 */
const AUTH_HELPER = `
/**
 * \`req.user\` / \`req.isAuthenticated()\`: denext's auth session — signed out until the
 * \`denextAuth()\` plugin (\`@denext/auth\`) is in denext.config.ts's \`plugins\`.
 */
async function requestAuth() {
  try {
    return await auth();
  } catch (error) {
    if (error instanceof AuthPluginMissingError) return null;
    throw error;
  }
}
`;

/** The generated module's helpers: `requestSession()` and `requestAuth()`, as it needs them. */
function helpers(needs: Needs, server: ServerModule, translator: Translator): string {
  return (needs.session ? sessionHelper(server, translator) : "") + (needs.user ? AUTH_HELPER : "");
}

/** The import lines of the generated module. */
function importLines(
  server: ServerModule,
  needs: Needs,
  usesBuild: boolean,
  providerClass = false,
): string[] {
  const runtime = [
    "defineLoadContext",
    ...(usesBuild ? ["remixServerBuild"] : []),
    ...(providerClass ? ["RouterContextProvider"] : []),
  ];
  const lines = [`import { ${runtime.join(", ")} } from "denext/remix/server";`];
  if (needs.server.size) {
    lines.push(`import { ${[...needs.server].sort().join(", ")} } from "denext/server";`);
  }
  const seen = new Set<Node>();
  for (const id of needs.carried) {
    const decl = server.imports.get(id);
    if (!decl || seen.has(decl)) continue;
    seen.add(decl);
    const line = prunedImport(decl, needs.carried);
    if (line) lines.push(line);
  }
  return lines;
}

/** The `defineLoadContext(…)` head: `async ({ request, params }) =>`. */
function providerHead(needs: Needs, isAsync: boolean): string {
  const args = [needs.request || needs.url ? "request" : "", needs.params ? "params" : ""]
    .filter(Boolean);
  return `${isAsync ? "async " : ""}(${args.length ? `{ ${args.join(", ")} }` : ""}) =>`;
}

/** The `defineLoadContext(…)` call around the properties. */
function providerSource(props: string, needs: Needs, isAsync: boolean): string {
  const head = providerHead(needs, isAsync);
  if (!needs.url) return `export default defineLoadContext(${head} ({\n${props}}));\n`;
  return `export default defineLoadContext(${head} {\n  const requestUrl = new URL(request.url);\n` +
    `  return {\n${props}  };\n});\n`;
}

/**
 * The custom server's `getLoadContext` → `load-context.ts`. A Remix server hands every
 * loader/action a `context` (the Epic Stack: `{ cspNonce, serverBuild }`); denext replaces
 * that server, so the returned object's keys are re-created in a `defineLoadContext` module.
 * Returns null when the app has no custom server with a `getLoadContext`.
 *
 * @param dir The app root.
 * @returns The planned module and the report notes, or null.
 */
export async function loadContextModule(dir: string): Promise<LoadContextResult | null> {
  const found = await findServerLoadContext(dir);
  if (!found) return null;
  const { rel, parsed, fn } = found;
  const dest = join(dir, "load-context.ts");
  if (await exists(dest)) {
    return {
      module: null,
      warnings: [`${rel}: getLoadContext NOT ported — load-context.ts already exists`],
    };
  }
  const server = analyzeServer(parsed.ctx, parsed.items, rel, fn);
  const translator = new Translator(server);
  const obj = returnedObject(fn);
  const provider = obj ? null : returnedProvider(fn);
  if (provider) return providerModule(dir, dest, server, translator, provider);
  return objectModule(dir, dest, server, translator, obj);
}

/** The custom server module with a `getLoadContext`, parsed, and that function; else null. */
async function findServerLoadContext(
  dir: string,
): Promise<{ rel: string; parsed: { ctx: Ctx; items: Node[] }; fn: Node } | null> {
  const rel = await firstExisting(dir, SERVER_ENTRIES);
  if (!rel) return null;
  const source = await mfs.readTextFile(join(dir, rel)).catch(() => null);
  if (source === null || !source.includes("getLoadContext")) return null;
  const parsed = await parseRouteModule(source);
  const fn = parsed ? findLoadContextFn(parsed.items) : null;
  return parsed && fn ? { rel, parsed, fn } : null;
}

/** `load-context.ts` for a `getLoadContext` that returns an object literal (or one unread). */
function objectModule(
  dir: string,
  dest: string,
  server: ServerModule,
  translator: Translator,
  obj: Node | null,
): LoadContextResult {
  const { rel } = server;
  const keys = obj ? objectKeys(obj) : null;
  // The URL form nests the properties one level deeper; translate first to know which.
  const draft = keys?.map((k) => keyProperty(k, server, translator, "  "));
  const needs = translator.needs;
  const indent = needs.url ? "    " : "  ";
  const rendered = needs.url
    ? keys!.map((k) => keyProperty(k, server, new Translator(server), indent))
    : draft;
  const props = rendered?.map((r) => r.code).join("") ??
    `  // TODO(denext migrate): ${rel} — could not read the object getLoadContext returns; ` +
      "port it by hand\n";
  const helper = helpers(needs, server, translator);
  const isAsync = /\bawait\b/.test(props);
  const code = `${GEN_HEADER}${moduleIntro(rel)}
${importLines(server, needs, props.includes("remixServerBuild()")).join("\n")}
${helper}
${providerSource(props, needs, isAsync)}`;
  const summary = keys
    ? keys.map((k, i) => `${k.spread ? "..." : k.name} → ${rendered![i].todo ? "TODO" : "wired"}`)
      .join(", ")
    : "TODO";
  const todos = rendered?.flatMap((r) => (r.todo ? [r.todo] : [])) ?? [rel];
  const warnings = reportWarnings(rel, summary, todos, translator.proxyTrust);
  return { module: { dest, code, srcDir: join(dir, dirname(rel)) }, warnings };
}

/** The comment heading a generated `load-context.ts`. */
function moduleIntro(rel: string): string {
  return `// What ${rel}'s \`getLoadContext\` gave every loader/action as \`context\`, re-derived per
// request: denext replaced that server, so request reads come from the Fetch \`Request\` and
// \`denext/server\`, a middleware's result is recomputed from its own expression, and what has
// no equivalent is marked \`TODO(denext migrate)\` with where it came from.`;
}

/** The migrate report lines for a generated `load-context.ts`. */
function reportWarnings(
  rel: string,
  summary: string,
  todos: string[],
  proxyTrust: ReadonlySet<string> = new Set(),
): string[] {
  const warnings = [`${rel}: getLoadContext → load-context.ts (${summary})`];
  if (todos.length > 0) {
    warnings.push(
      `load-context.ts: ${todos.length} value(s) need porting by hand — see its ` +
        `TODO(denext migrate) notes (from ${todos.join(", ")})`,
    );
  }
  if (proxyTrust.size > 0) {
    const fields = [...proxyTrust].sort().map((f) => `req.${f}`).join(", ");
    warnings.push(
      `load-context.ts: ${fields} no longer follow Express's \`trust proxy\` setting. ` +
        "`clientIp()` (req.ip) reads a proxy's X-Forwarded-For hop only with denext's " +
        "`trustForwardedHeaders` (or DENEXT_TRUST_PROXY=1), else the socket peer; req.secure, " +
        "req.protocol and req.hostname read the request's own URL, which behind a " +
        "TLS-terminating proxy is the proxy's hop (http, an internal host) — check these values " +
        "behind your proxy",
    );
  }
  return warnings;
}

/**
 * `load-context.ts` for a `getLoadContext` that returns a `RouterContextProvider` (React
 * Router 7 with middleware): the provider is rebuilt per request with each `.set(key, value)`
 * whose value carries over.
 */
function providerModule(
  dir: string,
  dest: string,
  server: ServerModule,
  translator: Translator,
  provider: ProviderReturn,
): LoadContextResult {
  const { rel } = server;
  const body = providerStatements(provider, server, translator);
  const needs = translator.needs;
  const url = needs.url ? "  const requestUrl = new URL(request.url);\n" : "";
  const helper = helpers(needs, server, translator);
  const head = providerHead(needs, /\bawait\b/.test(body.code));
  const code = `${GEN_HEADER}${moduleIntro(rel)}
${importLines(server, needs, body.code.includes("remixServerBuild()"), body.fallback).join("\n")}
${helper}
export default defineLoadContext(${head} {\n${url}${body.code}});\n`;
  const summary = ["RouterContextProvider", ...body.summary].join(", ");
  return {
    module: { dest, code, srcDir: join(dir, dirname(rel)) },
    warnings: reportWarnings(rel, summary, body.todos, translator.proxyTrust),
  };
}

/** What {@link carryLoadContext} wrote and the notes for the migrate report. */
export interface CarriedLoadContext {
  /** The files written (`load-context.ts`, and `instrumentation.ts` when it was missing). */
  written: string[];
  /** Report lines: what was wired, what is left as `TODO(denext migrate)`. */
  warnings: string[];
}

/**
 * The React Router path of `denext migrate`: the app's sources stay where they are, so the
 * custom server's `getLoadContext` becomes `load-context.ts` at the app root (its relative
 * imports re-based there) and an `instrumentation.ts` that imports it, which registers it when
 * the server boots. Returns null when the app has no custom server with a `getLoadContext`.
 *
 * @param dir The app root.
 * @returns The files written and the report notes, or null.
 */
export async function carryLoadContext(dir: string): Promise<CarriedLoadContext | null> {
  const result = await loadContextModule(dir);
  if (!result) return null;
  if (!result.module) return { written: [], warnings: result.warnings };
  const { dest, code, srcDir } = result.module;
  const destDir = dirname(dest);
  const rebased = rewriteSpecifiers(code, (spec) => {
    if (!spec.startsWith(".")) return null;
    const next = relative(destDir, join(srcDir, spec)).replace(/\\/g, "/");
    return next.startsWith(".") ? next : `./${next}`;
  });
  await mfs.writeTextFile(dest, rebased);
  const written = [dest];
  const warnings = [...result.warnings];
  const instrumentation = await firstExisting(dir, ["instrumentation.ts", "instrumentation.js"]);
  if (instrumentation === null) {
    const path = join(dir, "instrumentation.ts");
    await mfs.writeTextFile(
      path,
      `${GEN_HEADER}// Registers the app's load context (\`load-context.ts\`) when the server boots.\n` +
        `import "./load-context.ts";\n`,
    );
    written.push(path);
  } else {
    const source = await mfs.readTextFile(join(dir, instrumentation)).catch(() => "");
    if (!source.includes("load-context")) {
      warnings.push(
        `${instrumentation} already exists — add \`import "./load-context.ts";\` to it so the ` +
          "server registers the load context",
      );
    }
  }
  return { written, warnings };
}

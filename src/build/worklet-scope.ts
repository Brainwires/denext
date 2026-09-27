// Lexical scope analysis over an swc AST, for the worklets transform (reanimated.ts).
//
// The transform needs what Reanimated's Babel plugin gets from `@babel/traverse`'s scope
// tracker: for every function, which of the identifiers it reads are bound OUTSIDE it (its
// closure), and, for an identifier passed to a hook, the declaration it names. This module
// walks a parsed module once, builds the scope tree (function, block, catch, loop and class
// scopes; `var` hoisted to its function, `let`/`const`/`class`/function declarations to their
// block, imports to the module), and records every value reference with the scope it occurs
// in. Resolution happens after the walk, when every scope's declarations are known, so
// hoisting needs no pre-pass.
//
// What counts as a reference follows Babel's `ReferencedIdentifier` as the plugin uses it:
// property keys, non-computed member properties, labels, JSX element and attribute names
// (the plugin skips `JSXIdentifier`s), TypeScript type positions and the target of a plain
// assignment (`x = …`, which Babel's `isReferenced` rejects) are not references; a shorthand
// property (`{ a }`), an update (`a++`) and a default value are.

import type { Node } from "./swc-ast.ts";

/** How a name was declared. */
export type BindingKind =
  | "var"
  | "let"
  | "const"
  | "using"
  | "function"
  | "class"
  | "param"
  | "import"
  | "catch"
  | "enum";

/** A declared name. */
export interface Binding {
  /** The declared name. */
  name: string;
  /** How it was declared. */
  kind: BindingKind;
  /** The scope it is declared in. */
  scope: Scope;
  /**
   * The declaring node: a `VariableDeclarator`, `FunctionDeclaration`, class, import
   * specifier or parameter pattern.
   */
  node: Node;
  /** The declarator's initializer when the binding is the whole `id` (`const f = …`). */
  init: Node | null;
  /** The right-hand sides assigned to the name after its declaration, in source order. */
  assignments: Node[];
}

/** A lexical scope. */
export interface Scope {
  /** The enclosing scope (null for the module). */
  parent: Scope | null;
  /** Whether `var` declarations stop here (a function or the module). */
  fn: boolean;
  /** The names declared here. */
  names: Map<string, Binding>;
  /** Nesting depth (the module is 0). */
  depth: number;
}

/** A value reference: an identifier read at `scope`. */
export interface Ref {
  /** The name read. */
  name: string;
  /** The scope the read occurs in. */
  scope: Scope;
}

/** A function-like node (declaration, expression, arrow, method, accessor, constructor). */
export interface FunctionSite {
  /** The node. */
  node: Node;
  /** The scope holding its parameters and body. */
  scope: Scope;
  /** The statement list that directly contains a function declaration (else null). */
  container: Node[] | null;
}

/** A call expression and the scope it occurs in. */
export interface CallSite {
  /** The `CallExpression`. */
  node: Node;
  /** The scope the call occurs in. */
  scope: Scope;
}

/** What {@linkcode analyzeScopes} learns about a module. */
export interface ScopeAnalysis {
  /** The module scope. */
  root: Scope;
  /** Every value reference, in source order. */
  refs: Ref[];
  /** Every function-like node, keyed by the node object. */
  functions: Map<Node, FunctionSite>;
  /** Every call expression, in source order. */
  calls: CallSite[];
  /** Resolve `name` from `scope` outward (undefined for a global). */
  resolve(name: string, scope: Scope): Binding | undefined;
}

/** Keys that hold TypeScript types or type arguments: never value references. */
const TYPE_KEYS = new Set([
  "typeAnnotation",
  "typeParameters",
  "typeParams",
  "returnType",
  "superTypeParams",
  "typeArguments",
  "implements",
]);

/** TypeScript wrappers around a value expression (`x as T`, `x!`, `<T>x`, `x satisfies T`). */
const TS_VALUE_WRAPPERS = new Set([
  "TsAsExpression",
  "TsSatisfiesExpression",
  "TsNonNullExpression",
  "TsConstAssertion",
  "TsTypeAssertion",
  "TsInstantiation",
]);

/** Whether `inner` is `outer` or nested inside it. */
export function scopeWithin(inner: Scope, outer: Scope): boolean {
  for (let s: Scope | null = inner; s; s = s.parent) {
    if (s === outer) return true;
  }
  return false;
}

/** The first statement of `stmts` after its directive prologue (`"use strict"`, `"worklet"`). */
export function prologueEnd(stmts: Node[]): Node | undefined {
  return stmts.find((s) => !isDirective(s));
}

/** Whether a statement is a directive (a bare string-literal expression statement). */
function isDirective(stmt: Node): boolean {
  return stmt?.type === "ExpressionStatement" &&
    stmt.expression?.type === "StringLiteral";
}

/** The directives of a function body (empty for an expression-bodied arrow). */
export function directivesOf(body: Node | null | undefined): string[] {
  if (!body || body.type !== "BlockStatement") return [];
  const out: string[] = [];
  for (const stmt of body.stmts) {
    if (!isDirective(stmt)) break;
    out.push(stmt.expression.value);
  }
  return out;
}

/** The scope-tree builder: one walk over the module. */
class Walker {
  readonly root: Scope = { parent: null, fn: true, names: new Map(), depth: 0 };
  readonly refs: Ref[] = [];
  readonly functions = new Map<Node, FunctionSite>();
  readonly calls: CallSite[] = [];
  /** Assignments to plain identifiers, resolved once every declaration is known. */
  readonly writes: { name: string; scope: Scope; right: Node | null }[] = [];

  child(parent: Scope, fn: boolean): Scope {
    return { parent, fn, names: new Map(), depth: parent.depth + 1 };
  }

  declare(
    scope: Scope,
    name: string,
    kind: BindingKind,
    node: Node,
    init: Node | null,
  ): void {
    // `var` redeclarations and a function that shadows a parameter keep the first binding.
    if (scope.names.has(name)) return;
    scope.names.set(name, { name, kind, scope, node, init, assignments: [] });
  }

  ref(name: string, scope: Scope): void {
    this.refs.push({ name, scope });
  }

  /** Visit a statement list; function declarations remember it as their container. */
  statements(stmts: Node[], scope: Scope): void {
    for (const stmt of stmts) {
      const decl = stmt?.type === "ExportDeclaration" ? stmt.declaration : stmt;
      if (decl?.type === "FunctionDeclaration") {
        this.functionDeclaration(decl, scope, stmts);
      } else if (isNamedDefaultFunction(stmt)) {
        this.functionDeclaration(stmt.decl, scope, stmts);
      } else this.visit(stmt, scope);
    }
  }

  functionDeclaration(
    node: Node,
    scope: Scope,
    container: Node[] | null,
  ): void {
    if (node.identifier) {
      this.declare(scope, node.identifier.value, "function", node, null);
    }
    this.fn(node, scope, container);
  }

  /** A function-like node: parameters and body in a fresh function scope. */
  fn(
    node: Node,
    outer: Scope,
    container: Node[] | null = null,
    selfName?: Node,
  ): void {
    const scope = this.child(outer, true);
    this.functions.set(node, { node, scope, container });
    if (selfName) this.declare(scope, selfName.value, "function", node, null);
    const params: Node[] = node.params ?? (node.param ? [node.param] : []);
    for (const p of params) {
      this.pattern(paramPattern(p), scope, "param", p, null);
    }
    const body = node.body;
    if (!body) return;
    if (body.type === "BlockStatement") this.statements(body.stmts, scope);
    else this.visit(body, scope);
  }

  /** Declare the names a binding pattern introduces, visiting its default values. */
  pattern(
    pat: Node,
    scope: Scope,
    kind: BindingKind,
    node: Node,
    init: Node | null,
  ): void {
    if (!pat || typeof pat !== "object") return;
    switch (pat.type) {
      case "Identifier":
        this.declare(scope, pat.value, kind, node, init);
        return;
      case "AssignmentPattern":
        this.pattern(pat.left, scope, kind, node, null);
        this.visit(pat.right, scope);
        return;
      case "RestElement":
        this.pattern(pat.argument, scope, kind, node, null);
        return;
      case "ArrayPattern":
        for (const el of pat.elements) {
          if (el) this.pattern(el, scope, kind, node, null);
        }
        return;
      case "ObjectPattern":
        for (const p of pat.properties) {
          this.objectPatternProperty(p, scope, kind, node);
        }
        return;
      default:
        // An assignment target such as `a.b` in `[a.b] = x`, or an invalid node.
        this.visit(pat, scope);
    }
  }

  objectPatternProperty(
    p: Node,
    scope: Scope,
    kind: BindingKind,
    node: Node,
  ): void {
    if (p.type === "AssignmentPatternProperty") {
      this.declare(scope, p.key.value, kind, node, null);
      this.visit(p.value, scope);
    } else if (p.type === "KeyValuePatternProperty") {
      this.key(p.key, scope);
      this.pattern(p.value, scope, kind, node, null);
    } else if (p.type === "RestElement") {
      this.pattern(p.argument, scope, kind, node, null);
    }
  }

  /** An assignment target: plain names are writes (not reads), the rest is visited. */
  target(pat: Node, scope: Scope, right: Node | null): void {
    if (!pat || typeof pat !== "object") return;
    switch (pat.type) {
      case "Identifier":
        this.writes.push({ name: pat.value, scope, right });
        return;
      case "AssignmentPattern":
        this.target(pat.left, scope, null);
        this.visit(pat.right, scope);
        return;
      case "RestElement":
        this.target(pat.argument, scope, null);
        return;
      case "ArrayPattern":
        for (const el of pat.elements) if (el) this.target(el, scope, null);
        return;
      case "ObjectPattern":
        for (const p of pat.properties) this.objectTargetProperty(p, scope);
        return;
      default:
        this.visit(pat, scope);
    }
  }

  objectTargetProperty(p: Node, scope: Scope): void {
    if (p.type === "AssignmentPatternProperty") {
      this.writes.push({ name: p.key.value, scope, right: null });
      this.visit(p.value, scope);
    } else if (p.type === "KeyValuePatternProperty") {
      this.key(p.key, scope);
      this.target(p.value, scope, null);
    } else if (p.type === "RestElement") {
      this.target(p.argument, scope, null);
    }
  }

  /** A property key: only a computed key holds a value reference. */
  key(key: Node, scope: Scope): void {
    if (key?.type === "Computed") this.visit(key.expression, scope);
  }

  variableDeclaration(node: Node, scope: Scope): void {
    const kind: BindingKind = node.kind === "var"
      ? "var"
      : node.kind === "let"
      ? "let"
      : node.kind === "const"
      ? "const"
      : "using";
    let target = scope;
    if (kind === "var") {
      while (!target.fn && target.parent) target = target.parent;
    }
    for (const d of node.declarations) {
      const init = d.id?.type === "Identifier" ? d.init ?? null : null;
      this.pattern(d.id, target, kind, d, init);
      this.visit(d.init, scope);
    }
  }

  cls(node: Node, outer: Scope, declareIn: Scope | null): void {
    if (node.identifier && declareIn) {
      this.declare(declareIn, node.identifier.value, "class", node, null);
    }
    this.visit(node.superClass, outer);
    for (const d of node.decorators ?? []) this.visit(d, outer);
    const scope = this.child(outer, false);
    if (node.identifier && !declareIn) {
      this.declare(scope, node.identifier.value, "class", node, null);
    }
    for (const member of node.body ?? []) this.classMember(member, scope);
  }

  classMember(member: Node, scope: Scope): void {
    this.key(member.key, scope);
    for (const d of member.decorators ?? []) this.visit(d, scope);
    if (member.type === "Constructor") this.fn(member, scope);
    else if (member.function) this.fn(member.function, scope);
    else if (member.type === "StaticBlock") {
      this.statements(member.body.stmts, this.child(scope, true));
    } else this.visit(member.value, this.child(scope, true));
  }

  /** Visit any node. */
  visit(node: Node, scope: Scope): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) this.visit(n, scope);
    } else if (typeof node.type === "string") {
      this.typed(node, node.type, scope);
    } else {
      this.children(node, scope); // an untyped wrapper such as swc's `ExprOrSpread`
    }
  }

  /** A typed node: its handler, nothing for a TypeScript type, else its children. */
  typed(node: Node, type: string, scope: Scope): void {
    const handler = Object.hasOwn(HANDLERS, type) ? HANDLERS[type] : undefined;
    if (handler) handler(this, node, scope);
    else if (TS_VALUE_WRAPPERS.has(type)) this.visit(node.expression, scope);
    else if (!type.startsWith("Ts")) this.children(node, scope);
  }

  /** Every child of `node` that can hold a value reference. */
  children(node: Node, scope: Scope): void {
    for (const key of Object.keys(node)) {
      if (key === "span" || key === "ctxt" || TYPE_KEYS.has(key)) continue;
      const value = node[key];
      if (value && typeof value === "object") this.visit(value, scope);
    }
  }
}

/** `export default function name() {}`: a declaration (its name is a module binding). */
function isNamedDefaultFunction(stmt: Node): boolean {
  return stmt?.type === "ExportDefaultDeclaration" &&
    stmt.decl?.type === "FunctionExpression" && !!stmt.decl.identifier;
}

/** A function parameter's pattern (swc wraps them in `Parameter` / `TsParameterProperty`). */
function paramPattern(p: Node): Node {
  if (p?.type === "Parameter") return p.pat;
  if (p?.type === "TsParameterProperty") return p.param;
  return p;
}

type Handler = (w: Walker, node: Node, scope: Scope) => void;

/** Nothing inside is a value reference. */
const skip: Handler = () => {};

/** Per-node-type visitors; anything else recurses into its children. */
const HANDLERS: Record<string, Handler> = {
  Identifier: (w, n, s) => w.ref(n.value, s),
  ImportDeclaration: (w, n, s) => {
    if (n.typeOnly) return;
    for (const spec of n.specifiers) {
      w.declare(s, spec.local.value, "import", spec, null);
    }
  },
  ExportNamedDeclaration: skip,
  ExportAllDeclaration: skip,
  ExportDefaultDeclaration: (w, n, s) => {
    const decl = n.decl;
    // An anonymous function (a named one is a declaration: see `statements`).
    if (decl?.type === "FunctionExpression") w.fn(decl, s);
    else if (decl?.type === "ClassExpression") w.cls(decl, s, s);
  },
  VariableDeclaration: (w, n, s) => w.variableDeclaration(n, s),
  FunctionDeclaration: (w, n, s) => w.functionDeclaration(n, s, null),
  FunctionExpression: (w, n, s) => w.fn(n, s, null, n.identifier ?? undefined),
  ArrowFunctionExpression: (w, n, s) => w.fn(n, s),
  ClassDeclaration: (w, n, s) => w.cls(n, s, s),
  ClassExpression: (w, n, s) => w.cls(n, s, null),
  BlockStatement: (w, n, s) => w.statements(n.stmts, w.child(s, false)),
  StaticBlock: (w, n, s) => w.statements(n.body.stmts, w.child(s, true)),
  ForStatement: (w, n, s) => {
    const loop = w.child(s, false);
    w.visit(n.init, loop);
    w.visit(n.test, loop);
    w.visit(n.update, loop);
    w.visit(n.body, loop);
  },
  ForInStatement: (w, n, s) => forInOf(w, n, s),
  ForOfStatement: (w, n, s) => forInOf(w, n, s),
  CatchClause: (w, n, s) => {
    const scope = w.child(s, false);
    if (n.param) w.pattern(n.param, scope, "catch", n.param, null);
    w.statements(n.body.stmts, scope);
  },
  SwitchStatement: (w, n, s) => {
    w.visit(n.discriminant, s);
    const scope = w.child(s, false);
    for (const c of n.cases) {
      w.visit(c.test, scope);
      w.statements(c.consequent, scope);
    }
  },
  // Babel visits a do-while's body before its test (the closure lists names in that order).
  DoWhileStatement: (w, n, s) => {
    w.visit(n.body, s);
    w.visit(n.test, s);
  },
  LabeledStatement: (w, n, s) => w.visit(n.body, s),
  BreakStatement: skip,
  ContinueStatement: skip,
  MemberExpression: (w, n, s) => {
    w.visit(n.object, s);
    if (n.property?.type === "Computed") w.visit(n.property.expression, s);
  },
  SuperPropExpression: (w, n, s) => {
    if (n.property?.type === "Computed") w.visit(n.property.expression, s);
  },
  CallExpression: (w, n, s) => {
    w.calls.push({ node: n, scope: s });
    w.visit(n.callee, s);
    w.visit(n.arguments, s);
  },
  AssignmentExpression: (w, n, s) => {
    // Babel's `isReferenced` rejects every assignment target, compound ones included.
    w.target(n.left, s, n.operator === "=" ? n.right : null);
    w.visit(n.right, s);
  },
  UpdateExpression: (w, n, s) => {
    if (n.argument?.type === "Identifier") {
      w.ref(n.argument.value, s);
      w.writes.push({ name: n.argument.value, scope: s, right: null });
    } else {
      w.visit(n.argument, s);
    }
  },
  ObjectExpression: (w, n, s) => {
    for (const p of n.properties) objectProperty(w, p, s);
  },
  JSXOpeningElement: (w, n, s) => w.visit(n.attributes, s),
  JSXClosingElement: skip,
  JSXAttribute: (w, n, s) => w.visit(n.value, s),
  JSXMemberExpression: skip,
  JSXNamespacedName: skip,
  JSXText: skip,
  MetaProperty: skip,
  PrivateName: skip,
  ThisExpression: skip,
  TsEnumDeclaration: (w, n, s) => w.declare(s, n.id.value, "enum", n, null),
};

function forInOf(w: Walker, n: Node, s: Scope): void {
  const loop = w.child(s, false);
  if (n.left?.type === "VariableDeclaration") w.visit(n.left, loop);
  else w.target(n.left, loop, null);
  w.visit(n.right, loop);
  w.visit(n.body, loop);
}

function objectProperty(w: Walker, p: Node, s: Scope): void {
  switch (p.type) {
    case "Identifier": // shorthand `{ a }`
      w.ref(p.value, s);
      return;
    case "KeyValueProperty":
      w.key(p.key, s);
      w.visit(p.value, s);
      return;
    case "MethodProperty":
    case "GetterProperty":
    case "SetterProperty":
      w.key(p.key, s);
      w.fn(p, s);
      return;
    default: // SpreadElement, AssignmentProperty
      w.visit(p, s);
  }
}

/**
 * Walk a parsed module (its top-level statements) and build its scope tree.
 *
 * @param body The module's top-level statements.
 * @returns The scope tree, references, function sites and calls.
 */
export function analyzeScopes(body: Node[]): ScopeAnalysis {
  const w = new Walker();
  w.statements(body, w.root);
  const resolve = (name: string, scope: Scope): Binding | undefined => {
    for (let s: Scope | null = scope; s; s = s.parent) {
      const b = s.names.get(name);
      if (b) return b;
    }
    return undefined;
  };
  for (const write of w.writes) {
    const b = resolve(write.name, write.scope);
    if (b && write.right) b.assignments.push(write.right);
    else if (b) b.assignments.push({ type: "__unknown" });
  }
  return {
    root: w.root,
    refs: w.refs,
    functions: w.functions,
    calls: w.calls,
    resolve,
  };
}

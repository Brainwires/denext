/**
 * `@denext/swc` — a Deno-native WebAssembly build of
 * [swc](https://github.com/swc-project/swc)'s parse / print / transform / minify
 * bindings, mirroring swc's own `binding_core_wasm` (the crate `@swc/wasm-web` is
 * built from). Rebuilt for Deno with `jsr:@deno/wasmbuild`, so it carries **zero
 * npm dependencies** and instantiates at import via Deno's native `.wasm` ESM
 * support.
 *
 * The JS API matches `@swc/wasm-web`: the same eight functions, the same option
 * objects (swc's `ParseOptions` / `Options` / `JsMinifyOptions`, passed through to
 * the wasm verbatim), the same results. denext's build pipeline
 * (`src/build/swc-ast.ts`) uses `parse`; the rest are exported for API parity.
 *
 * @example Parse TypeScript to an AST
 * ```ts
 * import { parse } from "@denext/swc";
 * const ast = await parse("const x: number = 1", { syntax: "typescript", target: "es2022" });
 * ast.type; // "Module"
 * ```
 *
 * @example Transform + minify
 * ```ts
 * import { minifySync, transformSync } from "@denext/swc";
 * const { code } = transformSync("const a = <b/>;", {
 *   jsc: { parser: { syntax: "ecmascript", jsx: true }, target: "es2020" },
 * });
 * const small = minifySync(code, { compress: true, mangle: true }).code;
 * ```
 *
 * @module
 */
import * as wasm from "./lib/denext_swc.js";

/**
 * swc `ParseOptions` — the parser configuration `parse` / `parseSync` take. Passed to
 * the wasm verbatim; the fields below are the common ones, and any other swc parser
 * option is accepted through the index signature.
 */
export interface ParseOptions {
  /** `"ecmascript"` (default) or `"typescript"`. */
  syntax?: "ecmascript" | "typescript";
  /** TypeScript: also parse JSX (`.tsx`). */
  tsx?: boolean;
  /** ECMAScript: also parse JSX. */
  jsx?: boolean;
  /** Parse decorators. */
  decorators?: boolean;
  /** Keep comments on the AST. */
  comments?: boolean;
  /** Parse as a script (no `import`/`export`) rather than a module. */
  isModule?: boolean | "unknown";
  /** ECMAScript version the input targets, e.g. `"es2022"`. */
  target?: string;
  /** Any other swc parser option. */
  [option: string]: unknown;
}

/**
 * swc `Options` — the transform configuration `transform` / `transformSync` take (the
 * `.swcrc` shape: `jsc`, `module`, `minify`, `sourceMaps`, …). Passed to the wasm
 * verbatim.
 */
export interface Options {
  /** Parser + transform settings (`parser`, `target`, `transform`, `minify`, …). */
  jsc?: Record<string, unknown>;
  /** Output module format (`{ type: "es6" | "commonjs" | … }`). */
  module?: Record<string, unknown>;
  /** Minify the output. */
  minify?: boolean;
  /** Emit a source map (`true`, `false`, or `"inline"`). */
  sourceMaps?: boolean | "inline";
  /** The input's file name (for source maps and error messages). */
  filename?: string;
  /** Any other swc option. */
  [option: string]: unknown;
}

/** swc `JsMinifyOptions` — the minifier configuration `minify` / `minifySync` take. */
export interface JsMinifyOptions {
  /** Compression passes (`true` for defaults, or an object of terser-style options). */
  compress?: boolean | Record<string, unknown>;
  /** Name mangling (`true` for defaults, or an object of options). */
  mangle?: boolean | Record<string, unknown>;
  /** Output formatting options. */
  format?: Record<string, unknown>;
  /** Emit a source map. */
  sourceMap?: boolean;
  /** Parse the input as a module (default `true`). */
  module?: boolean;
  /** Any other swc minifier option. */
  [option: string]: unknown;
}

/**
 * A parsed swc program: the root AST node (`Module` or `Script`) with its `body` of
 * statements and a byte-offset `span`. Node shapes follow swc's `@swc/types`; they are
 * kept open here because the full AST typing is a 60 KB declaration this package
 * deliberately omits.
 */
export interface Program {
  /** `"Module"` (has `import`/`export`) or `"Script"`. */
  type: "Module" | "Script";
  /** Top-level statements / module items. */
  body: unknown[];
  /** Source span (`start`/`end` are UTF-8 byte offsets, `ctxt` the syntax context). */
  span: { start: number; end: number; ctxt?: number };
  /** Any other AST field (`interpreter`, `comments`, …). */
  [field: string]: unknown;
}

/** The result of a print / transform / minify: generated code and, when requested, its map. */
export interface Output {
  /** The generated JavaScript. */
  code: string;
  /** The source map (JSON string), when the options asked for one. */
  map?: string;
}

/** swc's parser options are tagged by `syntax` (a required field upstream); default it. */
function withSyntax(options: ParseOptions): ParseOptions {
  return options.syntax ? options : { ...options, syntax: "ecmascript" };
}

/**
 * Parse source text to an swc AST asynchronously.
 *
 * @param source The JavaScript / TypeScript source.
 * @param options Parser options (`syntax` — defaults to `"ecmascript"` — `tsx`, `target`, …).
 * @returns The program's root node.
 */
export function parse(
  source: string,
  options: ParseOptions = { syntax: "ecmascript" },
): Promise<Program> {
  return wasm.parse(source, withSyntax(options)) as Promise<Program>;
}

/**
 * Parse source text to an swc AST synchronously.
 *
 * @param source The JavaScript / TypeScript source.
 * @param options Parser options (`syntax` — defaults to `"ecmascript"` — `tsx`, `target`, …).
 * @returns The program's root node.
 */
export function parseSync(
  source: string,
  options: ParseOptions = { syntax: "ecmascript" },
): Program {
  return wasm.parseSync(source, withSyntax(options)) as Program;
}

/**
 * Print an AST back to source asynchronously (swc's code generator).
 *
 * @param program A root node from `parse` / `parseSync`, possibly modified.
 * @param options swc options (`jsc.target`, `minify`, `sourceMaps`, …).
 * @returns The generated code (+ map).
 */
export function print(program: Program, options: Options = {}): Promise<Output> {
  return wasm.print(program, options) as Promise<Output>;
}

/**
 * Print an AST back to source synchronously (swc's code generator).
 *
 * @param program A root node from `parse` / `parseSync`, possibly modified.
 * @param options swc options (`jsc.target`, `minify`, `sourceMaps`, …).
 * @returns The generated code (+ map).
 */
export function printSync(program: Program, options: Options = {}): Output {
  return wasm.printSync(program, options) as Output;
}

/**
 * Transform source text (or an AST) asynchronously: TypeScript / JSX / syntax lowering
 * per `options.jsc`, module conversion per `options.module`.
 *
 * @param input Source text, or a root node from `parse`.
 * @param options swc `.swcrc`-shaped options.
 * @returns The transformed code (+ map).
 */
export function transform(input: string | Program, options: Options = {}): Promise<Output> {
  return wasm.transform(input, options, undefined) as Promise<Output>;
}

/**
 * Transform source text (or an AST) synchronously.
 *
 * @param input Source text, or a root node from `parseSync`.
 * @param options swc `.swcrc`-shaped options.
 * @returns The transformed code (+ map).
 */
export function transformSync(input: string | Program, options: Options = {}): Output {
  return wasm.transformSync(input, options, undefined) as Output;
}

/**
 * Minify source text asynchronously (swc's minifier: compress + mangle).
 *
 * @param source The JavaScript source.
 * @param options Minifier options.
 * @returns The minified code (+ map).
 */
export function minify(source: string, options: JsMinifyOptions = {}): Promise<Output> {
  return wasm.minify(source, options) as Promise<Output>;
}

/**
 * Minify source text synchronously (swc's minifier: compress + mangle).
 *
 * @param source The JavaScript source.
 * @param options Minifier options.
 * @returns The minified code (+ map).
 */
export function minifySync(source: string, options: JsMinifyOptions = {}): Output {
  return wasm.minifySync(source, options) as Output;
}

/**
 * No-op initializer. The wasm self-instantiates at import time (native `.wasm`
 * ESM), so no explicit init is needed — this exists only so callers written for
 * `@swc/wasm-web` (whose default export must be `await`ed before use) work
 * unchanged.
 *
 * @returns A resolved promise.
 */
export default function init(): Promise<void> {
  return Promise.resolve();
}

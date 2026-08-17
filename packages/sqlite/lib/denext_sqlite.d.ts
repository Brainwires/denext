// @generated file from wasmbuild -- do not edit
// deno-lint-ignore-file
// deno-fmt-ignore-file

export class WasmDatabase {
  free(): void;
  [Symbol.dispose](): void;
  close(): void;
  /**
   * Register a JavaScript callback as a SQL scalar function.
   *
   * The callback receives the evaluated arguments as JS values and must
   * return synchronously (async callbacks are deferred to a later
   * release). Pass `n_args = -1` for variadic.
   *
   * User-defined functions cannot shadow built-ins — the engine resolves
   * known names (`UPPER`, `JSON_EXTRACT`, `vec_distance_cosine`, …) before
   * consulting the UDF registry.
   */
  createFunction(name: string, n_args: number, callback: Function): void;
  /**
   * Remove a previously-registered user-defined function. Returns true if
   * a function by that name existed.
   */
  deleteFunction(name: string): boolean;
  exec(sql: string): bigint;
  execMany(sql: string): void;
  execParams(sql: string, params: any): bigint;
  flush(): void;
  static fromBuffer(data: Uint8Array): WasmDatabase;
  constructor();
  static openInMemory(): WasmDatabase;
  static openPersisted(
    name: string,
    chunk_size?: bigint | null,
    max_shards?: number | null,
  ): Promise<WasmDatabase>;
  /**
   * Open (or create) a database backed by a real file on the host
   * filesystem, via `node:fs`. Available on the Node/Deno build only.
   * Synchronous — unlike the OPFS/IDB backends there are no async handles to
   * pre-register. `path` is used verbatim (absolute or relative to cwd).
   */
  static openWithFile(path: string): WasmDatabase;
  static openWithIdb(
    name: string,
    chunk_size?: bigint | null,
  ): Promise<WasmDatabase>;
  static openWithOpfs(
    name: string,
    chunk_size?: bigint | null,
    max_shards?: number | null,
  ): Promise<WasmDatabase>;
  query(sql: string): any;
  queryOne(sql: string): any;
  queryParams(sql: string, params: any): any;
  toBuffer(): Uint8Array;
}

export function init(): void;

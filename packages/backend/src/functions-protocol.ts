// The messages between the Edge Functions host (`functions.ts`) and a function's worker
// (`functions-worker.ts`). Types only.

/** Host → worker. */
export type HostMessage =
  | {
    /** Load the function's module, with `env` overlaid on `Deno.env`. */
    t: "init";
    module: string;
    env: Record<string, string>;
  }
  | {
    /** One request, its body buffered. */
    t: "req";
    id: number;
    url: string;
    method: string;
    headers: [string, string][];
    body: ArrayBuffer | null;
    /** The client's address, as `info.remoteAddr.hostname`. */
    remote?: string;
  }
  | {
    /** The client went away, or the request timed out. */
    t: "abort";
    id: number;
  };

/** Worker → host. */
export type WorkerMessage =
  | { t: "ready" }
  | { t: "fail"; message: string }
  | {
    t: "head";
    id: number;
    status: number;
    statusText: string;
    headers: [string, string][];
  }
  | { t: "chunk"; id: number; data: Uint8Array }
  | { t: "end"; id: number }
  /** The worker received the host's `abort` for request `id` (a busy worker cannot answer). */
  | { t: "aborted"; id: number }
  | { t: "error"; id: number; message: string };

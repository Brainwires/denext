// The wire format between the app (src/sync-client.ts) and its backend (backend/app/api/*).
//
// Uploads use the shape PowerSync's backend demos post from a connector's `uploadData`: a
// `batch` of CRUD operations, each `{ op: "PUT" | "PATCH" | "DELETE", table, id, data? }`. The
// same route therefore takes this example's own upload queue and a real PowerSync client's
// (see /docs/powersync). Downloads are this example's own: the rows changed since a checkpoint.
// In a PowerSync deployment the PowerSync Service streams those from the database instead.

/** The tables the backend accepts writes to. */
const TABLES = ["notes"] as const;
/** One of {@linkcode TABLES}. */
export type TableName = typeof TABLES[number];

/** A note as both sides store it. */
export interface Note {
  readonly id: string;
  readonly body: string;
  /** When the device last changed it, in ms since the epoch. */
  readonly updated_at: number;
}

/** One queued write: PowerSync's `CrudEntry` as its connectors upload it. */
export interface CrudOp {
  readonly op: "PUT" | "PATCH" | "DELETE";
  readonly table: TableName;
  readonly id: string;
  /** The row's columns for PUT, the changed ones for PATCH; absent for DELETE. */
  readonly data?: Readonly<Record<string, unknown>>;
}

/** `POST /api/data`'s body. */
export interface UploadBody {
  readonly batch: readonly CrudOp[];
}

/** `GET /api/changes?since=<checkpoint>`'s answer. */
export interface ChangesResponse {
  /** The checkpoint to ask from next time. */
  readonly checkpoint: number;
  /** Every row changed after `since`, deletions as `deleted: true`. */
  readonly rows: ReadonlyArray<Note & { readonly deleted: boolean }>;
}

/** The most operations one upload may carry. */
export const MAX_BATCH = 500;
/** The longest note body, in characters. */
const MAX_BODY = 10_000;

const OPS = new Set(["PUT", "PATCH", "DELETE"]);
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Why an operation's op, table or id is not valid, or null. */
function headProblem(op: Record<string, unknown>): string | null {
  if (!OPS.has(op.op as string)) return "op must be PUT, PATCH or DELETE";
  if (!(TABLES as readonly unknown[]).includes(op.table)) {
    return "unknown table";
  }
  const idOk = typeof op.id === "string" && ID.test(op.id);
  return idOk ? null : "id must be 1-64 of [A-Za-z0-9_-]";
}

/** Why a PUT / PATCH's `data` is not valid, or null. */
function dataProblem(
  put: boolean,
  data: Record<string, unknown>,
): string | null {
  const body = data.body;
  if (put && typeof body !== "string") return "PUT needs data.body";
  if (
    body !== undefined && (typeof body !== "string" || body.length > MAX_BODY)
  ) {
    return `data.body must be a string of at most ${MAX_BODY} characters`;
  }
  const stamp = data.updated_at;
  return stamp === undefined || Number.isSafeInteger(stamp)
    ? null
    : "data.updated_at must be an integer";
}

/** Why `value` is not a valid {@linkcode CrudOp}, or null when it is. */
function opProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "not an object";
  const op = value as Record<string, unknown>;
  const head = headProblem(op);
  if (head || op.op === "DELETE") return head;
  const data = op.data;
  if (typeof data !== "object" || data === null) {
    return "data is required for PUT and PATCH";
  }
  return dataProblem(op.op === "PUT", data as Record<string, unknown>);
}

/**
 * Check an upload body.
 *
 * @param value The parsed JSON body.
 * @returns The batch, or the first problem as a message.
 */
export function parseUpload(
  value: unknown,
): { batch: CrudOp[] } | { error: string } {
  const batch = (value as { batch?: unknown } | null)?.batch;
  if (!Array.isArray(batch)) return { error: "body must be { batch: [...] }" };
  if (batch.length > MAX_BATCH) {
    return { error: `at most ${MAX_BATCH} operations per batch` };
  }
  for (const [i, op] of batch.entries()) {
    const problem = opProblem(op);
    if (problem) return { error: `batch[${i}]: ${problem}` };
  }
  return { batch: batch as CrudOp[] };
}

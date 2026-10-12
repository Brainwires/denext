// The sign route's body, as a hand-rolled Standard Schema (no validator dependency): `defineApi`
// runs it before the handler, and a mismatch is the typed API's structured 400.

import type { StandardSchemaV1 } from "@denext/denext/server";
import type { StorageTransform } from "./shared.ts";

/** `POST /_denext/storage/sign` bodies. */
export type SignRequest =
  | {
    op: "upload";
    bucket: string;
    key?: string;
    contentType: string;
    size: number;
    filename?: string;
  }
  | { op: "complete"; token: string; parts?: { partNumber: number; etag: string }[] }
  | { op: "abort"; token: string }
  | {
    op: "download";
    bucket: string;
    key: string;
    expiresIn?: number;
    transform?: StorageTransform;
  };

type Issue = { message: string; path: (string | number)[] };
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max = 2048): v is string => typeof v === "string" && v.length <= max;
const isInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** Field checkers per op: each returns an issue message for a bad field, or `null`. */
const FIELDS: Record<SignRequest["op"], Record<string, (v: unknown) => string | null>> = {
  upload: {
    bucket: (v) => isStr(v, 64) ? null : "must be a string",
    key: (v) => v === undefined || isStr(v) ? null : "must be a string",
    contentType: (v) => isStr(v, 255) ? null : "must be a string",
    size: (v) => isInt(v) ? null : "must be a non-negative integer",
    filename: (v) => v === undefined || isStr(v, 1024) ? null : "must be a string",
  },
  complete: {
    token: (v) => isStr(v, 8192) ? null : "must be a string",
    parts: (v) =>
      v === undefined || validParts(v) ? null : "must be a list of { partNumber, etag }",
  },
  abort: { token: (v) => isStr(v, 8192) ? null : "must be a string" },
  download: {
    bucket: (v) => isStr(v, 64) ? null : "must be a string",
    key: (v) => isStr(v) ? null : "must be a string",
    expiresIn: (v) => v === undefined || (isInt(v) && v > 0) ? null : "must be a positive integer",
    transform: (v) =>
      v === undefined || validTransform(v) ? null : "must be { width, height, quality, format }",
  },
};

function validParts(v: unknown): boolean {
  return Array.isArray(v) && v.length <= 10_000 &&
    v.every((p) => isObj(p) && isInt(p.partNumber) && isStr(p.etag, 256));
}

function validTransform(v: unknown): boolean {
  if (!isObj(v)) return false;
  const numbers = ["width", "height", "quality"].every((k) => v[k] === undefined || isInt(v[k]));
  const format = v.format === undefined || v.format === "webp" || v.format === "avif";
  return numbers && format &&
    Object.keys(v).every((k) => ["width", "height", "quality", "format"].includes(k));
}

function validate(value: unknown): { value: SignRequest } | { issues: Issue[] } {
  if (!isObj(value)) return { issues: [{ message: "body must be an object", path: [] }] };
  const fields = FIELDS[value.op as SignRequest["op"]];
  if (typeof value.op !== "string" || !Object.hasOwn(FIELDS, value.op) || !fields) {
    return {
      issues: [{ message: "op must be upload, complete, abort or download", path: ["op"] }],
    };
  }
  const issues: Issue[] = [];
  for (const [name, check] of Object.entries(fields)) {
    const message = check(value[name]);
    if (message) issues.push({ message, path: [name] });
  }
  for (const name of Object.keys(value)) {
    if (name !== "op" && !Object.hasOwn(fields, name)) {
      issues.push({ message: "unknown field", path: [name] });
    }
  }
  return issues.length ? { issues } : { value: value as SignRequest };
}

/** The Standard Schema `defineApi` validates the sign route's body with. */
export const signSchema: StandardSchemaV1<SignRequest> = {
  "~standard": { version: 1, vendor: "denext-backend", validate },
};

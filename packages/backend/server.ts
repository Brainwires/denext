/**
 * `@denext/backend/server` — the storage server API, the app's Postgres client (`db()`, scoped
 * by row-level security; `db.service()` bypasses it) and realtime on the server (`onTableChange`,
 * `tableChanges`), for route handlers, Server Actions, Server Components and jobs.
 *
 * ```ts
 * // app/api/avatar/route.ts
 * import { storage } from "@denext/backend/server";
 *
 * export async function POST(request: Request): Promise<Response> {
 *   const avatars = storage.bucket("avatars"); // authorize() runs with this request's session
 *   const upload = await avatars.createSignedUploadUrl("u1/me.png", { contentType: "image/png" });
 *   return Response.json(upload);
 * }
 * ```
 *
 * Every operation enforces the bucket's rules. Inside a request, the bucket's `authorize` runs
 * with that request's session (`auth()` under `denextAuth`); outside one (a job, a script) the
 * call is trusted. `storage.bucket(name, { service: true })` skips `authorize` inside a request
 * too, for the server acting on its own behalf.
 *
 * @module
 */

export { storage } from "./src/storage.ts";
export { db } from "./src/postgres.ts";
export type { Db } from "./src/postgres.ts";
export type { DbIdentity, DbOptions, DbUser, RlsRole, RlsScope } from "./src/rls.ts";
export {
  ANON_IDENTITY,
  IdentityError,
  identityScope,
  isIdentityError,
  resolveIdentity,
} from "./src/identity.ts";
export type {
  IdentityErrorCode,
  IdentityRole,
  RequestIdentity,
  ResolveIdentityOptions,
} from "./src/identity.ts";
export { onTableChange, RealtimeUnsupportedError, tableChanges } from "./src/realtime.ts";
export { broadcast } from "./src/realtime-socket.ts";
export type { TableChangeEvent, TableChangesOptions } from "./src/realtime.ts";
export type {
  FilterOp,
  FilterValue,
  TableChange,
  TableChangesFrame,
  TableEvent,
  TableFilter,
} from "./src/realtime-shared.ts";
export { isStorageError, StorageError } from "./src/errors.ts";
export type { StorageErrorCode } from "./src/errors.ts";
export type { StorageTransform } from "./src/shared.ts";
export type { StorageIdentity, StorageRole } from "./src/storage-identity.ts";
export type {
  BucketAccessOptions,
  BucketInfo,
  BucketSettings,
  FolderEntry,
  FolderListOptions,
  ListedObject,
  ListOptions,
  ListResult,
  MultipartUpload,
  ObjectDetails,
  ObjectInfo,
  SignedUpload,
  SignedUploadOptions,
  SignedUrlOptions,
  Storage,
  StorageBucket,
  StoredObject,
  TransferOptions,
  UploadBody,
  UploadOptions,
} from "./src/types.ts";

---
title: File uploads
slug: uploads
lead: A File through a Server Action (small, form-native, under actionMaxBodyBytes), a route handler for anything bigger (request.formData() or a streamed body to disk or S3, with the cap lifted per route), an XHR upload with progress from a client component, and the one thing not to do.
---

Three shapes, chosen by size and by whether you need progress. All of them are
web-standard: a `File` in a `FormData`, a `Request` with a body, a
`ReadableStream` you pipe somewhere.

| Shape                                  | Use when                                                    | Body cap                                                                       |
| -------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Server Action with a `File` field      | An avatar, a CSV, anything a form submits and a page awaits | `actionMaxBodyBytes` in `denext.config.ts` — default 1 MiB, over it → `413`    |
| Route handler, `request.formData()`    | Larger files, an API a non-browser client calls             | `apiMaxBodyBytes` (default 1 MiB), or `export const maxBodyBytes` on the route |
| Route handler, streamed `request.body` | Big files straight to disk or object storage, no buffering  | `export const maxBodyBytes = false` to lift it                                 |

## A Server Action that receives a `File`

The form posts multipart; the action gets the `FormData` and the field is a
`File`. Works with JavaScript off (a native form post) and on (the client
runtime posts the same multipart body and awaits the result).

```ts
// app/actions.ts
"use server";
import { ActionValidationError, defineAction } from "denext/server";

export const uploadAvatar = defineAction({
  input: (f) => {
    const file = f.avatar; // FormDataEntryValue: string | File
    if (!(file instanceof File) || file.size === 0) {
      throw new ActionValidationError("bad", { avatar: "Choose an image" });
    }
    if (!file.type.startsWith("image/")) {
      throw new ActionValidationError("bad", { avatar: "Images only" });
    }
    return { file };
  },
  handler: async ({ file }) => {
    const name = `${crypto.randomUUID()}.${file.type.split("/")[1] ?? "bin"}`;
    await Deno.writeFile(
      `./uploads/${name}`,
      new Uint8Array(await file.arrayBuffer()),
    );
    return { name };
  },
});
```

```tsx
// app/avatar-form.tsx
"use client";
import { idleActionState, useActionState } from "denext";
import { uploadAvatar } from "./actions.ts";

export function AvatarForm() {
  const [state, action, pending] = useActionState(
    uploadAvatar,
    idleActionState<{ name: string }>(),
  );
  return (
    <form action={action} encType="multipart/form-data">
      <input type="file" name="avatar" accept="image/*" required />
      <button type="submit" disabled={pending}>
        {pending ? "Uploading…" : "Upload"}
      </button>
      {!state.ok && state.fieldErrors?.avatar && <p role="alert">{state.fieldErrors.avatar}</p>}
      {state.ok && <p>Saved as {state.data.name}</p>}
    </form>
  );
}
```

A plain `"use server"` function taking `(formData: FormData)` works the same way
— `formData.get("avatar")` is the `File`. `defineAction` adds the typed input
and the `fieldErrors` that flow into `useActionState`.

### The cap, and what a too-large upload looks like

Every Server Action request is bounded by **`actionMaxBodyBytes`** (default 1
MiB, Next's default). The check runs **before the action is resolved or
decoded**: a declared `Content-Length` over the cap, or a chunked body that
crosses it while buffering, is answered `413` with the JSON body
`{ "error": "payload too large" }`. The action never runs, so no
`ActionValidationError` and no `fieldErrors` — on the client the dispatch throws
`Error("payload too large")`, and `useActionState` re-throws it from the next
render into the nearest `error.tsx` boundary. A body that stalls for 30 s
between chunks is answered `408` the same way.

So an action that accepts files should raise the cap to what it expects, and the
form should check `file.size` on the client for the friendly message:

```ts
// denext.config.ts
export default {
  actionMaxBodyBytes: 10 * 1024 * 1024, // 10 MiB across every action
};
```

The cap is global to actions. For anything a single action should not carry — a
video, a backup — use a route handler, which caps per route.

## A route handler

A `route.ts` handler is a `Request` in, a `Response` out. Its body is bounded by
`apiMaxBodyBytes` (default 1 MiB) unless the route says otherwise with
`export const maxBodyBytes`; a declared over-cap `Content-Length` is a `413`
before the handler runs, and a chunked body errors the stream as the handler
reads past the cap. `defineApi`'s `body` schema is for JSON, so an upload
handler is a plain function.

### Buffered: `request.formData()`

```ts
// app/api/upload/route.ts
import { ApiError } from "denext/server";

export const maxBodyBytes = 50 * 1024 * 1024; // 50 MiB for this route only

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new ApiError(400, "missing_file");
  const path = `./uploads/${crypto.randomUUID()}-${file.name.replace(/[^\w.-]/g, "_")}`;
  await Deno.writeFile(path, new Uint8Array(await file.arrayBuffer()));
  return Response.json({ path, size: file.size });
}
```

`request.formData()` parses the whole body in memory (that is the platform API,
not a denext limit) — fine for tens of megabytes, not for a gigabyte.

### Streamed: `request.body` to disk or S3

Send the raw file as the body (`fetch(url, { method: "PUT", body: file })`) and
pipe the stream; nothing is buffered, and the per-route cap is lifted because
the destination bounds it:

```ts
// app/api/upload/[name]/route.ts
import { ApiError } from "denext/server";

export const maxBodyBytes = false; // unbounded: the stream goes straight to its destination

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  if (!request.body) throw new ApiError(400, "empty_body");
  const { name } = await params;
  const safe = name.replace(/[^\w.-]/g, "_");
  const file = await Deno.open(`./uploads/${safe}`, {
    write: true,
    create: true,
    truncate: true,
  });
  await request.body.pipeTo(file.writable); // closes the file when the stream ends
  return Response.json({ name: safe });
}
```

For object storage, hand the same stream to the SDK — `@aws-sdk/lib-storage`'s
`Upload` takes a `ReadableStream` body — or, better for a browser client, sign a
pre-signed URL in a route handler and let the browser `PUT` to S3 directly so
the bytes never pass through denext.

Two operational notes for big uploads: `requestTimeout` (default 30 s) bounds
the **whole** request, so raise it (or set `0`) for a route that expects long
transfers, and the drain on shutdown waits `DENEXT_SHUTDOWN_DRAIN_MS` (10 s
default) for in-flight requests — see [Deployment](/docs/deploy).

## An upload with progress from a client component

`fetch` reports no upload progress; `XMLHttpRequest` does. A small hook around
it:

```tsx
// app/uploader.tsx
"use client";
import { useState } from "denext";

function upload(
  url: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => resolve(new Response(xhr.response, { status: xhr.status }));
    xhr.onerror = () => reject(new Error("network error"));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

export function Uploader() {
  const [pct, setPct] = useState<number | null>(null);
  const [result, setResult] = useState<string | null>(null);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const file = new FormData(e.currentTarget).get("file");
        if (!(file instanceof File)) return;
        setPct(0);
        const res = await upload("/api/upload", file, setPct);
        setResult(res.ok ? "Done" : `Failed (${res.status})`);
        setPct(null);
      }}
    >
      <input type="file" name="file" required />
      <button type="submit" disabled={pct !== null}>Upload</button>
      {pct !== null && <progress value={pct} max={100}>{pct}%</progress>}
      {result && <p>{result}</p>}
    </form>
  );
}
```

The handler is the `POST /api/upload` route above. A same-origin request carries
the session cookie, so the handler can call `auth()` or `getSession()` like any
other.

## What not to do

- **Base64 in JSON.** Reading the file into a string and posting
  `{ data: "iVBORw0…" }` grows it by a third, costs a decode on both ends, and
  lands under the JSON body cap. A `File` in a `FormData`, or the file as the
  body, is smaller and streams.
- **Trusting the file name.** `file.name` is client data. Generate your own, or
  strip it to `[\w.-]` as above; never join it into a path unchanged.
- **Trusting `file.type`.** It is whatever the browser (or a `curl`) said. Sniff
  the bytes when the type matters (`@denext/photon` decodes images and fails on
  anything that is not one).
- **Serving uploads from the app directory.** Write outside `public/` and serve
  through a handler that checks authorization, or from object storage with its
  own policy.
- **Raising `actionMaxBodyBytes` to lift a route handler's cap** (or the
  reverse). They are independent: actions share one global cap, routes cap per
  file.

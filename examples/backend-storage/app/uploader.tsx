"use client";
import { useState } from "denext";
import { getFileUrl, uploadFile } from "@denext/backend/client";

/** What the picker shows: idle, a progress fraction, the stored file's link, or an error. */
type Status =
  | { kind: "idle" }
  | { kind: "sending"; fraction: number }
  | { kind: "done"; href: string }
  | { kind: "failed"; message: string };

export function Uploader(
  { bucket, accept }: { bucket: string; accept: string },
) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function send(file: File) {
    const stored = await uploadFile(bucket, file, {
      onProgress: ({ loaded, total }) => setStatus({ kind: "sending", fraction: loaded / total }),
    });
    setStatus({ kind: "done", href: await getFileUrl(bucket, stored.key) });
  }

  function onChange(event: { currentTarget: HTMLInputElement }) {
    const file = event.currentTarget.files?.item(0);
    if (!file) return;
    send(file).catch((err: Error) => setStatus({ kind: "failed", message: err.message }));
  }

  return (
    <p>
      <input type="file" accept={accept} onChange={onChange} />
      <StatusLine status={status} />
    </p>
  );
}

function StatusLine({ status }: { status: Status }) {
  switch (status.kind) {
    case "sending":
      return <progress value={status.fraction} max={1} />;
    case "done":
      return (
        <a href={status.href} target="_blank" rel="noreferrer">
          Open the uploaded file
        </a>
      );
    case "failed":
      return <strong role="alert">{status.message}</strong>;
    default:
      return null;
  }
}

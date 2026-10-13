"use client";
import { useState } from "denext";
import { uploadResumable } from "@denext/backend/client";

/** A large file, uploaded resumably (TUS) in 6 MiB chunks: a dropped chunk is retried. */
export function ResumableUploader(
  { bucket, accept }: { bucket: string; accept: string },
) {
  const [percent, setPercent] = useState<number | null>(null);
  const [message, setMessage] = useState("");

  async function send(file: File) {
    await uploadResumable(bucket, `big/${file.name}`, file, {
      upsert: true,
      onProgress: ({ loaded, total }) => setPercent(Math.round((loaded / total) * 100)),
    });
    setMessage(`stored big/${file.name}`);
  }

  return (
    <p>
      <input
        type="file"
        accept={accept}
        onChange={(event: { currentTarget: HTMLInputElement }) => {
          const picked = event.currentTarget.files?.item(0);
          if (picked) send(picked).catch((err: Error) => setMessage(err.message));
        }}
      />
      {percent !== null && <progress value={percent} max={100} />}
      {message && <span>{message}</span>}
    </p>
  );
}

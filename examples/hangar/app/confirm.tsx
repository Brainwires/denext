"use client";
// The confirm step every destructive action goes through: the first click asks the user to type
// the target's name, and only that exact name enables the action (the backend checks it again).

import { useState } from "denext";

export function ConfirmButton(props: {
  label: string;
  /** What the user must type (the VM id, the file or the snapshot name). */
  expected: string;
  onConfirm: (typed: string) => Promise<void> | void;
  disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  if (!asking) {
    return (
      <button
        type="button"
        className="danger"
        disabled={props.disabled}
        onClick={() => setAsking(true)}
      >
        {props.label}
      </button>
    );
  }
  return (
    <span className="confirm">
      <label>
        Type <code>{props.expected}</code> to confirm:{" "}
        <input
          value={typed}
          autoFocus
          onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
        />
      </label>
      <button
        type="button"
        className="danger"
        disabled={typed !== props.expected || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await props.onConfirm(typed);
          } finally {
            setBusy(false);
            setAsking(false);
            setTyped("");
          }
        }}
      >
        {props.label}
      </button>
      <button type="button" onClick={() => setAsking(false)}>Cancel</button>
    </span>
  );
}

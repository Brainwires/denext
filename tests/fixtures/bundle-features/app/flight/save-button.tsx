"use client";

/** A client island handed a Server Action by its Server Component (a Flight `{$:"a"}` value). */
export function SaveButton({ save }: { save: () => Promise<number> }) {
  return <button type="button" onClick={() => void save()}>save</button>;
}

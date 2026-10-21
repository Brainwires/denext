"use server";

let count = 0;

/** A Server Action the island calls. */
export async function bump(): Promise<number> {
  await Promise.resolve();
  return ++count;
}

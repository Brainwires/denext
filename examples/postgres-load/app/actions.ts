"use server";

import { revalidatePath } from "denext/server";
import { recordVisit } from "../lib/db.ts";

/** Record a visit from the homepage form (works with no client JS). */
export async function hit(): Promise<void> {
  await recordVisit("/ (form)");
  revalidatePath("/");
}

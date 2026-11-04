import { createApi, requireSession } from "denext/server";
import { requireBearer } from "@denext/auth";

export const GET = createApi().use(requireSession()).use(requireBearer({ scope: "items:read" }))
  .define({}, () => []);

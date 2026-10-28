import {
  createApi,
  requireBearer,
  requireSession,
} from "denext/server";

export const GET = createApi().use(requireSession()).use(requireBearer({ scope: "items:read" }))
  .define({}, () => []);

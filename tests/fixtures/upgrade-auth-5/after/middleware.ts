import { requireAuth } from "denext/server";

export const middleware = (request: Request) => requireAuth(request, { role: "admin" });

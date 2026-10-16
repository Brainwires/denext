import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";

/** Start's router factory: one router per request on the server, one in the browser. */
export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}

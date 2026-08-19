"use server";

// A Server Action that throws — so a form post (routeType "action") reaches
// `onRequestError` in instrumentation.ts, exercising the action error path.

export function boomAction(): void {
  throw new Error("intentional action error (for onRequestError)");
}

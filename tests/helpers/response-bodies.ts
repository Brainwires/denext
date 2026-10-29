// The responses an in-process test harness hands out. A server delivers every response body or
// cancels it when the client goes away, and only then does the app's request deadline stop
// (src/server/app.ts keeps it armed until a streamed body ends); a test that reads only a status
// leaves the body unread, so the deadline's timer (and a file body's handle) outlives the test and
// the op / resource sanitizers report it. `release()`, from the harness's `close()`, cancels what
// the test did not read, as the server would.

/** Track responses, and cancel the bodies nobody read. */
export interface ResponseBodies {
  /** Record `response` (returned as is). */
  track(response: Response): Response;
  /** Cancel every recorded body still unread, and forget them. */
  release(): Promise<void>;
}

/** A fresh tracker. */
export function responseBodies(): ResponseBodies {
  const handed: Response[] = [];
  return {
    track(response) {
      handed.push(response);
      return response;
    },
    async release() {
      await Promise.all(
        handed.splice(0).map((r) =>
          r.bodyUsed || !r.body || r.body.locked ? undefined : r.body.cancel().catch(() => {})
        ),
      );
    },
  };
}

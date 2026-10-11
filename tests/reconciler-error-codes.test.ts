// The client reconciler's errors carry a code: a production bundle throws the short form (the
// code and the component it names), and the full texts are installed with the dev warnings
// (`installDevtools`) and by `denext/testing`, so they never ship in a production bundle.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  ERR_ASYNC_COMPONENT,
  ERR_MEMO_CLASS,
  ERR_MORE_HOOKS,
  ERR_UPDATE_DEPTH,
  reconcilerError,
} from "../src/client/fiber/errors.ts";
import { installErrorTexts } from "../src/client/fiber/error-texts.ts";
import { updateDepthError } from "../src/client/fiber/fiber-utils.ts";

Deno.test("reconciler errors: the short form names the code and the component", () => {
  installErrorTexts(false);
  try {
    assertEquals(
      updateDepthError("Looper").message,
      "denext: error 2 in <Looper> (a dev build has the full message)",
    );
    assertEquals(
      reconcilerError(ERR_MEMO_CLASS).message,
      "denext: error 4 (a dev build has the full message)",
    );
  } finally {
    installErrorTexts();
  }
});

Deno.test("reconciler errors: the installed texts are the full messages", () => {
  installErrorTexts();
  assertStringIncludes(
    reconcilerError(ERR_MORE_HOOKS, "Comp").message,
    "Rendered more hooks than during the previous render",
  );
  const depth = reconcilerError(ERR_UPDATE_DEPTH, "Looper").message;
  assertStringIncludes(depth, "Maximum update depth exceeded. <Looper>");
  assertStringIncludes(
    reconcilerError(ERR_ASYNC_COMPONENT, "Page").message,
    "async components are server-only",
  );
  assertStringIncludes(
    reconcilerError(ERR_MEMO_CLASS).message,
    "memo() of a class component is unsupported",
  );
  assert(!depth.includes("a dev build"), "the full text replaces the short form");
});

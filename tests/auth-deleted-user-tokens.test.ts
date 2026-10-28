// A deleted user's native and `/auth/v1` access tokens are refused at every use, on the
// in-memory adapter (the cases: tests/helpers/deleted-user-tokens.ts; Postgres runs them in
// tests/helpers/postgres-suites.ts). The user's row alone is dropped — as a deletion that left
// its sessions behind would — by hiding it from `getUser`.

import type { AuthAdapter } from "../packages/auth/src/adapter.ts";
import { inMemoryAuthAdapter } from "../packages/auth/src/memory-adapter.ts";
import { DELETED_USER_CASES } from "./helpers/deleted-user-tokens.ts";

for (const [name, run] of Object.entries(DELETED_USER_CASES)) {
  Deno.test(`in-memory: ${name}`, async () => {
    const adapter: AuthAdapter = inMemoryAuthAdapter();
    const getUser = adapter.getUser.bind(adapter);
    const gone = new Set<string>();
    adapter.getUser = (id) => gone.has(id) ? undefined : getUser(id);
    await run({ adapter, forget: (id) => Promise.resolve(void gone.add(id)) });
  });
}

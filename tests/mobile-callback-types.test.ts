// Type-level guards for two `denext/mobile` pairings the docs promise: `secureStore` is a
// `nativeSession` storage as is (its `set` resolves `{ stored }`, not `void`), and
// `promptStoreUpdate`'s promise is a valid `onNativeUpdateRequired` return. Both are checked by
// `deno test`'s type check; the runtime asserts only keep the test honest.

import { assert, assertEquals } from "@std/assert";
import { nativeSession, type NativeSessionStorage } from "../src/runtime/native-session.ts";
import { secureStore } from "../src/mobile/secure-store.ts";
import type { OtaCheckOptions } from "../src/mobile/ota.ts";
import { promptStoreUpdate } from "../src/mobile/app-update.ts";

Deno.test("secureStore is a NativeSessionStorage as is", () => {
  const storage: NativeSessionStorage = secureStore;
  const session = nativeSession({
    base: "https://api.example.com",
    redirectUri: "com.example.app://auth/callback",
    storage: secureStore,
  });
  assertEquals(typeof storage.set, "function");
  assertEquals(typeof session.signIn, "function");
});

Deno.test("onNativeUpdateRequired takes a handler that returns promptStoreUpdate's promise", () => {
  const options: OtaCheckOptions = {
    baseUrl: "https://api.example.com/mobile-ui",
    onNativeUpdateRequired: () => promptStoreUpdate({ appStoreId: "123456789" }),
  };
  const sync: OtaCheckOptions = { baseUrl: "https://x", onNativeUpdateRequired: () => 1 };
  assert(typeof options.onNativeUpdateRequired === "function");
  assert(typeof sync.onNativeUpdateRequired === "function");
});

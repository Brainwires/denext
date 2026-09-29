// `denext mobile doctor`'s web-storage check (src/build/mobile-doctor.ts): app code that keeps
// data in localStorage / IndexedDB (which the OS may clear from a WebView) is flagged under both
// profiles, and AsyncStorage / MMKV / openKeyValueStore without a durable native store too.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { mobileDoctorChecks, runMobileDoctor } from "../src/build/mobile-doctor.ts";

async function project(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_doctor_storage_" });
  for (const [path, content] of Object.entries(files)) {
    await Deno.mkdir(join(dir, path, ".."), { recursive: true });
    await Deno.writeTextFile(join(dir, path), content);
  }
  return dir;
}

/** The web-storage findings of a --release run. */
async function webStorage(files: Record<string, string>) {
  const dir = await project({
    "capacitor.config.json": JSON.stringify({ appId: "dev.example", webDir: "out" }),
    ...files,
  });
  try {
    const report = await runMobileDoctor({ root: dir, profile: "release" });
    return report.findings.filter((f) => f.check === "web-storage");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("mobile doctor web-storage: in both profiles", () => {
  assert(mobileDoctorChecks("store").includes("web-storage"));
  assert(mobileDoctorChecks("release").includes("web-storage"));
});

Deno.test("mobile doctor web-storage: localStorage / IndexedDB / redux-persist in app code", async () => {
  const found = await webStorage({
    "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "^8.0.0" } }),
    "src/prefs.ts": 'export const theme = () => localStorage.getItem("theme");\n',
    "src/db.ts": 'export const open = () => indexedDB.open("app");\n',
    "src/store.ts": 'import storage from "redux-persist/lib/storage";\nexport { storage };\n',
    "src/fine.ts": "export const x = 1;\n",
    "node_modules/lib/index.js": "localStorage.setItem('x', 1);\n",
  });
  assertEquals(found.length, 1);
  assertEquals(found[0].level, "warning");
  for (const file of ["src/prefs.ts", "src/db.ts", "src/store.ts"]) {
    assertStringIncludes(found[0].message, file);
  }
  assert(!found[0].message.includes("node_modules") && !found[0].message.includes("fine.ts"));
  assertStringIncludes(found[0].fix, "denext mobile add storage");
});

Deno.test("mobile doctor web-storage: AsyncStorage / MMKV need a durable native store", async () => {
  const deps = {
    "package.json": JSON.stringify({
      dependencies: {
        "@capacitor/core": "^8.0.0",
        "@react-native-async-storage/async-storage": "^2.2.0",
        "react-native-mmkv": "^4.0.0",
      },
    }),
    "src/app.ts": 'import { openKeyValueStore } from "denext/mobile";\nopenKeyValueStore("x");\n',
  };
  const missing = await webStorage(deps);
  assertEquals(missing.length, 1);
  assertStringIncludes(missing[0].message, "@react-native-async-storage/async-storage");
  assertStringIncludes(missing[0].message, "react-native-mmkv");
  assertStringIncludes(missing[0].message, "openKeyValueStore()");
  assertEquals(
    await webStorage({ ...deps, "ios/App/App/DenextStoragePlugin.swift": "// plugin\n" }),
    [],
  );
});

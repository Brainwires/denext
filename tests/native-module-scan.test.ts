// React Native mode's build-time check (src/build/native-module-scan.ts): a native module
// method's result used without await / then is reported with its file:line; awaited, returned,
// chained, fire-and-forget and Promise.all uses are not. The esbuild plugin only adds warnings:
// the module still loads through the loaders after it.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import * as esbuild from "esbuild";
import {
  nativeModuleScanPlugin,
  scanNativeModuleSyncUse,
} from "../src/build/native-module-scan.ts";

const SOURCE = `import NativeCalc from "./NativeCalc";
import { NativeModules, TurboModuleRegistry } from "react-native";
import { requireNativeModule } from "expo";
const Foo = TurboModuleRegistry.getEnforcing<Spec>("Foo");
const { Bar } = NativeModules;
const Expo = requireNativeModule("ExpoThing");
export async function fine() {
  await NativeCalc.add(1, 2);
  NativeCalc.fire();
  void Foo.go();
  const p = Foo.load();
  await p;
  NativeModules.Baz.go().then(console.log).catch(() => {});
  await Promise.all([Bar.a(), Bar.b()]);
  const arrow = () => Expo.run();
  Foo.addListener("x");
  return cond ? Foo.x() : Foo.y();
}
export function wrong() {
  const n = NativeCalc.add(1, 2) + 1;
  const v = Foo.getSync();
  console.log(v.length);
  if (Bar.isReady()) {}
  setState(Expo.value());
  return <p>{NativeModules.Baz.name()}</p>;
}
`;

Deno.test("scanNativeModuleSyncUse: reports only the synchronous uses, with line and label", async () => {
  const found = await scanNativeModuleSyncUse(SOURCE, "/app/screen.tsx");
  assertEquals(
    found.map((d) => [d.line, d.text.match(/reactNative: (\S+)\(\)/)?.[1]]),
    [
      [20, "NativeCalc.add"],
      [21, "Foo.getSync"],
      [23, "Bar.isReady"],
      [24, "Expo.value"],
      [25, "NativeModules.Baz.name"],
    ],
  );
  assertEquals(found[0].lineText, "  const n = NativeCalc.add(1, 2) + 1;");
  assertEquals(found[0].column, 13);
  assertStringIncludes(found[0].text, "await NativeCalc.add(");
});

Deno.test("scanNativeModuleSyncUse: a module without native references, or unparseable, is skipped", async () => {
  assertEquals(await scanNativeModuleSyncUse("export const x = 1 + 2;\n", "/app/a.ts"), []);
  assertEquals(await scanNativeModuleSyncUse("const NativeModules = (;\n", "/app/a.ts"), []);
  // A module named Native<Name> is a spec only when default-imported.
  assertEquals(
    await scanNativeModuleSyncUse(
      'import { helper } from "./NativeCalc";\nconst n = helper.add() + 1;\n',
      "/app/a.ts",
    ),
    [],
  );
});

Deno.test("nativeModuleScanPlugin: warnings for app source only; the module still builds", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_native_scan_" }));
  try {
    await Deno.writeTextFile(
      join(dir, "entry.ts"),
      'import Calc from "./NativeCalc.ts";\nexport const total = Calc.add(1, 2) + 1;\n',
    );
    await Deno.writeTextFile(
      join(dir, "NativeCalc.ts"),
      "export default { add: (a: number, b: number) => Promise.resolve(a + b) };\n",
    );
    const out = await esbuild.build({
      entryPoints: [join(dir, "entry.ts")],
      bundle: true,
      write: false,
      format: "esm",
      logLevel: "silent",
      plugins: [nativeModuleScanPlugin(dir)],
    });
    assertEquals(out.warnings.length, 1);
    assertEquals(out.warnings[0].location?.line, 2);
    assert(out.warnings[0].location?.file.endsWith("entry.ts"), out.warnings[0].location?.file);
    const code = new TextDecoder().decode(out.outputFiles![0].contents);
    assert(code.includes("a + b"), "the module still loads through esbuild's own loader");

    const outside = await esbuild.build({
      entryPoints: [join(dir, "entry.ts")],
      bundle: true,
      write: false,
      logLevel: "silent",
      plugins: [nativeModuleScanPlugin(join(dir, "elsewhere"))],
    });
    assertEquals(outside.warnings, [], "files outside the app are not scanned");
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

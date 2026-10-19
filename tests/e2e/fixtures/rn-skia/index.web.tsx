// The web entry: load CanvasKit (Skia's wasm build) first, then import the app, whose modules
// read `global.CanvasKit` when they load (Skia's documented LoadSkiaWeb + deferred import).
import { AppRegistry } from "react-native";
import { LoadSkiaWeb } from "@shopify/react-native-skia/lib/module/web";
import canvasKitWasm from "canvaskit-wasm/bin/full/canvaskit.wasm?url";

const g = globalThis as Record<string, unknown>;

LoadSkiaWeb({ locateFile: () => canvasKitWasm })
  .then(async () => {
    const { App } = await import("./App.tsx");
    AppRegistry.registerComponent("main", () => App);
    AppRegistry.runApplication("main", { rootTag: document.getElementById("root") });
  })
  .catch((e: unknown) => {
    g.__skiaError = String((e as Error)?.stack ?? e);
  });

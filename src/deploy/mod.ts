/**
 * `denext/deploy` — deploy adapters and their presets.
 *
 * `denext build` writes a typed deploy manifest (`.denext/deploy-manifest.json`, the
 * {@linkcode DeployManifest} type): every route and how it is served (static, ISR, dynamic, route
 * handler, middleware), the files served as they are with their `Cache-Control`, how the server
 * starts, the jobs and their schedules, the services, the environment the app reads, the Deno
 * permissions it needs, the image optimizer and the `build --compile` output. A deploy adapter
 * turns that into a target's files. Name one in `denext.config.ts`:
 *
 * ```ts
 * import { fly } from "denext/deploy";
 * export default { deploy: { adapter: fly({ app: "my-app", region: "ams" }) } };
 * ```
 *
 * Then `denext build` runs its `prepare` after every build, `denext deploy prepare` runs it on
 * its own (`--preset <name>` picks a preset without the config), and `denext deploy` pushes with
 * the target's CLI when there is one — credentials only from the environment, and nothing is
 * pushed without that explicit command. Presets: {@linkcode docker}, {@linkcode fly},
 * {@linkcode denoDeploy}, {@linkcode genericHost} and {@linkcode staticHost}; your own adapter is
 * a {@linkcode DeployAdapter} (a plugin can contribute one with `addDeployAdapter`).
 *
 * @module
 */

export { defineDeployAdapter } from "./adapter.ts";
export type {
  DeployAdapter,
  DeployConfig,
  DeployContext,
  DeployRunOptions,
  DeployWriteOptions,
} from "./adapter.ts";
export { DEPLOY_MANIFEST_FILE, DEPLOY_MANIFEST_VERSION } from "./manifest.ts";
export type {
  DeployAssetGroup,
  DeployCache,
  DeployCompile,
  DeployEnvVar,
  DeployImages,
  DeployJob,
  DeployManifest,
  DeployPermissions,
  DeployRoute,
  DeployRouteKind,
  DeploySchedule,
  DeployServer,
  DeployService,
} from "./manifest.ts";
export { docker } from "./presets/docker.ts";
export type { DockerPresetOptions } from "./presets/docker.ts";
export { fly } from "./presets/fly.ts";
export type { FlyPresetOptions } from "./presets/fly.ts";
export { denoDeploy } from "./presets/deno-deploy.ts";
export type { DenoDeployPresetOptions } from "./presets/deno-deploy.ts";
export { genericHost } from "./presets/generic-host.ts";
export type { GenericHostPresetOptions } from "./presets/generic-host.ts";
export { staticHost } from "./presets/static.ts";
export type { StaticPresetOptions } from "./presets/static.ts";

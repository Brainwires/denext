/**
 * Internal: the framework modules `@denext/ui` (the `denext ui` / `denext dashboard` web UI,
 * published as its own package) is built on. Not a public API — it changes with any release.
 * `@denext/ui` X.Y.Z imports exactly `@denext/denext` X.Y.Z, and denext X.Y.Z loads exactly
 * `@denext/ui` X.Y.Z (on first use, by a dynamic import), so both sides always agree on it.
 *
 * @module
 */

export { signingReadiness, signingReadinessLines } from "../build/code-signing.ts";
export type { SigningReadiness } from "../build/code-signing.ts";
export {
  applyArrayOps,
  bail,
  columnAt,
  commit,
  CONFIG_LABEL,
  deleteConfigValue,
  indentAt,
  objectDeleteEdits,
  objectSetEdits,
  objectSlots,
  readConfigModel,
  renderValue,
  scopeOf,
  scopeSlot,
  setConfigValue,
  snippetOf,
  unwrap,
} from "../build/config-edit.ts";
export type { ArrayOp, ConfigKeyInfo, EditResult, SpliceOutcome } from "../build/config-edit.ts";
export {
  currentDenoIdentity,
  denoReleaseVersion,
  denoVersionOk,
  MIN_DENO_VERSION,
} from "../build/deno-version.ts";
export { resolveDocker, STACK_FEATURES } from "../build/docker-detect.ts";
export type { DockerRequest, StackDetection, StackFeature } from "../build/docker-detect.ts";
export {
  COMPOSE_FILE_NAMES,
  DEFAULT_COMPOSE_FILE,
  dockerPlan,
  findComposeFile,
  isGeneratedDockerFile,
  renderCompose,
} from "../build/docker-template.ts";
export type { DockerMode, DockerOptions, DockerPlanFile } from "../build/docker-template.ts";
export { offlineNote, pinEligibleFiles } from "../build/eligible-pins.ts";
export { runToExit } from "../build/exited-output.ts";
export { migrationPlan, usesPostgres } from "../build/generate-ops.ts";
export {
  GENERATE_KINDS,
  generateArtifact,
  OPTIONAL_NAME_KINDS,
  safeJoin,
} from "../build/generate.ts";
export type { GenerateKind, GeneratePreviewFile } from "../build/generate.ts";
export { setJsonValue } from "../build/json-edit.ts";
export { evalNextConfigProgram, LOAD_NEXT_CONFIG } from "../build/next-config-eval.ts";
export { createUnifiedDiff } from "../build/patch-diff.ts";
export { CONFIG_FILES } from "../build/paths.ts";
export {
  createConfigSource,
  ejectPlugin,
  injectPlugin,
  listPlugins,
  normalizeSpec,
  resolvePluginNames,
} from "../build/plugin-install.ts";
export type { ConfiguredPlugin, PluginNames } from "../build/plugin-install.ts";
export { MONOREPO_CONFIGS, scaffoldMonorepo } from "../build/scaffold-monorepo.ts";
export {
  DENEXT_UNSTABLE,
  denoJson,
  scaffoldProject,
  withDenextUnstable,
} from "../build/scaffold.ts";
export { sseSend, sseStream } from "../build/sse.ts";
export type { SseClients } from "../build/sse.ts";
export { applyEdits, endOf, startOf, txt } from "../build/swc-ast.ts";
export type { Ctx, Edit, Node } from "../build/swc-ast.ts";
export { GLOBAL_FLAGS } from "../cli/command.ts";
export type { FlagSpec, PositionalSpec } from "../cli/command.ts";
export { FEATURES } from "../cli/commands/create.ts";
export { lineLevel, serviceHealth } from "../cli/commands/stack-health.ts";
export type { ServiceHealth } from "../cli/commands/stack-health.ts";
export { parsePs } from "../cli/commands/stack-io.ts";
export type { PsRow } from "../cli/commands/stack-io.ts";
export { forwardedDeno } from "../cli/deno-path.ts";
export { pinnedDenextCli, pinnedVersion } from "../cli/self-exec.ts";
export { Fragment, h } from "../jsx/jsx-runtime.ts";
export type { VNode, VNodeChild, VNodeChildren } from "../jsx/types.ts";
export { devFetch, readDevInfo } from "../mcp/dev-client.ts";
export type { DevInfo, DevStateResponse } from "../mcp/dev-client.ts";
export { default as CATALOG } from "../plugin/catalog.json" with { type: "json" };
export { composeCron, cronError, cronMatches, describeCron } from "../runtime/cron.ts";
export type { CronFrequency, CronParts } from "../runtime/cron.ts";
export { validateDenextConfig, warnUnknownConfigKeys } from "../server/config-validate.ts";
export type { DenextConfig } from "../server/config.ts";
export { parseEnv } from "../server/env.ts";
export { JOB_HISTORY_DB, sqliteJobHistoryStore } from "../server/job-history.ts";
export type { JobHistory, JobHistoryCleared, JobHistoryRow } from "../server/job-history.ts";
export { privateEntriesUnder } from "../server/module-walk.ts";
export { verifyOrigin } from "../server/origin-check.ts";
export { remoteAddrOf } from "../server/remote-addr.ts";
export { serveWithPortFallback } from "../server/serve-utils.ts";
export { SERVICES_SNAPSHOT } from "../server/service-loader.ts";
export type { ServicesSnapshot } from "../server/service-loader.ts";
export type { ChildStatus, SupervisorStatus } from "../server/supervise.ts";
export { stripComments } from "../utils/strip-comments.ts";
export {
  Badge,
  CsrfField,
  DiffBlock,
  FileDetails,
  FilterForm,
  Hidden,
  Input,
  Mono,
  NoChange,
  Note,
  OpForm,
  Out,
  Panel,
  PreviewLead,
  ResultList,
  Row,
  SourceBlock,
  Table,
  Tabs,
} from "./components.ts";
export type { BadgeTone, InputProps, ResultGroup } from "./components.ts";
export {
  DB_BAN_DURATIONS,
  DB_CELL_MAX_CHARS,
  DB_CELL_PREVIEW_CHARS,
  DB_MAX_PASSWORD,
  DB_MIN_PASSWORD,
  DB_SQL_MAX_CHARS,
  DB_SQL_MAX_ROWS,
  DB_UPLOAD_MAX_BYTES,
  maskSecrets,
} from "./database/protocol.ts";
export type {
  DbActor,
  DbAuthUser,
  DbColumn,
  DbEnvelope,
  DbErrorCode,
  DbFailure,
  DbObject,
  DbPolicy,
  DbRealtimeTable,
  DbReplies,
  DbReply,
  DbRequest,
  DbSqlResult,
  DbStatement,
  DbSuccess,
  DbTableInfo,
  DbTableSummary,
  DbUserAction,
} from "./database/protocol.ts";
export { enableRlsMigration } from "./database/sql.ts";
export { Control, Field, OpButton } from "./form/control.ts";
export type { ControlAttrs } from "./form/control.ts";
export { FormField, FormFields, readWidget } from "./form/render.ts";
export { loadConfigSchema, resolveAt } from "./form/schema.ts";
export type { SchemaNode } from "./form/schema.ts";
export {
  applyListOp,
  decode,
  encode,
  fieldName,
  FormValueError,
  OP_FIELD,
  parseFieldName,
  parseOp,
} from "./form/value.ts";
export type { FormEntry, ListOpRequest } from "./form/value.ts";
export { selectedBranch, widgetFor } from "./form/widget.ts";
export type { WidgetKind, WidgetOption, WidgetSpec } from "./form/widget.ts";
export { fetchJsrConfig, fetchJsrMeta, isJsrSpec, jsrAvailable, searchJsr } from "./jsr.ts";
export type {
  JsrConfigResult,
  JsrHit,
  JsrMetaResult,
  JsrRequestOptions,
  JsrSearchResult,
} from "./jsr.ts";
export { UI_PANELS } from "./panels.ts";
export { cliInvocation, runDeno } from "./proc.ts";
export type { RunDenoOptions } from "./proc.ts";
export {
  applySecurityHeaders,
  authorized,
  checkCsrf,
  constantTimeEqual,
  createUiSession,
  deriveCsrf,
  handshake,
  isMutation,
  newToken,
  readContained,
  StaleWriteError,
  stampOf,
  UI_CSRF_FIELD,
  UI_CSRF_HEADER,
  uiOriginAllowed,
  uiSafeJoin,
  uiSafeUnder,
  writeFileAtomic,
} from "./security.ts";
export type { UiCookie, UiSession } from "./security.ts";
export { hasCommand, listSigningIdentities } from "./signing.ts";
export type { SigningIdentity } from "./signing.ts";
export { Raw, renderView } from "./view.ts";
export type { RawHtml } from "./view.ts";
export { DASH_MIN_PASSWORD, DEFAULT_RELAY_PORT, DEFAULT_UI_PORT } from "./constants.ts";

// denext's esbuild JavaScript API — the `esbuild` npm package's async surface (`build`, `context`,
// `transform`, `formatMessages`, `analyzeMetafile`, `initialize`, `stop`, `version`, plugins and
// every type), with no `npm:esbuild` import. Everything in the build pipeline, the SPA path, dev,
// `analyze`, plugins and the scripts imports esbuild from here.
//
// The protocol half is esbuild's own code, vendored from v0.25.5 (MIT — ./vendor/LICENSE.md):
// ./vendor/common.ts, ./vendor/stdio_protocol.ts and ./vendor/types.ts are upstream's
// `lib/shared/` files with only these edits:
//   - import specifiers carry `.ts`;
//   - common.ts imports ESBUILD_VERSION from ./version.ts instead of a build-time `declare const`;
//   - stdio_protocol.ts types `ByteBuffer.buf` as `Uint8Array` (TS 5.7's typed-array generics);
//   - types.ts drops its trailing `declare global` WebAssembly/URL shim (JSR refuses global
//     augmentation; Deno declares both).
// This file is the host half, adapted from upstream's lib/npm/node.ts: it spawns the binary
// ./binary.ts resolves (ESBUILD_BINARY_PATH > denext's Deno toolchain > the verified npm binary)
// through `node:child_process`, so the child and its pipes are unref'd while idle exactly as with
// the npm package — a CLI exits without `stop()`. The sync APIs (`buildSync`, …) need a worker
// thread and are not provided; nothing in denext uses them.
//
// To move to another esbuild release: re-copy the three vendor files (re-applying the edits),
// bump ./version.ts and the ESBUILD_NPM table in ./binary.ts, and pin a toolchain whose zip
// carries that release.

import { runToExit } from "../exited-output.ts";
import { spawnExclusive } from "../serial-child.ts";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, readFileSync, unlink, writeFile } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as common from "./vendor/common.ts";
import type * as types from "./vendor/types.ts";
import { ESBUILD_BINARY_PATH_ENV, resolveEsbuildBinary } from "./binary.ts";
import { ESBUILD_VERSION } from "./version.ts";
import * as ourselves from "./mod.ts";

export type * from "./vendor/types.ts";

/** The esbuild version this API speaks (the binary must report exactly this). */
export const version: string = ESBUILD_VERSION;

/** Whether stderr is a terminal (esbuild colors its log then). */
const isTTY = (): boolean => {
  try {
    return Deno.stderr.isTerminal();
  } catch {
    return false;
  }
};

/** Temp-file transport for large `transform` inputs/outputs (upstream's `fsAsync`). */
const fsAsync: common.StreamFS = {
  readFile(tempFile, callback) {
    try {
      readFile(tempFile, "utf8", (err, contents) => {
        try {
          unlink(tempFile, () => callback(err, contents));
        } catch {
          callback(err, contents);
        }
      });
    } catch (err) {
      callback(err as Error, null);
    }
  },
  writeFile(contents, callback) {
    try {
      const tempFile = join(tmpdir(), `esbuild-${randomBytes(32).toString("hex")}`);
      writeFile(tempFile, contents, (err) => err !== null ? callback(null) : callback(tempFile));
    } catch {
      callback(null);
    }
  },
};

interface Service {
  build: typeof types.build;
  context: typeof types.context;
  transform: typeof types.transform;
  formatMessages: typeof types.formatMessages;
  analyzeMetafile: typeof types.analyzeMetafile;
}

let longLivedService: Promise<Service> | undefined;
let stopService: (() => Promise<void>) | undefined;
/** The exit of a child being stopped: a concurrent {@linkcode stop} waits for it too. */
let stopping: Promise<void> | undefined;
let initializeWasCalled = false;
let warned = false;

/** Start (once) the long-lived `esbuild --service` child and the channel over its pipes. */
function ensureServiceIsRunning(): Promise<Service> {
  if (!longLivedService) {
    const starting = startService();
    longLivedService = starting;
    // A failed start (no binary, refused download) is not cached: the next call retries.
    starting.catch(() => {
      if (longLivedService === starting) longLivedService = undefined;
    });
  }
  return longLivedService;
}

/** Refuse an `ESBUILD_BINARY_PATH` binary that is not esbuild {@linkcode ESBUILD_VERSION}. */
async function checkOverrideVersion(path: string): Promise<void> {
  let reported: string;
  try {
    const out = await runToExit(path, { args: ["--version"], stdin: "null" });
    reported = new TextDecoder().decode(out.stdout).trim();
  } catch (err) {
    throw new Error(
      `denext: ${ESBUILD_BINARY_PATH_ENV}=${path} could not be run: ` +
        `${err instanceof Error ? err.message : err}`,
    );
  }
  if (reported !== ESBUILD_VERSION) {
    throw new Error(
      `denext: ${ESBUILD_BINARY_PATH_ENV}=${path} is esbuild ${JSON.stringify(reported)}; ` +
        `denext's esbuild API needs exactly ${ESBUILD_VERSION} (unset it to use the verified one).`,
    );
  }
}

async function startService(): Promise<Service> {
  const binary = await resolveEsbuildBinary();
  if (binary.warning && !warned) {
    warned = true;
    console.warn(binary.warning);
  }
  // The toolchain and npm binaries are hash-pinned to ESBUILD_VERSION; an override is only as
  // good as its word, so ask it first and refuse with a message that names the variable.
  if (binary.source === "env") await checkOverrideVersion(binary.path);
  const defaultWD = Deno.cwd();
  // Long-lived: on Windows it must not be created while a `deno info` / `deno bundle` child of
  // this process runs, or it inherits and holds that child's pipes (serial-child.ts).
  const child = await spawnExclusive(() =>
    spawn(binary.path, [`--service=${ESBUILD_VERSION}`, "--ping"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "inherit"],
      cwd: defaultWD,
    })
  );
  const { readFromStdout, afterClose, service } = common.createChannel({
    writeToStdin(bytes) {
      child.stdin!.write(bytes, (err) => {
        // Assume the service was stopped if we get an error writing to stdin.
        if (err) afterClose(err);
      });
    },
    readFileSync: (path, encoding) => readFileSync(path, encoding),
    isSync: false,
    hasFS: true,
    esbuild: ourselves,
  });
  const stdin = child.stdin!;
  const stdout = child.stdout!;
  stdin.on("error", afterClose);
  child.on("error", afterClose);
  // Settles once the child has exited and its pipes are closed.
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const stop = () => {
    stdin.destroy();
    stdout.destroy();
    // Wait for the exit with the child referenced: an unref'd child's exit would not keep the
    // event loop alive for the wait, and a test that ended first would see the process open.
    if (child.exitCode === null && child.signalCode === null) child.ref();
    child.kill();
    initializeWasCalled = false;
    longLivedService = undefined;
    stopService = undefined;
    stopping = closed;
    void closed.then(() => {
      if (stopping === closed) stopping = undefined;
    });
    return closed;
  };
  stopService = stop;
  stdout.on("data", (chunk: Uint8Array) => {
    try {
      readFromStdout(chunk);
    } catch (err) {
      // The version handshake (or a corrupt packet): fail every pending call instead of throwing
      // out of a stream callback, and drop the child.
      afterClose(err as Error);
      if (stopService === stop) stop();
    }
  });
  stdout.on("end", afterClose);

  // Idle, the child and its pipes do not keep the process alive; a build in flight does.
  let refCount = 0;
  child.unref();
  (stdin as { unref?: () => void }).unref?.();
  (stdout as { unref?: () => void }).unref?.();
  const refs: common.Refs = {
    ref() {
      if (++refCount === 1) child.ref();
    },
    unref() {
      if (--refCount === 0) child.unref();
    },
  };

  return {
    build: (options: types.BuildOptions) =>
      new Promise<types.BuildResult>((resolve, reject) => {
        service.buildOrContext({
          callName: "build",
          refs,
          options,
          isTTY: isTTY(),
          defaultWD,
          callback: (err, res) => err ? reject(err) : resolve(res as types.BuildResult),
        });
      }),
    context: (options: types.BuildOptions) =>
      new Promise<types.BuildContext>((resolve, reject) =>
        service.buildOrContext({
          callName: "context",
          refs,
          options,
          isTTY: isTTY(),
          defaultWD,
          callback: (err, res) => err ? reject(err) : resolve(res as types.BuildContext),
        })
      ),
    transform: (input: string | Uint8Array, options?: types.TransformOptions) =>
      new Promise<types.TransformResult>((resolve, reject) =>
        service.transform({
          callName: "transform",
          refs,
          input,
          options: options || {},
          isTTY: isTTY(),
          fs: fsAsync,
          callback: (err, res) => err ? reject(err) : resolve(res!),
        })
      ),
    formatMessages: (messages, options) =>
      new Promise((resolve, reject) =>
        service.formatMessages({
          callName: "formatMessages",
          refs,
          messages,
          options,
          callback: (err, res) => err ? reject(err) : resolve(res!),
        })
      ),
    analyzeMetafile: (metafile, options) =>
      new Promise((resolve, reject) =>
        service.analyzeMetafile({
          callName: "analyzeMetafile",
          refs,
          metafile: typeof metafile === "string" ? metafile : JSON.stringify(metafile),
          options,
          callback: (err, res) => err ? reject(err) : resolve(res!),
        })
      ),
  };
}

/** esbuild's `build` (https://esbuild.github.io/api/#build). */
export const build: typeof types.build =
  ((options: types.BuildOptions) =>
    ensureServiceIsRunning().then((s) => s.build(options))) as typeof types.build;

/** esbuild's `context` (incremental / watch / serve). */
export const context: typeof types.context =
  ((options: types.BuildOptions) =>
    ensureServiceIsRunning().then((s) => s.context(options))) as typeof types.context;

/** esbuild's `transform`. */
export const transform: typeof types.transform =
  ((input: string | Uint8Array, options?: types.TransformOptions) =>
    ensureServiceIsRunning().then((s) => s.transform(input, options))) as typeof types.transform;

/** esbuild's `formatMessages`. */
export const formatMessages: typeof types.formatMessages = (messages, options) =>
  ensureServiceIsRunning().then((s) => s.formatMessages(messages, options));

/** esbuild's `analyzeMetafile`. */
export const analyzeMetafile: typeof types.analyzeMetafile = (metafile, options) =>
  ensureServiceIsRunning().then((s) => s.analyzeMetafile(metafile, options));

/**
 * Stop the esbuild child (the next call starts a new one), resolving once it has exited. Optional
 * in a CLI — an idle child does not keep the process alive — but a Deno test that used esbuild
 * awaits it before it ends.
 */
export const stop: typeof types.stop = async () => {
  const pending = longLivedService;
  if (pending) await pending.catch(() => {});
  await stopService?.();
  // Another caller's stop() may have begun it (a dev server's shutdown): wait for that exit too.
  await stopping;
};

const noSync = (name: string) => () => {
  throw new Error(`denext's esbuild API has no "${name}"; use the async API`);
};
/** Not provided (needs a worker thread); throws. */
export const buildSync: typeof types.buildSync = noSync("buildSync");
/** Not provided; throws. */
export const transformSync: typeof types.transformSync = noSync("transformSync");
/** Not provided; throws. */
export const formatMessagesSync: typeof types.formatMessagesSync = noSync("formatMessagesSync");
/** Not provided; throws. */
export const analyzeMetafileSync: typeof types.analyzeMetafileSync = noSync(
  "analyzeMetafileSync",
);

/** esbuild's `initialize`: starts the service early (the browser-only options are refused). */
export const initialize: typeof types.initialize = async (options) => {
  options = common.validateInitializeOptions(options || {});
  if (options.wasmURL) throw new Error(`The "wasmURL" option only works in the browser`);
  if (options.wasmModule) throw new Error(`The "wasmModule" option only works in the browser`);
  if (options.worker) throw new Error(`The "worker" option only works in the browser`);
  if (initializeWasCalled) throw new Error('Cannot call "initialize" more than once');
  await ensureServiceIsRunning();
  initializeWasCalled = true;
};

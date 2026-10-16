/**
 * Typed API clients in other languages, generated from an OpenAPI document (or any
 * {@linkcode ClientModel}): Python, Go, Swift and Kotlin, each one file with no dependency beyond
 * the language's standard library. `denext openapi client --lang <lang>` writes one;
 * `@denext/graphql`'s `denext graphql client` uses the same emitters for a GraphQL schema.
 *
 * ```ts
 * import { emitClient } from "@denext/openapi/clients";
 * const { fileName, source } = emitClient(document, "python");
 * ```
 *
 * @module
 */

import type { OpenApiDocument } from "../spec.ts";
import { emitGo } from "./go.ts";
import { emitKotlin } from "./kotlin.ts";
import { type ClientModel, modelFromOpenApi } from "./model.ts";
import { emitPython } from "./python.ts";
import { emitSwift } from "./swift.ts";

export { camelCase, modelFromOpenApi, pascalCase, snakeCase } from "./model.ts";
export type {
  ClientModel,
  ModelField,
  ModelOperation,
  ModelParam,
  NamedType,
  TypeRef,
} from "./model.ts";
export type {
  JsonSchema,
  OpenApiDocument,
  OpenApiInfo,
  OpenApiOperation,
  OpenApiSecurityScheme,
  OpenApiServer,
  SecurityRequirement,
} from "../spec.ts";
export type { GoOptions } from "./go.ts";
export type { KotlinOptions } from "./kotlin.ts";
export { emitGo, emitKotlin, emitPython, emitSwift };

/** The languages a client can be generated in. */
export const CLIENT_LANGUAGES = ["python", "go", "swift", "kotlin"] as const;

/** One of {@linkcode CLIENT_LANGUAGES}. */
export type ClientLanguage = typeof CLIENT_LANGUAGES[number];

/** Options for {@linkcode emitClient}. */
export interface EmitClientOptions {
  /** The Go package / Kotlin package (default `client`). */
  packageName?: string;
}

/** A generated client: its conventional file name and source. */
export interface GeneratedClient {
  /** `client.py`, `client.go`, `Client.swift` or `Client.kt`. */
  fileName: string;
  /** The file's source. */
  source: string;
}

/** Is `lang` a supported client language? */
export function isClientLanguage(lang: unknown): lang is ClientLanguage {
  return (CLIENT_LANGUAGES as readonly unknown[]).includes(lang);
}

/**
 * Generate a client in `lang` from an OpenAPI document or a client model.
 *
 * @param input The document (`denext openapi emit`'s), or a {@linkcode ClientModel}.
 * @param lang The language.
 * @param options The package name (Go, Kotlin).
 * @returns The file name and source.
 */
export function emitClient(
  input: OpenApiDocument | ClientModel,
  lang: ClientLanguage,
  options: EmitClientOptions = {},
): GeneratedClient {
  const model = "openapi" in input ? modelFromOpenApi(input) : input;
  switch (lang) {
    case "python":
      return { fileName: "client.py", source: emitPython(model) };
    case "go":
      return { fileName: "client.go", source: emitGo(model, options) };
    case "swift":
      return { fileName: "Client.swift", source: emitSwift(model) };
    case "kotlin":
      return { fileName: "Client.kt", source: emitKotlin(model, options) };
  }
}

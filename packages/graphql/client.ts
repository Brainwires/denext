/**
 * Typed GraphQL clients in Python, Go, Swift and Kotlin (`denext graphql client --lang <lang>`):
 * the schema's types — object and interface types (every field optional: what a response holds
 * depends on the selection), input types (a non-null field without a default is required),
 * enums and scalars — plus a small client whose `execute(query, variables)` posts an operation
 * and raises the response's `errors`. One file, the language's standard library only; the
 * emitters are `@denext/openapi`'s (`@denext/openapi/clients`), loaded when the verb runs.
 *
 * @module
 */

import {
  buildSchema,
  type GraphQLNamedType,
  type GraphQLType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
} from "graphql";
import type { ClientModel, NamedType, TypeRef } from "@denext/openapi/clients";

/** The built-in scalars, by JSON type. */
const SCALARS: Record<string, TypeRef["kind"]> = {
  ID: "string",
  String: "string",
  Int: "integer",
  Float: "number",
  Boolean: "boolean",
};

/** A GraphQL type as a model reference (`nullable` unless non-null). */
function refOf(type: GraphQLType): TypeRef {
  if (isNonNullType(type)) {
    const inner = refOf(type.ofType);
    return inner.kind === "nullable" ? inner.inner : inner;
  }
  const inner: TypeRef = isListType(type)
    ? { kind: "array", items: refOf(type.ofType) }
    : namedRef(type as GraphQLNamedType);
  return inner.kind === "any" ? inner : { kind: "nullable", inner };
}

function namedRef(type: GraphQLNamedType): TypeRef {
  if (isScalarType(type)) {
    const kind = SCALARS[type.name];
    return kind ? { kind } as TypeRef : { kind: "any" };
  }
  return isUnionType(type) ? { kind: "any" } : { kind: "named", name: type.name };
}

function describe(type: GraphQLNamedType): { description?: string } {
  return type.description ? { description: type.description } : {};
}

/** One declared type, or `null` for a scalar, a union or an introspection type. */
function declared(type: GraphQLNamedType): NamedType | null {
  if (type.name.startsWith("__")) return null;
  if (isEnumType(type)) {
    return {
      kind: "enum",
      name: type.name,
      values: type.getValues().map((v) => v.name),
      ...describe(type),
    };
  }
  if (isInputObjectType(type)) {
    const fields = Object.values(type.getFields()).map((f) => ({
      name: f.name,
      type: refOf(f.type),
      required: isNonNullType(f.type) && f.defaultValue === undefined,
      ...(f.description ? { description: f.description } : {}),
    }));
    return { kind: "object", name: type.name, fields, ...describe(type) };
  }
  if (isObjectType(type) || isInterfaceType(type)) {
    const fields = Object.values(type.getFields()).map((f) => ({
      name: f.name,
      type: refOf(f.type),
      required: false,
      ...(f.description ? { description: f.description } : {}),
    }));
    return { kind: "object", name: type.name, fields, ...describe(type) };
  }
  return null;
}

/**
 * The client model of a GraphQL schema given as SDL (`denext graphql sdl`'s output).
 *
 * @param sdl The schema.
 * @param path The endpoint path (`/graphql`), noted in the client.
 * @returns The model: the schema's types, no REST operations, `graphqlPath` set.
 */
export function modelFromSdl(sdl: string, path = "/graphql"): ClientModel {
  const schema = buildSchema(sdl);
  const types = Object.values(schema.getTypeMap()).map(declared).filter((t): t is NamedType =>
    t !== null
  );
  return { title: `GraphQL ${path}`, version: "", types, operations: [], graphqlPath: path };
}

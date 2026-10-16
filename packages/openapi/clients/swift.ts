/**
 * The Swift client: one file, Foundation only (`URLSession` with async/await). Object types are
 * `Codable` structs (an optional key is an optional property, omitted when `nil`), string enums
 * are `String`-backed `Codable` enums, a schema-less value is the generated `JSONValue`, and
 * every operation is an `async throws` method of `Client`.
 *
 * @module
 */

import {
  camelCase,
  type ClientModel,
  type ModelOperation,
  type NamedType,
  type TypeRef,
} from "./model.ts";
import {
  banner,
  fillPath,
  lineComment,
  operationDoc,
  queryItems,
  quote,
  sortedTypes,
  typePrinter,
} from "./shared.ts";

const KEYWORDS = new Set([
  "associatedtype",
  "class",
  "deinit",
  "enum",
  "extension",
  "fileprivate",
  "func",
  "import",
  "init",
  "inout",
  "internal",
  "let",
  "open",
  "operator",
  "private",
  "protocol",
  "public",
  "rethrows",
  "static",
  "struct",
  "subscript",
  "typealias",
  "var",
  "break",
  "case",
  "continue",
  "default",
  "defer",
  "do",
  "else",
  "fallthrough",
  "for",
  "guard",
  "if",
  "in",
  "repeat",
  "return",
  "switch",
  "where",
  "while",
  "as",
  "catch",
  "false",
  "is",
  "nil",
  "super",
  "self",
  "Self",
  "throw",
  "throws",
  "true",
  "try",
  "Type",
  "Protocol",
  "any",
  "some",
]);

/** A Swift identifier (a property, argument or case), backticked when it is a keyword. */
function ident(name: string): string {
  const id = camelCase(name) || "value";
  return KEYWORDS.has(id) ? `\`${id}\`` : id;
}

/** The Swift type of a reference. */
const swiftType: (ref: TypeRef) => string = typePrinter(
  { string: "String", integer: "Int", number: "Double", boolean: "Bool", any: "JSONValue" },
  {
    array: (items) => `[${items}]`,
    map: (values) => `[String: ${values}]`,
    named: (name) => name,
    nullable: (inner) => optional(inner),
  },
);

function optional(ref: TypeRef): string {
  const t = swiftType(ref);
  return t.endsWith("?") ? t : `${t}?`;
}

function doc(text: string | undefined, indent = ""): string {
  return lineComment(text, indent, "///");
}

/** Named types a reference holds inline (not through an array or a dictionary, which box). */
function inlineNames(ref: TypeRef): string[] {
  if (ref.kind === "named") return [ref.name];
  return ref.kind === "nullable" ? inlineNames(ref.inner) : [];
}

/**
 * The object types that contain themselves inline (directly or through other structs): a Swift
 * struct cannot, so these are emitted as final classes.
 */
function recursiveTypes(types: readonly NamedType[]): Set<string> {
  const byName = new Map(types.map((t) => [t.name, t]));
  const edges = (name: string): string[] => {
    const t = byName.get(name);
    if (t?.kind === "object") return t.fields.flatMap((f) => inlineNames(f.type));
    return t?.kind === "alias" ? inlineNames(t.target) : [];
  };
  const out = new Set<string>();
  for (const t of types) {
    if (t.kind !== "object") continue;
    const seen = new Set<string>();
    const stack = edges(t.name);
    while (stack.length) {
      const next = stack.pop()!;
      if (next === t.name) {
        out.add(t.name);
        break;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...edges(next));
    }
  }
  return out;
}

function declaration(type: NamedType, recursive: Set<string>): string {
  if (type.kind === "enum") {
    const cases = type.values.map((v, i) => {
      const name = ident(v) === "value" && v !== "value" ? `case${i}` : ident(v);
      return `    case ${name} = ${quote(v)}\n`;
    });
    return `${
      doc(type.description)
    }public enum ${type.name}: String, Codable, Sendable, CaseIterable {\n${cases.join("")}}\n`;
  }
  if (type.kind === "alias") {
    return `${doc(type.description)}public typealias ${type.name} = ${swiftType(type.target)}\n`;
  }
  const props = type.fields.map((f) => ({
    field: f,
    name: ident(f.name),
    type: f.required ? swiftType(f.type) : optional(f.type),
  }));
  // A recursive type is a class: its properties are constants, so sharing it is safe.
  const binding = recursive.has(type.name) ? "let" : "var";
  const lines = props.map((p) =>
    `${doc(p.field.description, "    ")}    public ${binding} ${p.name}: ${p.type}\n`
  );
  const keys = props.some((p) => p.name.replace(/`/g, "") !== p.field.name)
    ? `\n    enum CodingKeys: String, CodingKey {\n${
      props.map((p) => `        case ${p.name} = ${quote(p.field.name)}\n`).join("")
    }    }\n`
    : "";
  const params = props.map((p) => `${p.name}: ${p.type}${p.type.endsWith("?") ? " = nil" : ""}`);
  const init = `\n    public init(${params.join(", ")}) {\n${
    props.map((p) => `        self.${p.name} = ${p.name}\n`).join("")
  }    }\n`;
  const kind = recursive.has(type.name)
    ? `final class ${type.name}: Codable, @unchecked Sendable`
    : `struct ${type.name}: Codable, Sendable`;
  return `${doc(type.description)}public ${kind} {\n${lines.join("")}${keys}${init}}\n`;
}

function operation(op: ModelOperation): string {
  const params = op.pathParams.map((p) => `${ident(p.name)}: String`);
  for (const q of op.queryParams) {
    params.push(
      q.required
        ? `${ident(q.name)}: ${swiftType(q.type)}`
        : `${ident(q.name)}: ${optional(q.type)} = nil`,
    );
  }
  if (op.body) params.push(`body: ${swiftType(op.body)}`);
  const path = fillPath(quote(op.path), op, (name) => `\\(segment(${ident(name)}))`);
  const query = op.queryParams.length
    ? `[${queryItems(op, (wire) => `(${quote(wire)}, queryValue(${ident(wire)}))`)}]`
    : "[]";
  const body = op.body ? "body" : "nil as NoBody?";
  const lines = operationDoc(op, (codes) => `Throws \`APIError\` with a code in: ${codes}.`);
  const ret = op.response ? ` -> ${swiftType(op.response)}` : "";
  const call = `try await send(${quote(op.method)}, ${path}, query: ${query}, body: ${body})`;
  const run = op.response ? `        try decode(${call})\n` : `        _ = ${call}\n`;
  return `${doc(lines.join("\n"), "    ")}    public func ${ident(op.name)}(${
    params.join(", ")
  }) async throws${ret} {\n${run}    }\n`;
}

const JSON_VALUE = `/// Any JSON value (a schema the generator could not type).
public enum JSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}
`;

const RUNTIME = `/// A non-2xx response: its status and the server's error envelope.
public struct APIError: Error, Sendable {
    public let status: Int
    public let code: String
    public let message: String
    public let data: JSONValue?
}

private struct NoBody: Encodable {}

private struct ErrorEnvelope: Decodable {
    struct Body: Decodable {
        let code: String
        let message: String?
        let data: JSONValue?
    }
    let error: Body
}

/// Calls the API. \`headers\` are sent with every request (e.g. \`["authorization": "Bearer …"]\`).
@available(macOS 12.0, iOS 15.0, tvOS 15.0, watchOS 8.0, *)
public struct Client: Sendable {
    public var baseURL: URL
    public var headers: [String: String]
    public var session: URLSession

    public init(baseURL: URL, headers: [String: String] = [:], session: URLSession = .shared) {
        self.baseURL = baseURL
        self.headers = headers
        self.session = session
    }

    private func segment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? value
    }

    private func queryValue<T: Encodable>(_ value: T?) -> [String] {
        guard let value else { return [] }
        if let s = value as? String { return [s] }
        if let a = value as? [String] { return a }
        if let r = value as? any RawRepresentable, let s = r.rawValue as? String { return [s] }
        guard let data = try? JSONEncoder().encode(value), let text = String(data: data, encoding: .utf8) else { return [] }
        return [text]
    }

    private func send<B: Encodable>(_ method: String, _ path: String, query: [(String, [String])], body: B?) async throws -> Data {
        let base = baseURL.absoluteString
        var components = URLComponents(string: (base.hasSuffix("/") ? String(base.dropLast()) : base) + path)!
        let items = query.flatMap { name, values in values.map { URLQueryItem(name: name, value: $0) } }
        if !items.isEmpty { components.queryItems = items }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "accept")
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data) {
                throw APIError(status: status, code: envelope.error.code, message: envelope.error.message ?? "", data: envelope.error.data)
            }
            throw APIError(status: status, code: "http_error", message: String(decoding: data, as: UTF8.self), data: nil)
        }
        return data
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        try JSONDecoder().decode(T.self, from: data.isEmpty ? Data("null".utf8) : data)
    }
`;

const GRAPHQL_RUNTIME = `/// The errors a GraphQL response carried.
public struct GraphQLError: Error, Sendable, Decodable {
    public struct Entry: Sendable, Decodable {
        public let message: String
        public let path: [JSONValue]?
        public let extensions: JSONValue?
    }
    public let errors: [Entry]
}

/// Posts operations to \`url\`; \`headers\` are sent with every request.
@available(macOS 12.0, iOS 15.0, tvOS 15.0, watchOS 8.0, *)
public struct GraphQLClient: Sendable {
    public var url: URL
    public var headers: [String: String]
    public var session: URLSession

    public init(url: URL, headers: [String: String] = [:], session: URLSession = .shared) {
        self.url = url
        self.headers = headers
        self.session = session
    }

    private struct Payload: Encodable {
        let query: String
        let variables: [String: JSONValue]?
        let operationName: String?
    }

    private struct Response<D: Decodable>: Decodable {
        let data: D?
        let errors: [GraphQLError.Entry]?
    }

    /// Run one operation and decode its \`data\` as \`D\`; throws \`\`GraphQLError\`\` when errors came back.
    public func execute<D: Decodable>(_ query: String, variables: [String: JSONValue]? = nil, operationName: String? = nil, as type: D.Type) async throws -> D? {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        request.httpBody = try JSONEncoder().encode(Payload(query: query, variables: variables, operationName: operationName))
        let (data, _) = try await session.data(for: request)
        let response = try JSONDecoder().decode(Response<D>.self, from: data)
        if let errors = response.errors, !errors.isEmpty { throw GraphQLError(errors: errors) }
        return response.data
    }
}
`;

/**
 * The Swift file for `model`.
 *
 * @param model The client model.
 * @returns The file source (`Client.swift`).
 */
export function emitSwift(model: ClientModel): string {
  const graphql = model.graphqlPath !== undefined;
  const recursive = recursiveTypes(model.types);
  const parts = [
    `// ${
      banner(model.title, model.version, graphql ? "graphql" : "openapi", "swift")
    }\n// Foundation only.\n`,
    "import Foundation\n#if canImport(FoundationNetworking)\nimport FoundationNetworking\n#endif\n",
    JSON_VALUE,
    ...sortedTypes(model.types).map((t) => declaration(t, recursive)),
    graphql
      ? GRAPHQL_RUNTIME
      : RUNTIME + model.operations.map((op) => "\n" + operation(op)).join("") + "}\n",
  ];
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

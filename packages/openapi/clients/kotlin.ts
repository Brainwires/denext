/**
 * The Kotlin client: one file for the JVM (11+), no dependency beyond the Kotlin standard
 * library — `java.net.http.HttpClient` and a small JSON reader/writer in the file. Object types
 * are data classes with `toJson()` / `fromJson()`, string enums are enum classes carrying their
 * wire value, a schema-less value is `Any?`, and every operation is a blocking `Client` method
 * (call it from `Dispatchers.IO` in coroutine code).
 *
 * @module
 */

import {
  camelCase,
  type ClientModel,
  type ModelOperation,
  type NamedType,
  pascalCase,
  type TypeRef,
} from "./model.ts";
import { banner, fillPath, operationDoc, quote, sortedTypes, typePrinter } from "./shared.ts";

const KEYWORDS = new Set([
  "as",
  "break",
  "class",
  "continue",
  "do",
  "else",
  "false",
  "for",
  "fun",
  "if",
  "in",
  "interface",
  "is",
  "null",
  "object",
  "package",
  "return",
  "super",
  "this",
  "throw",
  "true",
  "try",
  "typealias",
  "typeof",
  "val",
  "var",
  "when",
  "while",
  "body",
  "query",
]);

/** A Kotlin identifier, backticked when it is a keyword. */
function ident(name: string): string {
  const id = camelCase(name) || "value";
  return KEYWORDS.has(id) ? `\`${id}\`` : id;
}

/** A Kotlin string literal (`$` escaped). */
function kstr(s: string): string {
  return quote(s).replace(/\$/g, "\\$");
}

/** Names of the enum types (their decode differs from an object's). */
type Kinds = Map<string, NamedType["kind"]>;

const ktType: (ref: TypeRef) => string = typePrinter(
  { string: "String", integer: "Long", number: "Double", boolean: "Boolean", any: "Any?" },
  {
    array: (items) => `List<${items}>`,
    map: (values) => `Map<String, ${values}>`,
    named: (name) => name,
    nullable: (inner) => nullable(inner),
  },
);

function nullable(ref: TypeRef): string {
  const t = ktType(ref);
  return t.endsWith("?") ? t : `${t}?`;
}

/** How each scalar decodes from its JSON value. */
const SCALAR_DECODE: Record<string, (e: string) => string> = {
  string: (e) => `(${e} as String)`,
  integer: (e) => `(${e} as Number).toLong()`,
  number: (e) => `(${e} as Number).toDouble()`,
  boolean: (e) => `(${e} as Boolean)`,
  any: (e) => e,
};

/** An expression decoding the JSON value `e` (an `Any?`) as `ref`. */
function decode(ref: TypeRef, e: string, kinds: Kinds): string {
  if (ref.kind === "array") return `(${e} as List<*>).map { ${decode(ref.items, "it", kinds)} }`;
  if (ref.kind === "map") {
    return `(${e} as Map<*, *>).entries.associate { (k, v) -> (k as String) to ${
      decode(ref.values, "v", kinds)
    } }`;
  }
  if (ref.kind === "nullable") return `${e}?.let { ${decode(ref.inner, "it", kinds)} }`;
  if (ref.kind === "named") {
    return kinds.get(ref.name) === "alias"
      ? `decode${ref.name}(${e})`
      : `${ref.name}.fromJson(${e})`;
  }
  return SCALAR_DECODE[ref.kind](e);
}

/** `ref` without its outer nullability (a value already checked for `null`). */
function nonNull(ref: TypeRef): TypeRef {
  return ref.kind === "nullable" ? ref.inner : ref;
}

/** Whether a value of `ref` is already its JSON value (no conversion needed). */
function plain(ref: TypeRef): boolean {
  if (ref.kind === "array") return plain(ref.items);
  if (ref.kind === "map") return plain(ref.values);
  if (ref.kind === "nullable") return plain(ref.inner);
  return ref.kind !== "named";
}

/** An expression encoding the Kotlin value `e` of `ref` as a JSON value. */
function encode(ref: TypeRef, e: string, kinds: Kinds): string {
  if (plain(ref)) return e;
  switch (ref.kind) {
    case "array":
      return `${e}.map { ${encode(ref.items, "it", kinds)} }`;
    case "map":
      return `${e}.mapValues { (_, v) -> ${encode(ref.values, "v", kinds)} }`;
    case "named":
      return kinds.get(ref.name) === "alias" ? `encode${ref.name}(${e})` : `${e}.toJson()`;
    case "nullable":
      return `${e}?.let { ${encode(ref.inner, "it", kinds)} }`;
    default:
      return e;
  }
}

function doc(text: string | undefined, indent = ""): string {
  if (!text) return "";
  return `${indent}/** ${text.replace(/\*\//g, "*\\/").replace(/\n/g, `\n${indent} * `)} */\n`;
}

function declaration(type: NamedType, kinds: Kinds): string {
  if (type.kind === "enum") {
    const cases = type.values.map((v, i) => {
      const name = (pascalCase(v) || `Value${i}`).replace(/^[a-z]/, (c) => c.toUpperCase());
      return `    ${name}(${kstr(v)})`;
    });
    return `${doc(type.description)}enum class ${type.name}(val value: String) {\n${
      cases.join(",\n")
    };\n\n` +
      `    fun toJson(): String = value\n\n    companion object {\n` +
      `        fun fromJson(v: Any?): ${type.name} = entries.first { it.value == v }\n    }\n}\n`;
  }
  if (type.kind === "alias") {
    return `${doc(type.description)}typealias ${type.name} = ${ktType(type.target)}\n\n` +
      `internal fun decode${type.name}(v: Any?): ${type.name} = ${
        decode(type.target, "v", kinds)
      }\n\n` +
      `internal fun encode${type.name}(v: ${type.name}): Any? = ${
        encode(type.target, "v", kinds)
      }\n`;
  }
  const props = type.fields.map((f) => ({
    f,
    name: ident(f.name),
    type: f.required ? ktType(f.type) : nullable(f.type),
  }));
  const ctor = props.map((p) =>
    `${doc(p.f.description, "    ")}    val ${p.name}: ${p.type}${p.f.required ? "" : " = null"},`
  ).join("\n");
  const toJson = props.map((p) =>
    p.f.required
      ? `        put(${kstr(p.f.name)}, ${encode(p.f.type, p.name, kinds)})`
      : `        if (${p.name} != null) put(${kstr(p.f.name)}, ${
        encode(nonNull(p.f.type), p.name, kinds)
      })`
  ).join("\n");
  const fromJson = props.map((p) => {
    const raw = `o[${kstr(p.f.name)}]`;
    const ref: TypeRef = p.f.required || p.f.type.kind === "nullable"
      ? p.f.type
      : { kind: "nullable", inner: p.f.type };
    return `            ${p.name} = ${decode(ref, raw, kinds)},`;
  }).join("\n");
  const head = props.length ? `data class ${type.name}(\n${ctor}\n)` : `class ${type.name}`;
  return `${doc(type.description)}${head} {\n` +
    `    fun toJson(): Map<String, Any?> = buildMap {\n${toJson}\n    }\n\n` +
    `    companion object {\n        fun fromJson(v: Any?): ${type.name} {\n` +
    `            val o = v as Map<*, *>\n` +
    (props.length
      ? `            return ${type.name}(\n${
        fromJson.replace(/^ {12}/gm, "                ")
      }\n            )\n`
      : `            return ${type.name}()\n`) +
    `        }\n    }\n}\n`;
}

function operation(op: ModelOperation, kinds: Kinds): string {
  const params = op.pathParams.map((p) => `${ident(p.name)}: String`);
  if (op.body) params.push(`body: ${ktType(op.body)}`);
  for (const q of op.queryParams) {
    params.push(
      q.required
        ? `${ident(q.name)}: ${ktType(q.type)}`
        : `${ident(q.name)}: ${nullable(q.type)} = null`,
    );
  }
  const path = fillPath(kstr(op.path), op, (name) => `\${segment(${ident(name)})}`);
  const query = op.queryParams.length
    ? `listOf(${
      op.queryParams.map((q) =>
        `${kstr(q.name)} to ${encode({ kind: "nullable", inner: q.type }, ident(q.name), kinds)}`
      ).join(", ")
    })`
    : "emptyList()";
  const body = op.body ? encode(op.body, "body", kinds) : "NoBody";
  const lines = operationDoc(op, (codes) => `@throws ApiException with a code in: ${codes}.`);
  const call = `send(${kstr(op.method)}, ${path}, ${query}, ${body})`;
  if (!op.response) {
    return `${doc(lines.join("\n"), "    ")}    fun ${ident(op.name)}(${
      params.join(", ")
    }) {\n        ${call}\n    }\n`;
  }
  return `${doc(lines.join("\n"), "    ")}    fun ${ident(op.name)}(${params.join(", ")}): ${
    ktType(op.response)
  } =\n` +
    `        ${call}.let { ${decode(op.response, "it", kinds)} }\n`;
}

const JSON_RUNTIME = `/**
 * The default HTTP client: HTTP/2 over TLS (negotiated), HTTP/1.1 over plain http — the JDK's
 * cleartext HTTP/2 upgrade is refused by many servers (Deno's among them).
 */
internal fun defaultHttpClient(url: String): HttpClient =
    if (url.startsWith("https:", ignoreCase = true)) {
        HttpClient.newHttpClient()
    } else {
        HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build()
    }

/** A minimal JSON reader/writer: objects are Map<String, Any?>, arrays List<Any?>, numbers Long or Double. */
internal object Json {
    fun stringify(v: Any?): String = StringBuilder().also { write(it, v) }.toString()

    private fun write(sb: StringBuilder, v: Any?) {
        when (v) {
            null -> sb.append("null")
            is String -> quote(sb, v)
            is Boolean -> sb.append(v)
            is Double -> sb.append(if (v.isFinite()) v.toString() else "null")
            is Float -> write(sb, v.toDouble())
            is Number -> sb.append(v.toLong())
            is Map<*, *> -> {
                sb.append('{')
                var first = true
                for ((k, value) in v) {
                    if (!first) sb.append(',')
                    first = false
                    quote(sb, k.toString())
                    sb.append(':')
                    write(sb, value)
                }
                sb.append('}')
            }
            is Iterable<*> -> {
                sb.append('[')
                var first = true
                for (item in v) {
                    if (!first) sb.append(',')
                    first = false
                    write(sb, item)
                }
                sb.append(']')
            }
            else -> quote(sb, v.toString())
        }
    }

    private fun quote(sb: StringBuilder, s: String) {
        sb.append('"')
        for (c in s) {
            when (c) {
                '"' -> sb.append("\\\\\\"")
                '\\\\' -> sb.append("\\\\\\\\")
                '\\n' -> sb.append("\\\\n")
                '\\r' -> sb.append("\\\\r")
                '\\t' -> sb.append("\\\\t")
                else -> if (c < ' ') sb.append(String.format("\\\\u%04x", c.code)) else sb.append(c)
            }
        }
        sb.append('"')
    }

    fun parse(text: String): Any? {
        val p = Parser(text)
        val v = p.value()
        p.skip()
        require(p.i == text.length) { "trailing JSON" }
        return v
    }

    private class Parser(val s: String) {
        var i = 0

        fun skip() {
            while (i < s.length && s[i].isWhitespace()) i++
        }

        fun value(): Any? {
            skip()
            require(i < s.length) { "unexpected end of JSON" }
            return when (s[i]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> str()
                't' -> word("true", true)
                'f' -> word("false", false)
                'n' -> word("null", null)
                else -> num()
            }
        }

        private fun word(w: String, v: Any?): Any? {
            require(s.startsWith(w, i)) { "bad JSON at $i" }
            i += w.length
            return v
        }

        private fun obj(): Map<String, Any?> {
            val out = LinkedHashMap<String, Any?>()
            i++
            skip()
            if (s[i] == '}') { i++; return out }
            while (true) {
                skip()
                val k = str()
                skip()
                require(s[i] == ':') { "bad JSON at $i" }
                i++
                out[k] = value()
                skip()
                if (s[i] == ',') { i++; continue }
                require(s[i] == '}') { "bad JSON at $i" }
                i++
                return out
            }
        }

        private fun arr(): List<Any?> {
            val out = ArrayList<Any?>()
            i++
            skip()
            if (s[i] == ']') { i++; return out }
            while (true) {
                out.add(value())
                skip()
                if (s[i] == ',') { i++; continue }
                require(s[i] == ']') { "bad JSON at $i" }
                i++
                return out
            }
        }

        private fun str(): String {
            require(s[i] == '"') { "bad JSON at $i" }
            i++
            val sb = StringBuilder()
            while (s[i] != '"') {
                val c = s[i++]
                if (c != '\\\\') { sb.append(c); continue }
                when (val e = s[i++]) {
                    'n' -> sb.append('\\n')
                    't' -> sb.append('\\t')
                    'r' -> sb.append('\\r')
                    'b' -> sb.append('\\b')
                    'f' -> sb.append('\\u000c')
                    'u' -> { sb.append(s.substring(i, i + 4).toInt(16).toChar()); i += 4 }
                    else -> sb.append(e)
                }
            }
            i++
            return sb.toString()
        }

        private fun num(): Number {
            val start = i
            while (i < s.length && (s[i].isDigit() || s[i] in "+-.eE")) i++
            val t = s.substring(start, i)
            return if (t.any { it in ".eE" }) t.toDouble() else t.toLongOrNull() ?: t.toDouble()
        }
    }
}
`;

const RUNTIME = `/** A non-2xx response: its status and the server's error envelope. */
class ApiException(val status: Int, val code: String, override val message: String, val data: Any?) :
    Exception("$status $code: $message")

internal object NoBody

/** Calls the API. [headers] are sent with every request (e.g. "authorization" to "Bearer …"). */
class Client(
    baseUrl: String,
    private val headers: Map<String, String> = emptyMap(),
    private val http: HttpClient = defaultHttpClient(baseUrl),
    private val timeout: Duration = Duration.ofSeconds(30),
) {
    private val base = baseUrl.trimEnd('/')

    private fun segment(v: String): String = URLEncoder.encode(v, StandardCharsets.UTF_8).replace("+", "%20")

    private fun queryString(params: List<Pair<String, Any?>>): String {
        val parts = params.flatMap { (k, v) ->
            when (v) {
                null -> emptyList()
                is List<*> -> v.map { k to it }
                else -> listOf(k to v)
            }
        }.map { (k, v) -> "\${segment(k)}=\${segment(if (v is String) v else if (v is Map<*, *>) Json.stringify(v) else v.toString())}" }
        return if (parts.isEmpty()) "" else "?" + parts.joinToString("&")
    }

    private fun send(method: String, path: String, query: List<Pair<String, Any?>>, body: Any?): Any? {
        val builder = HttpRequest.newBuilder(URI.create(base + path + queryString(query)))
            .timeout(timeout)
            .header("accept", "application/json")
        headers.forEach { (k, v) -> builder.header(k, v) }
        val publisher = if (body === NoBody) {
            HttpRequest.BodyPublishers.noBody()
        } else {
            builder.header("content-type", "application/json")
            HttpRequest.BodyPublishers.ofString(Json.stringify(body))
        }
        val response = http.send(builder.method(method, publisher).build(), HttpResponse.BodyHandlers.ofString())
        val text = response.body() ?: ""
        if (response.statusCode() !in 200..299) {
            val envelope = runCatching { (Json.parse(text) as Map<*, *>)["error"] as Map<*, *> }.getOrNull()
            throw ApiException(
                response.statusCode(),
                envelope?.get("code") as? String ?: "http_error",
                envelope?.get("message") as? String ?: text,
                envelope?.get("data"),
            )
        }
        return if (text.isBlank()) null else Json.parse(text)
    }
`;

const GRAPHQL_RUNTIME =
  `/** The errors a GraphQL response carried (each a decoded {"message", "path"?, "extensions"?}). */
class GraphQLException(val errors: List<Map<String, Any?>>, val data: Any?) :
    Exception(errors.joinToString("; ") { it["message"]?.toString() ?: "GraphQL error" })

/** Posts operations to [url]; [headers] are sent with every request. */
class GraphQLClient(
    private val url: String,
    private val headers: Map<String, String> = emptyMap(),
    private val http: HttpClient = defaultHttpClient(url),
    private val timeout: Duration = Duration.ofSeconds(30),
) {
    /** Run one operation; returns its decoded data, or throws [GraphQLException] when errors came back. */
    fun execute(query: String, variables: Map<String, Any?>? = null, operationName: String? = null): Any? {
        val payload = buildMap<String, Any?> {
            put("query", query)
            if (variables != null) put("variables", variables)
            if (operationName != null) put("operationName", operationName)
        }
        val builder = HttpRequest.newBuilder(URI.create(url))
            .timeout(timeout)
            .header("content-type", "application/json")
            .header("accept", "application/json")
        headers.forEach { (k, v) -> builder.header(k, v) }
        val response = http.send(
            builder.POST(HttpRequest.BodyPublishers.ofString(Json.stringify(payload))).build(),
            HttpResponse.BodyHandlers.ofString(),
        )
        val result = Json.parse(response.body()) as Map<*, *>
        val errors = (result["errors"] as? List<*>)?.map { e -> (e as Map<*, *>).entries.associate { (k, v) -> k.toString() to v } }
        if (!errors.isNullOrEmpty()) throw GraphQLException(errors, result["data"])
        return result["data"]
    }
}
`;

/** Options for {@linkcode emitKotlin}. */
export interface KotlinOptions {
  /** The package (default `client`). */
  packageName?: string;
}

/**
 * The Kotlin file for `model`.
 *
 * @param model The client model.
 * @param options The package.
 * @returns The file source (`Client.kt`).
 */
export function emitKotlin(model: ClientModel, options: KotlinOptions = {}): string {
  const graphql = model.graphqlPath !== undefined;
  const kinds: Kinds = new Map(model.types.map((t) => [t.name, t.kind]));
  const parts = [
    `// ${
      banner(model.title, model.version, graphql ? "graphql" : "openapi", "kotlin")
    }\n// JVM 11+, Kotlin standard library only.\n` +
    `@file:Suppress("UNCHECKED_CAST", "unused", "RedundantVisibilityModifier")\n\npackage ${
      options.packageName ?? "client"
    }\n`,
    "import java.net.URI\nimport java.net.URLEncoder\nimport java.net.http.HttpClient\nimport java.net.http.HttpRequest\n" +
    "import java.net.http.HttpResponse\nimport java.nio.charset.StandardCharsets\nimport java.time.Duration\n",
    ...sortedTypes(model.types).map((t) => declaration(t, kinds)),
    graphql
      ? GRAPHQL_RUNTIME
      : RUNTIME + model.operations.map((op) => "\n" + operation(op, kinds)).join("") + "}\n",
    JSON_RUNTIME,
  ];
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

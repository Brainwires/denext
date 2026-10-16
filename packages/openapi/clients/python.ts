/**
 * The Python client: one module, standard library only (`urllib.request` + `json`), Python 3.11+.
 * Types are `TypedDict`s (`NotRequired` for optional keys) and `Literal` string enums, so a value
 * is the decoded JSON itself — nothing to convert.
 *
 * @module
 */

import {
  type ClientModel,
  type ModelOperation,
  type NamedType,
  snakeCase,
  type TypeRef,
} from "./model.ts";
import {
  banner,
  operationDoc,
  orderAliases,
  queryItems,
  quote,
  sortedTypes,
  typePrinter,
} from "./shared.ts";

/** Python's keywords: not usable as a class-form `TypedDict` key or an argument name. */
const KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

/** Argument names an operation method already uses. */
const TAKEN = new Set(["self", "body"]);

/** A Python argument name for a wire name. */
function ident(name: string): string {
  const id = snakeCase(name) || "value";
  return KEYWORDS.has(id) || TAKEN.has(id) ? `${id}_` : id;
}

/** The Python annotation of a type. */
const py = typePrinter(
  { string: "str", integer: "int", number: "float", boolean: "bool", any: "Any" },
  {
    array: (items) => `list[${items}]`,
    map: (values) => `dict[str, ${values}]`,
    named: (name) => name,
    nullable: (inner, print) => `${print(inner)} | None`,
  },
);

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function docstring(text: string | undefined, indent: string): string {
  if (!text) return "";
  return `${indent}"""${text.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"')}"""\n`;
}

function declaration(type: NamedType): string {
  if (type.kind === "enum") {
    return `${type.name} = Literal[${type.values.map(quote).join(", ")}]\n`;
  }
  if (type.kind === "alias") return `${type.name} = ${py(type.target)}\n`;
  const field = (f: { name: string; type: TypeRef; required: boolean }) =>
    f.required ? py(f.type) : `NotRequired[${py(f.type)}]`;
  if (type.fields.every((f) => IDENT.test(f.name) && !KEYWORDS.has(f.name))) {
    const body = type.fields.length
      ? type.fields.map((f) => `    ${f.name}: ${field(f)}\n`).join("")
      : type.description
      ? ""
      : "    pass\n";
    return `class ${type.name}(TypedDict):\n${docstring(type.description, "    ")}${body}`;
  }
  // Keys that are not identifiers need the functional form (string annotations: forward refs).
  const entries = type.fields.map((f) => `${quote(f.name)}: ${quote(field(f))}`).join(", ");
  return `${type.name} = TypedDict(${quote(type.name)}, {${entries}})\n`;
}

function signature(op: ModelOperation): string {
  const args = ["self", ...op.pathParams.map((p) => `${ident(p.name)}: str`)];
  if (op.body) args.push(`body: ${py(op.body)}`);
  if (op.queryParams.length) {
    args.push("*");
    for (const q of op.queryParams) {
      args.push(
        q.required
          ? `${ident(q.name)}: ${py(q.type)}`
          : `${ident(q.name)}: ${py(q.type)} | None = None`,
      );
    }
  }
  const ret = op.response ? py(op.response) : "None";
  return `    def ${snakeCase(op.name)}(${args.join(", ")}) -> ${ret}:\n`;
}

function method(op: ModelOperation): string {
  let path = op.path.replace(/[{}]/g, (c) => c + c);
  for (const p of op.pathParams) {
    path = path.replace(`{{${p.name}}}`, `{_segment(${ident(p.name)})}`);
  }
  const doc = operationDoc(op, (codes) => `Raises ApiError with a code in: ${codes}.`)
    .join("\n\n        ");
  const query = op.queryParams.length
    ? `{${queryItems(op, (wire) => `${quote(wire)}: ${ident(wire)}`)}}`
    : "None";
  const literal = op.pathParams.length ? `f${quote(path)}` : quote(op.path);
  const call = `self._request(${quote(op.method)}, ${literal}, ${query}, ${
    op.body ? "body" : "None"
  })`;
  const body = op.response
    ? `        return cast(${quote(py(op.response))}, ${call})\n`
    : `        ${call}\n`;
  return signature(op) + `        """${doc}"""\n` + body;
}

const RUNTIME = `class ApiError(Exception):
    """A non-2xx response: its status and the server's error envelope (\`code\`, \`message\`, \`data\`)."""

    def __init__(self, status: int, code: str, message: str, data: Any = None) -> None:
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.data = data


def _segment(value: str) -> str:
    return urllib.parse.quote(str(value), safe="")


def _query_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return value if isinstance(value, str) else json.dumps(value) if isinstance(value, (dict, list)) else str(value)


def _query(params: dict[str, Any] | None) -> str:
    pairs: list[tuple[str, str]] = []
    for key, value in (params or {}).items():
        if value is None:
            continue
        for item in value if isinstance(value, list) else [value]:
            pairs.append((key, _query_value(item)))
    return "?" + urllib.parse.urlencode(pairs) if pairs else ""


class Client:
    """A typed client. \`headers\` are sent with every call (e.g. \`{"authorization": "Bearer …"}\`)."""

    def __init__(self, base_url: str, headers: dict[str, str] | None = None, timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.headers = dict(headers or {})
        self.timeout = timeout

    def _request(self, method: str, path: str, query: dict[str, Any] | None, body: Any) -> Any:
        data = None if body is None else json.dumps(body).encode()
        headers = {"accept": "application/json", **self.headers}
        if data is not None:
            headers["content-type"] = "application/json"
        request = urllib.request.Request(self.base_url + path + _query(query), data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                text = response.read().decode()
        except urllib.error.HTTPError as error:
            raw = error.read().decode()
            try:
                envelope = json.loads(raw).get("error", {})
            except (ValueError, AttributeError):
                envelope = {}
            raise ApiError(error.code, str(envelope.get("code", "http_error")), str(envelope.get("message", raw or error.reason)), envelope.get("data")) from None
        return json.loads(text) if text else None
`;

const GRAPHQL_RUNTIME = `class GraphQLError(Exception):
    """The \`errors\` a GraphQL response carried (each \`{"message", "path"?, "extensions"?}\`)."""

    def __init__(self, errors: list[Any], data: Any = None) -> None:
        super().__init__("; ".join(str(e.get("message", e)) if isinstance(e, dict) else str(e) for e in errors))
        self.errors = errors
        self.data = data


class GraphQLClient:
    """Posts operations to the endpoint; \`headers\` are sent with every call."""

    def __init__(self, url: str, headers: dict[str, str] | None = None, timeout: float = 30.0) -> None:
        self.url = url
        self.headers = dict(headers or {})
        self.timeout = timeout

    def execute(self, query: str, variables: dict[str, Any] | None = None, operation_name: str | None = None) -> Any:
        """Run one operation; returns its \`data\`, raises GraphQLError when \`errors\` came back."""
        payload: dict[str, Any] = {"query": query}
        if variables is not None:
            payload["variables"] = variables
        if operation_name is not None:
            payload["operationName"] = operation_name
        request = urllib.request.Request(self.url, data=json.dumps(payload).encode(), method="POST", headers={"content-type": "application/json", "accept": "application/json", **self.headers})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                result = json.loads(response.read().decode())
        except urllib.error.HTTPError as error:
            try:
                result = json.loads(error.read().decode())
            except ValueError:
                raise GraphQLError([{"message": f"HTTP {error.code}"}]) from None
        if result.get("errors"):
            raise GraphQLError(result["errors"], result.get("data"))
        return result.get("data")
`;

/**
 * The Python module for `model`.
 *
 * @param model The client model.
 * @returns The module source (`client.py`).
 */
export function emitPython(model: ClientModel): string {
  const types = sortedTypes(model.types);
  const enums = types.filter((t) => t.kind === "enum");
  const objects = types.filter((t) => t.kind === "object");
  const aliases = orderAliases(types.filter((t) => t.kind === "alias"));
  const parts = [
    `"""${
      banner(model.title, model.version, model.graphqlPath ? "graphql" : "openapi", "python")
    }\n\nStandard library only; Python 3.11+.\n"""\n`,
    "from __future__ import annotations\n",
    "import json\nimport urllib.error\nimport urllib.parse\nimport urllib.request\n" +
    "from typing import Any, Literal, NotRequired, TypedDict, cast\n",
    ...[...enums, ...objects, ...aliases].map(declaration),
  ];
  if (model.graphqlPath) {
    parts.push(GRAPHQL_RUNTIME);
  } else {
    parts.push(RUNTIME + model.operations.map((op) => "\n" + method(op)).join(""));
  }
  return parts.join("\n\n").replace(/\n{3,}/g, "\n\n\n").trimEnd() + "\n";
}

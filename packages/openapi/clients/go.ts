/**
 * The Go client: one file of package `client` (or the name given), standard library only
 * (`net/http`, `encoding/json`). Object types are structs with `json` tags (an optional field is
 * a pointer, slice or map with `omitempty`), string enums are named `string` types with
 * constants, and every operation is a `Client` method taking a `context.Context`.
 *
 * @module
 */

import {
  camelCase,
  type ClientModel,
  type ModelField,
  type ModelOperation,
  type NamedType,
  pascalCase,
  type TypeRef,
} from "./model.ts";
import {
  banner,
  fillPath,
  lineComment,
  orderAliases,
  quote,
  sortedTypes,
  typePrinter,
} from "./shared.ts";

/** Initialisms Go spells in capitals (`ID`, `URL`). */
const INITIALISMS = new Set([
  "Id",
  "Url",
  "Api",
  "Http",
  "Https",
  "Json",
  "Uuid",
  "Ip",
  "Uri",
  "Html",
  "Sql",
]);

/** An exported Go identifier for a name. */
function goName(name: string): string {
  return pascalCase(name).replace(
    /[A-Z][a-z]*/g,
    (w) => (INITIALISMS.has(w) ? w.toUpperCase() : w),
  );
}

const KEYWORDS = new Set([
  "break",
  "case",
  "chan",
  "const",
  "continue",
  "default",
  "defer",
  "else",
  "fallthrough",
  "for",
  "func",
  "go",
  "goto",
  "if",
  "import",
  "interface",
  "map",
  "package",
  "range",
  "return",
  "select",
  "struct",
  "switch",
  "type",
  "var",
  "ctx",
  "body",
  "query",
  "c",
]);

/** An unexported Go identifier (an argument). */
function argName(name: string): string {
  const id = camelCase(name) || "value";
  return KEYWORDS.has(id) ? `${id}Arg` : id;
}

/** The Go type of a reference. */
const goType: (ref: TypeRef) => string = typePrinter(
  { string: "string", integer: "int64", number: "float64", boolean: "bool", any: "any" },
  {
    array: (items) => `[]${items}`,
    map: (values) => `map[string]${values}`,
    named: (name) => goName(name),
    nullable: (inner) => pointer(inner),
  },
);

/** A type that can be absent: slices, maps and `any` already can; anything else is a pointer. */
function pointer(ref: TypeRef): string {
  const t = goType(ref);
  return t.startsWith("[]") || t.startsWith("map[") || t === "any" || t.startsWith("*")
    ? t
    : `*${t}`;
}

/**
 * Align the cells of consecutive lines as gofmt does: each line is `[indent, ...cells]`; a run
 * of lines with more than one cell shares column widths (a comment line ends the run).
 */
function align(rows: (string | string[])[], indent = "\t"): string {
  const out: string[] = [];
  let run: string[][] = [];
  const flush = () => {
    const widths: number[] = [];
    for (const cells of run) {
      cells.slice(0, -1).forEach((c, i) => widths[i] = Math.max(widths[i] ?? 0, c.length));
    }
    for (const cells of run) {
      out.push(
        indent + cells.map((c, i) => i < cells.length - 1 ? c.padEnd(widths[i]) : c).join(" "),
      );
    }
    run = [];
  };
  for (const row of rows) {
    if (typeof row === "string") {
      flush();
      out.push(row);
    } else run.push(row);
  }
  flush();
  return out.map((l) => l + "\n").join("");
}

function comment(text: string | undefined, indent = ""): string {
  return lineComment(text, indent, "//");
}

/** A struct field's rows: its doc comment lines, then `[name, type, tag]`. */
function field(f: ModelField, used: Set<string>, tags = true): (string | string[])[] {
  let name = goName(f.name) || "Field";
  for (let n = 2; used.has(name); n++) name = `${goName(f.name)}${n}`;
  used.add(name);
  const type = f.required ? goType(f.type) : pointer(f.type);
  const tag = f.required ? f.name : `${f.name},omitempty`;
  const doc = f.description ? comment(f.description, "\t").trimEnd().split("\n") : [];
  return [...doc, tags ? [name, type, `\`json:${quote(tag)}\``] : [name, type]];
}

function struct(name: string, rows: (string | string[])[]): string {
  return `type ${name} struct {\n${align(rows)}}\n`;
}

function declaration(type: NamedType): string {
  const name = goName(type.name);
  const doc = comment(type.description ?? `${name} is a generated type.`);
  if (type.kind === "enum") {
    const consts = type.values.map((
      v,
    ) => [`${name}${goName(v) || "Empty"}`, name, `= ${quote(v)}`]);
    return `${doc}type ${name} string\n\nconst (\n${align(consts)})\n`;
  }
  if (type.kind === "alias") return `${doc}type ${name} = ${goType(type.target)}\n`;
  const used = new Set<string>();
  return doc + struct(name, type.fields.flatMap((f) => field(f, used)));
}

/** The query struct of an operation, when it has query parameters. */
function queryStruct(op: ModelOperation): string {
  if (!op.queryParams.length) return "";
  const used = new Set<string>();
  const rows = op.queryParams.flatMap((q) =>
    field({ name: q.name, type: q.type, required: false }, used, false)
  );
  return `// ${goName(op.name)}Query holds the query parameters of ${goName(op.name)}.\n` +
    struct(`${goName(op.name)}Query`, rows) + "\n" +
    `func (q *${
      goName(op.name)
    }Query) values() url.Values {\n\tv := url.Values{}\n\tif q == nil {\n\t\treturn v\n\t}\n` +
    op.queryParams.map((p) => {
      const name = goName(p.name);
      const t = goType(p.type);
      const add = t.startsWith("[]") || t.startsWith("map[") || t === "any"
        ? `addQuery(v, ${quote(p.name)}, q.${name})`
        : `v.Add(${quote(p.name)}, fmt.Sprint(*q.${name}))`;
      return `\tif q.${name} != nil {\n\t\t${add}\n\t}\n`;
    }).join("") + "\treturn v\n}\n";
}

function operation(op: ModelOperation): string {
  const name = goName(op.name);
  const args = ["ctx context.Context", ...op.pathParams.map((p) => `${argName(p.name)} string`)];
  if (op.queryParams.length) args.push(`query *${name}Query`);
  if (op.body) args.push(`body ${goType(op.body)}`);
  const path = fillPath(quote(op.path), op, (name) => `"+url.PathEscape(${argName(name)})+"`)
    .replace(/\+""$/, "");
  const values = op.queryParams.length ? "query.values()" : "nil";
  const body = op.body ? "body" : "nil";
  const doc = [
    `${name} calls ${op.method} ${op.path}.${op.summary ? ` ${op.summary}` : ""}`,
    ...Object.keys(op.errors).length
      ? [`It fails with an *APIError whose Code is one of: ${Object.keys(op.errors).join(", ")}.`]
      : [],
  ].join("\n");
  if (!op.response) {
    return `${comment(doc)}func (c *Client) ${name}(${args.join(", ")}) error {\n` +
      `\treturn c.do(ctx, ${quote(op.method)}, ${path}, ${values}, ${body}, nil)\n}\n`;
  }
  const ret = goType(op.response);
  return `${comment(doc)}func (c *Client) ${name}(${args.join(", ")}) (${ret}, error) {\n` +
    `\tvar out ${ret}\n\terr := c.do(ctx, ${
      quote(op.method)
    }, ${path}, ${values}, ${body}, &out)\n` +
    `\treturn out, err\n}\n`;
}

const RUNTIME = `// APIError is a non-2xx response: its status and the server's error envelope.
type APIError struct {
	Status  int
	Code    string
	Message string
	Data    json.RawMessage
}

func (e *APIError) Error() string {
	return fmt.Sprintf("%d %s: %s", e.Status, e.Code, e.Message)
}

// Client calls the API. Header is sent with every request (e.g. Authorization).
type Client struct {
	BaseURL    string
	HTTPClient *http.Client
	Header     http.Header
}

// New returns a Client for baseURL using http.DefaultClient.
func New(baseURL string) *Client {
	return &Client{BaseURL: strings.TrimRight(baseURL, "/"), HTTPClient: http.DefaultClient, Header: http.Header{}}
}

func addQuery(v url.Values, key string, value any) {
	switch x := value.(type) {
	case []string:
		for _, s := range x {
			v.Add(key, s)
		}
	default:
		if b, err := json.Marshal(x); err == nil {
			v.Add(key, string(b))
		}
	}
}

func (c *Client) do(ctx context.Context, method, path string, query url.Values, body any, out any) error {
	target := c.BaseURL + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return err
	}
	for k, vs := range c.Header {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := c.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		var envelope struct {
			Error struct {
				Code    string          \`json:"code"\`
				Message string          \`json:"message"\`
				Data    json.RawMessage \`json:"data"\`
			} \`json:"error"\`
		}
		apiErr := &APIError{Status: res.StatusCode, Code: "http_error", Message: res.Status}
		if json.Unmarshal(data, &envelope) == nil && envelope.Error.Code != "" {
			apiErr.Code, apiErr.Message, apiErr.Data = envelope.Error.Code, envelope.Error.Message, envelope.Error.Data
		}
		return apiErr
	}
	if out == nil || len(bytes.TrimSpace(data)) == 0 {
		return nil
	}
	return json.Unmarshal(data, out)
}
`;

const GRAPHQL_RUNTIME = `// GraphQLError is one entry of a GraphQL response's errors.
type GraphQLError struct {
	Message    string          \`json:"message"\`
	Path       []any           \`json:"path,omitempty"\`
	Extensions json.RawMessage \`json:"extensions,omitempty"\`
}

// GraphQLErrors is the errors a response carried.
type GraphQLErrors []GraphQLError

func (e GraphQLErrors) Error() string {
	messages := make([]string, len(e))
	for i, x := range e {
		messages[i] = x.Message
	}
	return strings.Join(messages, "; ")
}

// GraphQLClient posts operations to URL. Header is sent with every request.
type GraphQLClient struct {
	URL        string
	HTTPClient *http.Client
	Header     http.Header
}

// Execute runs one operation and decodes its data into out; it fails with GraphQLErrors when the
// response carried errors.
func (c *GraphQLClient) Execute(ctx context.Context, query string, variables map[string]any, operationName string, out any) error {
	payload := map[string]any{"query": query}
	if variables != nil {
		payload["variables"] = variables
	}
	if operationName != "" {
		payload["operationName"] = operationName
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL, bytes.NewReader(b))
	if err != nil {
		return err
	}
	for k, vs := range c.Header {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	client := c.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	var result struct {
		Data   json.RawMessage \`json:"data"\`
		Errors GraphQLErrors   \`json:"errors"\`
	}
	if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
		return fmt.Errorf("graphql: HTTP %d: %w", res.StatusCode, err)
	}
	if len(result.Errors) > 0 {
		return result.Errors
	}
	if out == nil || len(result.Data) == 0 {
		return nil
	}
	return json.Unmarshal(result.Data, out)
}
`;

/** Options for {@linkcode emitGo}. */
export interface GoOptions {
  /** The package name (default `client`). */
  packageName?: string;
}

/**
 * The Go file for `model`.
 *
 * @param model The client model.
 * @param options The package name.
 * @returns The file source (`client.go`).
 */
export function emitGo(model: ClientModel, options: GoOptions = {}): string {
  const pkg = options.packageName ?? "client";
  const types = sortedTypes(model.types);
  const decls = [
    ...types.filter((t) => t.kind !== "alias"),
    ...orderAliases(types.filter((t) => t.kind === "alias")),
  ].map(declaration);
  const graphql = model.graphqlPath !== undefined;
  const imports = graphql
    ? ["bytes", "context", "encoding/json", "fmt", "net/http", "strings"]
    : ["bytes", "context", "encoding/json", "fmt", "io", "net/http", "net/url", "strings"];
  const parts = [
    `// Package ${pkg}: ${
      banner(model.title, model.version, graphql ? "graphql" : "openapi", "go")
    }\n` +
    `//\n// Standard library only.\npackage ${pkg}\n`,
    `import (\n${imports.map((i) => `\t${quote(i)}\n`).join("")})\n`,
    ...decls,
    graphql ? GRAPHQL_RUNTIME : RUNTIME,
    ...model.operations.flatMap((op) => [queryStruct(op), operation(op)].filter(Boolean)),
  ];
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

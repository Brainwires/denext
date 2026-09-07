import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "OpenAPI & API docs",
  description:
    "An OpenAPI 3.1 document and a docs page derived from your defineApi definitions via the @denext/openapi plugin: live /openapi.json and /docs, a build artifact, and a denext openapi CI verb — zero config.",
};

export default function OpenApi() {
  return (
    <DocsShell
      active="openapi"
      title="OpenAPI & API docs"
      lead="The schema that validates a route is the schema that documents it. @denext/openapi reads the definitions your defineApi handlers already carry and serves an OpenAPI 3.1 document at /openapi.json and a reference page at /docs — nothing to annotate twice, nothing to keep in sync."
    >
      <h2>Install</h2>
      <Code lang="sh">{`denext plugin add @denext/openapi`}</Code>
      <p>Or by hand:</p>
      <Code lang="ts">
        {`// denext.config.ts
import { openapi } from "@denext/openapi";

export default {
  plugins: [openapi({ info: { title: "Todos", version: "1.0.0" } })],
};`}
      </Code>
      <p>
        That is the whole setup. An app that already uses{" "}
        <a href="/docs/typed-api">
          <code>defineApi</code>
        </a>{" "}
        now serves <code>GET /openapi.json</code> (the document, ETag'd) and <code>GET /docs</code>
        {" "}
        (the reference page), and <code>denext build</code> writes <code>openapi.json</code>{" "}
        into the output directory. Both endpoints are plugin request handlers, so an app page at
        {" "}
        <code>/docs</code> always wins — the plugin can never shadow your routes.
      </p>

      <h2>What gets described</h2>
      <Code lang="ts">
        {`export const POST = defineApi({
  summary: "Create a todo",                        // → operation summary
  body: z.object({ title: z.string().min(1) }),   // → requestBody (application/json)
  response: todo,                                 // → 200 response schema
  errors: { duplicate: 409 },                     // → 409 response, code enum ["duplicate"]
}, handler);`}
      </Code>
      <ul>
        <li>
          <code>params</code> → path parameters, typed from the schema's properties (a{" "}
          <code>[...rest]</code> catch-all is one <code>/</code>-joined parameter);{" "}
          <code>query</code> → one query parameter per property, <code>required</code>{" "}
          from the schema.
        </li>
        <li>
          A declared <code>params</code>, <code>query</code> or <code>body</code> schema adds the
          {" "}
          <code>400</code> validation response (a <code>body</code> also adds{" "}
          <code>bad_request</code> for a malformed one); every operation gets a <code>default</code>
          {" "}
          envelope response for what the definition cannot name. Every error response uses the
          shared <code>ApiError</code>{" "}
          envelope schema (<code>components.schemas.ApiError</code>) with that status's codes as an
          enum, so a generated client can narrow on <code>error.code</code> exactly like{" "}
          <code>ApiClientError</code> does.
        </li>
        <li>
          A plain <code>export function GET(req)</code> is still listed by path and method, with an
          {" "}
          <code>undescribed-route</code> lint warning. <code>HEAD</code>{" "}
          is never an operation (denext derives it from <code>GET</code>).
        </li>
      </ul>

      <h2>JSON Schema from your validator</h2>
      <p>
        Standard Schema has no JSON-Schema export of its own; its companion{" "}
        <a href="https://standardschema.dev/json-schema">
          Standard JSON Schema
        </a>{" "}
        does, and denext tries it first: <code>schema["~standard"].jsonSchema.input()</code>{" "}
        for params / query / body and <code>.output()</code> for the response. Then, in order:
      </p>
      <ul>
        <li>
          Your converter, when given:{" "}
          <code>openapi({"{ toJsonSchema: (schema, side) => … }"})</code>{" "}
          — consulted before everything below.
        </li>
        <li>
          <strong>Zod ≥ 4.2, ArkType ≥ 2.1.28</strong> implement it directly;{" "}
          <strong>Valibot</strong> via <code>toStandardJsonSchema</code> from{" "}
          <code>@valibot/to-json-schema</code>.
        </li>
        <li>
          <strong>TypeBox</strong> schemas are JSON Schema already — used as-is.
        </li>
        <li>
          A <code>toJsonSchema()</code> method on the schema (older ArkType).
        </li>
      </ul>
      <p>
        Anything else is emitted as <code>{"{}"}</code> (accepts anything) with an{" "}
        <code>opaque-schema</code> warning. The document is always valid;{" "}
        <code>denext openapi lint</code> tells you exactly which route, method and part to fix.
      </p>

      <h2>The docs page</h2>
      <p>
        <code>ui: "builtin"</code>{" "}
        (the default) is a server-rendered reference — operations grouped by tag, parameters,
        request body, responses and schemas as a compact tree. It ships{" "}
        <strong>no JavaScript</strong>{" "}
        and its stylesheet is served from your origin, so it works unchanged under a strict{" "}
        <code>script-src 'self'; style-src 'self'</code> CSP.
      </p>
      <Code lang="ts">
        {`openapi({ ui: "scalar" });                              // Scalar API Reference, from cdn.jsdelivr.net
openapi({ ui: "swagger" });                             // Swagger UI, from unpkg.com
openapi({ ui: "scalar", cdn: "/vendor/scalar.js" });   // self-hosted bundle`}
      </Code>
      <Callout kind="note">
        The interactive renderers load a bundle from a CDN by default. Allow that host in your{" "}
        <code>csp</code>, or self-host the bundle and point <code>cdn</code> at it.
      </Callout>

      <h2>CI</h2>
      <Code lang="sh">
        {`denext openapi emit --out openapi.json   # regenerate the committed spec
denext openapi diff openapi.json         # exit 1 when an operation or schema changed
denext openapi lint --strict             # exit 1 when anything is undescribed`}
      </Code>
      <p>
        <code>@denext/openapi/spec</code> exports <code>buildOpenApi</code>, <code>diffSpecs</code>
        {" "}
        and <code>toJsonSchema</code> for scripts that need no server:
      </p>
      <Code lang="ts">
        {`import { buildOpenApi } from "@denext/openapi/spec";
import { scanRoutes } from "@denext/denext/server";

const { document, warnings } = await buildOpenApi({
  manifest: await scanRoutes("./app"),
  load: (file) => import(file),
  info: { title: "Todos", version: "1.0.0" },
});`}
      </Code>

      <h2>Options</h2>
      <ul>
        <li>
          <code>path</code> (<code>/openapi.json</code>), <code>docs</code> (<code>/docs</code>, or
          {" "}
          <code>false</code>) — both prefixed with <code>basePath</code>.
        </li>
        <li>
          <code>ui</code>, <code>cdn</code> — the renderer and where its bundle comes from.
        </li>
        <li>
          <code>info</code>, <code>servers</code>{" "}
          — document metadata (the title defaults to the project directory's name).
        </li>
        <li>
          <code>include(route)</code>, <code>tags(route)</code>{" "}
          — which routes, and how they group (default tag: the first path segment after{" "}
          <code>/api</code>).
        </li>
        <li>
          <code>authorize(request)</code> — return <code>false</code>{" "}
          to hide both endpoints from a request. The refusal falls through to the app's ordinary
          404, so there is no "forbidden" oracle.
        </li>
        <li>
          <code>outFile</code> — the build-output file name, or <code>false</code>{" "}
          to skip the build step.
        </li>
      </ul>
      <p>
        See <code>examples/typed-api</code>{" "}
        — its hand-rolled schema implements Standard JSON Schema, so every operation is fully
        described with zero third-party code.
      </p>
    </DocsShell>
  );
}

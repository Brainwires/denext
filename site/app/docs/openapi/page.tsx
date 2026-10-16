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
        (the reference page), <code>denext build</code> writes <code>openapi.json</code>{" "}
        into the output directory, and <code>denext export</code>{" "}
        publishes the document at its URL in the static site (the docs page renders per request, so
        it is not exported). Both endpoints are plugin request handlers, so an app page at{" "}
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
          <code>bad_request</code>{" "}
          for a malformed one). The endpoint's middleware adds the responses it answers with:{" "}
          <code>requireSession()</code>'s <code>401</code> (and its <code>403</code> with a{" "}
          <code>role</code>), <code>requireBearer()</code>'s <code>401</code> with its{" "}
          <code>www-authenticate</code> header (and <code>403</code> with a <code>scope</code> or
          {" "}
          <code>role</code>), <code>rateLimit()</code>'s <code>429</code> with{" "}
          <code>retry-after</code>, <code>csrf()</code>'s <code>403</code>{" "}
          — and your own middleware's, tagged with{" "}
          <code>documentsErrors(mw, {"{ quota_exceeded: 402 }"})</code> (an error spec may list the
          {" "}
          <code>headers</code> it carries). A <code>default</code>{" "}
          envelope response covers what only the framework answers (a <code>413</code>{" "}
          over the body cap, a redacted <code>500</code>). Every error response uses the shared{" "}
          <code>ApiError</code>{" "}
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

      <h2>Security</h2>
      <p>
        Declare the schemes once in the plugin options and the interactive renderers show an
        "Authorize" button. Which operations need one comes from the routes themselves:{" "}
        <code>requireBearer()</code> documents itself as{" "}
        <code>bearerAuth</code>, so an endpoint built with{" "}
        <code>createApi().use(requireBearer(…))</code>{" "}
        is marked secured with nothing repeated. Tag your own middleware the same way with{" "}
        <code>documentsSecurity(mw, [{"{ bearerAuth: [] }"}])</code>, or set <code>security</code>
        {" "}
        on one <code>defineApi</code>{" "}
        definition (it wins over both). A middleware's documented error codes (<code>
          csrf()
        </code>'s <code>csrf_failed</code>) join the endpoint's responses the same way.
      </p>
      <Code lang="ts">
        {`openapi({
  securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
  // a document-wide default, or per route:
  security: (route) => (route.routePath.startsWith("/api/public") ? [] : undefined),
});`}
      </Code>
      <Callout kind="note">
        <code>security</code>{" "}
        is documentation. It enforces nothing; the middleware on the route is what refuses a
        request.
      </Callout>

      <h2>Routes from plugins</h2>
      <p>
        A plugin that serves routes of its own registers an <code>OpenApiSource</code>{" "}
        and the document lists them beside the route handlers. <code>@denext/backend</code>
        's auto-REST does: with <code>backend({"{ postgres: {}, rest: {} }"})</code>{" "}
        installed, every relation and function of the default schema the <code>anon</code> and{" "}
        <code>authenticated</code> roles can use is an OpenAPI 3.1 operation under{" "}
        <code>/rest/v1</code>, its rows typed as <code>rest.&lt;table&gt;</code>{" "}
        schemas. A path an app route already describes keeps the app's operation (a{" "}
        <code>path-collision</code>{" "}
        warning); a source that fails (no database reachable) is left out with a{" "}
        <code>source-failed</code> warning.
      </p>
      <Code lang="ts">
        {`openapi({ sources: [mySource] });   // describe more routes
openapi({ sources: false });        // the app's route handlers only
backend({ postgres: {}, rest: { openapi: false } }); // keep auto-REST out`}
      </Code>

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
        {`openapi({ ui: "swagger" });                             // Swagger UI, vendored, from your origin
openapi({ ui: "scalar" });                              // Scalar API Reference, from cdn.jsdelivr.net
openapi({ ui: "scalar", cdn: "/vendor/scalar.js" });   // self-hosted bundle`}
      </Code>
      <p>
        <code>ui: "swagger"</code>{" "}
        serves Swagger UI (swagger-ui-dist 5.32.15, Apache-2.0) from the package itself, under{" "}
        <code>&lt;docs&gt;/swagger-ui/</code>: nothing loads from a CDN, the start-up script is a
        file rather than an inline script, and each vendored file is checked against its recorded
        SHA-256 before it is served (bytes that differ are refused). Every docs page answers with
        its own <code>content-security-policy</code>; the builtin and Swagger pages allow{" "}
        <code>'self'</code> only.
      </p>
      <Callout kind="note">
        Scalar still loads from a CDN by default, and its page's CSP names that host. Self-host its
        bundle and point <code>cdn</code> at it to keep everything on your origin.
      </Callout>

      <h2>CI</h2>
      <Code lang="sh">
        {`denext openapi emit --out openapi.json   # regenerate the committed spec
denext openapi diff openapi.json         # exit 1 when an operation or schema changed
denext openapi lint --strict             # exit 1 when anything is undescribed
denext openapi types --out api-types.ts  # TypeScript types for a consumer outside the app`}
      </Code>

      <h2>Consume the API from another project</h2>
      <p>
        Inside the app <code>createApiClient()</code>{" "}
        is already typed from the route modules. For a separate frontend or a script,{" "}
        <code>denext openapi types</code> emits one <code>.ts</code>{" "}
        with no imports: the openapi-typescript <code>paths</code> / <code>components</code>{" "}
        shape, and denext&apos;s <code>ApiSchema</code> — hand it to the client from{" "}
        <code>jsr:@denext/denext</code>{" "}
        and the other project gets the same typed calls, wire codec and error-code narrowing. Types
        only; the client library is the client.
      </p>
      <Code lang="ts">
        {`// a different repo
import { createApiClient, isApiClientError } from "jsr:@denext/denext";
import type { ApiSchema } from "./api-types.ts"; // denext openapi types --out api-types.ts

const api = createApiClient<ApiSchema>({ base: "https://api.example.com" });
const pet = await api("/api/pets/[id]", "GET", { params: { id: "1" } }); // typed`}
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
          <code>ui</code>, <code>cdn</code>{" "}
          — the renderer and where its bundle comes from (Swagger UI: the vendored copy unless{" "}
          <code>cdn</code> names one).
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
          <code>securitySchemes</code>, <code>security</code>{" "}
          — the schemes the document advertises, and which operations need them (an array for the
          whole document, or a function per route; see <a href="#security">Security</a>).
        </li>
        <li>
          <code>toJsonSchema</code>{" "}
          — a converter for validators the built-in detection cannot describe.
        </li>
        <li>
          <code>sources</code> — more{" "}
          <code>OpenApiSource</code>s beside the ones plugins register, or <code>false</code>{" "}
          to leave those out (see{" "}
          <a href="#routes-from-plugins">
            Routes from plugins
          </a>).
        </li>
        <li>
          <code>expose</code> — <code>"always"</code>{" "}
          (the default) serves both endpoints in every mode; <code>"dev"</code>{" "}
          serves them only under <code>denext dev</code>{" "}
          (and an export then publishes nothing), so production reveals no route map.
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

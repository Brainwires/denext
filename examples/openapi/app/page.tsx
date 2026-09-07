export default function Home() {
  return (
    <main>
      <h1>OpenAPI on denext</h1>
      <p>
        This app's <code>defineApi</code> routes describe themselves. The{" "}
        <a href="/openapi.json">OpenAPI 3.1 document</a> and an interactive{" "}
        <a href="/docs">Swagger UI</a> are generated with no extra annotation, and{" "}
        <code>deno task build</code> writes <code>openapi.json</code> into the output.
      </p>
      <pre>
        {`# the document
curl -s localhost:3000/openapi.json | jq .info

# list pets, then add one
curl -s localhost:3000/api/pets
curl -s localhost:3000/api/pets -X POST \\
  -H 'content-type: application/json' -d '{"name":"Nimbus","species":"bird"}'

# a validation error is a structured 400
curl -s localhost:3000/api/pets -X POST \\
  -H 'content-type: application/json' -d '{"name":""}'`}
      </pre>
      <p>
        Prefer a zero-JavaScript reference page? Set <code>ui: "builtin"</code> in{" "}
        <code>denext.config.ts</code> (that is what <code>examples/typed-api</code> shows).
      </p>
    </main>
  );
}

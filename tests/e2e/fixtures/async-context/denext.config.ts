// `asyncContext` instruments every client `await` and writes the instrumented copies into
// `.denext/asyncctx/`: this app's modules reach each other through every shape a copy must keep
// resolving (a literal `import()`, a stylesheet, JSON, a platform-file variant, an island).
export default { asyncContext: true };

// Reached only by the server page (a Flight route's server tree): never in a client bundle, so
// the AsyncContext pass leaves it alone although it awaits.
export async function serverLabel(): Promise<string> {
  await Promise.resolve();
  return "server-data-ok";
}

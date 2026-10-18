// The API the page reads through `useApi`.
export function GET(): Response {
  return Response.json({ hello: "world from the shell" });
}

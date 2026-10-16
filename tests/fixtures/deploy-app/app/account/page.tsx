// Reads a request API: dynamic.
declare function cookies(): Promise<{ get(name: string): unknown }>;
export default async function Account() {
  const jar = await cookies();
  return <h1>{String(jar.get("session"))}</h1>;
}

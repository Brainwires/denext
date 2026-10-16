// Environment reads the manifest records: an asserted one is required.
export const databaseUrl = Deno.env.get("DATABASE_URL")!;
export const site = Deno.env.get("DENEXT_PUBLIC_SITE_NAME") ?? "Example";

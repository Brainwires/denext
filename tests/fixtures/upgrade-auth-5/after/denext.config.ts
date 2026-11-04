import { denextAuth, github } from "@denext/auth";

export default {
  plugins: [denextAuth({ secret: Deno.env.get("AUTH_SECRET")!, providers: [github({})] })],
};

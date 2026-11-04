import { denextAuth, github } from "denext/server";

export default {
  plugins: [denextAuth({ secret: Deno.env.get("AUTH_SECRET")!, providers: [github({})] })],
};

// The auth plugin is declared here, so the `/auth/*` endpoints mount automatically
// and `auth()` / `requireAuth()` work everywhere. The config itself lives in
// lib/auth-config.ts so the integration test can import it too.

import { denextAuth } from "denext/server";
import { authConfig } from "./lib/auth-config.ts";

export default {
  plugins: [denextAuth(authConfig)],
};

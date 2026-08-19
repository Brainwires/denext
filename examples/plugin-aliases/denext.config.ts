import { aliasesPlugin } from "./plugin.ts";

export default {
  plugins: [
    aliasesPlugin({
      "/home": "/",
      "/about-us": "/about",
    }),
  ],
};

import type { DenextConfig } from "denext/server";
import { gleam } from "denext/gleam";

export default {
  // Compiles gleam/ to JavaScript at dev startup, on every .gleam change and at build; with Lustre
  // in the project it also writes .denext/lustre*.ts, the kits the app's Lustre code imports.
  plugins: [gleam()],
} satisfies DenextConfig;

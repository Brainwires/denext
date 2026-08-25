import { htmx } from "@denext/htmx";

// The htmx plugin serves the vendored runtime from `'self'` and contributes the
// `denext htmx` verb. That's all the wiring an htmx app needs.
export default {
  plugins: [htmx()],
};

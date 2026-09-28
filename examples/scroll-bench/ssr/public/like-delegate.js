// static-cv-script: the delegated like handler as a plain script from public/ (no island, so
// the page carries no Flight payload). One listener for every row's server-rendered button.
import { toggleLike } from "./like-toggle.js";

document.addEventListener("click", toggleLike);
globalThis.__sbHydrated = 1;
globalThis.__sbHydratedAt = performance.now();

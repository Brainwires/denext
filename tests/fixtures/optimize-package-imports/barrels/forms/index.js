// Every re-export form a barrel uses.
export { a, b as c } from "./lib.js";
export { default as D, default as DIcon } from "./d.js";
export * from "./star.js";
export * as ns from "./ns.js";
import * as inner from "./inner.js";
import { x as y } from "./lib.js";
import Def from "./d.js";
export { Def as DefAgain, inner as innerNs, y as fromImport };
export { "odd-name" as oddName } from "./lib.js";
export { gone } from "./missing.js";

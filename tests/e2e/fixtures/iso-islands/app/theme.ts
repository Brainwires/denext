import { createContext } from "denext";

/** Provided by the page, read by each island: context crosses into a split island. */
export const Theme = createContext("light");

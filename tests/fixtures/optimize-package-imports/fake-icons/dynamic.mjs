// Like lucide-react/dynamic: every icon is its own code-splitting entry.
const dynamicIconImports = {
  "icon-1": () => import("./dist/esm/icons/icon-1.js"),
  "icon-2": () => import("./dist/esm/icons/icon-2.js"),
  "icon-3": () => import("./dist/esm/icons/icon-3.js"),
  "icon-4": () => import("./dist/esm/icons/icon-4.js"),
  "icon-5": () => import("./dist/esm/icons/icon-5.js"),
  "icon-6": () => import("./dist/esm/icons/icon-6.js"),
  "icon-7": () => import("./dist/esm/icons/icon-7.js"),
  "icon-8": () => import("./dist/esm/icons/icon-8.js"),
  "icon-9": () => import("./dist/esm/icons/icon-9.js"),
  "icon-10": () => import("./dist/esm/icons/icon-10.js"),
  "icon-11": () => import("./dist/esm/icons/icon-11.js"),
  "icon-12": () => import("./dist/esm/icons/icon-12.js"),
};

export default dynamicIconImports;

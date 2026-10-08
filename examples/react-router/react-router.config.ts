// A stock React Router v7 config. denext honours `appDirectory`, `ssr` (`false` is SPA mode:
// route components render in the browser, their `HydrateFallback` on the server) and
// `prerender` (a listed static route renders once and is cached; `denext export` writes it).
export default {
  appDirectory: "app",
  ssr: true,
  prerender: ["/about"],
};

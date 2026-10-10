// Runs before first paint (inlined ahead of the shell): the saved theme, so the shell paints in it.
try {
  document.documentElement.dataset.theme = localStorage.getItem("theme") ?? "light";
} catch {
  document.documentElement.dataset.theme = "light";
}

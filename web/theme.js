/* Picks the light or dark theme before the page paints, so it never flashes the wrong one.
 * Loaded as a file (not inline) so the Content Security Policy can forbid inline scripts. */
(function () {
  var theme = "auto";
  try { theme = JSON.parse(localStorage.getItem("capacity-atlas-display") || "{}").theme || "auto"; } catch (e) {}
  if (theme !== "light" && theme !== "dark") theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
})();

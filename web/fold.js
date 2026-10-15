/* Phones: start with the panel folded, before the first paint, so the map does not jump
 * when the main script loads. Loaded right after the panel's markup. */
(function () {
  if (!matchMedia("(max-width: 760px)").matches) return;
  document.getElementById("panel").classList.add("is-collapsed");
  ["panel-toggle", "sheet-toggle"].forEach(function (id) {
    var button = document.getElementById(id);
    if (button) button.setAttribute("aria-expanded", "false");
  });
})();

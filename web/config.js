// Where the weekly map data lives. Change dataUrl when the site moves to a custom domain.
window.ATLAS_CONFIG = {
  dataUrl: "https://pub-e6f6a3882d1748dea6eb7f7d9dcfd046.r2.dev",
  repoUrl: "https://github.com/SRINIVASRAVIKANTH/capacity-atlas",
  // OpenFreeMap: free basemaps with no key. One style per site theme.
  basemapStyles: {
    dark: "https://tiles.openfreemap.org/styles/dark",
    light: "https://tiles.openfreemap.org/styles/positron",
  },
  startView: { center: [-75.9, 42.9], zoom: 6.4 },
};

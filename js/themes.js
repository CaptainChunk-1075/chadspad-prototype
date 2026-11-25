// Theme registry. Adding a theme = add CSS tokens under [data-theme="id"] in css/themes.css
// and one entry here. No component code changes. `assets` is where a future theme can declare
// textures/sounds/device-chrome images without the logic knowing about them.
export const THEMES = [
  { id: 'default', name: 'Default', assets: {} },
  { id: 'walts-desk', name: "Walt's Desk (preview)", assets: { /* paperTexture: 'themes/walts/legal-pad.jpg', deviceChrome: 'themes/walts/1985-device.svg' */ } },
];
export function applyTheme(id) {
  const t = THEMES.find(x => x.id === id) || THEMES[0];
  document.documentElement.dataset.theme = t.id;
  document.body.dataset.theme = t.id;
  return t;
}

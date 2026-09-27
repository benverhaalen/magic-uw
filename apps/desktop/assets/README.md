# My Magic UW application icon

`app-icon.svg` is the editable master. Its wizard-head shapes come from `marketing/logo/head-color.svg` (SHA-256 `3cc91d1ec524b457d044f9e21581a168f6fde16b6b2d60b1cef7c77a0d62781a`). Every artwork element keeps the source geometry and explicit fill/stroke values. The source's CSS-variable fill declaration was omitted because macOS `sips` rendered that declaration as black; its explicit cardinal fallback is unchanged. The source's provenance metadata is retained in the marketing original, not duplicated in this composed icon.

The tile uses the current desktop shell gradient stops from `docs/design/tokens.css` and a cream field to keep the red hat legible at Dock size. The icon contains the head only. It does not change the default profile avatar.

`app-icon.png` is the 512 × 512 runtime/window icon, `app-icon.icns` contains macOS 16–1024 px representations, and `app-icon.ico` contains Windows 16, 24, 32, 48, 64, 128 and 256 px representations. The build copies all three beside `main.cjs`. Electron sets the macOS Dock icon at readiness and gives the window the PNG on other platforms. No packaged installer configuration exists yet; these files are ready for one.

To regenerate on macOS, convert `app-icon.svg` to a 1024 px PNG with `sips`, downsize to the ten standard `.iconset` names, then run `iconutil -c icns`. Export ICO from the same 1024 px image at the listed sizes. Keep the SVG artwork comparison against the marketing original when editing the composition. The existing generated binaries are the delivery assets; regeneration is only needed after a deliberate icon change.

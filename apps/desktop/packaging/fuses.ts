// owner: T05e (with T63). What a packaged build of My Magic UW must set (plan D39, spec A1).
//
// The repository has no packager yet (no electron-builder or Electron Forge config, and
// @electron/fuses isn't installed), so these settings take effect at the first packaged build.
// `pnpm dev` runs the stock Electron binary, whose fuses are never flipped.
//
// Apply the fuses with @electron/fuses `flipFuses(electronBinary, { version: FuseVersion.V1,
// [FuseV1Options.EnableCookieEncryption]: true })` after packaging and before code signing
// (electron-builder's `afterPack` hook, or Forge's FusesPlugin). On Apple silicon, pass
// `resetAdHocDarwinSignature: true` when the build isn't signed straight afterwards.
// Source: electron/electron docs/tutorial/fuses.md and electron/fuses README, read 2026-09-27.

/** Keyed by @electron/fuses FuseV1Options names. */
export const packagedFuses = Object.freeze({
  /**
   * Encrypts the cookie store on disk with the OS key (DPAPI, or the macOS Keychain, as
   * safeStorage does). Without it the UW, Canvas and Duo cookies sit readable in
   * Partitions/uw/Network/Cookies (measured; plan D39).
   * One-way: turning it off later corrupts the cookie store. On macOS it needs a code-signed app.
   */
  EnableCookieEncryption: true,
});

/**
 * Deliberately left at Electron's default (on): the MCP export starts mcp-server.cjs with
 * ELECTRON_RUN_AS_NODE=1 (main.ts, magic:mcp-export). Turning RunAsNode off breaks it.
 */
export const fusesLeftAtDefault = Object.freeze(["RunAsNode"] as const);

/**
 * Uninstall removes the app's data folder, which holds the saved sign-in (remembered-signin.enc)
 * with every other local secret (electron-builder NSIS: `deleteAppDataOnUninstall: true`).
 * macOS has no uninstaller: Forget my sign-in, Sign out or Delete local data removes it there.
 */
export const uninstall = Object.freeze({ deleteAppData: true });
// end owner: T05e

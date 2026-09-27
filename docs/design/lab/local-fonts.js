/* Karma Medium (500) loads by default from the repository's bundled asset
   (packages/ui/assets/fonts, SIL OFL 1.1). For Geist in this lab, supply
   ?fontBase=/work/fonts/ on a localhost origin, or window.MAGIC_LOCAL_FONT_BASE
   before this script, for a directory containing Geist-Variable.woff2.
   magicFontsReady resolves to { karma, geist, exact }; exact needs both. */
window.magicFontsReady = (async () => {
  const script = document.currentScript?.src || location.href;
  async function load(face) {
    try {
      await face.load();
      document.fonts.add(face);
      return true;
    } catch {
      return false;
    }
  }
  const karma = load(
    new FontFace(
      "Karma",
      `url(${new URL("../../../packages/ui/assets/fonts/Karma-Medium.ttf", script).href})`,
      { weight: "500", style: "normal" },
    ),
  );
  async function geistFace() {
    const base =
      window.MAGIC_LOCAL_FONT_BASE ||
      new URLSearchParams(location.search).get("fontBase");
    if (!base) return false;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(location.hostname))
      return false;
    try {
      const root = new URL(base, location.href);
      if (root.origin !== location.origin) return false;
      return load(
        new FontFace(
          "Geist",
          `url(${new URL("Geist-Variable.woff2", root).href})`,
          { weight: "100 900" },
        ),
      );
    } catch {
      return false;
    }
  }
  const [karmaLoaded, geist] = await Promise.all([karma, geistFace()]);
  return { karma: karmaLoaded, geist, exact: karmaLoaded && geist };
})();
window.magicFontLabel = (state) =>
  state.exact
    ? "Karma Medium + local Geist loaded"
    : state.karma
      ? "Karma Medium loaded · Geist fallback, not a visual match"
      : "fallback fonts · not a visual match";

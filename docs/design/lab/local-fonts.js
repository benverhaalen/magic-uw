/* No font binaries are distributed. Explicitly supply ?fontBase=/work/fonts/
   on a localhost origin, or window.MAGIC_LOCAL_FONT_BASE before this script.
   Production must provide a separately permitted font loader. */
window.magicFontsReady = (async () => {
  const base =
    window.MAGIC_LOCAL_FONT_BASE ||
    new URLSearchParams(location.search).get("fontBase");
  if (!base) return false;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(location.hostname))
    return false;
  try {
    const root = new URL(base, location.href);
    if (root.origin !== location.origin)
      throw Error("Font base must be same-origin");
    const faces = [
      new FontFace(
        "Cooper Light",
        `url(${new URL("cooperl.ttf", root).href})`,
        { weight: "400" },
      ),
      new FontFace(
        "Geist",
        `url(${new URL("Geist-Variable.woff2", root).href})`,
        { weight: "100 900" },
      ),
    ];
    await Promise.all(faces.map((f) => f.load()));
    faces.forEach((f) => document.fonts.add(f));
    return true;
  } catch {
    return false;
  }
})();

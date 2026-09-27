// Builds everything the film needs that isn't HTML: slot placeholders, SFX, the TEMP guide
// voice, the TEMP music bed (ducked under the narration), and the burned-in captions.
//
//   node tools/audio.mjs            placeholders + sfx + bed + captions (keeps narration.wav)
//   node tools/audio.mjs --temp-vo  also renders the TEMP guide narration with local Kokoro
//                                   (HYPERFRAMES_PYTHON must point at a python with kokoro-onnx)
//
// Slots (drop the real file in with the same name, then re-run this script):
//   assets/skit.mp4        0:00-0:20 live skit (placeholder card until filmed)
//   assets/presenters.mp4  1:30-2:00 presenters on camera (placeholder card until filmed)
//   assets/narration.wav   0:00-1:30 Ben's voiceover, timed to script.json (TEMP guide until recorded)
//   assets/music-bed.src.wav  the music bed before ducking (TEMP synthesized pad until chosen)
// Local only: no network, no paid API.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const root = resolve(import.meta.dirname, "..");
const A = (...p) => join(root, "assets", ...p);
const script = JSON.parse(readFileSync(join(root, "script.json"), "utf8"));
const FILM = 120;
const ff = (args) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args], { stdio: "inherit" });
const probe = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }).trim());
for (const d of [A(), A("sfx"), A("vo"), A("ui")]) mkdirSync(d, { recursive: true });

// ---------- placeholders for filmed slots ----------
const fonts = ["C:/Windows/Fonts/segoeui.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"];
const font = fonts.find((f) => existsSync(f));
const esc = (s) => s.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\u2019");
function placeholder(file, seconds, title, detail) {
  if (existsSync(A(file))) return console.log(`slot ${file}: present, kept`);
  const text = font
    ? `,drawtext=fontfile='${esc(font)}':text='${esc(title)}':fontcolor=0xfff4ed:fontsize=64:x=(w-tw)/2:y=h/2-70,drawtext=fontfile='${esc(font)}':text='${esc(detail)}':fontcolor=0xffe9dd:fontsize=34:x=(w-tw)/2:y=h/2+20,drawtext=fontfile='${esc(font)}':text='PLACEHOLDER %{eif\\:t\\:d}s':fontcolor=0xffe9dd:fontsize=28:x=(w-tw)/2:y=h-120`
    : "";
  ff(["-f", "lavfi", "-i", `color=c=0x3a0a0d:s=1920x1080:r=30:d=${seconds}${text}`, "-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo`, "-t", String(seconds), "-c:v", "libx264", "-g", "30", "-keyint_min", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", A(file)]);
  writeFileSync(A(`${file}.PLACEHOLDER`), "Generated placeholder. Replace the .mp4 with the filmed take and delete this marker.\n");
  console.log(`slot ${file}: placeholder written`);
}
placeholder("skit.mp4", 20, "SKIT: filmed by the team", "assets/skit.mp4  ·  0:00-0:20  ·  see SCRIPT.md, Skit (draft)");
placeholder("presenters.mp4", 30, "PRESENTERS: Nathaniel and Sean on camera", "assets/presenters.mp4  ·  1:30-2:00  ·  keep the right 45 percent of frame clear");

// ---------- SFX: the media-use bundled library (Pixabay Content License) ----------
const sfxDirs = [".claude", ".agents", ".codex"].map((d) => join(homedir(), d, "skills", "media-use", "audio", "assets", "sfx"));
const sfxDir = sfxDirs.find((d) => existsSync(d));
const SFX = ["sparkle", "whoosh", "whoosh-cinematic", "whoosh-short", "pop", "notification", "click-soft", "key-press", "chime", "riser", "impact-bass-1", "glitch-1", "ping"];
for (const s of SFX) {
  if (existsSync(A("sfx", `${s}.mp3`))) continue;
  if (!sfxDir) throw new Error("media-use skill not installed: run `npx hyperframes skills update media-use`");
  copyFileSync(join(sfxDir, `${s}.mp3`), A("sfx", `${s}.mp3`));
}
console.log(`sfx: ${SFX.length} files from ${sfxDir ?? "assets/sfx"}`);

// ---------- TEMP guide narration (local Kokoro) ----------
const durFile = A("vo", "durations.json");
const durations = existsSync(durFile) ? JSON.parse(readFileSync(durFile, "utf8")) : {};
if (process.argv.includes("--temp-vo")) {
  for (const line of script.lines.filter((l) => l.tts)) {
    const out = A("vo", `${line.id}.wav`);
    const room = line.slot[1] - line.slot[0];
    let speed = 1.0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const txt = A("vo", `${line.id}.txt`);
      writeFileSync(txt, line.tts);
      execFileSync("npx", ["--yes", "hyperframes@0.8.79", "tts", `"${txt}"`, "-v", script.voices[line.speaker], "-s", speed.toFixed(2), "-o", `"${out}"`], { stdio: "ignore", shell: true, env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1", DO_NOT_TRACK: "1" } });
      const d = probe(out);
      durations[line.id] = { seconds: d, speed, room };
      if (d <= room || speed >= 1.3) break;
      speed = Math.min(1.3, speed * (d / room) * 1.03);
    }
    const r = durations[line.id];
    console.log(`vo ${line.id}: ${r.seconds.toFixed(2)} s at ${r.speed.toFixed(2)}x (room ${room.toFixed(1)} s)${r.seconds > room ? "  OVER" : ""}`);
  }
  writeFileSync(durFile, JSON.stringify(durations, null, 2));
  // Mix Ben's lines into the narration slot, and the on-camera lines into a separate guide
  // track (the skit and presenter footage will carry those voices once filmed).
  const mix = (ids, file) => {
    const inputs = [], filters = [];
    ids.forEach((l, i) => {
      inputs.push("-i", A("vo", `${l.id}.wav`));
      const ms = Math.round(l.slot[0] * 1000);
      filters.push(`[${i}]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[d${i}]`);
    });
    const labels = ids.map((_, i) => `[d${i}]`).join("");
    ff([...inputs, "-filter_complex", `${filters.join(";")};${labels}amix=inputs=${ids.length}:normalize=0,apad=whole_dur=${FILM}[out]`, "-map", "[out]", "-t", String(FILM), "-ar", "48000", A(file)]);
  };
  const voiced = script.lines.filter((l) => l.tts);
  mix(voiced.filter((l) => l.speaker === "Ben"), "narration.wav");
  writeFileSync(A("narration.wav.TEMP"), "TEMP guide narration (Kokoro-82M, local). Replace narration.wav with Ben's recording and delete this marker.\n");
  mix(voiced.filter((l) => l.speaker !== "Ben"), "dialogue-guide.wav");
  console.log("narration.wav: TEMP guide written; dialogue-guide.wav: TEMP on-camera lines");
}
if (!existsSync(A("narration.wav"))) ff(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", String(FILM), A("narration.wav")]);
if (!existsSync(A("dialogue-guide.wav"))) ff(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", String(FILM), A("dialogue-guide.wav")]);

// ---------- TEMP music bed: 120 BPM pad, synthesized here (no licence involved) ----------
if (!existsSync(A("music-bed.src.wav"))) {
  // Am - F - C - G, one chord per bar (2 s at 120 BPM); pad + eighth-note pluck + soft beat pulse.
  const k = "mod(floor(t/2),4)";
  const pick = (a, b, c, d) => `if(eq(${k},0),${a},if(eq(${k},1),${b},if(eq(${k},2),${c},${d})))`;
  const r1 = pick(220, 174.61, 130.81, 196), r2 = pick(261.63, 220, 164.81, 246.94), r3 = pick(329.63, 261.63, 196, 293.66);
  const arpNote = `if(lt(mod(t,1),0.25),${r1}*2,if(lt(mod(t,1),0.5),${r2}*2,if(lt(mod(t,1),0.75),${r3}*2,${r2}*2)))`;
  const pad = `0.06*(sin(2*PI*${r1}*t)+sin(2*PI*${r2}*t)+sin(2*PI*${r3}*t))*(0.8+0.2*sin(2*PI*0.25*t))`;
  const pluck = `0.05*sin(2*PI*${arpNote}*t)*exp(-9*mod(t,0.25))`;
  const pulse = `0.10*sin(2*PI*55*t)*exp(-14*mod(t,0.5))`;
  const fade = `min(1,t/2)*min(1,(${FILM}-t)/3)`;
  ff(["-f", "lavfi", "-i", `aevalsrc='(${pad}+${pluck}+${pulse})*${fade}|(${pad}+${pluck}+${pulse})*${fade}':s=48000:d=${FILM}`, "-af", "lowpass=f=3200,aecho=0.8:0.6:120|240:0.25|0.15", A("music-bed.src.wav")]);
  writeFileSync(A("music-bed.src.wav.TEMP"), "TEMP bed synthesized by tools/audio.mjs. Replace music-bed.src.wav with a chosen track and re-run.\n");
  console.log("music-bed.src.wav: TEMP pad synthesized");
}
// Duck the bed under the voice (narration + on-camera dialogue guide) with a sidechain compressor.
ff(["-i", A("music-bed.src.wav"), "-i", A("narration.wav"), "-i", A("dialogue-guide.wav"), "-filter_complex", "[1][2]amix=inputs=2:normalize=0[voice];[0][voice]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400[out]", "-map", "[out]", "-t", String(FILM), A("music-bed.wav")]);
console.log("music-bed.wav: ducked under the voice");

// ---------- captions: always on, burned in from script.json ----------
const chunks = [];
for (const line of script.lines) {
  const said = durations[line.id]?.seconds;
  const length = Math.min(line.slot[1] - line.slot[0], said ? said + 0.35 : line.slot[1] - line.slot[0]);
  const words = line.text.split(/\s+/);
  const groups = [];
  for (let i = 0; i < words.length; ) {
    let n = Math.min(9, words.length - i);
    // prefer to break after punctuation
    for (let j = Math.min(9, words.length - i); j >= 5; j--) if (/[.,:;?!…]$/.test(words[i + j - 1])) { n = j; break; }
    groups.push(words.slice(i, i + n));
    i += n;
  }
  const total = words.length;
  let t = line.slot[0];
  for (const g of groups) {
    const d = (length * g.length) / total;
    chunks.push({ start: +t.toFixed(2), duration: +Math.max(0.8, d).toFixed(2), text: g.join(" "), speaker: line.speaker, part: line.part, kind: line.kind });
    t += d;
  }
}
const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const items = chunks
  .map((c, i) => `      <p id="cap-${i}" class="clip cap is-${c.part}" data-start="${c.start}" data-duration="${c.duration}" data-track-index="40">${c.speaker && c.kind === "dialogue" ? `<b>${escHtml(c.speaker)}</b> ` : ""}${escHtml(c.text)}</p>`)
  .join("\n");
writeFileSync(
  join(root, "compositions", "captions.html"),
  `<!doctype html>
<!-- Generated by tools/audio.mjs from script.json. Do not edit by hand; edit script.json and re-run. -->
<html><head><meta charset="UTF-8" /></head><body>
  <template>
    <style>
      @font-face { font-family: Geist; src: url("assets/fonts/Geist-Variable.woff2") format("woff2"); font-weight: 100 900; }
      #captions { position: absolute; inset: 0; pointer-events: none; }
      #captions .cap { position: absolute; left: 50%; bottom: 54px; width: 1400px; margin: 0 0 0 -700px; text-align: center; font-family: Geist, system-ui, sans-serif; font-weight: 500; font-size: 38px; line-height: 1.3; color: #fff4ed; text-shadow: 0 2px 10px rgba(26, 13, 11, 0.9), 0 0 2px rgba(26, 13, 11, 0.9); }
      #captions .cap b { font-weight: 700; color: #f7c440; }
      #captions .cap.is-presenters { left: 60px; width: 960px; margin: 0; text-align: left; }
    </style>
    <div id="captions" data-composition-id="captions" data-width="1920" data-height="1080">
${items}
    </div>
    <script>
      window.__timelines["captions"] = gsap.timeline({ paused: true });
    </script>
  </template>
</body></html>
`,
);
console.log(`captions: ${chunks.length} caption chunks written to compositions/captions.html`);

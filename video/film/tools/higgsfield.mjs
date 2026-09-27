// Higgsfield API: generate the film's HF shots (PRODUCTION-SCRIPT.md, HIGGSFIELD-SHOTS.md).
// Seedance 2.5 image-to-video from the wizard reference; output lands in assets/hf/<slot>.mp4.
// Needs HF_API_KEY_ID and HF_API_KEY_SECRET in the environment; the key is never printed.
// Usage: node tools/higgsfield.mjs <slot> [--takes N]   (slots: see SHOTS below)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const API = "https://api.higgsfield.ai";
const id = process.env.HF_API_KEY_ID, secret = process.env.HF_API_KEY_SECRET;
if (!id || !secret) { console.error("Set HF_API_KEY_ID and HF_API_KEY_SECRET first."); process.exit(2); }
const auth = { Authorization: `Key ${id}:${secret}` };

const STYLE = "stylized 2D-animated mascot look, flat shading, cardinal red hat and robe, warm white and deep ink palette, soft rim light, clean studio background, smooth professional motion, no text, no letters, no logos";
const REF = join(root, "..", "..", "marketing", "uploads", "Wizard_logo.jpg");
const SHOTS = {
  "whiz-sting": { duration: 4, ref: REF, prompt: `the wizard mascot pops into frame in a burst of golden sparkles, squash-and-stretch bounce, then a friendly wave to camera; ${STYLE}` },
  spell: { duration: 5, ref: REF, prompt: `the wizard mascot raises his staff and casts a spell: ribbons of glowing blank cards, file tiles and calendar tiles stream from a floating glowing orb into an open laptop, strong suction, an elastic snap-back when the stream ends, then a bright white-gold sparkle flash filling the frame; ${STYLE}` },
  guard: { duration: 6, ref: REF, prompt: `the wizard mascot stands guard at a glowing arched gate holding a round shield; dark smoky tendrils rush at the gate and bounce off the shield in bright sparks; calm confident pose; composition on the right half of frame, left half dark and empty; ${STYLE}` },
  "agents-spell": { duration: 5, ref: REF, prompt: `the wizard mascot casts a spell over three floating glowing orbs (cyan, cardinal, white); each orb ignites and streaks away leaving bright speed lines, a feeling of acceleration; composition on the right half of frame, left half dark and empty; ${STYLE}` },
  campus: { duration: 5, ref: null, prompt: "cinematic sunrise over a college hill with a domed building at the top, students walking to morning class, slow dolly push-in, warm golden light, shallow depth of field, no signage, no logos, no text" },
};

async function upload(path) {
  const r = await fetch(`${API}/files/generate-upload-url`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ content_type: "image/jpeg" }) });
  if (!r.ok) throw new Error(`upload url: ${r.status} ${await r.text()}`);
  const u = await r.json();
  const put = await fetch(u.upload_url, { method: "PUT", headers: u.upload_headers, body: readFileSync(path) });
  if (!put.ok) throw new Error(`upload: ${put.status}`);
  return u.public_url;
}

async function generate(slot, take) {
  const s = SHOTS[slot];
  const body = { prompt: s.prompt, duration: s.duration, aspect_ratio: "16:9", resolution: "1080p" };
  const endpoint = s.ref ? "bytedance/seedance-2.5/image-to-video" : "bytedance/seedance-2.5/text-to-video";
  if (s.ref) body.image_url = await upload(s.ref);
  const r = await fetch(`${API}/${endpoint}`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${slot}: ${r.status} ${await r.text()}`);
  const { request_id, status_url } = await r.json();
  console.log(`${slot} take ${take}: queued ${request_id}`);
  for (let wait = 5000; ; wait = Math.min(wait * 1.5, 20000)) {
    await new Promise((res) => setTimeout(res, wait));
    const st = await (await fetch(status_url, { headers: auth })).json();
    if (st.status === "completed") {
      const url = st.video?.url;
      const out = join(root, "assets", "hf", take === 1 ? `${slot}.mp4` : `${slot}.take${take}.mp4`);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, Buffer.from(await (await fetch(url)).arrayBuffer()));
      console.log(`${slot} take ${take}: saved ${out}`);
      return out;
    }
    if (["failed", "nsfw", "canceled", "cancelled"].includes(st.status)) throw new Error(`${slot}: ${st.status} ${JSON.stringify(st.error ?? "")}`);
  }
}

const [slot, ...rest] = process.argv.slice(2);
if (!SHOTS[slot]) { console.error(`slot: ${Object.keys(SHOTS).join(" | ")}`); process.exit(2); }
const takes = Number(rest[rest.indexOf("--takes") + 1]) || 1;
if (!existsSync(REF)) { console.error(`missing reference ${REF}`); process.exit(2); }
for (let t = 1; t <= takes; t++) await generate(slot, t);

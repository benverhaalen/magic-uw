# Higgsfield shot list: My Magic UW film

Generative shots only. The product UI always comes from the real headless capture; no model ever draws the app's screens or readable text.

## Setup (once)
- **Character:** Whiz, trained from `marketing/uploads/Wizard_logo.jpg` plus the wizard SVG poses in `marketing/logo-design-elements/svg/`, using Soul ID / `create_character`. Keep him a stylized mascot (flat-shaded, with the site's cardinal hat and robe), never photoreal.
- **Look (every shot):** the brand palette from `apps/web/assets/site.css`: cardinal, warm white and a deep ink background, soft rim light, a clean studio set. 16:9 at 1080p. No text, no logos, no UW marks.
- **Models:** Kling 3.0 (or O3 first/last frame) for character motion and matched boundaries; Seedance 2.5 for the particle and energy work. 2–3 takes per shot, keeping the best.
- **Audio:** none from the model; sound design is mixed in HyperFrames.

## Shots
| Slot | Length | Picture | Prompt core | Boundaries |
|---|---|---|---|---|
| `hf/whiz-sting.mp4` | 2 s | Whiz pops in with a sparkle burst, a small bounce, and a wave | "stylized wizard mascot in a cardinal hat and robe pops into frame with a burst of golden sparkles, squash-and-stretch bounce, friendly wave, clean dark studio background, 2D animated look" | last frame: Whiz centred, for a cut to the UI |
| `hf/spell.mp4` | 5 s | Whiz raises his staff; streams of blank glowing document cards, file icons and calendar tiles are pulled from a floating source orb into an open laptop; the stream ends with a springy snap-back and a sparkle flash | "wizard mascot casts a spell, ribbons of glowing blank cards and file tiles stream from a floating orb into an open laptop, energetic suction, elastic snap-back when the stream ends, bright sparkle flash, no text on anything" | ends on a white-gold flash (a hard cut to the real Home capture) |
| `hf/guard.mp4` | 5 s | Whiz stands at a glowing arched gate with a round shield; dark smoky tendrils rush in and bounce off the shield in sparks | "wizard mascot guards a glowing arched gate with a round shield, dark smoky tendrils rush at it and bounce off in sparks, calm confident pose, no text" | first frame: Whiz at the gate, still |
| `hf/agents-spell.mp4` | 5 s | Whiz casts over three small glowing agent orbs (cyan, cardinal, white); each ignites and streaks off with speed lines | "wizard mascot casts a spell over three floating glowing orbs, each ignites and streaks away leaving bright speed lines, sense of acceleration, no text, no logos" | leaves the right 45% of the frame compositable over the presenter shot (alpha or matte) |
| `hf/hook.mp4` (optional) | 4 s | Establishing morning shot: a campus hill at sunrise, students walking to class; a slow push-in | "cinematic sunrise over a college hill with a domed building, students walking to morning class, slow dolly push-in, warm light, shallow depth of field, no signage or logos" | ends on a warm frame that cuts to the live skit |

**Total:** about 21 s kept. With retakes, about 60 s generated.

## Honesty rules
- These shots are illustrative brand animation; the voiceover never presents them as the product.
- Every product claim is shown in the real UI capture or as a labelled number.

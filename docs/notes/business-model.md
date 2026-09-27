# Business model: open source and free with your own keys, $5 lifetime for our hosted Jev, then a campus licence

**Status: Decision (operator), updated 2026-09-26.** It differs from decisions recorded in [decisions](../decisions.md) (free, local-first default, no paid-plan prerequisite); see [where we differ](where-we-differ.md). Checked 2026-09-26.

## In one paragraph
Magic Canvas runs **locally** for privacy: course data, study history and notes stay on the student's computer. **The code is open source (MIT), and free for anyone who brings their own keys:** their AI (Claude Code, Codex, Gemini CLI or an OpenRouter key), plus their own Jev access (an OpenRouter key covers Jev through `typesafe/jev-router`) or a local model. **Students who don't want to manage keys pay $5 for life** (early adopters) for our hosted Jev service. The team's decisions log (`docs/decisions.md`, "Pricing and AI access resolution") records the accepted direction as a $5 license plus the student's own paid AI, with OpenRouter users paying Jev through their own key. Whether OpenRouter-key users also pay the $5 is the one open point. Revenue never depends on collecting or selling student data. The AI comes from the student's own paid account. The app **detects it on the computer when it's installed and signed in** (Claude Code, Codex, Gemini CLI with a paid key, or an OpenRouter key through Claude Code). When nothing is found, the app **shows step-by-step onboarding instead.** The licence pays for our hosted Jev judgments and the service. It never pays for model usage.

## Phase 1: open-source launch, early-adopter lifetime deal
- **Free with your own keys.** **$5 for life** covers our hosted Jev gateway and the service for those who'd rather not bring a Jev key. Model usage always runs on the student's own AI.
- **One-button AI setup:**
  1. The app finds the installed AI tools (Claude Code, Codex, Gemini CLI).
  2. It checks their sign-in and the models the student's plan serves.
  3. It configures our prompt packs and skills in a folder the app owns. The student's own client settings are never edited.
- **Each app action is a prompt pack with a model tier,** so tokens are spent only where an action needs them, and the in-app ledger shows each action's use. See the [course backend spec](../plans/2026-09-26-course-backend/spec.md).
- **The optional course bank:** an MCP server the student can register in their own clients to read their courses outside the app. It's separate from how the app works.
- **Protecting a lifetime price against a recurring Jev cost:**
  - a capped number of early-adopter slots
  - a fair-use clause in the Terms
  - the existing global abuse cap on the gateway

  The per-student cost comes from the ledger before any later price is set.

## Phase 2: a UW–Madison partnership, after launch
- **Now (launch and hackathon):**
  - The student signs in to UW themselves; the app reads only what that session can already see.
  - Read-only: no submitting, enrolling or posting.
  - Everything is local.
- **After launch, and only then:** pursue a direct partnership with UW–Madison (DoIT) for a sanctioned, more established connection:
  - NetID/SSO integration
  - approved Canvas and Microsoft 365 access (a registered application instead of the student's browser session)
  - a campus privacy and security review
- **What a partnership would change:**
  - more reliable data access and fewer reconnects
  - campus vetting, which UW's KB recommends to students (kb.wisc.edu 139025)
  - **An institutional licence at $1–2 per student** (the billing period is to be set):
  - UW–Madison enrolled 51,822 students in Fall 2025 (wisc.edu facts page), so that's about $52k–$104k per period. **UW News reports 51,865 for the same term (two official figures differ by 43; corrected 2026-09-26, news.wisc.edu, 2025-09-25).**
  - At that scale we pay Jev for every student, so the fee must cover Jev plus operations. The ledger's per-student cost sets the final price.
- **What UW would authorise:** a university-issued Canvas developer key (OAuth2), which gives each student a long-lived, revocable connection instead of browser-session sign-ins. These are the "persistent NetID keys".
- **The value we'd propose:**
  - measured results against the tools students and instructors use today
  - an open, AI-first platform on which UW and students can build further academic tools
  - academic integrity built in: read-only access, course AI policies enforced in code, and a citation on every answer
- **No partnership exists today. Don't present one as existing.**

## The model
- **Early adopters: a one-time $5, for life.** It covers the hosted Jev judgments and a service fee. Pricing after the early-adopter slots is to be set from the ledger. There's no subscription and no user account; a licence key is not an account.
- **The student brings a paid AI provider:** Claude Code (Claude Pro or higher), Codex (a paid ChatGPT plan), Gemini CLI with a paid API key, or an OpenRouter API key. See [agent runtime](agent-runtime.md).
- **The price never includes model usage.** Anthropic's terms forbid paying for, reselling or intermediating Claude usage on end users' behalf (code.claude.com legal-and-compliance). The student's own plan or key pays for the model.
- **Jev:**
  - For Claude, Codex and Gemini users, the team's gateway pays for Jev. The key stays server-side, and each licence enrolls a device credential.
  - **For OpenRouter users, their own key pays for Jev** through OpenRouter's Jev route.
  - The operator's expectation is a small worst-case Jev cost per student, so **no per-student Jev budget is planned.** The existing gateway principle still applies: a global cap protects the owner's bill from abuse.
- **Payments:** the provider is **not chosen yet.**

## Payment options researched (fees from the providers' pricing pages, 2026-09-26)
| Provider | Fee | Merchant of record (handles sales tax) | Net from $5 |
|---|---|---|---|
| Lemon Squeezy | 5% + 50¢ | yes | $4.25 |
| Polar | 5% + 50¢ on the free tier | yes | $4.25 |
| Paddle | 5% + 50¢; "products under $10 require contacting Paddle" | yes | $4.25 if the standard rate applies |
| Gumroad | 10% + 50¢ direct | yes | $4.00 |
| Stripe | 2.9% + 30¢ domestic; Stripe Tax extra | no (processor only) | about $4.53 before tax handling |

**Licence keys:** Lemon Squeezy documents activate, validate and deactivate endpoints. Keygen offers offline licensing (per its pricing page). The flow: purchase, then a licence key, then activation on first run, which enrolls the device with the gateway.

## Distribution
- **Direct, signed downloads.**
- **macOS:** the Apple Developer Program costs $99 a year and notarizes apps distributed outside the Mac App Store. A sandboxed Mac App Store build likely can't launch user-installed CLIs (inferred from Apple forum guidance; not quoted from Apple), so the stores aren't planned.
- **Windows:** code signing (Azure Artifact Signing or an OV certificate) builds SmartScreen reputation over time. Microsoft says EV certificates are no longer recommended for SmartScreen.

## What changes for the team
- **Licensing is decided: open source.** The repository stays MIT, and the paid part is the hosted service.
- **Legal documents are written at the end of the build:** a Terms of Service, a Privacy Policy and an in-app notice. The notice shows what data goes where for the student's chosen AI client and for Jev, and asks consent once per destination. They come from focused legal research and expert application, and are based on [AI and privacy](../ai-and-privacy.md).
- **Anthropic's Commercial Terms** must be accepted before the product runs Claude Code.
- **Onboarding** states plainly what each route needs, and that the $5 doesn't include AI usage.

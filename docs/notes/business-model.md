# Business model: one-time purchase, bring your own paid AI

**Status: Decision (operator).** It differs from decisions recorded in [decisions](../decisions.md) (free, local-first default, no paid-plan prerequisite); see [where we differ](where-we-differ.md). Checked 2026-09-26.

## In one paragraph
Magic Canvas runs **locally** for privacy: course data, study history and notes stay on the student's computer. **We still earn:** students pay to use the app (currently a one-time $5 licence), so revenue never depends on collecting or selling student data. The AI comes from the student's own paid account. The app **detects it on the computer when it's installed and signed in** (Claude Code, Codex, Gemini CLI with a paid key, or an OpenRouter key through Claude Code). When nothing is found, the app **shows step-by-step onboarding instead.** The licence pays for our hosted Jev judgments and the service. It never pays for model usage.

## Roadmap: a UW–Madison partnership, after launch
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
  - possibly an institutional licence in place of the per-student purchase
- **No partnership exists today. Don't present one as existing.**

## The model
- **A one-time $5 purchase.** It covers the hosted Jev judgments and a service fee. There's no subscription and no user account; a licence key is not an account.
- **The student brings a paid AI provider:** Claude Code (Claude Pro or higher), Codex (a paid ChatGPT plan), Gemini CLI with a paid API key, or an OpenRouter API key. See [agent runtime](agent-runtime.md).
- **The price never includes model usage.** Anthropic's terms forbid paying for, reselling or intermediating Claude usage on end users' behalf (code.claude.com legal-and-compliance). The student's own plan or key pays for the model.
- **Jev:**
  - For Claude, Codex and Gemini users, the team's gateway pays for Jev. The key stays server-side, and each licence enrolls a device credential.
  - **For OpenRouter users, their own key pays for Jev** through OpenRouter's Jev route.
  - The operator's expectation is a small worst-case Jev cost per student, so **no per-student Jev budget is planned.** Ben's gateway principle still applies: a global cap protects the owner's bill from abuse.
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
- **A deliberate licensing decision.** The repository is MIT; [decisions](../decisions.md) notes that closed distribution needs a deliberate licensing decision.
- **Anthropic's Commercial Terms** must be accepted before the product runs Claude Code.
- **Onboarding** states plainly what each route needs, and that the $5 doesn't include AI usage.

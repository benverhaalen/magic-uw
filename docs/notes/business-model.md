# Business model: one-time purchase, bring your own paid AI

**Status: Decision (operator).** It differs from decisions recorded in [decisions](../decisions.md) (free, local-first default, no paid-plan prerequisite); see [where we differ](where-we-differ.md). Checked 2026-09-26.

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

# Outlook, OneNote and OneDrive: setup and the E1 test

Magic Canvas reads a student's UW Outlook mail and calendar, OneNote pages and linked OneDrive files through **its own Microsoft sign-in**. It never reuses Outlook on the web's session, cookies or tokens, and it never uses a Microsoft first-party client ID. It uses one app registration of ours, a public client with no secret.

Status: built and tested in isolation against fakes (`tests/graph.test.ts`, `tests/outlook-oauth.test.ts`). It has not yet run against Microsoft or UW. E1 below is that test.

## 1. Register the app (once, by the operator)

Portal steps were checked against learn.microsoft.com on 2026-09-26. The portal's labels change over time; the cited pages are the reference.

1. **Microsoft Entra admin center → Entra ID → App registrations → New registration.** ([Register an application](https://learn.microsoft.com/entra/identity-platform/quickstart-register-app))
   - **Name:** "Magic Canvas". Students see this name on Microsoft's consent screen.
   - **Supported account types:** choose the multitenant option for organizational directories. Current label: "Multiple Entra ID tenants"; older label: "Accounts in any organizational directory". Do not include personal Microsoft accounts. UW students sign in with their UW work-or-school account.
   - Leave the redirect URI empty here and select **Register**.
   - On the **Overview** page, copy the **Application (client) ID**.
2. **Authentication → Add a platform → Mobile and desktop applications.** Add the custom redirect URI `http://localhost`. ([Desktop app registration](https://learn.microsoft.com/entra/identity-platform/scenario-desktop-app-registration))
   - Microsoft ignores the port for localhost redirect URIs, and a native app may use any port. ([Redirect URI restrictions, "Localhost exceptions"](https://learn.microsoft.com/entra/identity-platform/reply-url)) Register only one `http://localhost`, with no port variants.
   - **Our choice:** the app intercepts the redirect inside its own sign-in window (`will-redirect` / `will-navigate`) and never opens a listener. That is the simpler mechanism in Electron, and nothing on the machine can race for the code.
   - Microsoft's desktop page suggests `msal{client-id}://auth` for Electron apps that use the system browser. We don't use the system browser: the window must share the app's `persist:uw` session so UW single sign-on carries over.
3. **Authentication → Advanced settings → Allow public client flows → Yes.** ([Desktop app registration, "Enable public client flow"](https://learn.microsoft.com/entra/identity-platform/scenario-desktop-app-registration))
4. **API permissions → Add a permission → Microsoft Graph → Delegated permissions.** Add exactly these ([Configure access to web APIs](https://learn.microsoft.com/entra/identity-platform/quickstart-configure-app-access-web-apis)):

   | Scope | Why | Admin consent required (Microsoft's permissions reference) | Expected under UW's policy |
   |---|---|---|---|
   | `offline_access` | Refresh token, so the sign-in survives restarts | No | Consentable |
   | `User.Read` | Sign-in and the account | No | Consentable |
   | `Calendars.Read` | Calendar delta, meeting capture | No | **May be blocked**: Calendars.* is on the exclusion list of Microsoft's managed `microsoft-user-default-recommended` policy |
   | `Mail.Read` | Mail delta: sender, subject, date and the 255-character preview. `Mail.ReadBasic` excludes `bodyPreview`, so it can't give the preview. | No | **May be blocked**: Mail.* is on the same exclusion list |
   | `Files.Read` | The student's OneDrive files (Word, PowerPoint, PDF, Markdown) | No | Not on the listed exclusions (only `Files.Read.All` is); inferred consentable, not proven |
   | `Notes.Read` | OneNote pages | No | Not on the listed exclusions; inferred consentable, not proven |
   | `Files.ReadWrite.AppFolder` | Only the app's own `Apps/<app>` folder, for lecture notes the student edits in Word online | No | Not on the listed exclusions; inferred, not proven |
   | `Calendars.ReadWrite` (optional, not on the first screen) | Adding a meeting the student confirmed | No | **Likely blocked** where Calendars.* is excluded |

   Sources: [Microsoft Graph permissions reference](https://learn.microsoft.com/graph/permissions-reference) (each scope's "AdminConsentRequired" for Delegated) and [Manage app consent policies](https://learn.microsoft.com/entra/identity/enterprise-apps/manage-app-consent-policies) (the managed policies and the exclusions shown there: Files.Read.All, Sites.*, Mail.* …).

   - UW's actual tenant setting is unknown until E1.
   - Do **not** select "Grant admin consent". We are not UW's admins.
5. **No client secret and no certificate.** It is a public client, so the Certificates & secrets page stays empty.

Deliberately never requested or called:
- no `Mail.Send` or `Mail.ReadWrite`
- no meeting accept, decline or respond endpoints
- no `Files.Read.All` or `Sites.*`

Magic Canvas never sends, replies to, moves or deletes mail, and never answers invitations. The only writes it makes are to the app's own OneDrive folder, and one calendar event per proposal the student clicked to confirm.

## 2. Where the client ID goes

Either of these works:
- the environment variable `MAGIC_MS_CLIENT_ID=<Application (client) ID>`, and optionally `MAGIC_MS_TENANT=wisc.edu` to pin UW's tenant (the default is `organizations`)
- or the file `outlook-settings.json` in the app's user-data folder: `{ "clientId": "<GUID>" }`, optionally with `"tenant": "wisc.edu"`

The ID is not a secret, but it names our registration. Keep it out of issues and screenshots anyway. With no client ID, Outlook reports **Not set up** and makes no network call.

## 3. How it behaves

- **Consent.** The one setup checkbox (the `uw` record) covers it, with this line on the setup screen: "Also connects your UW Outlook calendar and mail (subject, sender, date, a short preview; never full messages)". The line text is `OUTLOOK_GRAPH_DISCLOSURE` in contracts, for the frontend's ConsentSetup. `CONSENT_DISCLOSURE_VERSION` moved to `setup-2026-09-26-outlook`, so existing records re-confirm. It is one version for all recipients, so provider agreements re-confirm too. Withdrawing `uw` disconnects Outlook: the tokens, the delta links and every stored Graph record are deleted.
- **Connect.** Automatic and silent:
  1. At launch: the encrypted MSAL cache, then an authorize request with `prompt=none` in a **hidden** window on `persist:uw`. Nothing is ever shown at launch.
  2. After a confirmed UW sign-in: the same. If Microsoft answers `interaction_required`, `consent_required` or `login_required`, Microsoft's own window opens **once** for first-time consent, with every scope on one screen.
  3. The hidden window may only visit login.microsoftonline.com and login.wisc.edu. Any other page, or a page that sits waiting for input, closes it. It never types, clicks, reads or injects anything, and Duo is only ever the student's own step in the visible window.
- **Blocked.** AADSTS90094 or AADSTS90095 (and AADSTS65001 after the visible window) give the state `needs_uw_approval`, with `approvalRequest`:
  - `not_sent` for 90094: the tenant has no request form
  - `unknown` for 90095, because the app can't read Microsoft's page to know whether the form was submitted

  After a block the app never re-prompts on its own; the student's "Connect Outlook" tries once more.
- **IPC** (preload `window.magic`, no renderer UI in this change):
  - `outlookConnect()` and `outlookStatus()` return `OutlookStatus`: `outlook` (`not_set_up` | `not_connected` | `connected` | `needs_uw_approval` | `expired` | `error`), `scopes`, `canWriteCalendar`, `approvalRequest`, `reason`, `lastSyncAt`, `counts`, `icsConnected`
  - `outlookDisconnectGraph()`
  - `outlookMailBody(resourceId)`: fetched on demand, never stored
  - `calendarProposeEvent(input)` and `calendarCreateEvent(proposalId)`
- **Sync.** Graph rides the refresh coordinator's run (5-minute hot tick) and is presence-gated like the Canvas reads.
  - Mail (inbox, last 45 days, `$select`ed fields), calendar (−14 to +120 days) and OneDrive use Graph delta: a check with nothing new costs one request per stream and writes nothing.
  - OneNote has no delta. Its page list is read at most hourly, and a page's content only when it is new or changed (a per-notebook `lastModifiedDateTime` watermark).
  - At most 2 concurrent requests (Outlook's limit is 4 per app and mailbox; [throttling limits](https://learn.microsoft.com/graph/throttling-limits)).
  - 410 restarts a stream with a full sync ([delta query overview](https://learn.microsoft.com/graph/delta-query-overview)); 429 and 503 wait `Retry-After`; 401 renews the token silently and retries once.
- **Stored mail** is subject, sender, date and the preview, never a full body, plus:
  - a code-computed category with its reason: `course`, `advisor`, `org`, `admin`, `meeting` or `general`
  - the matched Canvas course, or the org or list name
  - a ≤280-character gist only when the student's own AI client writes one (`mail.gist`, a stub for now)

  The advisor match compares the planning record's name in the worker only. Only the category `advisor` is stored.
- **ICS fallback.** The published calendar link is read with `If-None-Match` / `If-Modified-Since`; a 304 does no work. While the Graph calendar is connected, the ICS read is skipped and its duplicate copy removed. The link is kept, so a disconnect falls back to it. `calendarPublishGuide()` gives the Outlook on the web page (Settings → Calendar → Shared calendars) for the frontend to open.

## 4. E1: the live test (operator present, Ben's machine, one UW account)

1. Register the app (§1) and set `MAGIC_MS_CLIENT_ID`. Start the app, agree to the setup screen, and sign in to UW (NetID and Duo in UW's own window).
2. Right after the UW sign-in the app tries silently, and Microsoft's window then appears once. What the student sees next depends on UW's policy.

**If UW allows user consent:**
- Microsoft's consent screen lists the app name and the seven permissions. The student selects **Accept**, the window closes, and `outlookStatus()` shows `connected` with the granted scopes.
- Within one refresh (≤5 minutes, or at once with a manual sync), inbox messages from the last 45 days and the next 120 days of calendar appear. OneNote pages and linked OneDrive files appear as `unmapped` notes.
- Quit and relaunch: the status is `connected` again with no window (the encrypted refresh token renewed silently).

**If UW blocks it:** Microsoft shows one of two pages ([consent experience](https://learn.microsoft.com/entra/identity-platform/application-consent-experience), [user and admin consent](https://learn.microsoft.com/entra/identity/enterprise-apps/user-admin-consent-overview), [admin consent workflow](https://learn.microsoft.com/entra/identity/enterprise-apps/configure-admin-consent-workflow)):
- A page telling the student to ask their admin for access, with no request form (AADSTS90094; E1 records its exact title).
  - If Microsoft sends the window back to the app with that error, the status is `needs_uw_approval`, with `approvalRequest: "not_sent"`.
  - If the student just closes the window, the app sees no answer (it can't read Microsoft's page), so the status stays `not_connected` with reason `closed`.
  - E1 settles which of these Microsoft does.
- **"Approval required"** (the admin consent workflow is on, AADSTS90095). The student types a justification and selects **Request approval**, and Microsoft confirms "Request sent". Microsoft's docs say only the first of several requests is submitted, and the student is notified after a reviewer acts. The status is `needs_uw_approval` with `approvalRequest: "unknown"`, because the app can't read Microsoft's page.

After a block, nothing re-prompts on its own. Once UW approves, the student's "Connect Outlook" retries once. The ICS fallback (`calendarPublishGuide()`) keeps the calendar working meanwhile.

**Record for the build log:**
- which page appeared, and the AADSTS code in `reason`
- the scopes granted, if only some were
- request counts from a zero-change sync (`MAGIC_TRIAL_LOG`: service `graph`, statuses only)

Record no mail content, no addresses and no screenshots of the inbox.

# Project coordinator: one space per project, linked to the conversations about it

Checked 2026-09-26. The integrity rules are in `integrity-roles.md`.

## What it is
Every assignment that's a project, individual or group, gets a **project space**:

| Part | Where it comes from |
|---|---|
| **Spec + rubric** | Canvas assignment; files linked from it |
| **Requirements checklist** | extracted from the spec with citations (LLM); ticked off by the student |
| **Mapped materials + notes** | the course graph (lectures, readings, the student's notes) |
| **Milestones** | proposed from the spec and the due date; **the student edits them** |
| **Team** | Canvas groups (`GET /api/v1/users/self/groups`) plus group files, pages and discussions |
| **Conversations** | email threads, Canvas Inbox, Ed threads and Piazza links about *this* project |
| **Collaboration rule** | from the syllabus and spec: team project vs individual, what may be shared |
| **AI-use log** | from the audit trail, for the AI Usage Statement |

## Why these parts (evidence)
- **Milestones:** late submissions fell from **41% to 12%**, and correctness rose from 72% to 76% (Shaffer & Kazerouni, SIGCSE 2021; sourced).
- **Free-riding is common and rarely escalated:**
  - social loafing d=0.44 across 78 studies (Karau & Williams 1993)
  - 27% of students hit free-riding, and **82.6% of them never asked for help** (J. Marketing Education 2021, doi:10.1177/0273475321992109)
- **Team charters** improve early team process (Mathieu & Rapp 2009, doi:10.1037/a0013257). Across 1,891 teams they didn't raise final grades (Johnson et al. 2022, doi:10.5465/amle.2020.0332).
- **Peer evaluation during the project, not only at the end,** reduces loafing. CATME is the validated instrument (Ohland et al. 2012, doi:10.5465/AMLE.2010.0177).
- **"If-then" plans:** d≈0.72 in the academic meta-analysis, but one classroom RCT found no benefit. So they're offered, not promised.
- **Canvas Groups** give each group files, pages and discussions, but **no task board or milestones.** That's the gap we fill.

## Team features (group projects)
- **A charter template:** roles, norms, communication channel, meeting times, and what happens if someone falls behind. The team fills it in once.
- **A task board:** who does what, entered by students. Milestones come from the plan.
- **A check-in prompt** at each milestone (a 1-minute "done / blocked / next").
- **A peer-evaluation reminder** if the course uses CATME or similar.
- **Contribution visibility is opt-in and team-controlled,** never surveillance.

## Linking the conversations
**How threads get matched to a project:**
- **Code first:**
  - the course code or assignment name in the subject
  - the sender is course staff or a teammate
  - Canvas `GET /api/v1/conversations?filter[]=course_<id>` or `group_<id>`
- **Jev only for leftovers:** one yes/no per candidate project, "is this about P2?" Email text is untrusted, so Jev may only *add* a link, never hide a message.
- **The result is a timeline per project:** announcements, emails, Canvas messages, Ed threads, pinned Piazza posts.

## Starting a conversation (the student always sends)
- **"Ask the TA about this"** drafts a message that includes:
  - the assignment and the spec section
  - what's unclear
  - **what the student already checked:** the spec, announcements, and existing threads that were searched

  That last part avoids duplicate questions and makes the email better. Only 28% of college students actively seek help, against 41% who intend to (PMC12447698), so a good draft closes a measured gap.
- **How it opens, by channel:**

| Channel | How the draft opens |
|---|---|
| **Outlook** | the compose deep link `https://outlook.office.com/mail/deeplink/compose?to=…&subject=…&body=…` (sourced, Microsoft Q&A). **`cc` isn't officially supported** (there's a workaround inside `to`), and **subject and body can drop if the session re-authenticates**. Keep the body short and put the full context in the clipboard too. If UW allows it, Microsoft Graph `createReply` makes a real draft *inside the thread* (needs `Mail.ReadWrite`). |
| **Canvas Inbox** | no pre-filled compose URL exists: the app copies the draft and opens Canvas compose |
| **Ed Discussion** | has an official API with a token the student creates; open the thread or new-post page, draft copied |
| **Piazza** | **Piazza's terms forbid scraping without written consent** (piazza.com/legal/terms). So Piazza is a **web tab in the student's own session** plus posts the student pins; no automated harvesting. Draft copied, new-post page opened |
| **Teammates** | same as Outlook, addressed to the Canvas group members |

## Integrity guardrails
- **The collaboration rule belongs to each assignment** (UWS 14.03: collaborating "contrary to the stated rules of the course" is misconduct). **The app never moves an individual assignment's materials or notes into a team space,** and it shows the rule on every project.
- **It never drafts deliverable content.** Plans, checklists, messages and resources only.
- **It never posts in graded discussions or speaks as the student** (Michigan's sample policy).
- **It never sends automatically.**

## Open decisions
- Ask Piazza for API consent, or keep it as a web tab plus pinned links.
- Whether to request Microsoft Graph `Mail.ReadWrite` (drafts inside threads), or stay on deep links.

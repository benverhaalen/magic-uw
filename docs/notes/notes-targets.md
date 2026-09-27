# Where generated notes go: local first, cloud only when present

**Status: Proposal.** Checked 2026-09-26. It complements [notes](notes.md), which covers templates and evidence.

## Principle
The app writes a code-built folder tree of templated `.docx` notes from the banked course structure (course → lecture, assignment, exam, reading). **It assumes no cloud storage or OneDrive is set up.** Cloud targets are used only when detected or explicitly connected.

## Targets, in order
1. **Local folder (default, always works):** `Documents/My Magic UW/<Term>/<Course>/{Lectures, Assignments, Exams, Readings}/…`. Plain `.docx` opens in Word, Pages, LibreOffice or Google Docs.
2. **A detected sync folder,** offered, never assumed:

| Service | Where it is | How to detect it |
|---|---|---|
| Google Drive for desktop | macOS `~/Library/CloudStorage/…`, a fixed location; Windows streams to `G:` by default | registry `HKCU\Software\Google\DriveFS` (support.google.com, sourced) |
| OneDrive | Windows | `%OneDrive%`, `%OneDriveCommercial%`, and `HKCU\Software\Microsoft\OneDrive\Accounts\*\UserFolder`. These are community-documented, so verify against Microsoft before shipping. Files On-Demand is on by default |

3. **Opt-in cloud APIs,** for a student with no sync client:
   - **Google Drive** with the `drive.file` scope. Google classifies it **non-sensitive**, so no security assessment is needed. Desktop OAuth uses a loopback redirect. Uploading with the Google Docs MIME type converts the file to a native Doc.
   - **Microsoft Graph** (`PUT /me/drive/items/{parent}:/{name}:/content`). UW's tenant consent settings are unverified, and UW's KB urges caution with OAuth grants and prefers campus-vetted apps (kb.wisc.edu 139025).

## Opening a note
- The default `.docx` app.
- If none is registered: a read-only in-app preview, plus the choice to install Microsoft 365 or to connect Google Drive (target 3).

## How it's built
- **Code builds the tree and the files** (the `docx` package, MIT).
- **Jev picks the template per session type,** from a small candidate set: lecture, discussion, lab, reading, worked problems.
- **The student's AI pre-fills the outline** from that session's materials, with checked quotes.
- **The AI invokes the whole build as one coarse tool** (`notes.build_course_tree`), so the model never plans file-by-file.
- **The app records each note's path and hash only.** It never needs cloud access to find the student's notes later.

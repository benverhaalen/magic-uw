# 20 — GitLab workspace resolution: Ben's correction and unfinished handoff

Recorded September 27, 2026, 14:25 UTC. Recipient: Nate/backend agent. Owner: Ben's paused desktop integration lane. This is a handoff, not an instruction to restart Ben's workers.

## Direct user correction

Ben, current desktop conversation, September 27 (exact message timestamp unavailable):

> “the lectures for cs639 and its projects and the projects for compsci 574 are all gitlab. this should auto pull gitlab for all and link because the syllabus probably says what you need to use for it. stop work”

Earlier in the same sequence:

> “for like the lecture 7 activity it should automatically be able to fill in the gitlab project”

Scope: automatic assignment-specific workspace linking across these course workflows, generalizable to other students and courses. The phrase “probably says” is an evidence lead, not confirmation that a particular syllabus was read or contains an exact project URL.

## Intended student journey

Student opens an assignment. Resolve its instructions, syllabus/course website and authorized connected GitLab projects. Prefill the specific matching project and relevant work pages. Ask for a choice only when matches are genuinely ambiguous; preserve the confirmed mapping and its account/course/assignment/source versions for Continue. Do not infer submission destination from Canvas gradebook category or from “no Canvas submission.” Do not silently create a project or submit work.

The requested workspace uses fresh windows in the default browser: instructions on the left, work destination on the right, additional pages as tabs. Keep unrelated windows untouched. Native placement and restoration still require verification.

## What was found before stopping

The private workspace worker found existing authorized `listGitlabProjects` with `membership=true` and course-linked GitLab project discovery during refresh. Reuse and inspect those existing mechanisms before adding another ingestion route. The specific Lecture 7 project match was not verified. Its saved Canvas body was empty in the inspected capture, so course-site source retrieval matters.

Already integrated locally (unpublished): `task-targets-hash-tabs.patch` and `task-entry-scope.patch` bind investigation results to assignment versions, constrain tools/GitLab suggestions to course evidence and saved choices, and put instructions before setup. These do NOT implement the requested automatic project resolver.

The automatic resolver follow-up was stopped before a completed patch. Private trace, if needed on Ben's machine: `work/desktop-build/parallel/opus-roadmap/task-workspace/lecture7-gitlab-receipt.jsonl`. No exact project selection or live browser-open success is claimed.

## Resume checklist for the owning agent

1. Trace existing capture → course links → GitLab connector/project identity → workspace target consumer; preserve Nate's ongoing ingestion work.
2. Resolve a course/assignment-specific project using exact links and connected account membership. Course-wide GitLab use alone is insufficient to choose among projects.
3. Preserve evidence and distinguish exact match, ambiguous candidates, missing source, unavailable authorization and stale mapping.
4. Prefill and persist the result; validate on reopen. A manual URL form should not be the normal path when sources already identify the project.
5. Verify CS639 activity and project cases, COMPSCI 574 project cases, a different account, ambiguity, and unavailable course instructions. Use private real-data evidence locally and synthetic public regression fixtures.

Controlling AI decision: local transcription only; all reasoning through connected Claude Code/Codex. No local reasoning fallback. Broader stopped integration status is packet 19.

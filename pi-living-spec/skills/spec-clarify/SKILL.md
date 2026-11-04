---
name: spec-clarify
description: Resume an optional persistent specification interview without crawling. Resolve consequential questions, record attributed answers and necessary requirement consequences, and preserve decisions and impacts.
---

# Clarify the working specification

Start with `spec_clarify` action frontier. Read relevant records, answers, evidence, and open reviews. Do not require another crawl. Ask the user who is answering when attribution is unknown. Never invent a client's identity or approval authority.

Before asking the client anything, resolve factual questions from the evidence already available: records, answers, source maps, crawl outlines, screenshots, and API captures. Record the evidence-based answer or narrowed assumption with its source. Ask the client only about intent, priorities, business rules, authority, or facts that the evidence cannot settle. Say which evidence you checked.

Track the exact revision of every record you read or present. Pass it as `expectedRevision` on each confirm, update, retire, answer, answer patch, defer, resume, and supersede. If the tool rejects a stale revision, reload the record, explain to the user any substantive change since they saw it, and obtain renewed confirmation or answers where the change matters. Never fetch the new revision just to push an earlier approval through.

Work through a few consequential choices at a time. Prefer questions that unblock other questions, change scope, affect acceptance, or constrain a solution. Do not indiscriminately reask answered or deferred questions. The frontier reports dependencies and deferral conditions. Resume deferred questions only when their condition is met or the user explicitly chooses to revisit them.

Use `ask_user_question` when installed. Give two to four concise choices with their trade-offs, with space for the user's own answer. Otherwise ask the same question conversationally and wait. Do not assume an option was accepted because it was recommended.

After each exchange, call `spec_clarify` answer immediately. Include contributor, date, source, rationale, remainingUncertainty, and affectedIds. Record a partial answer when uncertainty remains. Include explicit or logically necessary requirement patches atomically with reasons. Do not require a second approval of every sentence that merely states the answer. Do ask again when a proposed consequence adds a new choice, obligation, estimate, or scope.

Ordinary confirmation uses `spec_record` confirm with attribution. A consequential choice with meaningful alternatives uses `spec_decision`, including rationale and consequences. Replace an old decision through supersede with a new ID. Preserve old reasoning. Never silently rewrite related artefacts. Check `spec_review` and resolve reviewed or no-change entries with reasons. A review resolution is not confirmation.

Challenge a concrete scenario after a major answer, such as duplicates, permissions, failure, high volume, or an empty result. Ask only about credible consequences. Defer blocked matters with a reason and a condition. Record newly discovered questions and links instead of carrying them only in conversation.

Keep estimates optional. Use one shared work package per piece of work, with units, range, basis, exclusions, assumptions, and exact applicability revisions. Do not invent effort or sum shared work twice.

If the user requests a baseline, confirm purpose, exact binding selection, supporting reasoning, responsibilities, acceptance arrangements, dependencies, exclusions, and assumptions. Draft or estimating baselines may contain unresolved matters. An approved baseline requires named approvers with supplied authority, date, and source. Completeness does not establish commercial authority.

At a pause, persist progress and report ready, waiting, and deferred matters. Export on request. Manuscript edits belong in records, not generated files. Another `/spec-clarify` resumes this same frontier.

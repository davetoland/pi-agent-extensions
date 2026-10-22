# Extending Pi

**Extending Pi** is a mini-series I've written about the [Pi coding agent](https://pi.dev). Each part looks at a way of extending the harness, what it adds, and how it can help you in day-to-day development. The parts get steadily more complex, from a footer tweak to a team of agents in tmux, and finish with how to write your own.

Install all six extensions with:

```bash
pi install git:github.com/davetoland/pi-agent-extensions@v0.1.1
```

---

## Extending Pi: 00 - Getting Started (Why Pi?)

Pi is an open source (MIT) coding agent for the terminal. Its core is deliberately small: it ships with solid defaults but leaves out features such as subagents and plan mode, and gives you the means to add whatever you need instead. Extensions, skills, prompt templates and themes can all be bundled as packages and shared.

It isn't tied to one model vendor. Sign in with a subscription you already pay for, such as Claude Pro/Max, ChatGPT Plus/Pro or GitHub Copilot, use an API key from one of many providers including OpenRouter, or point it at a local model.

```bash
curl -fsSL https://pi.dev/install.sh | sh    # Windows: powershell -c "irm https://pi.dev/install.ps1 | iex"
cd your-project
pi                                           # then /login to choose a provider
```

Key takeaways:

✅ Open: MIT licensed, readable code, and sessions saved as plain files on your machine.  
✅ Your models: use the subscriptions and providers you already have, or run locally.  
✅ Yours to shape: when something's missing, extend it, or ask Pi to build it for you.

---

## Extending Pi: 01 - Custom Footer (Small Tweaks, Easy Wins)

Pi's footer shows tokens, cache, cost and how full the context window is. [`custom-footer`](../custom-footer) replaces it with a version that makes a few small changes: context shows as tokens used against the window (`244k/1.1M (23.2%)`) rather than only a percentage, the reading turns amber at 40% and red at 60% instead of 70% and 90%, and the git branch shown stays correct when the project folder is mounted into a Docker container, where Pi's file watcher can miss branch changes.

It's the smallest extension in the series: one file, one event handler and one render function. The point isn't the features. It's how little it takes to replace part of Pi's interface with your own.

Key takeaways:

✅ Easy to extend: replacing part of Pi's interface takes one handler and one render function.  
✅ Start small: a few tweaks to something you look at all day add up.  
✅ Fix your own setup: when something doesn't work where you run it, you can change it yourself.

---

## Extending Pi: 02 - Conditional Instructions (Context on Demand)

[`conditional-instructions`](../conditional-instructions) brings GitHub Copilot's path-scoped instructions to Pi. Each instruction file declares an `applyTo` filter. The agent sees only a short index; the full instructions are added the first time it reads a matching file.

If the agent tries to edit a matching file before reading the instructions, the edit is blocked and it's told what to read first. After compaction, instructions count as unloaded, so they come back when next needed.

Key takeaways:

✅ Lean context: instructions cost tokens only when they're relevant.  
✅ Enforced, not hoped for: edits are blocked until the right rules are in context.  
✅ Familiar: the same `applyTo` format as GitHub Copilot's instruction files.

---

## Extending Pi: 03 - Skill Read Dedupe (Never Pay for a Skill Twice)

[`skill-read-dedupe`](../skill-read-dedupe) blocks a read of a `SKILL.md` whose full text is already in context, and tells the agent to use the copy it has. It decides from the messages Pi actually sent to the model on the latest request, so compaction, `/new` and session-tree navigation are handled without any tracking of its own.

It blocks only when the earlier copy is complete and matches the file byte for byte, it recognises both earlier reads and `/skill:name` injections, and on any doubt it lets the read through.

Key takeaways:

✅ Context is a budget: don't spend it on text the model already has.  
✅ Check the source of truth: use what was actually sent, not what you think was sent.  
✅ Fail open: a guard that blocks wrongly costs more than the waste it prevents.

---

## Extending Pi: 04 - Session Eval (Agent Session Evaluation)

[`session-eval`](../session-eval) has two parts. The extension exports Pi sessions, including their subagents and peers, as a trace bundle, and records facts Pi doesn't, such as tool durations. The `evaluate-session` skill reads the bundle: a script measures cost, cache hit ratio, context spent by source and flags such as repeated reads, loops and risky commands, then the agent confirms each flag against the trace.

Run `/evaluate-session`. The report covers nine dimensions, from outcome and efficiency to delegation and safety. Each finding has evidence, a cost and a cause, and names where the fix belongs: `AGENTS.md`, a skill, a script, the harness or the environment. The skill reports; it changes nothing.

Key takeaways:

✅ Measure, then judge: metrics first, and the model reports only what the trace confirms.  
✅ Fix the cause: send each finding to the change that fixes it.  
✅ Find deterministic work: anything rediscovered every session belongs in a script.

---

## Extending Pi: 05 - tmux Agents (A Team of Agents in One Terminal)

[`tmux-agents`](../tmux-agents) lets one Pi agent spawn, brief and coordinate others, each a real interactive Pi in its own tmux window or pane. Agents message each other only along links the lead grants, and a message to the lead raises a badge rather than starting work in its session.

Right-click a tab to split, join, reorder, rename or close windows. Agents sharing a window are laid out around the lead automatically, with layouts to choose from a right-click menu in any agent pane. It needs Linux and tmux; on Windows, use WSL or a container.

Key takeaways:

✅ Visible delegation: watch every agent work, and step in when you need to.  
✅ Coordination with guardrails: agents talk only along links you allow.  
✅ Arrange freely: split, join and lay out agents without losing track of them.

---

## Extending Pi: 06 - Writing Your Own (Start by Asking Pi)

When you ask Pi about extensions, it reads its own documentation and examples first, so describing the behaviour you want gets you a working extension. For example:

> Write a Pi extension at `~/.pi/agent/extensions/protect-env.ts` that stops the read, edit and write tools touching `.env` files, but allows `.env.example`. When you block a call, tell the agent why.

The result, in [`examples/protect-env.ts`](examples/protect-env.ts), is about 20 lines: a default export that receives the Pi API, a `tool_call` handler, and a `{ block: true, reason }` return that tells the model why. Try it with `pi -e ./protect-env.ts`, then ask Pi to cover `bash` commands too.

Key takeaways:

✅ Ask first: Pi knows its own extension API, so describe the behaviour you want.  
✅ Small surface: one function and a few events go a long way.  
✅ Share it: a package turns your extensions into a one-line install.

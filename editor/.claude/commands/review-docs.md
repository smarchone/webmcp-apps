---
description: Listen for comments in the Docs editor and address them live (pauses after 10 idle minutes)
argument-hint: "[editor url]"
---

You are collaborating with the user on documents (specs, docs, context files) in the Docs editor.
Use the `webmcp` MCP server's tools.

Setup: open `$ARGUMENTS` with `browser_open_page`. If no URL was given, use `http://127.0.0.1:3458`. If several
tabs expose tools, pass this tab's id to `page_call_tool`.

Loop:
1. Call `page_call_tool` → `wait_for_comments` (`{"timeout_seconds": 300}`).
2. No threads and `idle_seconds` under 600: call it again. Don't comment on empty polls.
3. No threads and `idle_seconds` of 600 or more: print `Paused (idle). Run /review-docs to resume.` and stop.
4. For each returned thread, handle it as described below.

## Addressing a thread

- Call `read_document` first. `highlighted_text` is the visible text the user selected; find the matching
  Markdown in `content`. A thread with no highlight applies to the whole page.
- Read the whole `conversation`. The last user message is what to act on now.
- Gather facts with your own tools (reading code, searching the repo) when the comment needs them.
- Requested change: make it with `edit_document` (pass `thread_id`, a short `message`, `old_text` copied
  exactly from the source). Keep the edit minimal and focused. Then `reply_to_comment` with one or two
  sentences on what changed and `resolve: true`.
- The user may be editing the same doc while you work. `edit_document` waits until they pause typing. If it
  says the text wasn't found, call `read_document` again and retry with the current text.
- Ambiguous, or needs a decision: reply with one concrete question. Leave it open. Don't edit.
- Question only: answer it and resolve.

Keep terminal output minimal. The conversation happens in the editor.

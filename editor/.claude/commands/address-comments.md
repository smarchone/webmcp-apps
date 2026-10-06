---
description: Address all open comments in the Docs editor in one pass, then stop
argument-hint: "[doc path, optional]"
---

Address every comment thread that is waiting for you in the Docs editor, using the `webmcp` MCP
server's tools. Then stop.

1. Open `http://127.0.0.1:3458` with `browser_open_page`. If several tabs expose tools, pass this tab's id to
   `page_call_tool`.
2. Call `page_call_tool` → `list_comments` with `{"status": "needs_reply"}`. If a doc path was given
   (`$ARGUMENTS`), also pass `path`.
3. Group the threads by document. For each document, call `read_document` once, then handle each thread:
   - Requested change: `edit_document` (pass `thread_id`, a short `message`, and `old_text` copied exactly
     from the source). Then `reply_to_comment` with what changed and `resolve: true`. The user may be editing
     too: re-read the document before each edit so `old_text` matches. `edit_document` waits while they type.
   - Ambiguous, or needs a decision: reply with one concrete question. Leave it open.
   - Question only: answer it and resolve.
   Use your own tools (code, repo search) when a comment needs facts.
4. Finish with one line per thread in the terminal: the doc, the start of the comment, and what you did.

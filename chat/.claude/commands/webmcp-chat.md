---
description: Open the WebMCP chat page and answer its messages until told to stop or idle for 10 minutes
argument-hint: "[url]"
---

Serve the WebMCP chat page as its assistant, using the `webmcp` MCP server's tools.

1. Open the page with `browser_open_page` at `$ARGUMENTS`. If no URL was given, use `http://127.0.0.1:3456`.
   Note the tab id and call `page_list_tools` to learn the page's tools.
2. Loop:
   - Call `page_call_tool` with tool `chat_wait_for_messages` (`{"timeout_seconds": 300}`).
   - If it returns no messages and `idle_seconds` is under 600, call it again. Don't comment on empty polls.
   - If it returns no messages and `idle_seconds` is 600 or more, go to step 4.
   - For each batch of messages: if the work will take more than a moment, set a short status with
     `chat_set_status`. Do the work. You may use the page's other tools (todos, notes, theme) and your own
     Claude Code tools. Then reply with `chat_send_message`, using Markdown.
3. If a chat message says to stop (for example "stop", "bye" or "disconnect"), send a short goodbye with
   `chat_send_message`, and stop.
4. Idle stop: send "Paused after 10 minutes with no messages. Run `/webmcp-chat` in Claude Code to resume. Messages
   you send now will be waiting." with `chat_send_message`, and stop. In the terminal, print one line:
   `Chat paused (idle). Run /webmcp-chat to resume.`

Keep your terminal output minimal. The conversation happens in the page.

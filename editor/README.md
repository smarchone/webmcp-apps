# Docs

A Notion-style Markdown editor for working on specs, docs and context files together with a Claude Code
session. You highlight text and comment; Claude reads the threads, edits the doc and replies. The files are
real `.md` files on disk, and every change is a version you can revert.

## Run

```bash
cd editor
npm start                        # sample docs in ./workspace
npm start -- /path/to/your/repo  # or edit the .md files in any folder
```

Open http://127.0.0.1:3458 in any browser. In another terminal, start `claude` in `editor/` and run either
command:

| Command             | What Claude does                                                          |
| ------------------- | ------------------------------------------------------------------------- |
| `/review-docs`      | Listens for comments and answers them live. Pauses after 10 idle minutes. |
| `/address-comments` | Handles every open comment once, then stops.                              |

## Editing together

You and Claude edit the same page. There's no mode to switch.

- **You type freely.** While you're typing in a page, Claude's edits to that page wait until you pause for
  3 seconds (up to 30s). The save indicator shows "Claude will edit when you pause…".
- **Claude's edits land in place.** Only the changed text is replaced, so your cursor, scroll position and
  any unsaved typing elsewhere are kept.
- **Undo reverses only Claude's change.** Anything you typed after it stays.

## Working together

- **Comment:** select text, then click **💬 Comment** (or press ⌘⌥M). Threads sit in the right margin next to
  their highlight. **+ Comment on page** is for whole-page requests.
- **Thread states:** Waiting for Claude → Claude is on it → Claude replied / Resolved.
  Replying to a resolved thread reopens it.
- **Claude's changes:** changed paragraphs get an orange bar that stays with the text as you keep typing.
  A notice says what changed, with **View changes · Show comment · Undo** ("Undo all" if Claude made several
  edits). Dismiss the notice to clear the marks.
- **History:** every version shows its author and message. Open one to see the diff, compare it with the
  current version, or restore it. Restoring adds a new version, so it can be undone too. Autosaves from one
  typing session (5 minutes) fold into a single version.
- **Outside edits** (Claude's own Edit tool, git, your IDE) are detected and recorded as versions.
- **Live sync:** every open tab updates instantly. Use your normal browser while Claude works in the bridge's
  Chrome window.

## Using it in your own repo

```bash
claude mcp add --scope user webmcp -- node /abs/path/to/webmcp-apps/chat/bridge/webmcp-bridge.mjs
cp editor/.claude/commands/*.md ~/.claude/commands/
cd editor && npm start -- /path/to/your/repo
```

Then run `claude` in your repo and use `/review-docs`, so Claude can read the code while it works on the docs.
Comments and history live in `<docs folder>/.collab/`. Commit that folder to share them, or add it to
`.gitignore`.

## WebMCP tools on the page

`list_documents`, `read_document`, `wait_for_comments`, `list_comments`, `edit_document`, `write_document`,
`reply_to_comment`, `add_comment`, `list_versions`, `revert_document`

## Development

The editor is [Tiptap](https://tiptap.dev) v3 with its official Markdown extension, prebuilt into
`app/vendor/tiptap.js`. There's nothing to install to run it. To rebuild after changing
`vendor-src/tiptap-entry.js`:

```bash
npm install && npm run build:vendor
```

Note: the editor normalizes Markdown formatting the first time you edit a page (list markers, spacing). Only
your own edits trigger a save. Opening a page never rewrites it.

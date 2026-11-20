# claude-acp-test-1

Two small examples of how to talk to Claude through the [Agent Client Protocol](https://agentclientprotocol.com) (ACP):

- `client.js`: a command-line client that sends one prompt
- `server.js` + `index.html`: a ChatGPT-style chat app in the browser

Both start the `claude-agent-acp` adapter as a child process. They talk to it with JSON-RPC over stdin/stdout, using `@agentclientprotocol/sdk`.

## Requirements

- Node.js 20 or newer (tested with 20.14.0)
- Claude Code installed and logged in (`claude`). The adapter uses that login, so each prompt uses your Claude account quota.

## Install

```sh
npm install -g @agentclientprotocol/claude-agent-acp --include=optional
npm install
```

`--include=optional` is important. Without it, npm can skip the native Claude binary, and every prompt fails with `Claude native binary not found`.

## Command-line client

```sh
node client.js "List the files in this folder"
```

It prints the reply as it streams. If Claude asks for permission to use a tool, it asks you `y/N` in the terminal.

## Browser chat app

```sh
node server.js
```

Then open http://127.0.0.1:3000. To use a different port, run `PORT=3001 node server.js`.

Features:

- **Streaming replies** with Markdown: lists, tables, links, and code blocks with a **Copy** button
- **Sidebar with your chats.** Click one to open it. Titles come from Claude.
- **History survives a reload.** Old chats are replayed from Claude's own transcripts, so there is no database.
- **Edit** any of your messages, or **Regenerate** the last reply. Both create a branch: a new chat named `… (fork)` that keeps everything before that message. The original chat does not change.
- **Model, Effort, and Mode menus** in the header (`session/set_config_option`). Your choice carries over to new and reopened chats until the server restarts.
- **Permission requests** show as buttons (for example `Yes` / `No`)
- **Stop** cancels the current reply. **New chat** starts an empty chat.
- Light and dark mode follow your system. On a phone, the sidebar opens with the **Chats** button.

How it works:

```
browser  --POST /prompt /new /open /edit /permission /cancel-->  server.js  --ACP (stdin/stdout)-->  claude-agent-acp
browser  <-------------- GET /events (SSE) -------------------  server.js  <-- session/update ----  claude-agent-acp
browser  <-------------- GET /sessions (chat list) -----------  server.js  --- session/list ------>
```

| Action | ACP calls |
| --- | --- |
| New chat | `session/close` (old chat), `session/new` |
| Open a chat | `session/close`, `session/load` (replays the chat as `session/update` messages) |
| Edit / Regenerate | `session/fork` at the agent message before your message, `session/load`, `session/prompt` |

Two files and details to know:

- `chat-sessions.json` stores the IDs of the chats this app created. The sidebar shows only those IDs, because `session/list` also returns your Claude Code CLI sessions from the same folder. Opening a CLI session here while Claude Code still uses it could mix the two. The file is in `.gitignore`.
- Forking at a specific message uses a `claude-agent-acp` extension (`_meta.jetbrains.air.fork`), not standard ACP. A future adapter version could change it. If it does, Edit and Regenerate will show an error.

## Permission mode

After each server start, chats use the mode from your Claude Code settings (`permissions.defaultMode` in `~/.claude/settings.json`). In **Auto** or **Accept edits** mode, Claude can edit files **without** showing the permission buttons.

To make Claude always ask first, pick **Manual** in the **Mode** menu. The available modes are Manual, Accept edits, Plan, Auto, and Bypass permissions.

The adapter also offers Fast mode, Ultracode, and Agent options. The page hides them to keep the header short: it shows only the standard ACP categories `model`, `thought_level`, and `mode` (see `MENUS` in `index.html`).

## Security

Anyone who can send requests to `server.js` can run tools on your machine, as your user.

- The server listens only on `127.0.0.1`.
- It rejects requests whose `Host` header is not `localhost:PORT` or `127.0.0.1:PORT`. This blocks DNS rebinding.
- It rejects `POST` requests whose `Origin` header is not this page. This blocks other websites from sending prompts (CSRF).
- Replies are rendered with `marked` and then cleaned with `DOMPurify`, so HTML in a reply cannot run scripts in the page.

Do not expose it to a network without adding real authentication.

## Limits

- All browser tabs show the same chat. For more than one user, give each user their own session.
- No delete button. `session/delete` exists, but it removes the transcript for good.
- Each Edit or Regenerate adds a new chat to the sidebar. ChatGPT instead keeps branches inside one chat.
- Code blocks have no syntax colors. Claude's thinking text is not shown.
- Long chats use more server memory, because the server keeps the current chat's events so reloaded tabs can catch up.

## Troubleshooting

| Problem | Cause | Fix |
| --- | --- | --- |
| `Claude native binary not found for linux-x64` | npm skipped the optional native package | Reinstall with `--include=optional`, or set `CLAUDE_CODE_EXECUTABLE=$(which claude)` |
| `EADDRINUSE`, or the page shows a 404 from another app | Another program uses the port | `PORT=3001 node server.js` |
| No permission buttons appear | The chat is in Auto or Accept edits mode | Pick **Manual** in the Mode menu |
| `403 forbidden` | You opened the page with a hostname other than `localhost` or `127.0.0.1` | Open http://127.0.0.1:3000 |
| Edit or Regenerate shows `Fork point message … was not found` | The adapter changed its fork extension | Update this app, or use New chat |

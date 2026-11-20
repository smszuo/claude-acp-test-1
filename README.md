# claude-acp-test-1

Two small examples of how to talk to Claude through the [Agent Client Protocol](https://agentclientprotocol.com) (ACP):

- `client.js`: a command-line client that sends one prompt
- `server.js` + `index.html`: a browser chat box

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

## Browser chat box

```sh
node server.js
```

Then open http://127.0.0.1:3000. To use a different port, run `PORT=3001 node server.js`.

What it does:

- Streams replies into the page as Claude writes them
- Keeps one ACP session, so Claude remembers earlier messages
- Shows permission requests as buttons (for example `Yes` / `No`)
- Has a **Stop** button that cancels the current reply (`session/cancel`)

How it works:

```
browser  --POST /prompt, /permission, /cancel-->  server.js  --ACP (stdin/stdout)-->  claude-agent-acp
browser  <--------- GET /events (SSE) ----------  server.js  <-- session/update ----  claude-agent-acp
```

## Permission mode

The session starts in the mode from your Claude Code settings (`permissions.defaultMode` in `~/.claude/settings.json`). In `auto` or `acceptEdits` mode, Claude can edit files **without** showing the permission buttons.

To make the chat always ask first, add this line in `server.js`, right after the `session/new` request:

```js
await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: "default" });
```

The available modes are `default`, `acceptEdits`, `plan`, `auto`, and `bypassPermissions`.

## Security

Anyone who can send requests to `server.js` can run tools on your machine, as your user.

- The server listens only on `127.0.0.1`.
- It rejects requests whose `Host` header is not `localhost:PORT` or `127.0.0.1:PORT`. This blocks DNS rebinding.
- It rejects `POST` requests whose `Origin` header is not this page. This blocks other websites from sending prompts (CSRF).

Do not expose it to a network without adding real authentication.

## Limits

- All browser tabs share one session. For more than one user, create one session per user.
- Replies show as plain text. Markdown is not rendered.
- Claude's thinking text is not shown.
- If you reload the page, the chat history disappears from the page. The session still remembers it.

## Troubleshooting

| Problem | Cause | Fix |
| --- | --- | --- |
| `Claude native binary not found for linux-x64` | npm skipped the optional native package | Reinstall with `--include=optional`, or set `CLAUDE_CODE_EXECUTABLE=$(which claude)` |
| `EADDRINUSE`, or the page shows a 404 from another app | Another program uses the port | `PORT=3001 node server.js` |
| No permission buttons appear | The session is in `auto` or `acceptEdits` mode | See [Permission mode](#permission-mode) |
| `403 forbidden` | You opened the page with a hostname other than `localhost` or `127.0.0.1` | Open http://127.0.0.1:3000 |

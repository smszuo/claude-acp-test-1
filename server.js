// Browser chat box for the global `claude-agent-acp` adapter.
// Usage: node server.js, then open http://127.0.0.1:3000
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Readable, Writable } from "node:stream";
// The unstable entrypoint adds session/fork, which edit and regenerate need.
import * as acp from "@agentclientprotocol/sdk/unstable";

const PORT = Number(process.env.PORT) || 3000;
// Anyone who can call this server can run tools on this machine. Accept only these
// Host/Origin values: this blocks other websites (CSRF) and DNS rebinding.
const HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
const cwd = process.cwd();

// session/list also returns Claude Code CLI sessions from this folder. Show only chats this app made,
// so nobody opens a CLI session here while Claude Code is still writing to it.
const SESSIONS_FILE = new URL("./chat-sessions.json", import.meta.url);
const chatIds = new Set(JSON.parse(await readFile(SESSIONS_FILE, "utf8").catch(() => "[]")));
async function rememberChat(id) {
  chatIds.add(id);
  await writeFile(SESSIONS_FILE, JSON.stringify([...chatIds]));
}

const browsers = new Set(); // open SSE responses
const permissions = new Map(); // id -> { resolve, options } for each pending permission request
let nextPermissionId = 1;
let busy = false;
let sessionId; // the chat that every open tab shows
let configOptions = []; // the current chat's model, effort, mode, ... (from the adapter)
// shortcut: choices live in memory, so a server restart goes back to your Claude Code defaults.
const chosen = new Map(); // configId -> value picked in the page, applied to every chat you open
// shortcut: the current chat's events stay in memory so a reloaded tab can catch up; very long chats use more memory.
let history = [];

function broadcast(event) {
  history.push(event);
  for (const res of browsers) res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function setBusy(value) {
  busy = value;
  broadcast({ type: "busy", value });
}

// Every tab clears its page and starts showing chat `id`.
function showChat(id) {
  sessionId = id;
  history = [];
  broadcast({ type: "session", sessionId: id });
  broadcast({ type: "busy", value: busy });
}

function showConfig(options = configOptions) {
  configOptions = options;
  broadcast({ type: "config", options });
}

// Select options can come flat or in groups.
const choicesOf = (option) => option.options.flatMap((o) => o.options ?? [o]);

function answerPermission(id, outcome, answer) {
  permissions.get(id)?.resolve({ outcome });
  permissions.delete(id);
  broadcast({ type: "permission_done", id, answer });
}

// ACP rule: on cancel, the client must answer every open permission request with "cancelled".
function cancelPermissions() {
  for (const id of permissions.keys()) answerPermission(id, { outcome: "cancelled" }, "Cancelled");
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("body too large");
  }
  return JSON.parse(body);
}

function requireText(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("text is required");
}

const app = acp
  .client({ name: "acp-chat" })
  .onNotification(acp.methods.client.session.update, ({ params }) => {
    if (params.sessionId !== sessionId) return; // late updates from a chat we already left
    const u = params.update;
    const text = u.content?.type === "text" ? u.content.text : "";
    if (u.sessionUpdate === "agent_message_chunk" && text) {
      broadcast({ type: "text", text, messageId: u.messageId });
    } else if (u.sessionUpdate === "user_message_chunk" && text) {
      broadcast({ type: "user", text, messageId: u.messageId }); // sent only while session/load replays a chat
    } else if (u.sessionUpdate === "tool_call") {
      broadcast({ type: "tool", title: u.title });
    } else if (u.sessionUpdate === "session_info_update") {
      broadcast({ type: "title" });
    } else if (u.sessionUpdate === "config_option_update") {
      showConfig(u.configOptions);
    }
  })
  // Send the question to the page, then wait until someone clicks a button there.
  .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
    if (browsers.size === 0) return { outcome: { outcome: "cancelled" } };
    const id = String(nextPermissionId++);
    const options = params.options.map(({ optionId, name }) => ({ optionId, name }));
    broadcast({ type: "permission", id, title: params.toolCall.title, options });
    return new Promise((resolve) => permissions.set(id, { resolve, options }));
  });

const page = await readFile(new URL("./index.html", import.meta.url));
const markedJs = await readFile(new URL("./node_modules/marked/lib/marked.esm.js", import.meta.url));
const purifyJs = await readFile(new URL("./node_modules/dompurify/dist/purify.es.mjs", import.meta.url));
const file = (type, body) => (req, res) => res.writeHead(200, { "Content-Type": type }).end(body);

const agent = spawn("claude-agent-acp", [], { stdio: ["pipe", "pipe", "inherit"] });
const stream = acp.ndJsonStream(Writable.toWeb(agent.stdin), Readable.toWeb(agent.stdout));

await app.connectWith(stream, async (ctx) => {
  await ctx.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {}, // no fs/terminal: the agent uses its own built-in tools
  });

  // Free the current chat's Claude process. Its transcript stays on disk, so it can be opened again.
  async function leaveChat() {
    if (sessionId) await ctx.request(acp.methods.agent.session.close, { sessionId });
  }

  async function setOption(configId, value) {
    const result = await ctx.request(acp.methods.agent.session.setConfigOption, { sessionId, configId, value });
    configOptions = result.configOptions;
  }

  // Give a chat the model, effort, and mode picked earlier in the page.
  async function applyChoices(options = []) {
    configOptions = options;
    for (const { id, currentValue } of options) { // adapter order: mode, model, effort, fast
      const value = chosen.get(id);
      if (value === undefined || value === currentValue) continue;
      await setOption(id, value).catch(() => chosen.delete(id)); // e.g. an effort level the new model lacks
    }
    showConfig();
  }

  async function newChat() {
    await leaveChat();
    const { sessionId: id, configOptions: options } = await ctx.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: [],
    });
    await rememberChat(id);
    showChat(id);
    await applyChoices(options ?? []);
  }

  async function openChat(id) {
    await leaveChat();
    showChat(id);
    // The adapter replays the whole chat as session/update notifications.
    const result = await ctx.request(acp.methods.agent.session.load, { sessionId: id, cwd, mcpServers: [] });
    await applyChoices(result?.configOptions ?? []);
  }

  // Copy the current chat up to and including agent message `messageId`, then show the copy.
  async function forkChat(messageId) {
    const { sessionId: id } = await ctx.request(acp.methods.agent.session.fork, {
      sessionId,
      cwd,
      mcpServers: [],
      // The fork point is a claude-agent-acp extension, not standard ACP. Without it, the whole chat is copied.
      _meta: { jetbrains: { air: { fork: { version: 1, messageId } } } },
    });
    await rememberChat(id);
    await openChat(id);
  }

  async function prompt(text) {
    broadcast({ type: "user", text });
    const { stopReason } = await ctx.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text }],
    });
    broadcast({ type: "done", stopReason });
  }

  // Run one chat-changing task at a time. Its results stream through /events.
  async function exclusive(res, task) {
    if (busy) return res.writeHead(409).end("Wait for Claude to finish, or press Stop");
    setBusy(true);
    res.writeHead(202).end();
    try {
      await task();
    } catch (err) {
      broadcast({ type: "error", message: err.data?.details ?? err.message });
    } finally {
      setBusy(false);
    }
  }

  await newChat();

  const routes = {
    "GET /": file("text/html; charset=utf-8", page),
    "GET /vendor/marked.js": file("text/javascript; charset=utf-8", markedJs),
    "GET /vendor/purify.js": file("text/javascript; charset=utf-8", purifyJs),
    "GET /events": (req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      // Send the current chat first. This is how a reloaded tab gets its history back.
      for (const event of history) res.write(`data: ${JSON.stringify(event)}\n\n`);
      browsers.add(res);
      req.on("close", () => browsers.delete(res));
    },
    "GET /sessions": async (req, res) => {
      const chats = [];
      let cursor;
      do {
        const result = await ctx.request(acp.methods.agent.session.list, { cwd, cursor });
        chats.push(...result.sessions.filter((s) => chatIds.has(s.sessionId)));
        cursor = result.nextCursor;
      } while (cursor);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ chats }));
    },
    "POST /prompt": async (req, res) => {
      const { text } = await readJson(req);
      requireText(text);
      await exclusive(res, () => prompt(text));
    },
    "POST /new": (req, res) => exclusive(res, newChat),
    "POST /open": async (req, res) => {
      const { sessionId: id } = await readJson(req);
      if (!chatIds.has(id)) return res.writeHead(404).end("no such chat");
      await exclusive(res, () => openChat(id));
    },
    // Edit a message, or regenerate a reply: branch the chat just before that message, then send the text.
    "POST /edit": async (req, res) => {
      const { forkFrom, text } = await readJson(req);
      requireText(text);
      if (forkFrom != null && typeof forkFrom !== "string") throw new Error("forkFrom must be a string");
      await exclusive(res, async () => {
        if (forkFrom) await forkChat(forkFrom);
        else await newChat(); // the first message has nothing before it to keep
        await prompt(text);
      });
    },
    "POST /config": async (req, res) => {
      const { configId, value } = await readJson(req);
      const option = configOptions.find((o) => o.id === configId && o.type === "select");
      if (!option || !choicesOf(option).some((c) => c.value === value)) {
        return res.writeHead(400).end("unknown option or value");
      }
      await exclusive(res, async () => {
        try {
          await setOption(configId, value);
          chosen.set(configId, value);
        } finally {
          showConfig(); // on failure, this puts the page's menu back to the real value
        }
      });
    },
    "POST /permission": async (req, res) => {
      const { id, optionId } = await readJson(req);
      const pending = permissions.get(id);
      if (!pending) return res.writeHead(404).end("no such permission request");
      const option = pending.options.find((o) => o.optionId === optionId);
      if (!option) return res.writeHead(400).end("unknown option");
      answerPermission(id, { outcome: "selected", optionId }, option.name);
      res.writeHead(204).end();
    },
    "POST /cancel": async (req, res) => {
      cancelPermissions();
      await ctx.notify(acp.methods.agent.session.cancel, { sessionId });
      res.writeHead(204).end();
    },
  };

  const server = createServer(async (req, res) => {
    const trusted =
      HOSTS.includes(req.headers.host) &&
      (req.method === "GET" || HOSTS.some((h) => req.headers.origin === `http://${h}`));
    if (!trusted) return res.writeHead(403).end("forbidden");
    const route = routes[`${req.method} ${req.url.split("?")[0]}`];
    if (!route) return res.writeHead(404).end("not found");
    try {
      await route(req, res);
    } catch (err) {
      if (!res.headersSent) res.writeHead(400).end(err.message);
    }
  });
  server.listen(PORT, "127.0.0.1", () => console.log(`Chat: http://127.0.0.1:${PORT}`));
  await once(agent, "exit");
});

console.error("claude-agent-acp exited");
process.exit(1);

// Browser chat box for the global `claude-agent-acp` adapter.
// Usage: node server.js, then open http://127.0.0.1:3000
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const PORT = Number(process.env.PORT) || 3000;
// Anyone who can call this server can run tools on this machine. Accept only these
// Host/Origin values: this blocks other websites (CSRF) and DNS rebinding.
const HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];

const browsers = new Set(); // open SSE responses
const permissions = new Map(); // id -> { resolve, optionIds } for each pending permission request
let nextPermissionId = 1;
let busy = false;

function broadcast(event) {
  for (const res of browsers) res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ACP rule: on cancel, the client must answer every open permission request with "cancelled".
function cancelPermissions() {
  for (const { resolve } of permissions.values()) resolve({ outcome: { outcome: "cancelled" } });
  permissions.clear();
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("body too large");
  }
  return JSON.parse(body);
}

const app = acp
  .client({ name: "acp-chat" })
  .onNotification(acp.methods.client.session.update, ({ params: { update: u } }) => {
    if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
      broadcast({ type: "text", text: u.content.text });
    } else if (u.sessionUpdate === "tool_call") {
      broadcast({ type: "tool", title: u.title });
    }
  })
  // Send the question to the page, then wait until someone clicks a button there.
  .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
    if (browsers.size === 0) return { outcome: { outcome: "cancelled" } };
    const id = String(nextPermissionId++);
    const options = params.options.map(({ optionId, name }) => ({ optionId, name }));
    broadcast({ type: "permission", id, title: params.toolCall.title, options });
    return new Promise((resolve) =>
      permissions.set(id, { resolve, optionIds: options.map((o) => o.optionId) }),
    );
  });

const page = await readFile(new URL("./index.html", import.meta.url));
const agent = spawn("claude-agent-acp", [], { stdio: ["pipe", "pipe", "inherit"] });
const stream = acp.ndJsonStream(Writable.toWeb(agent.stdin), Readable.toWeb(agent.stdout));

await app.connectWith(stream, async (ctx) => {
  await ctx.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {}, // no fs/terminal: the agent uses its own built-in tools
  });
  // shortcut: one session shared by every open tab; create one session per user before exposing this to more people.
  const { sessionId } = await ctx.request(acp.methods.agent.session.new, {
    cwd: process.cwd(),
    mcpServers: [],
  });

  const routes = {
    "GET /": (req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
    },
    "GET /events": (req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(": connected\n\n");
      browsers.add(res);
      req.on("close", () => browsers.delete(res));
    },
    "POST /prompt": async (req, res) => {
      const { text } = await readJson(req);
      if (typeof text !== "string" || !text.trim()) return res.writeHead(400).end("text is required");
      if (busy) return res.writeHead(409).end("Claude is still answering");
      busy = true;
      res.writeHead(202).end(); // the answer streams through /events
      try {
        const { stopReason } = await ctx.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text }],
        });
        broadcast({ type: "done", stopReason });
      } catch (err) {
        broadcast({ type: "done", stopReason: "error", error: err.data?.details ?? err.message });
      } finally {
        busy = false;
      }
    },
    "POST /permission": async (req, res) => {
      const { id, optionId } = await readJson(req);
      const pending = permissions.get(id);
      if (!pending) return res.writeHead(404).end("no such permission request");
      if (!pending.optionIds.includes(optionId)) return res.writeHead(400).end("unknown option");
      permissions.delete(id);
      pending.resolve({ outcome: { outcome: "selected", optionId } });
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

// Minimal ACP client: starts the global `claude-agent-acp` adapter and sends it one prompt.
// Usage: node client.js "your prompt here"
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import * as acp from "@agentclientprotocol/sdk";

const prompt = process.argv.slice(2).join(" ") || "List the files in the current folder.";
const rl = createInterface({ input: process.stdin, output: process.stdout });

// The adapter speaks ACP (newline-delimited JSON-RPC) on stdin/stdout.
const agent = spawn("claude-agent-acp", [], { stdio: ["pipe", "pipe", "inherit"] });
const stream = acp.ndJsonStream(Writable.toWeb(agent.stdin), Readable.toWeb(agent.stdout));

const app = acp
  .client({ name: "acp-example" })
  // Streamed output: text chunks, tool calls, plans, ...
  .onNotification(acp.methods.client.session.update, ({ params: { update: u } }) => {
    if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
      process.stdout.write(u.content.text);
    } else if (u.sessionUpdate === "tool_call") {
      console.log(`\n[tool] ${u.title}`);
    }
  })
  // The agent asks before it runs risky tools. Ask the human instead of auto-allowing.
  .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
    const yes = /^y/i.test(await rl.question(`\n[permission] Allow "${params.toolCall.title}"? [y/N] `));
    const option = params.options.find((o) => o.kind.startsWith(yes ? "allow" : "reject"));
    return option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } };
  });

try {
  await app.connectWith(stream, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {}, // no fs/terminal: the agent uses its own built-in tools
    });
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    const { stopReason } = await ctx.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: prompt }],
    });
    console.log(`\n[stop] ${stopReason}`);
  });
} finally {
  rl.close();
  agent.kill();
}

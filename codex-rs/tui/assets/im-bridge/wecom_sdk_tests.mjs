import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { wecomSocket } from "./wecom_ws.mjs";
import { cleanups, Pairing } from "./runtime.mjs";

const require = createRequire(import.meta.url);
let sdkPath;
try {
  sdkPath = require.resolve("@wecom/aibot-node-sdk", {
    paths: (process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .flatMap((directory) => [directory, join(directory, "..", "lib")]),
  });
} catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}

test(
  "official WeCom SDK authenticates and exchanges messages over a real local WebSocket",
  {
    skip: sdkPath
      ? false
      : "Install @wecom/aibot-node-sdk to run the SDK integration test",
    timeout: 15_000,
  },
  async () => {
    const { WSClient } = require(sdkPath);
    const { WebSocketServer } = createRequire(sdkPath)("ws");
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    class LocalClient extends WSClient {
      constructor(options) {
        super({ ...options, wsUrl: `ws://127.0.0.1:${server.address().port}` });
      }
    }
    const requests = [];
    let socket;
    server.on("connection", (connection) => {
      socket = connection;
      connection.on("message", (bytes) => {
        const frame = JSON.parse(bytes.toString());
        requests.push(frame);
        connection.send(
          JSON.stringify({ headers: frame.headers, errcode: 0, errmsg: "ok" }),
        );
      });
    });
    const pairing = new Pairing();
    const accepted = [];
    const failures = [];
    try {
      const send = await wecomSocket(
        (message) => {
          if (pairing.accept(message)) accepted.push(message.text);
        },
        (error) => failures.push(error.message),
        {
          botId: "local-bot",
          secret: "local-test-secret",
          WSClient: LocalClient,
        },
      );
      assert.deepEqual(requests[0].body, {
        bot_id: "local-bot",
        secret: "local-test-secret",
      });
      assert.equal(requests[0].cmd, "aibot_subscribe");
      const content = [`/pair ${pairing.code}`, "work in the current terminal"];
      for (const [index, text] of content.entries()) {
        socket.send(
          JSON.stringify({
            cmd: "aibot_msg_callback",
            headers: { req_id: `callback-${index}` },
            body: {
              msgid: `message-${index}`,
              aibotid: "local-bot",
              chattype: "single",
              from: { userid: "owner" },
              msgtype: "text",
              text: { content: text },
            },
          }),
        );
      }
      const deadline = Date.now() + 5000;
      while (accepted.length < 2 && Date.now() < deadline) await sleep(20);
      assert.deepEqual(accepted, content);
      await send("owner", "Task completed");
      assert.equal(requests.at(-1).cmd, "aibot_send_msg");
      assert.deepEqual(requests.at(-1).body, {
        chatid: "owner",
        msgtype: "markdown",
        markdown: { content: "Task completed" },
      });
      assert.deepEqual(failures, []);
    } finally {
      for (const cleanup of cleanups) cleanup();
      cleanups.clear();
      for (const client of server.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);

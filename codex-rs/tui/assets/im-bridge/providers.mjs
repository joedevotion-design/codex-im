import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { cli, launch, lines } from "./runtime.mjs";
import { wecomSocket } from "./wecom_ws.mjs";

export function unwrap(value) {
  for (let depth = 0; depth < 5; depth++) {
    const inner = value.data ?? value.content ?? value.result;
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) break;
    value = inner;
  }
  return value;
}

export function larkMessage(event) {
  if (event.sender_type !== "user" || event.message_type !== "text")
    return null;
  return {
    id: event.message_id,
    chat: event.chat_id,
    sender: event.sender_id,
    text: event.content,
  };
}

export async function lark(receive, fail) {
  const child = launch(
    "lark-cli",
    ["event", "consume", "im.message.receive_v1", "--as", "bot"],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  child.on("error", () => fail(new Error("Cannot launch lark-cli")));
  child.on("close", () =>
    fail(new Error("Lark event connection closed. Reconnect with /lark.")),
  );
  lines(
    child.stdout,
    (event) => {
      const message = larkMessage(event);
      if (message) return receive(message);
    },
    fail,
  );
  return (chat, text) =>
    cli("lark-cli", [
      "im",
      "+messages-send",
      "--as",
      "bot",
      "--chat-id",
      chat,
      "--text",
      text,
    ]);
}

function wecomTime(date) {
  // WeCom API timestamps use China Standard Time, regardless of the host OS timezone.
  return new Date(date + 8 * 3600_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

export async function wecom(receive, fail) {
  if (process.env.CODEX_WECOM_BOT_ID || process.env.CODEX_WECOM_BOT_SECRET)
    return wecomSocket(receive, fail, {
      botId: process.env.CODEX_WECOM_BOT_ID,
      secret: process.env.CODEX_WECOM_BOT_SECRET,
    });
  let since = Date.now();
  const poll = async () => {
    const until = Date.now();
    const sessions = unwrap(
      await cli("wecom-cli", ["message", "aibot", "sessions", "list"]),
    ).sessions;
    if (!Array.isArray(sessions))
      throw new Error("Unsupported WeCom sessions response");
    for (const session of sessions.slice(0, 20)) {
      let cursor;
      const occurrences = new Map();
      for (let page = 0; page < 20; page++) {
        const args = {
          chat_id: session.chat_id,
          begin_time: wecomTime(since - 2000),
          end_time: wecomTime(until),
          ...(cursor ? { cursor } : {}),
        };
        const result = unwrap(
          await cli("wecom-cli", [
            "chat",
            "messages",
            "list",
            "--json",
            JSON.stringify(args),
          ]),
        );
        if (!Array.isArray(result.messages))
          throw new Error("Unsupported WeCom messages response");
        for (const event of result.messages) {
          if (
            event.msg_type !== "text" ||
            event.send_time < wecomTime(since - 2000)
          )
            continue;
          // This API has no message ID. Include occurrence to retain identical messages within a second.
          const hash = createHash("sha256")
            .update(
              JSON.stringify([
                session.chat_id,
                event.userid,
                event.send_time,
                event.text,
              ]),
            )
            .digest("hex");
          const occurrence = (occurrences.get(hash) ?? 0) + 1;
          occurrences.set(hash, occurrence);
          await receive({
            id: `${hash}:${occurrence}`,
            chat: session.chat_id,
            sender: event.userid,
            text: event.text?.content,
          });
        }
        if (!result.has_more) break;
        if (!result.next_cursor || page === 19)
          throw new Error(
            "WeCom polling overflow; reconnect to avoid skipping commands.",
          );
        cursor = result.next_cursor;
      }
    }
    since = until;
  };
  // Check access before main.mjs advertises a pairing code.
  await poll();
  void (async () => {
    for (;;) {
      await sleep(3000);
      await poll();
    }
  })().catch(fail);
  return (chat, text) =>
    cli("wecom-cli", [
      "message",
      "aibot",
      "send",
      "--json",
      JSON.stringify({
        chat_id: chat,
        msg_type: "markdown",
        markdown: { content: text },
      }),
    ]);
}

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`DingTalk request failed (${response.status})`);
  const result = await response.json();
  if (result.errcode) throw new Error(`DingTalk API error ${result.errcode}`);
  return result;
}

export async function dingtalk(receive, fail, appId) {
  const credentials = unwrap(
    await cli("dws", [
      "dev",
      "app",
      "credentials",
      "get",
      "--unified-app-id",
      appId,
      "--format",
      "json",
    ]),
  );
  const clientId = credentials.clientId ?? credentials.appKey;
  const clientSecret = credentials.clientSecret ?? credentials.appSecret;
  if (!clientId || !clientSecret)
    throw new Error(
      "DWS did not return robot credentials. Check the application ID and developer permissions.",
    );
  const routes = new Map();
  void (async () => {
    for (;;) {
      const { endpoint, ticket } = await post(
        "https://api.dingtalk.com/v1.0/gateway/connections/open",
        {
          clientId,
          clientSecret,
          ua: "codex-im",
          subscriptions: [
            { type: "CALLBACK", topic: "/v1.0/im/bot/messages/get" },
          ],
        },
      );
      const url = new URL(endpoint);
      if (url.protocol !== "wss:" || !url.hostname.endsWith(".dingtalk.com"))
        throw new Error("Unexpected DingTalk gateway");
      url.searchParams.set("ticket", ticket);
      await new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        socket.addEventListener("error", () =>
          reject(new Error("DingTalk Stream failed")),
        );
        socket.addEventListener("close", resolve);
        socket.addEventListener("message", ({ data }) => {
          void (async () => {
            if (Buffer.byteLength(data) > 128_000)
              throw new Error("Oversized DingTalk event");
            const frame = JSON.parse(data);
            if (frame.type === "SYSTEM") {
              socket.send(
                JSON.stringify({
                  code: 200,
                  headers: frame.headers,
                  message: "OK",
                  data: frame.data,
                }),
              );
              if (frame.headers.topic === "disconnect") socket.close();
            } else if (
              frame.type === "CALLBACK" &&
              frame.headers.topic === "/v1.0/im/bot/messages/get"
            ) {
              const event = JSON.parse(frame.data);
              if (event.msgtype === "text") {
                const webhook = new URL(event.sessionWebhook);
                if (
                  webhook.protocol !== "https:" ||
                  webhook.hostname !== "oapi.dingtalk.com"
                )
                  throw new Error("Unexpected DingTalk reply endpoint");
                routes.set(event.conversationId, {
                  url: webhook,
                  expires: event.sessionWebhookExpiredTime,
                });
                if (routes.size > 100)
                  routes.delete(routes.keys().next().value);
                await receive({
                  id: event.msgId,
                  chat: event.conversationId,
                  sender: event.senderStaffId ?? event.senderId,
                  text: event.text?.content?.trim(),
                });
              }
              socket.send(
                JSON.stringify({
                  code: 200,
                  headers: {
                    contentType: "application/json",
                    messageId: frame.headers.messageId,
                  },
                  message: "OK",
                  data: "{}",
                }),
              );
            }
          })().catch(fail);
        });
      });
      await sleep(3000);
    }
  })().catch(fail);
  return async (chat, text) => {
    const route = routes.get(chat);
    if (!route || route.expires <= Date.now())
      throw new Error(
        "DingTalk reply session expired. Send /status from your phone to renew it.",
      );
    await post(route.url, { msgtype: "text", text: { content: text } });
  };
}

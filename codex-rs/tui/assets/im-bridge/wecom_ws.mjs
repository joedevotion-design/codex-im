import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import { cleanups } from "./runtime.mjs";

const require = createRequire(import.meta.url);

export function loadWecomClient() {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const root of [
      join(directory, "node_modules"),
      join(directory, "..", "lib", "node_modules"),
    ]) {
      try {
        return require(join(root, "@wecom/aibot-node-sdk")).WSClient;
      } catch (error) {
        if (error.code !== "MODULE_NOT_FOUND") break;
      }
    }
  }
  throw new Error(
    "Install the official SDK: npm install -g @wecom/aibot-node-sdk@1.0.7",
  );
}

export function wecomSocket(
  receive,
  fail,
  { botId, secret, WSClient = loadWecomClient() },
) {
  if (!botId || !secret)
    throw new Error(
      "Set both CODEX_WECOM_BOT_ID and CODEX_WECOM_BOT_SECRET locally before starting Codex. Do not paste the Secret into chat.",
    );
  const quiet = () => {};
  const client = new WSClient({
    botId,
    secret,
    maxReconnectAttempts: 0,
    maxAuthFailureAttempts: 0,
    maxReplyQueueSize: 32,
    requestTimeout: 10_000,
    wsOptions: { maxPayload: 65_536 },
    logger: { debug: quiet, info: quiet, warn: quiet, error: quiet },
  });
  return new Promise((resolve, reject) => {
    let ready = false;
    let ended = false;
    const cleanup = () => {
      ended = true;
      clearTimeout(timer);
      client.disconnect();
    };
    const abort = (text) => {
      if (ended) return;
      cleanup();
      cleanups.delete(cleanup);
      const error = new Error(text);
      if (ready) fail(error);
      else reject(error);
    };
    const timer = setTimeout(
      () =>
        abort(
          "WeCom bot authentication timed out. Check API long-connection mode, Bot ID, Secret and network.",
        ),
      30_000,
    );
    cleanups.add(cleanup);
    client.on("error", () =>
      abort(
        "WeCom bot connection/authentication failed. Check API long-connection mode, Bot ID and Secret; use /wecom to reconnect.",
      ),
    );
    client.on("disconnected", () =>
      abort(
        "WeCom bot connection closed. Reconnect with /wecom; do not connect another client using the same bot.",
      ),
    );
    client.on("authenticated", () => {
      if (ended) return;
      ready = true;
      clearTimeout(timer);
      resolve(async (chat, text) => {
        if (ended) throw new Error("WeCom bot is disconnected");
        try {
          await client.sendMessage(chat, {
            msgtype: "markdown",
            markdown: { content: text },
          });
        } catch {
          throw new Error(
            "WeCom bot reply failed. Check the bot's messaging permissions and connection.",
          );
        }
      });
    });
    client.on("message.text", (frame) => {
      const body = frame.body;
      if (
        !ready ||
        ended ||
        body?.aibotid !== botId ||
        body.chattype !== "single" ||
        body.msgtype !== "text"
      )
        return;
      const message = {
        id: body.msgid,
        chat: body.from?.userid,
        sender: body.from?.userid,
        text: body.text?.content,
      };
      // Resolve startup before allowing an immediate callback to send a pairing reply.
      queueMicrotask(() => {
        if (!ended)
          Promise.resolve()
            .then(() => receive(message))
            .catch(() =>
              abort("WeCom message handling failed; reconnect with /wecom."),
            );
      });
    });
    try {
      client.connect();
    } catch {
      abort("Cannot start WeCom bot connection");
    }
  });
}

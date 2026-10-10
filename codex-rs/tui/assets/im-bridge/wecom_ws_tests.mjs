import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { wecomSocket } from "./wecom_ws.mjs";
import { cleanups, Pairing } from "./runtime.mjs";

class Client extends EventEmitter {
  static latest;
  constructor(options) {
    super();
    this.options = options;
    this.sent = [];
    Client.latest = this;
  }
  connect() {
    queueMicrotask(() => this.emit("authenticated"));
  }
  disconnect() {
    this.closed = true;
    this.emit("disconnected", "SECRET_REASON");
  }
  async sendMessage(chat, body) {
    this.sent.push({ chat, body });
  }
}

test("WeCom socket authenticates, restricts pairing to private messages, replies and cleans up", async () => {
  const pairing = new Pairing();
  const accepted = [];
  const errors = [];
  const send = await wecomSocket(
    (message) => {
      if (pairing.accept(message)) accepted.push(message.text);
    },
    (error) => errors.push(error.message),
    { botId: "bot", secret: "SECRET", WSClient: Client },
  );
  const client = Client.latest;
  try {
    const body = {
      aibotid: "bot",
      chattype: "single",
      msgtype: "text",
      from: { userid: "owner" },
      msgid: "pair",
      text: { content: `/pair ${pairing.code}` },
    };
    for (const variant of [
      { ...body, aibotid: "other" },
      { ...body, chattype: "group" },
      body,
      body,
      {
        ...body,
        msgid: "stranger",
        from: { userid: "other" },
        text: { content: "ignore" },
      },
      { ...body, msgid: "task", text: { content: "work" } },
    ])
      client.emit("message.text", { body: variant });
    await setImmediate();
    assert.deepEqual(accepted, [`/pair ${pairing.code}`, "work"]);
    await send("owner", "done");
    assert.deepEqual(client.sent, [
      {
        chat: "owner",
        body: { msgtype: "markdown", markdown: { content: "done" } },
      },
    ]);
    assert.deepEqual(errors, []);
  } finally {
    for (const cleanup of cleanups) cleanup();
    cleanups.clear();
  }
  assert.equal(client.closed, true);
  await assert.rejects(send("owner", "late"), /disconnected/);
});

test("WeCom socket authentication and send failures never expose secrets", async () => {
  class Rejected extends Client {
    connect() {
      queueMicrotask(() => this.emit("error", new Error("SECRET_AUTH")));
    }
  }
  await assert.rejects(
    wecomSocket(
      () => {},
      () => assert.fail("startup must reject"),
      { botId: "bot", secret: "SECRET", WSClient: Rejected },
    ),
    (error) => {
      assert.match(error.message, /authentication failed/);
      assert.doesNotMatch(error.message, /SECRET_AUTH/);
      return true;
    },
  );
  assert.equal(Rejected.latest.closed, true);
  assert.equal(cleanups.size, 0);
  class SendFailure extends Client {
    async sendMessage() {
      throw new Error("SECRET_REPLY");
    }
  }
  const errors = [];
  const send = await wecomSocket(
    () => {},
    (error) => errors.push(error.message),
    { botId: "bot", secret: "SECRET", WSClient: SendFailure },
  );
  await assert.rejects(
    send("owner", "hello"),
    /^Error: WeCom bot reply failed\./,
  );
  Client.latest.emit("disconnected", "SECRET_REASON");
  assert.deepEqual(errors, [
    "WeCom bot connection closed. Reconnect with /wecom; do not connect another client using the same bot.",
  ]);
  assert.equal(cleanups.size, 0);
});

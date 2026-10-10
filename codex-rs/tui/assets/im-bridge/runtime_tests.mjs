import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { Bridge, Pairing, cli, lines } from "./runtime.mjs";
import { larkMessage, unwrap } from "./providers.mjs";

test("pairing binds both sender and conversation, rejects replays and expires", () => {
  const pairing = new Pairing();
  const message = {
    id: "1",
    sender: "owner",
    chat: "private",
    text: `/pair ${pairing.code}`,
  };
  assert.equal(pairing.accept({ ...message, text: "run a command" }), false);
  assert.equal(pairing.accept({ ...message, id: "2" }), "paired");
  assert.equal(pairing.accept({ ...message, id: "2" }), false);
  assert.equal(
    pairing.accept({ ...message, id: "3", sender: "stranger" }),
    false,
  );
  assert.equal(pairing.accept({ ...message, id: "4", chat: "group" }), false);
  assert.equal(pairing.accept({ ...message, id: "5", text: "continue" }), true);
  const expired = new Pairing();
  expired.expires = 0;
  assert.equal(
    expired.accept({ ...message, text: `/pair ${expired.code}` }),
    false,
  );
});

test("phone prompts are data on the existing TUI transport, never a shell command", async () => {
  const emitted = [];
  const replies = [];
  const bridge = new Bridge(
    (value) => emitted.push(value),
    async (text) => replies.push(text),
  );
  await bridge.input("!echo $(secret)");
  await bridge.input("/status");
  await bridge.input("x".repeat(12001));
  assert.deepEqual(emitted, [
    { kind: "input", text: "!echo $(secret)" },
    { kind: "input", text: "/status" },
  ]);
  assert.deepEqual(replies, ["Send 1 to 12000 bytes of text."]);
});

test("approval replies target the exact pending server request, and cannot be replayed", async () => {
  const emitted = [];
  const replies = [];
  const bridge = new Bridge(
    (value) => emitted.push(value),
    async (text) => replies.push(text),
  );
  await bridge.receive({
    kind: "request",
    data: {
      id: "approval-9",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "t", command: "npm test" },
    },
  });
  await bridge.input("/approve 1");
  await bridge.input("/approve 1");
  assert.deepEqual(emitted, [
    { kind: "response", id: "approval-9", result: { decision: "accept" } },
  ]);
  assert.equal(replies.at(-1), "Unknown or expired request.");
});

test("terminal resolution invalidates phone approvals; unsupported requests stay local", async () => {
  const emitted = [];
  const replies = [];
  const bridge = new Bridge(
    (value) => emitted.push(value),
    async (text) => replies.push(text),
  );
  await bridge.receive({
    kind: "request",
    data: { id: 9, method: "item/fileChange/requestApproval", params: {} },
  });
  await bridge.receive({
    kind: "notification",
    data: { method: "serverRequest/resolved", params: { requestId: 9 } },
  });
  await bridge.input("/deny 1");
  await bridge.receive({
    kind: "request",
    data: { id: 10, method: "item/permissions/requestApproval", params: {} },
  });
  assert.deepEqual(emitted, []);
  assert.equal(
    replies.at(-1),
    "A permission/tool request needs your attention in the terminal.",
  );
});

test("question responses and completed answers use the same transport", async () => {
  const emitted = [];
  const replies = [];
  const bridge = new Bridge(
    (value) => emitted.push(value),
    async (text) => replies.push(text),
  );
  await bridge.receive({
    kind: "request",
    data: {
      id: 5,
      method: "item/tool/requestUserInput",
      params: { questions: [] },
    },
  });
  await assert.rejects(bridge.input("/answer 1 not-json"));
  await bridge.input('/answer 1 {"q":{"answers":["yes"]}}');
  await bridge.receive({
    kind: "notification",
    data: {
      method: "item/completed",
      params: { item: { type: "agentMessage", text: "Done" } },
    },
  });
  assert.deepEqual(emitted, [
    {
      kind: "response",
      id: 5,
      result: { answers: { q: { answers: ["yes"] } } },
    },
  ]);
  assert.equal(replies.at(-1), "Done");
});

test("NDJSON handles fragmented UTF-8 and rejects oversized events", () => {
  const stream = new PassThrough();
  const received = [];
  const errors = [];
  lines(
    stream,
    (value) => received.push(value),
    (error) => errors.push(error.message),
  );
  const input = Buffer.from('{"text":"\u4f60\u597d"}\n');
  stream.write(input.subarray(0, 11));
  stream.write(input.subarray(11));
  assert.deepEqual(received, [{ text: "\u4f60\u597d" }]);
  stream.write("x".repeat(2 * 1024 * 1024 + 1));
  assert.deepEqual(errors, ["Oversized event"]);
});

test("provider schemas normalize human messages but ignore bot replies", () => {
  const event = {
    message_id: "m",
    chat_id: "c",
    sender_id: "u",
    content: "hello",
    sender_type: "user",
    message_type: "text",
  };
  assert.deepEqual(larkMessage(event), {
    id: "m",
    chat: "c",
    sender: "u",
    text: "hello",
  });
  assert.equal(larkMessage({ ...event, sender_type: "bot" }), null);
  assert.deepEqual(unwrap({ content: { result: { clientId: "id" } } }), {
    clientId: "id",
  });
  assert.deepEqual(unwrap({ data: { sessions: [] } }), { sessions: [] });
});

test("CLI arguments preserve Unicode and shell metacharacters on Windows shims", async () => {
  const text = "\u4f60\u597d ' $(throw 'injected') ` & | \" ;\nnext line";
  const result = await cli("node", [
    "-e",
    "process.stdout.write(JSON.stringify({text:process.argv[1]}))",
    text,
  ]);
  assert.deepEqual(result, { text });
});

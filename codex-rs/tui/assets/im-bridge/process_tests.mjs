import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

test(
  "WeCom rejects unavailable chat access before pairing without leaking API details",
  { timeout: 15_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-im-wecom-test-"));
    let child;
    let closed;
    try {
      for (const name of [
        "main.mjs",
        "runtime.mjs",
        "providers.mjs",
        "wecom_ws.mjs",
      ])
        await copyFile(new URL(name, import.meta.url), join(root, name));
      await writeFile(join(root, "connection.json"), "{}");
      const fixture = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.join(' ') === 'message aibot sessions list') {
  console.log(JSON.stringify({sessions:[{chat_id:'owner'}]}));
} else if (args.slice(0,3).join(' ') === 'chat messages list') {
  console.log(JSON.stringify({errcode:853006,errmsg:'SECRET_API_DETAIL',extra_identity_context:'SECRET_IDENTITY'}));
  console.error('SECRET_STDERR');
  process.exitCode = 1;
} else {
  process.exitCode = 2;
}
`;
      const packageRoot = join(root, "node_modules", "@wecom", "cli");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({ bin: { "wecom-cli": "fake.mjs" } }),
      );
      await writeFile(join(packageRoot, "fake.mjs"), fixture);
      await writeFile(join(root, "wecom-cli"), fixture, { mode: 0o755 });
      const env = {
        ...process.env,
        CODEX_WECOM_TRANSPORT: "cli",
        PATH: `${root}${delimiter}${process.env.PATH}`,
      };
      delete env.CODEX_WECOM_BOT_ID;
      delete env.CODEX_WECOM_BOT_SECRET;
      child = spawn(
        process.execPath,
        [join(root, "main.mjs"), "wecom", "run"],
        {
          windowsHide: true,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      closed = once(child, "close");
      let output = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      assert.deepEqual(await closed, [1, null]);
      const messages = output.trim().split("\n").map(JSON.parse);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].kind, "status");
      assert.match(messages[0].text, /853006.*corporation cannot use/);
      assert.match(messages[0].text, /chat\.messages\.list/);
      assert.doesNotMatch(output + stderr, /SECRET_|\/pair /);
    } finally {
      if (child && child.exitCode === null) {
        child.stdin.end();
        await closed;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "bridge process pairs, routes literal input, replies, and exits on disconnect",
  { timeout: 20_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-im-test-"));
    let child;
    let closed;
    try {
      for (const name of [
        "main.mjs",
        "runtime.mjs",
        "providers.mjs",
        "wecom_ws.mjs",
      ])
        await copyFile(new URL(name, import.meta.url), join(root, name));
      await writeFile(join(root, "connection.json"), "{}");
      const events = join(root, "events.ndjson");
      const replies = join(root, "replies.ndjson");
      await writeFile(events, "");
      await writeFile(replies, "");
      const fixture = `#!/usr/bin/env node
import { readFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'event') {
  let offset = 0;
  setInterval(() => {
    const data = readFileSync(process.env.IM_TEST_EVENTS, 'utf8');
    process.stdout.write(data.slice(offset));
    offset = data.length;
  }, 20);
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
} else {
  appendFileSync(process.env.IM_TEST_REPLIES, JSON.stringify(args) + '\\n');
  console.log('{}');
}
`;
      const packageRoot = join(root, "node_modules", "@larksuite", "cli");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({ bin: { "lark-cli": "fake.mjs" } }),
      );
      await writeFile(join(packageRoot, "fake.mjs"), fixture);
      // Unix resolves the executable; Windows resolves the npm package entrypoint.
      await writeFile(join(root, "lark-cli"), fixture, { mode: 0o755 });
      const messages = [];
      child = spawn(process.execPath, [join(root, "main.mjs"), "lark", "run"], {
        windowsHide: true,
        env: {
          ...process.env,
          PATH: `${root}${delimiter}${process.env.PATH}`,
          IM_TEST_EVENTS: events,
          IM_TEST_REPLIES: replies,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      closed = once(child, "close");
      child.stderr.resume();
      const reader = createInterface({ input: child.stdout });
      reader.on("line", (line) => messages.push(JSON.parse(line)));
      const until = async (predicate) => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const value = await predicate();
          if (value) return value;
          assert.equal(
            child.exitCode,
            null,
            "bridge exited before completing the exchange",
          );
          await sleep(20);
        }
        assert.fail("bridge exchange timed out");
      };
      const prompt = await until(() =>
        messages.find((message) => message.text?.includes("/pair ")),
      );
      const code = prompt.text.match(/\/pair ([a-f0-9]{32})/)[1];
      const event = {
        sender_type: "user",
        message_type: "text",
        sender_id: "owner",
        chat_id: "private",
      };
      await appendFile(
        events,
        JSON.stringify({
          ...event,
          message_id: "pair",
          content: `/pair ${code}`,
        }) + "\n",
      );
      await until(() =>
        messages.find((message) => message.text?.startsWith("Phone paired")),
      );
      const text = "!echo \u4f60\u597d & $(not-a-shell-command)";
      const input = { ...event, message_id: "task", content: text };
      await appendFile(
        events,
        [
          { ...input, message_id: "intruder", sender_id: "stranger" },
          input,
          input,
        ]
          .map(JSON.stringify)
          .join("\n") + "\n",
      );
      await until(() => messages.find((message) => message.kind === "input"));
      child.stdin.write(
        JSON.stringify({
          kind: "notification",
          data: {
            method: "item/completed",
            params: { item: { type: "agentMessage", text: "Task completed" } },
          },
        }) + "\n",
      );
      await until(async () =>
        (await readFile(replies, "utf8")).includes("Task completed"),
      );
      assert.deepEqual(
        messages.filter((message) => message.kind === "input"),
        [{ kind: "input", text }],
      );
      const sent = (await readFile(replies, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.deepEqual(sent.at(-1), [
        "im",
        "+messages-send",
        "--as",
        "bot",
        "--chat-id",
        "private",
        "--text",
        "Task completed",
      ]);
      child.stdin.end();
      assert.deepEqual(await closed, [0, null]);
    } finally {
      if (child && child.exitCode === null) {
        child.stdin.end();
        await closed;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

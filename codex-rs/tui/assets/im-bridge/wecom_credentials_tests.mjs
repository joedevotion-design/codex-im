import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, copyFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { loadWecomCredentials, wecomTransport } from "./wecom_ws.mjs";

test("WeCom defaults to long connection and requires explicit legacy selection", () => {
  assert.equal(wecomTransport({}), "websocket");
  assert.equal(wecomTransport({ CODEX_WECOM_TRANSPORT: "cli" }), "cli");
  assert.throws(() => wecomTransport({ CODEX_WECOM_TRANSPORT: "invalid" }));
});

test("explicit credentials take priority and partial values fail closed", async () => {
  assert.deepEqual(await loadWecomCredentials({ env: {
    CODEX_WECOM_BOT_ID: " bot ", CODEX_WECOM_BOT_SECRET: "secret",
  } }), { botId: "bot", secret: "secret" });
  await assert.rejects(loadWecomCredentials({ env: { CODEX_WECOM_BOT_ID: "bot" } }), /Set both/);
});

test("saved credential reader uses bounded hidden process and sanitizes failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "wecom-credentials-"));
  try {
    await writeFile(join(root, "wecom-bot.credential.xml"), "fixture");
    const options = { env: { CODEX_HOME: root }, platform: "win32" };
    assert.deepEqual(await loadWecomCredentials({ ...options,
      readCredential: async (command, args, settings) => {
        assert.ok(command.endsWith("powershell.exe"));
        assert.ok(args.includes("-NonInteractive"));
        assert.equal(settings.windowsHide, true);
        assert.equal(settings.timeout, 10_000);
        assert.equal(settings.maxBuffer, 16_384);
        assert.equal(settings.env.CODEX_WECOM_CREDENTIAL_PATH, join(root, "wecom-bot.credential.xml"));
        return { stdout: '\uFEFF{"botId":"saved","secret":"saved-secret"}' };
      },
    }), { botId: "saved", secret: "saved-secret" });
    await assert.rejects(loadWecomCredentials({ ...options,
      readCredential: async () => { throw new Error("DO_NOT_DISCLOSE"); },
    }), (error) => /Cannot read saved/.test(error.message) && !error.message.includes("DO_NOT_DISCLOSE"));
    await assert.rejects(loadWecomCredentials({ ...options,
      readCredential: async () => ({ stdout: '{"botId":4,"secret":"DO_NOT_DISCLOSE"}' }),
    }), /Cannot read saved/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows encrypted credentials load without credential environment variables", {
  skip: process.platform !== "win32",
  timeout: 20_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "wecom-dpapi-"));
  try {
    const env = { ...process.env, CODEX_HOME: root };
    delete env.PSModulePath;
    delete env.CODEX_WECOM_BOT_ID;
    delete env.CODEX_WECOM_BOT_SECRET;
    delete env.CODEX_WECOM_TRANSPORT;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; $s=ConvertTo-SecureString 'test-secret' -AsPlainText -Force; [System.Management.Automation.PSCredential]::new('test-bot',$s) | Export-Clixml -LiteralPath (Join-Path $env:CODEX_HOME 'wecom-bot.credential.xml')"],
      { env, windowsHide: true, timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr?.toString());
    assert.deepEqual(await loadWecomCredentials({ env }), { botId: "test-bot", secret: "test-secret" });
    for (const name of ["main.mjs", "providers.mjs", "runtime.mjs", "wecom_ws.mjs"])
      await copyFile(new URL(name, import.meta.url), join(root, name));
    const sdk = join(root, "node_modules", "@wecom", "aibot-node-sdk");
    await mkdir(sdk, { recursive: true });
    await writeFile(join(sdk, "index.js"), `
const {EventEmitter} = require('node:events');
exports.WSClient = class extends EventEmitter {
  constructor(options) {
    super();
    if (options.botId !== 'test-bot' || options.secret !== 'test-secret') throw new Error('Wrong credentials');
  }
  connect() { queueMicrotask(() => this.emit('authenticated')); }
  disconnect() {}
};
`);
    env.PATH = `${root}${delimiter}${env.PATH}`;
    const setup = spawnSync(process.execPath, [join(root, "main.mjs"), "wecom", "setup"],
      { env, encoding: "utf8", windowsHide: true, timeout: 10_000 });
    assert.equal(setup.status, 0, setup.stderr);
    assert.equal(setup.stdout, "");
    assert.equal(await readFile(join(root, "connection.json"), "utf8"), "{}");
    const child = spawn(process.execPath, [join(root, "main.mjs"), "wecom", "run"],
      { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const closed = once(child, "close");
    let output = "";
    let stderr = "";
    const timer = setTimeout(() => child.stdin.end(), 10_000);
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdout.on("data", chunk => {
      output += chunk;
      if (output.includes("/pair ")) child.stdin.end();
    });
    try {
      assert.deepEqual(await closed, [0, null]);
      assert.match(output, /WeCom API long connection authenticated/);
      assert.match(output, /\/pair [a-f0-9]{32}/);
      assert.doesNotMatch(output + stderr, /test-secret/);
    } finally { clearTimeout(timer); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setup with missing credentials reports configuration error without prompting for QR", async () => {
  const root = await mkdtemp(join(tmpdir(), "wecom-setup-"));
  try {
    const env = { ...process.env, CODEX_HOME: root };
    delete env.CODEX_WECOM_BOT_ID;
    delete env.CODEX_WECOM_BOT_SECRET;
    delete env.CODEX_WECOM_TRANSPORT;
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("main.mjs", import.meta.url)), "wecom", "setup",
    ], { env, encoding: "utf8", windowsHide: true, timeout: 10_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires an API long-connection bot/);
    assert.equal(result.stdout, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

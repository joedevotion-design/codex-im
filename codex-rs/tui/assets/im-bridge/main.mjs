import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { Bridge, Pairing, children, cleanups, cli, lines } from "./runtime.mjs";
import { loadWecomClient, loadWecomCredentials, wecomTransport } from "./wecom_ws.mjs";
import { lark, wecom, dingtalk } from "./providers.mjs";

const [provider, mode] = process.argv.slice(2);
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const cleanup of cleanups) cleanup();
  for (const child of children) {
    if (!child.pid) continue;
    if (process.platform === "win32")
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    else child.kill("SIGTERM");
  }
  process.exit(code);
}
function fail(error) {
  if (!stopping) {
    if (mode === "run") emit({ kind: "status", text: `IM: ${error.message}` });
    else console.error(error.message);
    stop(1);
  }
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

try {
  if (Number(process.versions.node.split(".")[0]) < 22)
    throw new Error("The IM bridge needs Node.js 22 or later.");
  if (!["lark", "wecom", "dingtalk"].includes(provider))
    throw new Error("Unknown IM provider");
  const settings = new URL("./connection.json", import.meta.url);
  if (mode === "setup") {
    if (
      provider === "wecom" &&
      wecomTransport() === "websocket"
    ) {
      await loadWecomCredentials();
      loadWecomClient();
      writeFileSync(settings, "{}", { mode: 0o600 });
      stop();
    }
    console.log(`Connect ${provider} to the current Codex conversation.`);
    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const login = await terminal.question("Run QR/browser login? [y/N] ");
    terminal.close();
    if (login.toLowerCase() === "y") {
      if (provider === "lark") {
        await cli("lark-cli", ["config", "init"], true);
        await cli("lark-cli", ["auth", "login", "--recommend"], true);
      } else if (provider === "wecom")
        await cli("wecom-cli", ["auth", "init", "--noninteractive"], true);
      else await cli("dws", ["auth", "login", "--format", "json"], true);
    }
    let appId;
    if (provider === "dingtalk") {
      const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      appId = (
        await prompt.question(
          "Stream-enabled robot unifiedAppId (from dws dev app robot result): ",
        )
      ).trim();
      prompt.close();
      if (!appId) throw new Error("An existing DingTalk robot is required.");
    }
    writeFileSync(settings, JSON.stringify({ appId }), { mode: 0o600 });
    stop();
  }
  const { appId } = JSON.parse(readFileSync(settings, "utf8"));
  const pairing = new Pairing();
  let sendRaw;
  let outbound = Promise.resolve();
  let queued = 0;
  const send = (text) => {
    if (!pairing.owner || !text) return Promise.resolve();
    if (++queued > 32) throw new Error("IM output queue is full");
    outbound = outbound
      .then(async () => {
        const characters = Array.from(String(text).slice(0, 60_000));
        for (let offset = 0; offset < characters.length; offset += 700)
          await sendRaw(
            pairing.owner.chat,
            characters.slice(offset, offset + 700).join(""),
          );
      })
      .finally(() => queued--);
    return outbound;
  };
  const bridge = new Bridge(emit, send);
  const receive = async (message) => {
    const accepted = pairing.accept(message);
    if (!accepted) return;
    if (accepted === "paired") {
      emit({
        kind: "status",
        text: "Phone paired to this conversation. Run the IM slash command again to disconnect.",
      });
      await send(
        "Connected to the current Codex conversation. Send a task, /status or /stop. Approvals will appear here.",
      );
    } else {
      try {
        await bridge.input(message.text.trim());
      } catch (error) {
        await send(`Request failed: ${error.message}`);
      }
    }
  };
  process.stdin.on("end", () => stop());
  lines(process.stdin, (message) => bridge.receive(message), fail);
  sendRaw = await { lark, wecom, dingtalk }[provider](receive, fail, appId);
  if (provider === "wecom" && wecomTransport() === "websocket")
    emit({ kind: "status", text: "WeCom API long connection authenticated. Chat-history access is not used." });
  emit({
    kind: "status",
    text: `Within five minutes, send this exact message to your bot in a private chat:\n/pair ${pairing.code}`,
  });
  setTimeout(() => {
    if (!pairing.owner)
      fail(new Error("Pairing expired. Reconnect for a fresh code."));
  }, 300_000).unref();
} catch (error) {
  fail(error);
}

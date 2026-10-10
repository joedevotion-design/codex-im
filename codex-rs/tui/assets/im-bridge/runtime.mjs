import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

export const children = new Set();
export const cleanups = new Set();
export function launch(program, args, options = {}) {
  if (program === "node") program = process.execPath;
  // Invoke npm entrypoints with Node directly; cmd/PowerShell can alter JSON arguments.
  if (
    process.platform === "win32" &&
    ["lark-cli", "wecom-cli"].includes(program)
  ) {
    const packageName =
      program === "lark-cli" ? "@larksuite/cli" : "@wecom/cli";
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      if (existsSync(join(directory, `${program}.exe`))) {
        program = join(directory, `${program}.exe`);
        break;
      }
      const root = join(directory, "node_modules", packageName);
      if (!existsSync(join(root, "package.json"))) continue;
      const manifest = JSON.parse(
        readFileSync(join(root, "package.json"), "utf8"),
      );
      const entry =
        typeof manifest.bin === "string"
          ? manifest.bin
          : manifest.bin?.[program];
      if (!entry) continue;
      args = [resolve(root, entry), ...args];
      program = process.execPath;
      break;
    }
  }
  const child = spawn(program, args, { windowsHide: true, ...options });
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}

export async function cli(program, args, interactive = false) {
  const child = launch(program, args, {
    stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let length = 0;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    length += Buffer.byteLength(chunk);
    if (length > 2 * 1024 * 1024) child.kill();
    else output += chunk;
  });
  // CLI errors can contain credentials. Report the command and exit status only.
  child.stderr?.resume();
  const timer = setTimeout(() => child.kill(), interactive ? 360_000 : 30_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", () =>
        reject(
          new Error(
            `Cannot launch ${program}; install its official CLI first.`,
          ),
        ),
      );
      child.once("close", resolve);
    });
    const failure = new Error(
      `${program} failed (${code ?? "timeout"}). Check its login and permissions.`,
    );
    if (length > 2 * 1024 * 1024) throw failure;
    if (interactive) {
      if (code !== 0) throw failure;
      return;
    }
    let result;
    try {
      result = JSON.parse(output);
    } catch {
      throw failure;
    }
    // Do not expose API messages, stderr or identity metadata: they may contain secrets.
    const apiCode = result?.errcode ?? result?.code;
    if (program === "wecom-cli" && String(apiCode) === "853006") {
      throw new Error(
        "WeCom API error 853006: this corporation cannot use the requested tool. " +
          "QR authorization does not grant chat.messages.list access. " +
          "Use an API long-connection bot with CODEX_WECOM_BOT_ID and CODEX_WECOM_BOT_SECRET, or ask your administrator about API availability. " +
          "Repeating QR login alone will not enable it.",
      );
    }
    if (code !== 0 || result?.error || (apiCode && String(apiCode) !== "0")) {
      const detail = /^\d{1,10}$/.test(String(apiCode)) ? ` ${apiCode}` : "";
      throw new Error(
        `${program} failed (${code ?? "timeout"}); API error${detail}. Check its login and permissions.`,
      );
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export function lines(stream, receive, fail) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    if (Buffer.byteLength(pending) > 2 * 1024 * 1024) {
      stream.destroy();
      fail(new Error("Oversized event"));
      return;
    }
    let index;
    while ((index = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (!line.trim()) continue;
      try {
        Promise.resolve(receive(JSON.parse(line))).catch(fail);
      } catch (error) {
        fail(error);
      }
    }
  });
}

export class Bridge {
  constructor(emit, send) {
    this.emit = emit;
    this.send = send;
    this.approvals = new Map();
    this.serial = 0;
  }
  async receive(envelope) {
    if (envelope.kind === "text") return this.send(envelope.text);
    const message = envelope.data;
    if (!message) return;
    const p = message.params ?? {};
    if (envelope.kind === "request") {
      if (this.approvals.size >= 16) return;
      const supported = [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/tool/requestUserInput",
      ];
      if (!supported.includes(message.method)) {
        await this.send(
          "A permission/tool request needs your attention in the terminal.",
        );
        return;
      }
      const detail = JSON.stringify(p);
      if (detail.length > 6000)
        return this.send(
          "This request is too large to review on IM. Review it in the terminal.",
        );
      const key = String(++this.serial);
      this.approvals.set(key, message);
      await this.send(
        `${message.method}\n${detail}\n${
          message.method.endsWith("requestUserInput")
            ? `/answer ${key} {"question_id":{"answers":["your answer"]}}`
            : `/approve ${key} or /deny ${key}`
        }`,
      );
      return;
    }
    if (message.method === "item/completed" && p.item?.type === "agentMessage")
      await this.send(p.item.text);
    if (message.method === "serverRequest/resolved") {
      for (const [key, request] of this.approvals)
        if (request.id === p.requestId) this.approvals.delete(key);
    }
    if (message.method === "turn/completed") {
      this.approvals.clear();
      await this.send(
        `Turn ${p.turn.status}.${p.turn.error ? " " + p.turn.error.message : ""}`,
      );
    }
  }
  async input(text) {
    const [command, key, ...rest] = text.split(/\s+/);
    if (["/approve", "/deny", "/answer"].includes(command)) {
      const request = this.approvals.get(key);
      if (!request) return this.send("Unknown or expired request.");
      const question = request.method.endsWith("requestUserInput");
      if (question !== (command === "/answer"))
        return this.send("Use the command shown with the request.");
      const result = question
        ? { answers: JSON.parse(rest.join(" ")) }
        : { decision: command === "/approve" ? "accept" : "decline" };
      this.emit({ kind: "response", id: request.id, result });
      this.approvals.delete(key);
      return;
    }
    if (!text.trim() || Buffer.byteLength(text) > 12_000)
      return this.send("Send 1 to 12000 bytes of text.");
    this.emit({ kind: "input", text });
  }
}

export class Pairing {
  constructor() {
    this.code = randomBytes(16).toString("hex");
    this.expires = Date.now() + 300_000;
    this.owner = null;
    this.seen = new Set();
  }
  accept(message) {
    if (
      ![message.id, message.sender, message.chat].every(
        (value) =>
          typeof value === "string" && value.length > 0 && value.length <= 2048,
      ) ||
      typeof message.text !== "string" ||
      Buffer.byteLength(message.text) > 12_000
    )
      return false;
    if (
      this.owner &&
      (message.sender !== this.owner.sender || message.chat !== this.owner.chat)
    )
      return false;
    if (
      !this.owner &&
      (Date.now() > this.expires ||
        message.text.trim() !== `/pair ${this.code}`)
    )
      return false;
    if (this.seen.has(message.id)) return false;
    this.seen.add(message.id);
    if (this.seen.size > 4096)
      this.seen.delete(this.seen.values().next().value);
    if (!this.owner) {
      this.owner = { sender: message.sender, chat: message.chat };
      return "paired";
    }
    return true;
  }
}

# IM transport

`/lark`, `/dingtalk`, and `/wecom` connect the currently displayed TUI thread.
Running an IM command again disconnects the active bridge. Only one bridge is
active per TUI. The terminal must stay open; this is not a background daemon.

Install Node.js 22+ and the corresponding official CLI on the TUI machine:

- Feishu/Lark: `@larksuite/cli`. Enable bot messaging and the
  `im.message.receive_v1` event in the app's developer console.
- DingTalk: `dws` from DingTalk-Real-AI/dingtalk-workspace-cli. An existing robot
  with Stream enabled and its `unifiedAppId` are required. Creating an app may
  require administrator/developer permission.
- WeCom: `@wecom/aibot-node-sdk@1.0.7` for API long-connection bots (see below),
  or `@wecom/cli` for legacy polling via `message aibot` and `chat messages`.

The setup prompt optionally runs official QR/browser login. Credentials remain
owned by those CLIs. A fresh five-minute pairing code appears in the TUI. Send
the complete `/pair CODE` message to the bot. Only that sender in that chat can
then control this connection. Disconnecting invalidates the pairing.

Phone commands: `/status`, `/stop`, `/approve ID`, `/deny ID`, and
`/answer ID {"question_id":{"answers":["answer"]}}`. Ordinary text is submitted
as a literal user message, including text starting with `!`. Current sandbox,
model and approval settings are preserved. Tool-specific permissions and MCP
elicitation that cannot be represented here remain in the terminal.

The phone receives completed assistant messages and turn completion status;
token deltas, tool output and historical messages are not mirrored. Text only
is supported. Switch the terminal back to the bound thread to resume phone
input after navigating away. A terminal popup must be closed before sending a
new task. Existing terminal drafts are retained.

Lark consumes CLI NDJSON events. DingTalk obtains credentials through `dws`
and connects to the official Stream gateway; reply webhooks expire, so send
`/status` from the phone to refresh the reply route during very long tasks.
WeCom's legacy CLI mode polls up to 20 recent bot conversations every three seconds, with bounded
pagination and overlapping windows. Its API has no stable message ID, so
deduplication uses sender, timestamp, content and occurrence. This is not an
exactly-once transport; avoid sending identical commands within one second.
Transport failure disconnects visibly; reconnect with the slash command.

WeCom QR authorization alone does not guarantee access to `chat messages list`.
If the API returns `853006`, the corporation cannot use that tool. The bridge
checks existing bot conversations before displaying a pairing code and reports
this restriction without exposing API identity metadata or credentials. Ask
your administrator/WeCom support about API availability; repeated QR login is
not a fix. Use the official bot WebSocket transport instead when an API
long-connection bot is available.

### WeCom Bot WebSocket

Install `npm install -g @wecom/aibot-node-sdk@1.0.7`. Create an API
long-connection intelligent bot in WeCom and configure its credentials locally
in the same PowerShell session that will launch Codex:

```powershell
$env:CODEX_WECOM_BOT_ID = Read-Host 'Bot ID'
$secret = Read-Host 'Bot Secret' -AsSecureString
$env:CODEX_WECOM_BOT_SECRET = [System.Net.NetworkCredential]::new('', $secret).Password
```

Then start Codex and enter `/wecom`. Both variables must be set. This mode skips
CLI QR login and waits for WebSocket authentication before showing the pairing
code. Send the code in a private chat with that bot. The existing sender binding,
deduplication, approval routing and current-terminal conversation still apply.
No chat-history access or CLI credentials are required. Only text in private
chats is accepted. Use a dedicated bot: another connection using the same bot
may disconnect this one. Connection failure requires a fresh `/wecom` connection
and pairing; it does not silently fall back to polling.

The Secret is inherited by the local bridge process, not written to connection
files or printed. Do not paste it into a Codex/IM conversation. Remove the two
environment variables after exiting Codex if the shell is shared.

The runtime modules are embedded in the Rust executable and extracted
to a temporary directory per connection. Bazel includes them via the existing
`assets/**` compile-data glob. The WeCom WebSocket mode loads the official SDK
from the global npm installation associated with a directory on `PATH`.

Tests (from the repo root):

```sh
node --test codex-rs/tui/assets/im-bridge/runtime_tests.mjs codex-rs/tui/assets/im-bridge/process_tests.mjs codex-rs/tui/assets/im-bridge/wecom_ws_tests.mjs codex-rs/tui/assets/im-bridge/wecom_sdk_tests.mjs
just test -p codex-tui
```

The subprocess test uses a fake Lark CLI to exercise pairing, input routing,
reply delivery and disconnect cleanup. It does not validate a real bot's
credentials, permissions or event subscription. The SDK integration test uses
the installed official SDK against a local WebSocket server to check wire-level
authentication and message delivery; it is skipped when that SDK is absent.

For platform prerequisites and build commands, see the
[repository build guide](../../../../README.md#build).

Keep the generated helper executables beside `codex.exe`. Building only the
TUI or CLI does not build the standalone code-mode host needed by some models
to execute tools. Select a model available to your account with `-m MODEL` if
your saved default is rejected by the service.

Terminal color snapshots require ANSI colors. If the test runner injects
`NO_COLOR=1`, clear it in the test process rather than accepting colorless
snapshot changes.

Live verification requires a real bot: start a terminal conversation, connect
with `/lark`, pair from the phone, and ask about something already said in that
terminal conversation. Confirm the phone's prompt and the assistant's answer
also appear in the terminal. A successful CLI login alone is not an end-to-end
check.

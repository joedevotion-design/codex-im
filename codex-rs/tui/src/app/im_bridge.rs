//! IM lifecycle and routing to the thread selected at connection time.

use super::App;
use crate::app_event::AppEvent;
use crate::app_server_session::AppServerSession;
use crate::slash_command::SlashCommand;
use crate::tui::TerminalHandoff;
use crate::tui::Tui;
use codex_app_server_protocol::RequestId;
use codex_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;
use std::collections::HashSet;
use std::process::Stdio;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;

pub(super) struct ImBridge {
    thread: ThreadId,
    generation: uuid::Uuid,
    outgoing: tokio::sync::mpsc::Sender<Value>,
    requests: HashSet<RequestId>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for ImBridge {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[cfg(test)]
#[path = "im_bridge_tests.rs"]
mod tests;

impl App {
    pub(super) async fn connect_im(&mut self, tui: &mut Tui, provider: SlashCommand) {
        if self.im_bridge.take().is_some() {
            self.chat_widget
                .add_info_message("IM disconnected.".into(), /*hint*/ None);
            return;
        }
        if self.chat_widget.is_user_turn_pending_or_running() {
            self.chat_widget
                .add_error_message("Wait for the current turn before connecting IM.".into());
            return;
        }
        let result: anyhow::Result<()> = async {
            let thread = self
                .current_displayed_thread_id()
                .ok_or_else(|| anyhow::anyhow!("No active thread"))?;
            anyhow::ensure!(
                !self.reconnect.offline
                    && !self.thread_unavailable(thread)
                    && !self.chat_widget.is_external_writer_view(),
                "The current thread is unavailable"
            );
            let node = which::which("node")?;
            let directory = tempfile::tempdir()?;
            for (name, source) in [
                ("main.mjs", include_str!("../../assets/im-bridge/main.mjs")),
                (
                    "wecom_ws.mjs",
                    include_str!("../../assets/im-bridge/wecom_ws.mjs"),
                ),
                (
                    "runtime.mjs",
                    include_str!("../../assets/im-bridge/runtime.mjs"),
                ),
                (
                    "providers.mjs",
                    include_str!("../../assets/im-bridge/providers.mjs"),
                ),
            ] {
                std::fs::write(directory.path().join(name), source)?;
            }
            let script = directory.path().join("main.mjs");
            let mut setup = tokio::process::Command::new(&node);
            setup
                .arg(&script)
                .arg(provider.command())
                .arg("setup")
                .current_dir(&self.launch_cwd)
                .kill_on_drop(/*kill_on_drop*/ true);
            let status = tui
                .with_restored(TerminalHandoff::Restore, || async {
                    crossterm::terminal::disable_raw_mode()?;
                    setup.status().await
                })
                .await?;
            anyhow::ensure!(status.success(), "IM login/setup exited with {status}");
            let mut child = tokio::process::Command::new(node)
                .arg(script)
                .arg(provider.command())
                .arg("run")
                .current_dir(&self.launch_cwd)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()?;
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| anyhow::anyhow!("Missing bridge stdin"))?;
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| anyhow::anyhow!("Missing bridge stdout"))?;
            let (outgoing, mut receiver) = tokio::sync::mpsc::channel::<Value>(/*buffer*/ 32);
            let tx = self.app_event_tx.clone();
            let generation = uuid::Uuid::new_v4();
            // Closing stdin triggers transport cleanup; the supervisor then reaps the child.
            tokio::spawn(async move {
                while let Some(message) = receiver.recv().await {
                    if stdin
                        .write_all(format!("{message}\n").as_bytes())
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                drop(stdin);
                let _ = child.wait().await;
                drop(directory);
            });
            let task = tokio::spawn(async move {
                let mut reader = tokio::io::BufReader::new(stdout);
                loop {
                    let mut line = String::new();
                    let read = (&mut reader)
                        .take(/*limit*/ 16_385)
                        .read_line(&mut line)
                        .await;
                    if !matches!(read, Ok(1..=16_384)) {
                        break;
                    }
                    let Ok(message) = serde_json::from_str(&line) else {
                        break;
                    };
                    tx.send(AppEvent::ImMessage {
                        generation,
                        message,
                    });
                }
                tx.send(AppEvent::ImMessage {
                    generation,
                    message: json!({"kind":"closed"}),
                });
            });
            self.im_bridge = Some(ImBridge {
                thread,
                generation,
                outgoing,
                requests: HashSet::new(),
                task,
            });
            Ok(())
        }
        .await;
        if let Err(error) = result {
            self.chat_widget
                .add_error_message(format!("IM connection failed: {error}"));
        }
        tui.frame_requester().schedule_frame();
    }

    pub(super) fn im_event(&mut self, kind: &str, data: Value) {
        let Some(bridge) = self.im_bridge.as_mut() else {
            return;
        };
        if data["params"]["threadId"].as_str() != Some(bridge.thread.to_string().as_str()) {
            return;
        }
        if kind == "notification"
            && !matches!(
                data["method"].as_str(),
                Some("turn/completed" | "serverRequest/resolved")
            )
            && !(data["method"] == "item/completed"
                && data["params"]["item"]["type"] == "agentMessage")
        {
            return;
        }
        if kind == "request" {
            if bridge.requests.len() >= 16 {
                return;
            }
            if let Ok(id) = serde_json::from_value::<RequestId>(data["id"].clone()) {
                bridge.requests.insert(id);
            }
        }
        if data["method"] == "serverRequest/resolved"
            && let Ok(id) = serde_json::from_value::<RequestId>(data["params"]["requestId"].clone())
        {
            bridge.requests.remove(&id);
        }
        if bridge
            .outgoing
            .try_send(json!({"kind":kind,"data":data}))
            .is_err()
        {
            self.im_bridge = None;
            self.chat_widget
                .add_error_message("IM disconnected: output queue overflow.".into());
        }
    }

    pub(super) async fn im_message(
        &mut self,
        server: &mut AppServerSession,
        generation: uuid::Uuid,
        message: Value,
    ) {
        let Some(bridge) = self
            .im_bridge
            .as_ref()
            .filter(|bridge| bridge.generation == generation)
        else {
            return;
        };
        let thread = bridge.thread;
        let send = bridge.outgoing.clone();
        let text = message["text"].as_str().unwrap_or_default();
        let result: anyhow::Result<()> = async {
            match message["kind"].as_str() {
                Some("status") => self.chat_widget.add_info_message(text.to_string(), /*hint*/ None),
                Some("closed") => {
                    self.im_bridge = None;
                    self.chat_widget.add_error_message("IM connection closed.".into());
                }
                Some("input") if self.reconnect.offline || self.current_displayed_thread_id() != Some(thread) || self.thread_unavailable(thread) || self.chat_widget.is_external_writer_view() => {
                    anyhow::bail!("Switch the terminal back to the connected thread before sending commands.");
                }
                Some("input") => match text {
                    "/status" => { let _ = send.try_send(json!({"kind":"text","text":format!("Thread: {thread}\nWorking: {}", self.chat_widget.is_user_turn_pending_or_running())})); }
                    "/stop" => {
                        server.turn_interrupt(thread, String::new()).await?;
                        let _ = send.try_send(json!({"kind":"text","text":"Stop requested."}));
                    }
                    _ if text.starts_with('/') => anyhow::bail!("Commands: /status /stop /approve /deny /answer"),
                    _ => {
                        anyhow::ensure!(!text.trim().is_empty() && text.len() <= 12_000, "Message is empty or too long");
                        anyhow::ensure!(!self.chat_widget.is_user_turn_pending_or_running(), "A turn is running; wait or use /stop");
                        anyhow::ensure!(self.chat_widget.no_modal_or_popup_active(), "Close the terminal popup before sending a task");
                        anyhow::ensure!(!self.chat_widget.has_misalignment_policy_violation(), "Resolve the pending terminal review first");
                        let _ = self.chat_widget.submit_user_message_as_plain_user_turn(text.to_string().into());
                        let _ = send.try_send(json!({"kind":"text","text":"Task received in the terminal conversation."}));
                    }
                },
                Some("response") => {
                    let id: RequestId = serde_json::from_value(message["id"].clone())?;
                    anyhow::ensure!(self.current_displayed_thread_id() == Some(thread), "Switch back to the connected thread first");
                    let bridge = self.im_bridge.as_mut().ok_or_else(|| anyhow::anyhow!("Disconnected"))?;
                    anyhow::ensure!(bridge.requests.remove(&id), "Unknown or expired request");
                    server.resolve_server_request(id, message["result"].clone()).await?;
                    let _ = send.try_send(json!({"kind":"text","text":"Response submitted."}));
                }
                _ => {}
            }
            Ok(())
        }
        .await;
        if let Err(error) = result {
            let _ = send.try_send(json!({"kind":"text","text":error.to_string()}));
        }
    }
}

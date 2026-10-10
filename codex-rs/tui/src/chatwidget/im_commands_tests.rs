use super::*;
use pretty_assertions::assert_eq;

#[tokio::test]
async fn im_commands_dispatch_locally_without_starting_an_agent_turn() {
    let (mut chat, mut events, mut commands) =
        make_chatwidget_manual(/*model_override*/ None).await;
    chat.thread_id = Some(ThreadId::new());
    for provider in [
        SlashCommand::Lark,
        SlashCommand::Dingtalk,
        SlashCommand::Wecom,
    ] {
        chat.dispatch_command(provider);
        let selected =
            std::iter::from_fn(|| events.try_recv().ok()).find_map(|event| match event {
                AppEvent::ConnectIm(selected) => Some(selected),
                _ => None,
            });
        assert_eq!(selected, Some(provider));
        assert!(commands.try_recv().is_err());
    }
}

#[tokio::test]
async fn remote_shell_prefix_is_submitted_as_literal_user_text() {
    let (mut chat, _events, mut commands) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.thread_id = Some(ThreadId::new());
    let text = "!echo remote message";
    chat.submit_user_message_as_plain_user_turn(text.into());
    let Op::UserTurn { items, .. } = next_submit_op(&mut commands) else {
        panic!("remote input must start a user turn");
    };
    assert_eq!(
        items,
        vec![UserInput::Text {
            text: text.into(),
            text_elements: Vec::new()
        }]
    );
}

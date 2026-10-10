use super::*;
use crate::app::test_support::make_test_app;
use pretty_assertions::assert_eq;

#[tokio::test]
async fn forwards_only_bound_thread_answers_and_expires_resolved_requests() {
    let mut app = make_test_app().await;
    let thread = ThreadId::new();
    let (outgoing, mut receiver) = tokio::sync::mpsc::channel(/*buffer*/ 4);
    app.im_bridge = Some(ImBridge {
        thread,
        generation: uuid::Uuid::new_v4(),
        outgoing,
        requests: HashSet::new(),
        task: tokio::spawn(std::future::pending()),
    });
    let answer = json!({"method":"item/completed","params":{"threadId":thread,"item":{"type":"agentMessage","text":"done"}}});
    app.im_event("notification", answer.clone());
    assert_eq!(
        receiver.try_recv().unwrap(),
        json!({"kind":"notification","data":answer})
    );
    app.im_event("notification", json!({"method":"item/completed","params":{"threadId":ThreadId::new(),"item":{"type":"agentMessage","text":"private"}}}));
    app.im_event(
        "notification",
        json!({"method":"item/agentMessage/delta","params":{"threadId":thread,"delta":"partial"}}),
    );
    assert!(receiver.try_recv().is_err());
    app.im_event(
        "request",
        json!({"id":7,"method":"item/fileChange/requestApproval","params":{"threadId":thread}}),
    );
    assert_eq!(
        app.im_bridge.as_ref().unwrap().requests,
        HashSet::from([RequestId::Integer(7)])
    );
    app.im_event(
        "notification",
        json!({"method":"serverRequest/resolved","params":{"threadId":thread,"requestId":7}}),
    );
    assert!(app.im_bridge.as_ref().unwrap().requests.is_empty());
}

#[tokio::test]
async fn disconnects_on_backpressure_instead_of_dropping_answers() {
    let mut app = make_test_app().await;
    let thread = ThreadId::new();
    let (outgoing, _receiver) = tokio::sync::mpsc::channel(/*buffer*/ 1);
    app.im_bridge = Some(ImBridge {
        thread,
        generation: uuid::Uuid::new_v4(),
        outgoing,
        requests: HashSet::new(),
        task: tokio::spawn(std::future::pending()),
    });
    for _ in 0..2 {
        app.im_event("notification", json!({"method":"turn/completed","params":{"threadId":thread,"turn":{"status":"completed"}}}));
    }
    assert!(app.im_bridge.is_none());
}

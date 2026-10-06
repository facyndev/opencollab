//! Traducción de los eventos SSE (`GET /event`) de OpenCode a `AgentEvent`s.
//!
//! Cada línea `data: {json}` del stream es un evento `{ "type", "properties" }`.
//! El traductor es puro pero con memoria mínima por lanzamiento: los textos
//! llegan sin rol (el rol viene en `message.updated`), las herramientas
//! repiten su estado, y los subagentes corren en sesiones hijas cuyo
//! `session.status` no debe pisar el del agente principal.

use std::collections::{HashMap, HashSet};

use application::{AgentEvent, AgentStatus};
use serde_json::Value;

#[derive(Debug, Default)]
pub struct OpenCodeTranslator {
    /// `messageID` -> rol, para quedarse solo con el texto del asistente.
    roles: HashMap<String, String>,
    /// Sesiones hijas (con `parentID`): sus estados no cuentan.
    child_sessions: HashSet<String>,
    /// `callID` de herramientas ya anunciadas (pending / running).
    announced: HashSet<String>,
    running: HashSet<String>,
}

impl OpenCodeTranslator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn translate(&mut self, event: &Value) -> Vec<AgentEvent> {
        let Some(kind) = event.get("type").and_then(Value::as_str) else {
            return Vec::new();
        };
        let props = event.get("properties").unwrap_or(&Value::Null);
        match kind {
            "session.created" | "session.updated" => {
                let info = &props["info"];
                if let (Some(id), Some(_)) = (str_at(info, "id"), str_at(info, "parentID")) {
                    insert_bounded(&mut self.child_sessions, id.to_string());
                }
                Vec::new()
            }
            "session.status" if !self.is_child(props) => match props["status"]["type"].as_str() {
                Some("busy") => vec![status(AgentStatus::Working)],
                Some("idle") => vec![status(AgentStatus::Idle)],
                _ => Vec::new(),
            },
            "session.idle" if !self.is_child(props) => vec![status(AgentStatus::Idle)],
            "session.error" if !self.is_child(props) => {
                let error = &props["error"];
                let name = str_at(error, "name");
                let message = str_at(&error["data"], "message");
                vec![AgentEvent::Error {
                    error: match (name, message) {
                        (Some(n), Some(m)) => format!("{n}: {m}"),
                        (Some(x), None) | (None, Some(x)) => x.to_string(),
                        (None, None) => "session error".to_string(),
                    },
                }]
            }
            "message.updated" => {
                let info = &props["info"];
                if let (Some(id), Some(role)) = (str_at(info, "id"), str_at(info, "role")) {
                    if self.roles.len() >= MAX_TRACKED {
                        self.roles.clear();
                    }
                    self.roles.insert(id.to_string(), role.to_string());
                }
                Vec::new()
            }
            "message.part.updated" => self.part(&props["part"]),
            // OpenCode 1.x emite `permission.asked`; versiones previas, `permission.updated`.
            "permission.asked" | "permission.updated" => permission(props),
            // Respondida: el agente retoma el trabajo (y se limpia la aprobación).
            "permission.replied" => vec![status(AgentStatus::Working)],
            _ => Vec::new(),
        }
    }

    fn is_child(&self, props: &Value) -> bool {
        str_at(props, "sessionID").is_some_and(|id| self.child_sessions.contains(id))
    }

    fn part(&mut self, part: &Value) -> Vec<AgentEvent> {
        match str_at(part, "type") {
            Some("tool") => self.tool(part),
            // Solo el texto final del asistente (el del usuario y los deltas no).
            Some("text") if part["time"]["end"].is_number() => {
                let from_assistant = str_at(part, "messageID")
                    .and_then(|id| self.roles.get(id))
                    .is_some_and(|role| role == "assistant");
                match str_at(part, "text") {
                    Some(text) if from_assistant => vec![AgentEvent::Message {
                        content: text.to_string(),
                    }],
                    _ => Vec::new(),
                }
            }
            _ => Vec::new(),
        }
    }

    fn tool(&mut self, part: &Value) -> Vec<AgentEvent> {
        let (Some(tool), Some(call)) = (str_at(part, "tool"), str_at(part, "callID")) else {
            return Vec::new();
        };
        let state = &part["state"];
        match str_at(state, "status") {
            Some("pending") => {
                if insert_bounded(&mut self.announced, call.to_string()) {
                    vec![AgentEvent::ToolStarted {
                        tool: tool.to_string(),
                        input: None,
                    }]
                } else {
                    Vec::new()
                }
            }
            // En `running` ya está la entrada completa: se re-anuncia una vez.
            Some("running") => {
                if insert_bounded(&mut self.running, call.to_string()) {
                    self.announced.insert(call.to_string());
                    let input = state.get("input").filter(|i| !is_empty(i)).cloned();
                    vec![AgentEvent::ToolStarted {
                        tool: tool.to_string(),
                        input,
                    }]
                } else {
                    Vec::new()
                }
            }
            Some("completed") | Some("error") => {
                self.announced.remove(call);
                self.running.remove(call);
                vec![AgentEvent::ToolFinished {
                    tool: tool.to_string(),
                }]
            }
            _ => Vec::new(),
        }
    }
}

/// Tope de ids recordados: una sesión larga no debe crecer sin límite.
const MAX_TRACKED: usize = 1000;

fn insert_bounded(set: &mut HashSet<String>, value: String) -> bool {
    if set.len() >= MAX_TRACKED {
        set.clear();
    }
    set.insert(value)
}

fn str_at<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str().filter(|s| !s.is_empty())
}

fn is_empty(value: &Value) -> bool {
    value.as_object().is_some_and(|o| o.is_empty()) || value.is_null()
}

fn status(status: AgentStatus) -> AgentEvent {
    AgentEvent::StatusChanged { status }
}

fn permission(props: &Value) -> Vec<AgentEvent> {
    let Some(id) = str_at(props, "id") else {
        return Vec::new();
    };
    let name = str_at(props, "permission")
        .or_else(|| str_at(props, "type"))
        .unwrap_or("permission");
    let detail = str_at(&props["metadata"], "command")
        .map(str::to_string)
        .or_else(|| {
            let patterns: Vec<&str> = props["patterns"]
                .as_array()
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            (!patterns.is_empty()).then(|| patterns.join(", "))
        });
    vec![AgentEvent::ApprovalRequired {
        request_id: id.to_string(),
        description: match detail {
            Some(d) => format!("{name}: {d}"),
            None => name.to_string(),
        },
    }]
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn run(events: &[Value]) -> Vec<AgentEvent> {
        let mut t = OpenCodeTranslator::new();
        events.iter().flat_map(|e| t.translate(e)).collect()
    }

    fn status(kind: &str) -> Value {
        json!({ "type": "session.status",
            "properties": { "sessionID": "ses_1", "status": { "type": kind } } })
    }

    fn tool(call: &str, state: Value) -> Value {
        json!({ "type": "message.part.updated", "properties": { "sessionID": "ses_1",
            "part": { "type": "tool", "tool": "bash", "callID": call, "state": state } } })
    }

    fn working() -> AgentEvent {
        AgentEvent::StatusChanged {
            status: AgentStatus::Working,
        }
    }

    fn idle() -> AgentEvent {
        AgentEvent::StatusChanged {
            status: AgentStatus::Idle,
        }
    }

    #[test]
    fn busy_and_idle_map_to_working_and_idle() {
        assert_eq!(run(&[status("busy")]), vec![working()]);
        assert_eq!(run(&[status("idle")]), vec![idle()]);
        assert_eq!(
            run(&[json!({ "type": "session.idle", "properties": { "sessionID": "ses_1" } })]),
            vec![idle()]
        );
        // Estados que no son busy/idle (p. ej. retry) no cambian nada.
        assert_eq!(run(&[status("retry")]), vec![]);
    }

    #[test]
    fn child_sessions_do_not_move_the_status() {
        let child = json!({ "type": "session.created", "properties": {
            "sessionID": "ses_child", "info": { "id": "ses_child", "parentID": "ses_1" } } });
        let child_idle = json!({ "type": "session.status",
            "properties": { "sessionID": "ses_child", "status": { "type": "idle" } } });
        assert_eq!(run(&[child, child_idle, status("busy")]), vec![working()]);
    }

    #[test]
    fn a_tool_starts_on_pending_then_is_refined_on_running_and_finishes() {
        let events = run(&[
            tool("c1", json!({ "status": "pending", "input": {} })),
            tool(
                "c1",
                json!({ "status": "running", "input": { "command": "echo hi" } }),
            ),
            // Actualizaciones repetidas de la misma herramienta no se re-emiten.
            tool(
                "c1",
                json!({ "status": "running", "input": { "command": "echo hi" },
                    "metadata": { "output": "hi\n" } }),
            ),
            tool(
                "c1",
                json!({ "status": "completed", "input": { "command": "echo hi" },
                    "output": "hi\n" }),
            ),
        ]);
        assert_eq!(
            events,
            vec![
                AgentEvent::ToolStarted {
                    tool: "bash".into(),
                    input: None
                },
                AgentEvent::ToolStarted {
                    tool: "bash".into(),
                    input: Some(json!({ "command": "echo hi" }))
                },
                AgentEvent::ToolFinished {
                    tool: "bash".into()
                },
            ]
        );
    }

    #[test]
    fn a_tool_first_seen_running_starts_and_an_error_finishes_it() {
        let events = run(&[
            tool(
                "c2",
                json!({ "status": "running", "input": { "command": "ls" } }),
            ),
            tool(
                "c2",
                json!({ "status": "error", "input": {}, "error": "boom" }),
            ),
        ]);
        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            AgentEvent::ToolStarted { input: Some(_), .. }
        ));
        assert_eq!(
            events[1],
            AgentEvent::ToolFinished {
                tool: "bash".into()
            }
        );
    }

    #[test]
    fn permission_asked_requires_approval_and_replied_resumes_work() {
        let asked = json!({ "type": "permission.asked", "properties": {
            "id": "per_1", "sessionID": "ses_1", "permission": "bash",
            "patterns": ["echo hi"], "metadata": { "command": "echo hi" } } });
        let replied = json!({ "type": "permission.replied",
            "properties": { "sessionID": "ses_1", "requestID": "per_1", "reply": "once" } });
        assert_eq!(
            run(&[asked, replied]),
            vec![
                AgentEvent::ApprovalRequired {
                    request_id: "per_1".into(),
                    description: "bash: echo hi".into()
                },
                working(),
            ]
        );
    }

    #[test]
    fn permission_description_falls_back_to_patterns_then_the_permission_name() {
        let by_patterns = json!({ "type": "permission.asked", "properties": {
            "id": "p", "permission": "edit", "patterns": ["a.rs", "b.rs"] } });
        let bare = json!({ "type": "permission.asked", "properties": {
            "id": "q", "permission": "webfetch" } });
        let events = run(&[by_patterns, bare]);
        assert!(
            matches!(&events[0], AgentEvent::ApprovalRequired { description, .. }
            if description == "edit: a.rs, b.rs")
        );
        assert!(
            matches!(&events[1], AgentEvent::ApprovalRequired { description, .. }
            if description == "webfetch")
        );
    }

    fn message_updated(id: &str, role: &str) -> Value {
        json!({ "type": "message.updated", "properties": {
            "sessionID": "ses_1", "info": { "id": id, "role": role } } })
    }

    fn text_part(message: &str, text: &str, done: bool) -> Value {
        let mut part = json!({ "type": "text", "messageID": message, "text": text });
        if done {
            part["time"] = json!({ "start": 1, "end": 2 });
        }
        json!({ "type": "message.part.updated",
            "properties": { "sessionID": "ses_1", "part": part } })
    }

    #[test]
    fn only_final_assistant_text_becomes_a_message() {
        let events = run(&[
            message_updated("m_user", "user"),
            text_part("m_user", "Run echo hi", true),
            message_updated("m_asst", "assistant"),
            text_part("m_asst", "Runn", false),
            text_part("m_asst", "Done: hi", true),
            json!({ "type": "message.part.delta", "properties": {
                "messageID": "m_asst", "field": "text", "delta": "x" } }),
        ]);
        assert_eq!(
            events,
            vec![AgentEvent::Message {
                content: "Done: hi".into()
            }]
        );
    }

    #[test]
    fn text_of_an_unknown_message_is_ignored() {
        assert_eq!(run(&[text_part("m_unknown", "hello", true)]), vec![]);
    }

    #[test]
    fn session_errors_become_errors_with_the_best_available_message() {
        let named = json!({ "type": "session.error", "properties": { "sessionID": "ses_1",
            "error": { "name": "ProviderAuthError", "data": { "message": "bad key" } } } });
        let nameless = json!({ "type": "session.error", "properties": { "sessionID": "ses_1" } });
        assert_eq!(
            run(&[named, nameless]),
            vec![
                AgentEvent::Error {
                    error: "ProviderAuthError: bad key".into()
                },
                AgentEvent::Error {
                    error: "session error".into()
                },
            ]
        );
    }

    #[test]
    fn heartbeats_unknown_and_malformed_events_produce_nothing() {
        assert_eq!(
            run(&[
                json!({ "type": "server.heartbeat", "properties": {} }),
                json!({ "type": "plugin.added", "properties": { "id": "x" } }),
                json!({ "type": "message.part.updated", "properties": {} }),
                json!({ "properties": {} }),
                json!("text"),
            ]),
            vec![]
        );
    }

    #[test]
    fn step_finish_parts_are_ignored() {
        let part = json!({ "type": "message.part.updated", "properties": { "part": {
            "type": "step-finish", "reason": "stop" } } });
        assert_eq!(run(&[part]), vec![]);
    }
}

//! Adaptadores de agentes: cómo cada CLI aporta datos a la app.
//!
//! Un [`AgentAdapter`] hace dos cosas, en dos pasos porque el id de la terminal
//! no existe hasta después de crearla:
//!
//! 1. `prepare` (antes de lanzar): devuelve argumentos / variables de entorno
//!    extra para el comando del agente y un `token` opaco que identifica ese
//!    lanzamiento (p. ej. el secreto por lanzamiento o el puerto elegido).
//! 2. `bind` (con la terminal ya creada): a partir de ese `token` empieza a
//!    producir [`AgentEvent`]s hacia el [`AgentEventSink`].
//!
//! El camino genérico (sin adaptador) no aporta nada y se queda con
//! [`activity_event`] / [`exit_event`], que expresan la actividad del PTY y la
//! salida del proceso como eventos. Para sumar un agente rico basta una
//! implementación de [`AgentAdapter`] registrada en [`AgentAdapters`].

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use domain::TerminalId;

use crate::activity::Activity;
use crate::agent_detection::KnownAgent;
use crate::agent_event::{AgentEvent, AgentStatus};
use crate::agent_state::AgentState;
use crate::ports::PortError;

/// Destino de los eventos de los agentes (el adaptador de entrada lo reenvía al
/// frontend, al relay, etc.).
pub trait AgentEventSink: Send + Sync {
    fn emit(&self, terminal: TerminalId, event: AgentEvent);
}

/// Lo que un adaptador agrega al lanzamiento de su agente.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LaunchAugmentation {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Identifica este lanzamiento ante `bind`.
    pub token: String,
}

pub trait AgentAdapter: Send + Sync {
    /// Agente al que atiende.
    fn agent(&self) -> KnownAgent;
    /// Antes de lanzar: qué agregar al comando.
    fn prepare(&self) -> Result<LaunchAugmentation, PortError>;
    /// Con la terminal creada: empezar a emitir eventos de ese lanzamiento.
    fn bind(&self, token: &str, terminal: TerminalId, events: Arc<dyn AgentEventSink>);
}

/// Resultado de `AgentAdapters::prepare`: lo que hay que agregar al lanzamiento
/// y, si hay adaptador, cómo engancharlo a la terminal una vez creada.
pub struct PreparedLaunch {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    binding: Option<(Arc<dyn AgentAdapter>, String)>,
}

impl PreparedLaunch {
    /// Sin adaptador: no agrega nada.
    pub fn none() -> Self {
        Self {
            args: Vec::new(),
            env: Vec::new(),
            binding: None,
        }
    }

    /// Con la terminal creada, activa el adaptador (si lo hay).
    pub fn bind(self, terminal: TerminalId, events: Arc<dyn AgentEventSink>) {
        if let Some((adapter, token)) = self.binding {
            adapter.bind(&token, terminal, events);
        }
    }
}

/// Los adaptadores registrados. Un agente sin adaptador usa el camino genérico.
#[derive(Default)]
pub struct AgentAdapters {
    adapters: Vec<Arc<dyn AgentAdapter>>,
}

impl AgentAdapters {
    pub fn new(adapters: Vec<Arc<dyn AgentAdapter>>) -> Self {
        Self { adapters }
    }

    pub fn prepare(&self, agent: KnownAgent) -> Result<PreparedLaunch, PortError> {
        let Some(adapter) = self.adapters.iter().find(|a| a.agent() == agent) else {
            return Ok(PreparedLaunch::none());
        };
        let LaunchAugmentation { args, env, token } = adapter.prepare()?;
        Ok(PreparedLaunch {
            args,
            env,
            binding: Some((adapter.clone(), token)),
        })
    }
}

/// Adaptador genérico: la actividad del PTY como evento.
pub fn activity_event(activity: Activity) -> AgentEvent {
    AgentEvent::StatusChanged {
        status: match activity {
            Activity::Working => AgentStatus::Working,
            Activity::Idle => AgentStatus::Idle,
        },
    }
}

/// Adaptador genérico: la salida del proceso como evento. Sin código de salida
/// conocido se asume salida normal.
pub fn exit_event(code: Option<i32>) -> AgentEvent {
    match code {
        None | Some(0) => AgentEvent::Completed,
        Some(code) => AgentEvent::Error {
            error: format!("exited with code {code}"),
        },
    }
}

/// Último [`AgentState`] de cada terminal. Aplica los eventos con el reductor y
/// avisa solo cuando algo cambió, para no emitir ruido hacia la UI.
#[derive(Default)]
pub struct AgentStates {
    states: Mutex<HashMap<TerminalId, AgentState>>,
}

impl AgentStates {
    pub fn new() -> Self {
        Self::default()
    }

    /// Aplica `event` a la terminal. Devuelve el estado nuevo si cambió.
    pub fn apply(&self, terminal: TerminalId, event: AgentEvent) -> Option<AgentState> {
        let mut states = self.states.lock().ok()?;
        let current = states.entry(terminal).or_default();
        let next = current.clone().reduce(event);
        if next == *current {
            return None;
        }
        *current = next.clone();
        Some(next)
    }

    pub fn forget(&self, terminal: TerminalId) {
        if let Ok(mut states) = self.states.lock() {
            states.remove(&terminal);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[test]
    fn activity_becomes_status_changed() {
        assert_eq!(
            activity_event(Activity::Working),
            AgentEvent::StatusChanged {
                status: AgentStatus::Working
            }
        );
        assert_eq!(
            activity_event(Activity::Idle),
            AgentEvent::StatusChanged {
                status: AgentStatus::Idle
            }
        );
    }

    #[test]
    fn exit_code_zero_or_unknown_completes_and_nonzero_errors() {
        assert_eq!(exit_event(Some(0)), AgentEvent::Completed);
        assert_eq!(exit_event(None), AgentEvent::Completed);
        assert_eq!(
            exit_event(Some(2)),
            AgentEvent::Error {
                error: "exited with code 2".into()
            }
        );
    }

    #[test]
    fn states_report_only_changes() {
        let states = AgentStates::new();
        let t = TerminalId::new();
        let working = AgentEvent::StatusChanged {
            status: AgentStatus::Working,
        };
        let first = states.apply(t, working.clone()).unwrap();
        assert_eq!(first.status, Some(AgentStatus::Working));
        assert_eq!(states.apply(t, working), None);
    }

    #[test]
    fn states_are_per_terminal_and_can_be_forgotten() {
        let states = AgentStates::new();
        let (a, b) = (TerminalId::new(), TerminalId::new());
        states.apply(a, AgentEvent::Completed);
        let working = AgentEvent::StatusChanged {
            status: AgentStatus::Working,
        };
        assert!(states.apply(b, working.clone()).is_some());
        states.forget(b);
        // Olvidada: vuelve a empezar de cero, así que el mismo evento cambia algo.
        assert!(states.apply(b, working).is_some());
        // `a` conserva su estado: repetir `completed` no cambia nada.
        assert_eq!(states.apply(a, AgentEvent::Completed), None);
    }

    struct Recorder(Mutex<Vec<(TerminalId, AgentEvent)>>);
    impl AgentEventSink for Recorder {
        fn emit(&self, terminal: TerminalId, event: AgentEvent) {
            self.0.lock().unwrap().push((terminal, event));
        }
    }

    struct FakeAdapter;
    impl AgentAdapter for FakeAdapter {
        fn agent(&self) -> KnownAgent {
            KnownAgent::ClaudeCode
        }
        fn prepare(&self) -> Result<LaunchAugmentation, PortError> {
            Ok(LaunchAugmentation {
                args: vec!["--flag".into()],
                env: vec![("K".into(), "V".into())],
                token: "tok".into(),
            })
        }
        fn bind(&self, token: &str, terminal: TerminalId, events: Arc<dyn AgentEventSink>) {
            events.emit(
                terminal,
                AgentEvent::Message {
                    content: token.into(),
                },
            );
        }
    }

    #[test]
    fn an_agent_without_adapter_gets_no_augmentation() {
        let adapters = AgentAdapters::new(vec![Arc::new(FakeAdapter)]);
        let prepared = adapters.prepare(KnownAgent::Codex).unwrap();
        assert!(prepared.args.is_empty() && prepared.env.is_empty());
        let sink = Arc::new(Recorder(Mutex::default()));
        prepared.bind(TerminalId::new(), sink.clone());
        assert!(sink.0.lock().unwrap().is_empty());
    }

    #[test]
    fn the_matching_adapter_augments_the_launch_and_binds_with_its_token() {
        let adapters = AgentAdapters::new(vec![Arc::new(FakeAdapter)]);
        let prepared = adapters.prepare(KnownAgent::ClaudeCode).unwrap();
        assert_eq!(prepared.args, vec!["--flag".to_string()]);
        assert_eq!(prepared.env, vec![("K".to_string(), "V".to_string())]);
        let sink = Arc::new(Recorder(Mutex::default()));
        let terminal = TerminalId::new();
        prepared.bind(terminal, sink.clone());
        assert_eq!(
            *sink.0.lock().unwrap(),
            vec![(
                terminal,
                AgentEvent::Message {
                    content: "tok".into()
                }
            )]
        );
    }
}

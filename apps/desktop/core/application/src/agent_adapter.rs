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

use std::collections::{HashMap, HashSet};
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
    /// La terminal se cerró: liberar lo que `prepare`/`bind` dejaron (archivos
    /// temporales, listeners, hilos). Se llama para toda terminal, así que debe
    /// ignorar las que no le pertenecen.
    fn release(&self, _terminal: TerminalId) {}
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

    /// `true` si hay un adaptador rico: pasa a ser la fuente autoritativa del
    /// estado de la terminal (ver `AgentStates::mark_rich`).
    pub fn is_rich(&self) -> bool {
        self.binding.is_some()
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

impl AgentAdapters {
    /// Avisa a todos los adaptadores que la terminal se cerró.
    pub fn release(&self, terminal: TerminalId) {
        for adapter in &self.adapters {
            adapter.release(terminal);
        }
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
    /// Terminales con un adaptador rico: él decide el estado (ver `mark_rich`).
    rich: Mutex<HashSet<TerminalId>>,
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

    /// Marca que la terminal tiene un adaptador rico. Desde entonces es
    /// autoritativo para `status_changed`: el estado inferido de la actividad del
    /// PTY se ignora en `apply_generic` (la salida del proceso sigue valiendo).
    pub fn mark_rich(&self, terminal: TerminalId) {
        if let Ok(mut rich) = self.rich.lock() {
            rich.insert(terminal);
        }
    }

    /// Como `apply`, pero para eventos del camino genérico (actividad del PTY,
    /// salida del proceso): si la terminal tiene un adaptador rico, los
    /// `status_changed` se descartan porque ese adaptador sabe más.
    pub fn apply_generic(&self, terminal: TerminalId, event: AgentEvent) -> Option<AgentState> {
        let is_rich = self.rich.lock().ok()?.contains(&terminal);
        if is_rich && matches!(event, AgentEvent::StatusChanged { .. }) {
            return None;
        }
        self.apply(terminal, event)
    }

    pub fn forget(&self, terminal: TerminalId) {
        if let Ok(mut states) = self.states.lock() {
            states.remove(&terminal);
        }
        if let Ok(mut rich) = self.rich.lock() {
            rich.remove(&terminal);
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

    #[test]
    fn a_rich_terminal_ignores_generic_status_but_keeps_generic_exit() {
        let states = AgentStates::new();
        let t = TerminalId::new();
        let working = AgentEvent::StatusChanged {
            status: AgentStatus::Working,
        };
        states.mark_rich(t);
        // El adaptador rico manda: la actividad del PTY no mueve el estado.
        assert_eq!(states.apply_generic(t, working.clone()), None);
        // Lo del adaptador rico sí se aplica.
        assert!(states.apply(t, working.clone()).is_some());
        // La salida del proceso sigue valiendo aunque venga por el camino genérico.
        let done = states.apply_generic(t, AgentEvent::Completed).unwrap();
        assert!(done.completed);
    }

    #[test]
    fn a_terminal_without_rich_source_applies_generic_status() {
        let states = AgentStates::new();
        let t = TerminalId::new();
        let working = AgentEvent::StatusChanged {
            status: AgentStatus::Working,
        };
        assert!(states.apply_generic(t, working).is_some());
    }

    #[test]
    fn forgetting_a_terminal_drops_its_rich_mark() {
        let states = AgentStates::new();
        let t = TerminalId::new();
        states.mark_rich(t);
        states.forget(t);
        let working = AgentEvent::StatusChanged {
            status: AgentStatus::Working,
        };
        assert!(states.apply_generic(t, working).is_some());
    }

    #[test]
    fn prepared_launch_reports_whether_it_has_a_rich_adapter() {
        let adapters = AgentAdapters::new(vec![Arc::new(FakeAdapter)]);
        assert!(adapters.prepare(KnownAgent::ClaudeCode).unwrap().is_rich());
        assert!(!adapters.prepare(KnownAgent::Codex).unwrap().is_rich());
    }

    #[test]
    fn release_reaches_every_adapter() {
        let released = Arc::new(Mutex::new(Vec::new()));
        struct Releasing(Arc<Mutex<Vec<TerminalId>>>);
        impl AgentAdapter for Releasing {
            fn agent(&self) -> KnownAgent {
                KnownAgent::ClaudeCode
            }
            fn prepare(&self) -> Result<LaunchAugmentation, PortError> {
                Ok(LaunchAugmentation::default())
            }
            fn bind(&self, _: &str, _: TerminalId, _: Arc<dyn AgentEventSink>) {}
            fn release(&self, terminal: TerminalId) {
                self.0.lock().unwrap().push(terminal);
            }
        }
        let adapters = AgentAdapters::new(vec![Arc::new(Releasing(released.clone()))]);
        let t = TerminalId::new();
        adapters.release(t);
        assert_eq!(*released.lock().unwrap(), vec![t]);
    }
}

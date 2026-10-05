//! Actividad de una terminal inferida de su salida: un agente trabajando
//! redibuja sin parar (spinners, texto en streaming) y uno inactivo calla.
//! Es agnóstico: no mira qué corre en la terminal, solo cuándo emitió bytes.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use domain::TerminalId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Activity {
    Working,
    Idle,
}

impl Activity {
    /// Identificador estable que viaja al frontend.
    pub fn id(self) -> &'static str {
        match self {
            Activity::Working => "working",
            Activity::Idle => "idle",
        }
    }
}

#[derive(Default)]
struct Tracked {
    last_output: HashMap<TerminalId, Instant>,
    reported: HashMap<TerminalId, Activity>,
}

/// Registra cuándo emitió salida cada terminal y, en cada `tick`, informa solo
/// las que cambiaron de estado. Sin reloj propio: quien llama pasa el instante.
pub struct ActivityTracker {
    /// Silencio a partir del cual una terminal pasa a inactiva.
    idle_after: Duration,
    state: Mutex<Tracked>,
}

impl ActivityTracker {
    pub fn new(idle_after: Duration) -> Self {
        Self {
            idle_after,
            state: Mutex::new(Tracked::default()),
        }
    }

    pub fn record_output(&self, terminal: TerminalId, now: Instant) {
        if let Ok(mut state) = self.state.lock() {
            state.last_output.insert(terminal, now);
        }
    }

    /// Terminales cuyo estado cambió desde el último `tick`. Una terminal sin
    /// salida registrada no se informa.
    pub fn tick(&self, now: Instant) -> Vec<(TerminalId, Activity)> {
        let Ok(mut state) = self.state.lock() else {
            return Vec::new();
        };
        let Tracked {
            last_output,
            reported,
        } = &mut *state;
        let mut changes = Vec::new();
        for (&terminal, &last) in last_output.iter() {
            let activity = if now.saturating_duration_since(last) >= self.idle_after {
                Activity::Idle
            } else {
                Activity::Working
            };
            if reported.insert(terminal, activity) != Some(activity) {
                changes.push((terminal, activity));
            }
        }
        changes
    }

    pub fn forget(&self, terminal: TerminalId) {
        if let Ok(mut state) = self.state.lock() {
            state.last_output.remove(&terminal);
            state.reported.remove(&terminal);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use domain::TerminalId;

    use super::*;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn output_makes_the_terminal_working() {
        let tracker = ActivityTracker::new(secs(3));
        let (t, t0) = (TerminalId::new(), Instant::now());
        tracker.record_output(t, t0);
        assert_eq!(tracker.tick(t0 + secs(1)), vec![(t, Activity::Working)]);
    }

    #[test]
    fn silence_for_the_threshold_makes_it_idle() {
        let tracker = ActivityTracker::new(secs(3));
        let (t, t0) = (TerminalId::new(), Instant::now());
        tracker.record_output(t, t0);
        tracker.tick(t0 + secs(1));
        assert!(tracker.tick(t0 + secs(2)).is_empty());
        assert_eq!(tracker.tick(t0 + secs(3)), vec![(t, Activity::Idle)]);
    }

    #[test]
    fn only_changes_are_reported() {
        let tracker = ActivityTracker::new(secs(3));
        let (t, t0) = (TerminalId::new(), Instant::now());
        tracker.record_output(t, t0);
        assert_eq!(tracker.tick(t0).len(), 1);
        assert!(tracker.tick(t0 + secs(1)).is_empty());
        tracker.record_output(t, t0 + secs(2));
        assert!(tracker.tick(t0 + secs(4)).is_empty());
        assert_eq!(tracker.tick(t0 + secs(5)), vec![(t, Activity::Idle)]);
        assert!(tracker.tick(t0 + secs(9)).is_empty());
    }

    #[test]
    fn new_output_after_idle_is_working_again() {
        let tracker = ActivityTracker::new(secs(3));
        let (t, t0) = (TerminalId::new(), Instant::now());
        tracker.record_output(t, t0);
        tracker.tick(t0);
        tracker.tick(t0 + secs(5));
        tracker.record_output(t, t0 + secs(6));
        assert_eq!(tracker.tick(t0 + secs(6)), vec![(t, Activity::Working)]);
    }

    #[test]
    fn terminals_without_output_are_not_reported() {
        let tracker = ActivityTracker::new(secs(3));
        assert!(tracker.tick(Instant::now()).is_empty());
    }

    #[test]
    fn terminals_are_tracked_independently() {
        let tracker = ActivityTracker::new(secs(3));
        let (a, b, t0) = (TerminalId::new(), TerminalId::new(), Instant::now());
        tracker.record_output(a, t0);
        tracker.record_output(b, t0 + secs(2));
        tracker.tick(t0 + secs(2));
        assert_eq!(tracker.tick(t0 + secs(3)), vec![(a, Activity::Idle)]);
    }

    #[test]
    fn a_forgotten_terminal_is_no_longer_reported() {
        let tracker = ActivityTracker::new(secs(3));
        let (t, t0) = (TerminalId::new(), Instant::now());
        tracker.record_output(t, t0);
        tracker.tick(t0);
        tracker.forget(t);
        assert!(tracker.tick(t0 + secs(10)).is_empty());
    }
}

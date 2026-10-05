//! La shell por defecto reporta su directorio actual con OSC 7, y esa secuencia
//! atraviesa el PTY (ConPTY en Windows) hasta el emulador.
//!
//!     cargo test -p infrastructure --test shell_integration_e2e -- --ignored --nocapture

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use application::ports::{PtyPort, TerminalOutputSink, TerminalSize};
use domain::TerminalId;
use infrastructure::{default_shell_profile, PortablePtyAdapter};

#[derive(Default)]
struct Sink(Mutex<Vec<u8>>);

impl TerminalOutputSink for Sink {
    fn output(&self, _terminal: TerminalId, data: &[u8]) {
        self.0.lock().unwrap().extend_from_slice(data);
    }
    fn exited(&self, _terminal: TerminalId) {}
}

fn text(sink: &Sink) -> String {
    String::from_utf8_lossy(&sink.0.lock().unwrap()).into_owned()
}

/// Espera hasta que la salida contenga `needle`, contestando las consultas de cursor.
fn wait_for(pty: &PortablePtyAdapter, terminal: TerminalId, sink: &Sink, needle: &str) -> bool {
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut answered = 0;
    while Instant::now() < deadline {
        let out = text(sink);
        if out.contains(needle) {
            return true;
        }
        let queries = out.matches("\x1b[6n").count();
        while answered < queries {
            let _ = pty.write(terminal, b"\x1b[1;1R");
            answered += 1;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

#[test]
#[ignore = "lanza la shell real del sistema"]
fn default_shell_reports_its_cwd_with_osc7() {
    let profile = default_shell_profile(None);
    let home = profile.cwd.clone().expect("la shell arranca en el home");
    let home = home.display().to_string().replace('\\', "/");

    let pty = PortablePtyAdapter::new();
    let terminal = TerminalId::new();
    let sink = Arc::new(Sink::default());
    pty.spawn(terminal, &profile, TerminalSize::default(), sink.clone())
        .unwrap();

    let first = format!("\x1b]7;file://localhost/{home}");
    assert!(
        wait_for(&pty, terminal, &sink, &first),
        "no llegó OSC 7 con el home; salida: {:?}",
        text(&sink)
    );

    // Después de un cd, el siguiente prompt reporta la carpeta nueva.
    let parent = std::path::Path::new(&home).parent().unwrap();
    let parent = parent.display().to_string().replace('\\', "/");
    let cmd = if cfg!(windows) { "cd ..\r" } else { "cd ..\n" };
    pty.write(terminal, cmd.as_bytes()).unwrap();
    let second = format!("\x1b]7;file://localhost/{parent}\x1b\\");
    let ok = wait_for(&pty, terminal, &sink, &second);
    let _ = pty.kill(terminal);
    assert!(ok, "no llegó OSC 7 tras cd; salida: {:?}", text(&sink));
}

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use application::ports::{PortError, PtyPort, TerminalOutputSink, TerminalSize};
use domain::{AgentProfile, TerminalId};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

struct PtyHandle {
    master: Box<dyn MasterPty + Send>,
    /// Lock propio por terminal: escribir puede bloquear (si el proceso no lee
    /// y el buffer se llena) y eso no debe frenar a las demás terminales.
    writer: SharedWriter,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
}

/// Termina el proceso y todos sus descendientes: cerrar una shell debe cerrar
/// también el agente que corre dentro.
fn kill_tree(pid: u32) -> std::io::Result<()> {
    #[cfg(windows)]
    let output = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()?
    };
    // portable-pty lanza el hijo con setsid: su pid es también el id del grupo.
    #[cfg(not(windows))]
    let output = std::process::Command::new("kill")
        .args(["-KILL", "--", &format!("-{pid}")])
        .output()?;

    if output.status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ))
    }
}

type Handles = Arc<Mutex<HashMap<TerminalId, PtyHandle>>>;

/// [`PtyPort`] sobre `portable-pty` (ConPTY en Windows, openpty en Unix).
///
/// Por cada terminal hay un hilo que lee la salida y otro que espera la
/// salida del proceso; al terminar se libera el PTY y se avisa al sink.
///
/// El mapa de terminales se bloquea solo para buscar o actualizar entradas:
/// nada que pueda tardar (escribir al PTY, `taskkill`) corre con ese lock tomado.
#[derive(Default)]
pub struct PortablePtyAdapter {
    handles: Handles,
}

impl PortablePtyAdapter {
    pub fn new() -> Self {
        Self::default()
    }
}

fn pty_size(size: TerminalSize) -> PtySize {
    PtySize {
        rows: size.rows,
        cols: size.cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn port_err(e: impl std::fmt::Display) -> PortError {
    PortError::new(e.to_string())
}

impl PtyPort for PortablePtyAdapter {
    fn spawn(
        &self,
        terminal: TerminalId,
        profile: &AgentProfile,
        size: TerminalSize,
        sink: Arc<dyn TerminalOutputSink>,
    ) -> Result<(), PortError> {
        let pair = native_pty_system()
            .openpty(pty_size(size))
            .map_err(port_err)?;

        let mut cmd = CommandBuilder::new(&profile.command);
        cmd.args(&profile.args);
        for (key, value) in &profile.env {
            cmd.env(key, value);
        }
        if let Some(cwd) = &profile.cwd {
            cmd.cwd(cwd);
        }

        let mut child = pair.slave.spawn_command(cmd).map_err(port_err)?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(port_err)?;
        let writer = pair.master.take_writer().map_err(port_err)?;
        let killer = child.clone_killer();
        let pid = child.process_id();

        self.handles.lock().map_err(port_err)?.insert(
            terminal,
            PtyHandle {
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                killer,
                pid,
            },
        );

        let output_sink = sink.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => output_sink.output(terminal, &buf[..n]),
                }
            }
        });

        let handles = self.handles.clone();
        thread::spawn(move || {
            let _ = child.wait();
            // Soltar el master cierra el PTY y destraba al hilo lector.
            if let Ok(mut handles) = handles.lock() {
                handles.remove(&terminal);
            }
            sink.exited(terminal);
        });

        Ok(())
    }

    fn write(&self, terminal: TerminalId, data: &[u8]) -> Result<(), PortError> {
        let writer = self
            .handles
            .lock()
            .map_err(port_err)?
            .get(&terminal)
            .map(|h| h.writer.clone())
            .ok_or_else(|| PortError::new(format!("terminal {terminal} no está activa")))?;
        // El lock del mapa ya se soltó: si esta escritura se bloquea, solo
        // espera esta terminal.
        let mut writer = writer.lock().map_err(port_err)?;
        writer.write_all(data).map_err(port_err)?;
        writer.flush().map_err(port_err)
    }

    fn resize(&self, terminal: TerminalId, size: TerminalSize) -> Result<(), PortError> {
        let handles = self.handles.lock().map_err(port_err)?;
        let handle = handles
            .get(&terminal)
            .ok_or_else(|| PortError::new(format!("terminal {terminal} no está activa")))?;
        handle.master.resize(pty_size(size)).map_err(port_err)
    }

    fn kill(&self, terminal: TerminalId) -> Result<(), PortError> {
        // El hilo que espera al proceso libera el handle y avisa `exited`.
        let pid = {
            let mut handles = self.handles.lock().map_err(port_err)?;
            let Some(handle) = handles.get_mut(&terminal) else {
                return Ok(());
            };
            match handle.pid {
                Some(pid) => pid,
                // Sin pid, solo queda el killer de portable-pty (es inmediato).
                None => return handle.killer.kill().map_err(port_err),
            }
        };
        // El killer de portable-pty falla en Windows ("handle inválido"), así
        // que se mata por pid. `taskkill` tarda: va sin el lock del mapa.
        kill_tree(pid).map_err(port_err)
    }

    fn process_id(&self, terminal: TerminalId) -> Option<u32> {
        self.handles.lock().ok()?.get(&terminal)?.pid
    }
}

impl Drop for PortablePtyAdapter {
    fn drop(&mut self) {
        let pids: Vec<u32> = match self.handles.lock() {
            Ok(mut handles) => handles
                .values_mut()
                .filter_map(|h| {
                    if h.pid.is_none() {
                        let _ = h.killer.kill();
                    }
                    h.pid
                })
                .collect(),
            Err(_) => return,
        };
        for pid in pids {
            let _ = kill_tree(pid);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;

    struct ChannelSink {
        output: Mutex<Vec<u8>>,
        exited: Mutex<Option<mpsc::Sender<()>>>,
    }

    impl TerminalOutputSink for ChannelSink {
        fn output(&self, _terminal: TerminalId, data: &[u8]) {
            self.output.lock().unwrap().extend_from_slice(data);
        }
        fn exited(&self, _terminal: TerminalId) {
            if let Some(tx) = self.exited.lock().unwrap().take() {
                let _ = tx.send(());
            }
        }
    }

    #[test]
    fn spawns_process_and_streams_output() {
        let profile = if cfg!(windows) {
            AgentProfile::new("echo", "cmd.exe")
                .unwrap()
                .with_args(["/C", "echo opencollab-pty-ok"])
        } else {
            AgentProfile::new("echo", "sh")
                .unwrap()
                .with_args(["-c", "echo opencollab-pty-ok"])
        };

        let (tx, rx) = mpsc::channel();
        let sink = Arc::new(ChannelSink {
            output: Mutex::new(Vec::new()),
            exited: Mutex::new(Some(tx)),
        });

        let adapter = PortablePtyAdapter::new();
        let terminal = TerminalId::new();
        adapter
            .spawn(terminal, &profile, TerminalSize::default(), sink.clone())
            .unwrap();

        // ConPTY (Windows) pregunta la posición del cursor (ESC[6n) y retiene
        // la salida hasta recibir respuesta. En la app la contesta xterm.js;
        // acá la simulamos como lo haría un emulador de terminal.
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        let mut answered_cursor_query = false;
        loop {
            if rx.recv_timeout(Duration::from_millis(50)).is_ok() {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "el proceso no terminó a tiempo; salida: {:?}",
                String::from_utf8_lossy(&sink.output.lock().unwrap())
            );
            let asked = sink
                .output
                .lock()
                .unwrap()
                .windows(4)
                .any(|w| w == b"\x1b[6n");
            if asked && !answered_cursor_query {
                answered_cursor_query = adapter.write(terminal, b"\x1b[1;1R").is_ok();
            }
        }
        // El lector puede recibir los últimos bytes justo después del exit.
        std::thread::sleep(Duration::from_millis(300));

        let output = String::from_utf8_lossy(&sink.output.lock().unwrap()).to_string();
        assert!(output.contains("opencollab-pty-ok"), "salida: {output:?}");
    }

    #[test]
    fn kill_terminates_a_running_process() {
        // Un proceso que no termina solo: la única salida es kill().
        let profile = if cfg!(windows) {
            AgentProfile::new("wait", "cmd.exe")
                .unwrap()
                .with_args(["/C", "ping -n 30 127.0.0.1 >NUL"])
        } else {
            AgentProfile::new("wait", "sh")
                .unwrap()
                .with_args(["-c", "sleep 30"])
        };
        let (tx, rx) = mpsc::channel();
        let sink = Arc::new(ChannelSink {
            output: Mutex::new(Vec::new()),
            exited: Mutex::new(Some(tx)),
        });

        let adapter = PortablePtyAdapter::new();
        let terminal = TerminalId::new();
        adapter
            .spawn(terminal, &profile, TerminalSize::default(), sink)
            .unwrap();

        adapter.kill(terminal).expect("kill debe reportar éxito");
        rx.recv_timeout(Duration::from_secs(10))
            .expect("el proceso no terminó después de kill");
        // Una terminal ya terminada se puede volver a cerrar sin error.
        adapter.kill(terminal).unwrap();
    }

    #[test]
    fn a_blocked_terminal_does_not_block_the_others() {
        // Simula una terminal cuyo proceso no lee: su writer queda trabado.
        let adapter = Arc::new(PortablePtyAdapter::new());
        let stuck = TerminalId::new();
        let profile = if cfg!(windows) {
            AgentProfile::new("wait", "cmd.exe")
                .unwrap()
                .with_args(["/C", "ping -n 30 127.0.0.1 >NUL"])
        } else {
            AgentProfile::new("wait", "sh")
                .unwrap()
                .with_args(["-c", "sleep 30"])
        };
        adapter
            .spawn(stuck, &profile, TerminalSize::default(), Arc::new(NullSink))
            .unwrap();
        let writer = adapter.handles.lock().unwrap()[&stuck].writer.clone();
        let held = writer.lock().unwrap(); // escritura "en curso" que no termina

        // Mientras tanto, las operaciones sobre otras terminales no esperan.
        let other = adapter.clone();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let _ = other.process_id(TerminalId::new());
            let _ = other.write(TerminalId::new(), b"x");
            tx.send(()).unwrap();
        });
        let finished = rx.recv_timeout(Duration::from_secs(2)).is_ok();
        drop(held);
        adapter.kill(stuck).unwrap();
        assert!(
            finished,
            "una escritura trabada bloqueó a las demás terminales"
        );
    }

    struct NullSink;
    impl TerminalOutputSink for NullSink {
        fn output(&self, _terminal: TerminalId, _data: &[u8]) {}
        fn exited(&self, _terminal: TerminalId) {}
    }

    #[test]
    fn writing_to_unknown_terminal_fails() {
        let adapter = PortablePtyAdapter::new();
        assert!(adapter.write(TerminalId::new(), b"x").is_err());
    }
}

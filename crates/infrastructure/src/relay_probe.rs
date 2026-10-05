//! Sondeo del relay por HTTP: `GET /health` con `std::net`, sin runtime async.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use application::ports::{PortError, RelayProbe};

/// Tope de lo que se lee de la respuesta: `/health` responde unos bytes.
const MAX_RESPONSE: usize = 4096;

/// Sondea `GET /health` del relay. Sale bien solo con `200` y cuerpo `ok`, y
/// mide el tiempo de ida y vuelta (conexión + respuesta completa).
pub struct HttpRelayProbe {
    addr: String,
    timeout: Duration,
}

impl HttpRelayProbe {
    /// Tiempo máximo total de un sondeo: corre en un hilo propio, pero no debe
    /// quedar colgado contra un relay que no contesta.
    pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(1);

    /// `addr` es `host:puerto` (por ejemplo `127.0.0.1:8787`).
    pub fn new(addr: impl Into<String>) -> Self {
        Self::with_timeout(addr, Self::DEFAULT_TIMEOUT)
    }

    pub fn with_timeout(addr: impl Into<String>, timeout: Duration) -> Self {
        Self {
            addr: addr.into(),
            timeout,
        }
    }

    fn fetch(&self, deadline: Instant) -> Result<Vec<u8>, PortError> {
        let target = self
            .addr
            .to_socket_addrs()
            .map_err(|e| PortError::new(format!("dirección del relay inválida: {e}")))?
            .next()
            .ok_or_else(|| PortError::new("dirección del relay sin resolver"))?;
        let mut stream = TcpStream::connect_timeout(&target, self.timeout)
            .map_err(|e| PortError::new(format!("relay inaccesible: {e}")))?;
        stream
            .set_write_timeout(Some(remaining(deadline)?))
            .map_err(|e| PortError::new(e.to_string()))?;
        // Un solo write: el pedido llega entero en un segmento y el servidor no lo ve a medias.
        let request = format!(
            "GET /health HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
            self.addr
        );
        stream
            .write_all(request.as_bytes())
            .map_err(|e| PortError::new(format!("no se pudo consultar al relay: {e}")))?;

        let mut response = Vec::new();
        let mut chunk = [0u8; 512];
        loop {
            // El timeout de lectura se recalcula en cada vuelta para que un
            // servidor que gotea bytes no estire el sondeo más allá del plazo.
            stream
                .set_read_timeout(Some(remaining(deadline)?))
                .map_err(|e| PortError::new(e.to_string()))?;
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    response.extend_from_slice(&chunk[..n]);
                    if response.len() > MAX_RESPONSE {
                        return Err(PortError::new("respuesta del relay demasiado larga"));
                    }
                }
                Err(e) => return Err(PortError::new(format!("relay sin respuesta: {e}"))),
            }
        }
        Ok(response)
    }
}

fn remaining(deadline: Instant) -> Result<Duration, PortError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or_else(|| PortError::new("el relay no respondió a tiempo"))
}

/// `true` si la respuesta HTTP es `200` con cuerpo `ok`.
fn is_healthy(response: &[u8]) -> bool {
    let text = String::from_utf8_lossy(response);
    let Some((head, body)) = text.split_once("\r\n\r\n") else {
        return false;
    };
    let status_ok = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .is_some_and(|code| code == "200");
    status_ok && body.trim() == "ok"
}

impl RelayProbe for HttpRelayProbe {
    fn probe(&self) -> Result<Duration, PortError> {
        let started = Instant::now();
        let response = self.fetch(started + self.timeout)?;
        let latency = started.elapsed();
        if is_healthy(&response) {
            Ok(latency)
        } else {
            Err(PortError::new("el relay respondió algo distinto de 200 ok"))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;
    use std::thread;

    use super::*;

    /// Servidor de un solo uso: acepta una conexión, lee el pedido y responde
    /// `reply` (o no responde nada si es `None`, quedándose colgado).
    fn serve_once(reply: Option<&'static str>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                match reply {
                    Some(text) => {
                        let _ = stream.write_all(text.as_bytes());
                    }
                    None => thread::sleep(Duration::from_secs(3)),
                }
            }
        });
        addr
    }

    const OK: &str = "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok";

    #[test]
    fn healthy_relay_returns_latency() {
        let probe = HttpRelayProbe::new(serve_once(Some(OK)));
        assert!(probe.probe().is_ok());
    }

    #[test]
    fn non_200_is_an_error() {
        let reply = "HTTP/1.1 503 Service Unavailable\r\ncontent-length: 2\r\n\r\nok";
        assert!(HttpRelayProbe::new(serve_once(Some(reply)))
            .probe()
            .is_err());
    }

    #[test]
    fn wrong_body_is_an_error() {
        let reply = "HTTP/1.1 200 OK\r\ncontent-length: 4\r\n\r\nnope";
        assert!(HttpRelayProbe::new(serve_once(Some(reply)))
            .probe()
            .is_err());
    }

    #[test]
    fn garbage_is_an_error() {
        let probe = HttpRelayProbe::new(serve_once(Some("esto no es http")));
        assert!(probe.probe().is_err());
    }

    #[test]
    fn closed_port_fails_quickly() {
        // Se reserva un puerto libre y se suelta: nadie escucha ahí.
        let addr = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .to_string();
        let started = Instant::now();
        assert!(HttpRelayProbe::new(addr).probe().is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn hung_server_fails_within_the_timeout() {
        let probe = HttpRelayProbe::with_timeout(serve_once(None), Duration::from_millis(300));
        let started = Instant::now();
        assert!(probe.probe().is_err());
        assert!(started.elapsed() < Duration::from_millis(1500));
    }

    #[test]
    fn invalid_address_is_an_error() {
        assert!(HttpRelayProbe::new("no-es-una-direccion").probe().is_err());
    }
}

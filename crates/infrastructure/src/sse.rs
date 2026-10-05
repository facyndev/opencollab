//! Piezas mínimas para consumir un stream SSE por HTTP/1.1 con `std::net`,
//! sin sumar un cliente HTTP: base64 para la autenticación básica, decodificador
//! de `Transfer-Encoding: chunked`, separador de líneas y parseo del encabezado.

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(BASE64[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Valor del encabezado `Authorization` para autenticación básica.
pub fn basic_auth(user: &str, password: &str) -> String {
    format!("Basic {}", base64(format!("{user}:{password}").as_bytes()))
}

/// Encabezado de una respuesta HTTP.
#[derive(Debug, PartialEq, Eq)]
pub struct ResponseHead {
    pub status: u16,
    pub chunked: bool,
    /// Bytes que ocupa el encabezado (incluido el `\r\n\r\n`).
    pub len: usize,
}

/// `None` mientras el encabezado no llegó completo (o es inválido).
pub fn parse_response_head(buf: &[u8]) -> Option<ResponseHead> {
    let end = buf.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&buf[..end]);
    let mut lines = head.split("\r\n");
    let status = lines.next()?.split_whitespace().nth(1)?.parse().ok()?;
    let chunked = lines.any(|l| {
        l.split_once(':').is_some_and(|(k, v)| {
            k.trim().eq_ignore_ascii_case("transfer-encoding")
                && v.to_ascii_lowercase().contains("chunked")
        })
    });
    Some(ResponseHead {
        status,
        chunked,
        len: end + 4,
    })
}

#[derive(Debug, Default)]
enum ChunkState {
    #[default]
    Size,
    Data(usize),
    DataEnd,
    Done,
}

/// Decodifica `Transfer-Encoding: chunked` de forma incremental: tolera que un
/// bloque (o su encabezado de tamaño) llegue partido en varias lecturas.
#[derive(Debug, Default)]
pub struct ChunkDecoder {
    state: ChunkState,
    size_line: Vec<u8>,
}

impl ChunkDecoder {
    pub fn finished(&self) -> bool {
        matches!(self.state, ChunkState::Done)
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            match self.state {
                ChunkState::Size => {
                    let b = bytes[i];
                    i += 1;
                    if b != b'\n' {
                        // Tope defensivo: una línea de tamaño es de pocos dígitos.
                        if self.size_line.len() < 32 {
                            self.size_line.push(b);
                        }
                        continue;
                    }
                    let line = String::from_utf8_lossy(&self.size_line).into_owned();
                    self.size_line.clear();
                    let hex = line.split(';').next().unwrap_or("").trim();
                    self.state = match usize::from_str_radix(hex, 16) {
                        Ok(0) => ChunkState::Done,
                        Ok(n) => ChunkState::Data(n),
                        Err(_) => ChunkState::Size,
                    };
                }
                ChunkState::Data(remaining) => {
                    let take = remaining.min(bytes.len() - i);
                    out.extend_from_slice(&bytes[i..i + take]);
                    i += take;
                    self.state = if take == remaining {
                        ChunkState::DataEnd
                    } else {
                        ChunkState::Data(remaining - take)
                    };
                }
                // CRLF que cierra cada bloque.
                ChunkState::DataEnd => {
                    if bytes[i] == b'\n' {
                        self.state = ChunkState::Size;
                    }
                    i += 1;
                }
                ChunkState::Done => break,
            }
        }
        out
    }
}

/// Parte un flujo de bytes en líneas (sin `\r\n`). Una línea más larga que
/// `max` se descarta entera, para que un evento enorme no llene la memoria.
#[derive(Debug)]
pub struct LineSplitter {
    buf: Vec<u8>,
    max: usize,
    overflowed: bool,
}

impl LineSplitter {
    pub fn new(max: usize) -> Self {
        Self {
            buf: Vec::new(),
            max,
            overflowed: false,
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut lines = Vec::new();
        for &b in bytes {
            if b == b'\n' {
                if !self.overflowed {
                    let line = String::from_utf8_lossy(&self.buf);
                    lines.push(line.trim_end_matches('\r').to_string());
                }
                self.buf.clear();
                self.overflowed = false;
            } else if !self.overflowed {
                if self.buf.len() >= self.max {
                    self.overflowed = true;
                    self.buf.clear();
                } else {
                    self.buf.push(b);
                }
            }
        }
        lines
    }
}

/// Carga de una línea `data: ...` de SSE.
pub fn sse_data(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("data:")?;
    Some(rest.strip_prefix(' ').unwrap_or(rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_rfc_4648_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(
            basic_auth("opencode", "secret"),
            "Basic b3BlbmNvZGU6c2VjcmV0"
        );
    }

    #[test]
    fn response_head_reports_status_and_chunking() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n";
        let head = parse_response_head(raw).unwrap();
        assert_eq!((head.status, head.chunked), (200, true));
        assert_eq!(&raw[head.len..head.len + 1], b"5");
        assert_eq!(
            parse_response_head(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
                .map(|h| (h.status, h.chunked)),
            Some((401, false))
        );
        assert_eq!(parse_response_head(b"HTTP/1.1 200 OK\r\nPartial"), None);
    }

    #[test]
    fn chunks_are_decoded_even_when_split_anywhere() {
        let wire = b"5\r\nhello\r\nb\r\n world\r\nfoo\r\n0\r\n\r\n";
        // Todo junto.
        let mut whole = ChunkDecoder::default();
        assert_eq!(whole.feed(wire), b"hello world\r\nfoo");
        assert!(whole.finished());
        // Byte por byte: el resultado es el mismo.
        let mut split = ChunkDecoder::default();
        let out: Vec<u8> = wire.iter().flat_map(|b| split.feed(&[*b])).collect();
        assert_eq!(out, b"hello world\r\nfoo");
        assert!(split.finished());
    }

    #[test]
    fn lines_are_split_across_feeds_and_crlf_is_trimmed() {
        let mut lines = LineSplitter::new(100);
        assert!(lines.feed(b"data: {\"a\"").is_empty());
        assert_eq!(
            lines.feed(b":1}\r\n\r\ndata: x\n"),
            vec!["data: {\"a\":1}", "", "data: x"]
        );
    }

    #[test]
    fn an_overlong_line_is_dropped_whole() {
        let mut lines = LineSplitter::new(8);
        assert_eq!(
            lines.feed(b"0123456789ABCDEF\nshort\n"),
            vec!["short".to_string()]
        );
    }

    #[test]
    fn sse_data_strips_the_prefix() {
        assert_eq!(sse_data("data: {\"x\":1}"), Some("{\"x\":1}"));
        assert_eq!(sse_data("data:{\"x\":1}"), Some("{\"x\":1}"));
        assert_eq!(sse_data(": comment"), None);
        assert_eq!(sse_data("event: ping"), None);
    }
}

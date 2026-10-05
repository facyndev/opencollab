//! Composition root del relay. Por ahora: `/health` y un WebSocket stub que
//! valida la versión del protocolo y responde con eco.

use std::net::SocketAddr;

use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use protocol::Envelope;

fn app() -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws_upgrade))
}

async fn health() -> &'static str {
    "ok"
}

async fn ws_upgrade(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(handle_socket)
}

// TODO: autenticar, enrutar por sesión y filtrar por permiso vigente.
async fn handle_socket(mut socket: WebSocket) {
    while let Some(Ok(msg)) = socket.recv().await {
        let WsMessage::Text(text) = msg else {
            continue;
        };
        let reply = match serde_json::from_str::<Envelope>(&text) {
            Ok(envelope) if envelope.is_compatible() => text,
            Ok(_) => r#"{"error":"incompatible_protocol_version"}"#.into(),
            Err(_) => r#"{"error":"invalid_message"}"#.into(),
        };
        if socket.send(WsMessage::Text(reply)).await.is_err() {
            break;
        }
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "relay=info".into()),
        )
        .init();

    let addr: SocketAddr = std::env::var("RELAY_ADDR")
        .unwrap_or_else(|_| protocol::DEFAULT_RELAY_ADDR.into())
        .parse()
        .expect("RELAY_ADDR inválida");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("no se pudo abrir el puerto del relay");
    tracing::info!("relay escuchando en {addr}");
    axum::serve(listener, app()).await.expect("el relay falló");
}

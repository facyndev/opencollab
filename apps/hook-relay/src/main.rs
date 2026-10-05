//! Sidecar `opencollab-hook <agente>`: nunca imprime ni falla (ver `hook_relay`).

fn main() {
    hook_relay::run(
        std::env::args().nth(1),
        |name| std::env::var(name).ok(),
        std::io::stdin().lock(),
    );
}

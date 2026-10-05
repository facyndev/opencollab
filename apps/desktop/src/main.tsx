import { createRoot } from "react-dom/client";
// Fuente empaquetada con la app (funciona sin conexión), pesos 400–700.
import "@fontsource-variable/google-sans";

import { App } from "./App";
import "./styles.css";

// Sin StrictMode: su doble montaje en dev abriría un PTY extra por terminal,
// y todavía no existe un comando para cerrarlos.
createRoot(document.getElementById("root")!).render(<App />);

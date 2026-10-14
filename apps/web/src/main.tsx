import "@fontsource-variable/google-sans";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createAuthClient } from "./services/authClient";
import { captureInitialHandoff } from "./services/handoff";
import "./styles.css";

// Run once, before the first render (outside React, so StrictMode cannot repeat it).
captureInitialHandoff(window.location);

createRoot(document.getElementById("root")!).render(<App client={createAuthClient()} />);

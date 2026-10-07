import "@fontsource-variable/google-sans";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createAuthClient } from "./authClient";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App client={createAuthClient()} />);

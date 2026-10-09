import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import "@fontsource-variable/manrope";
import "./index.css";
import { App } from "./App.tsx";
import { restoreSession } from "./lib/auth.ts";

// Installs the service worker so the app shell opens with no connection. A new version waits until the app is
// next opened fresh, so an update never reloads the page under a teacher who is midway through a register.
registerSW({ immediate: true });

void restoreSession();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

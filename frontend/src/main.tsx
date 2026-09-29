import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { OnScreenKeyboard } from "./components/OnScreenKeyboard.js";
import { IS_KIOSK, initKiosk } from "./lib/kiosk.js";
import { applyStoredTheme } from "./components/ThemeToggle.js";
import "./styles.css";

applyStoredTheme();
initKiosk();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    {/* Outside App so it also serves the access gate's password field. */}
    {IS_KIOSK && <OnScreenKeyboard />}
  </React.StrictMode>,
);

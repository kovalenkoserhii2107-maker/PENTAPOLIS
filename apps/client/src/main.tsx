import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";

// PWA: offline shell and Web Push. BASE_URL keeps it working under a GitHub Pages sub-path.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  const register = () =>
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .catch(() => undefined); // non-fatal in browsers without service workers
  if (document.readyState === "complete") void register();
  else window.addEventListener("load", () => void register(), { once: true });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

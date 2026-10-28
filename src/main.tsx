import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import AuthGate from "./AuthGate";
import "./styles.css";
import { ensureFonts } from "./renderers/svg";
// Font metrics must be ready before constructing/restoring automatic text bounds.
ensureFonts()
  .then(() => {
    createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <AuthGate>
          <App />
        </AuthGate>
      </React.StrictMode>,
    );
  })
  .catch(() => {
    const root = document.getElementById("root")!;
    root.setAttribute("role", "alert");
    root.textContent =
      "로컬 글꼴을 불러오지 못했습니다. 새로고침해 다시 시도해 주세요.";
  });

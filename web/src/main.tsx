import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "./design/fonts/fonts.css";
import "./index.css";
import "./i18n";
import { App } from "./App";
import { LearnerProvider } from "./lib/learner";
import { WorkspaceProvider } from "./lib/workspace";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <WorkspaceProvider>
        <LearnerProvider>
          <App />
        </LearnerProvider>
      </WorkspaceProvider>
    </BrowserRouter>
  </StrictMode>,
);

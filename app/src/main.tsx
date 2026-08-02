import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { bootstrapReviewerSession } from "./data/reviewerSession";
import "./styles/global.css";

bootstrapReviewerSession();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

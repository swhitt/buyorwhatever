import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { ErrorBoundary } from "./ErrorBoundary";

// Two routes, no router: /calc is the stripped-down "quick answer" mode, everything
// else is the full calculator. Each is lazy so a visit only ships that route's code.
const App = lazy(() => import("./App").then((m) => ({ default: m.App })));
const SimpleCalc = lazy(() => import("./SimpleCalc").then((m) => ({ default: m.SimpleCalc })));

const path = window.location.pathname.replace(/\/+$/, "");
const isCalc = path.endsWith("/calc");
const metroSlug = path.replace(/^\//, ""); // "" at root, e.g. "houston-tx" for /houston-tx

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <Suspense fallback={<div className="min-h-screen bg-paper" />}>
        {isCalc ? <SimpleCalc /> : <App initialMetroSlug={metroSlug || undefined} />}
      </Suspense>
    </ErrorBoundary>
  </StrictMode>,
);

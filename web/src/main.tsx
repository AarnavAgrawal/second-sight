import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { EvalDashboard } from "./components/EvalDashboard.tsx";
import "./styles.css";

/** "#/eval/KSFO" shows the shadow evaluation; anything else is the scope. */
function Root() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const m = /^#\/eval(?:\/([A-Za-z0-9]{3,4}))?/.exec(hash);
  return m ? <EvalDashboard icao={(m[1] ?? "KSFO").toUpperCase()} /> : <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

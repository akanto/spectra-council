/** The view's entry in Mirador's canvas frame: `window.mirador` made into the view's CouncilBridge. */
import { createRoot } from "react-dom/client";
import type { Review } from "../../core/model.ts";
import { App } from "../../view/App.tsx";
import styles from "../../view/styles.css" with { type: "text" };
import type { PluginViewBridge } from "./api.ts";
import { councilBridge, reportToConsole } from "./view-bridge.ts";

declare global {
  interface Window {
    mirador: PluginViewBridge<Review>;
  }
}

const style = document.createElement("style");
style.textContent = styles;
document.head.append(style);

const root = document.createElement("div");
root.id = "root";
document.body.append(root);
// React reports what a render throws to the console too, so Mirador shows its message whichever way WebKit would.
createRoot(root, {
  onUncaughtError: (error) => reportToConsole("the view failed", error),
  onRecoverableError: (error) => reportToConsole("the view recovered from", error),
}).render(<App bridge={councilBridge(window.mirador)} />);

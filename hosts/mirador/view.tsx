/** The view's entry in Mirador's canvas frame: `window.mirador` made into the view's CouncilBridge. */
import { createRoot } from "react-dom/client";
import type { Review } from "../../core/model.ts";
import { upgradeReview } from "../../core/review.ts";
import { App } from "../../view/App.tsx";
import type { CouncilBridge } from "../../view/bridge.ts";
import styles from "../../view/styles.css" with { type: "text" };
import type { PluginViewBridge } from "./api.ts";

declare global {
  interface Window {
    mirador: PluginViewBridge<Review>;
  }
}

const mirador = window.mirador;

const bridge: CouncilBridge = {
  onReview: (listener) => mirador.onItem((item) => listener(upgradeReview(item.data))),
  send: (action) => mirador.send(action),
  ...(mirador.openFile ? { openFile: (path: string) => mirador.openFile!(path) } : {}),
};

const style = document.createElement("style");
style.textContent = styles;
document.head.append(style);

const root = document.createElement("div");
root.id = "root";
document.body.append(root);
createRoot(root).render(<App bridge={bridge} />);

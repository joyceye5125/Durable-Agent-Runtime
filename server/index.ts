import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createApp } from "./app";
import { llmMode } from "./llm/recording";
import { Store } from "./store/store";

const root = path.resolve(import.meta.dirname, "..");
const store = await Store.open();
const app = createApp({ store });

if (process.env.NODE_ENV === "development") {
  const { createServer } = await import("vite");
  const vite = await createServer({ root: path.join(root, "web"), server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
} else {
  const dist = path.join(root, "dist");
  if (!fs.existsSync(path.join(dist, "index.html"))) {
    console.error("[web] dist/ is missing — run `npm run build` (npm start does this for you)");
  }
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

const port = Number(process.env.PORT ?? 3000);
app.listen(port, "0.0.0.0", () => {
  console.log(`[web] http://localhost:${port}  (LLM: ${llmMode() === "live" ? "LIVE — calls the model and records" : "replay from recordings/, no API key used"})`);
});

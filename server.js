// server.js (place this at your repo root)
//
// Runs your frontend at http://localhost:3000 by serving src/frontend as static files.
// Also includes an optional /gemma proxy (commented) so the browser can talk to
// a local Gemma runner (e.g., Ollama on localhost:11434) without CORS issues.

import express from "express";
import path from "path";
import { fileURLToPath } from "url";

// Node 18+ has global fetch. If you're on Node < 18, install node-fetch.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ---- Serve frontend ----
const FRONTEND_DIR = path.join(__dirname, "src", "frontend");
app.use(express.static(FRONTEND_DIR));

// Optional: default route
app.get("/", (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

// ---- Optional: proxy to local Gemma runner (Ollama) to avoid browser CORS ----
// Enable this if your frontend fetch to http://localhost:11434 is blocked by CORS.
// Frontend would call: fetch("/gemma/chat", { ... })
//
// app.use(express.json({ limit: "50mb" }));
//
// app.post("/gemma/chat", async (req, res) => {
//   try {
//     const r = await fetch("http://localhost:11434/api/chat", {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify(req.body),
//     });
//
//     const text = await r.text();
//     res.status(r.status).send(text);
//   } catch (err) {
//     res.status(500).json({ error: String(err) });
//   }
// });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ FormCheck running at http://localhost:${PORT}`);
  console.log(`📁 Serving static files from: ${FRONTEND_DIR}`);
});
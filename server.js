// server.js - Gemini with retry + local KB fallback
import express from "express";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors());

// Protect the server from heavy abuse (this is separate from Gemini rate limits)
app.use(rateLimit({ windowMs: 60 * 1000, max: 80 }));

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
if (!GEMINI_KEY) console.warn("⚠ No Gemini key found. Set GEMINI_API_KEY in .env");

// Local KB (fast answers for profile/FAQ)
function localProfileKB(prompt) {
  const p = prompt.toLowerCase();
  if (p.includes("hello") || p.includes("hi") || p.includes("hey")) {
    return "Hello! I am SK Pinkun — Kalu's virtual assistant. Ask me about his skills, projects, or contact info.";
  }
  if (p.includes("kalu") || p.includes("who are you") || p.includes("name")) {
    return "Kalu Ch Sahu — DevOps & Network Security Engineer (B.Tech 5th Semester).";
  }
  if (p.includes("skills") || p.includes("skill") || p.includes("tech stack")) {
    return "Skills: Azure AKS, Docker, Terraform, CI/CD, GitHub Actions, Python, Linux, Networking.";
  }
  if (p.includes("education") || p.includes("college")) {
    return "B.Tech in Computer Science at Gayatri College of Engineering (5th Semester).";
  }
  if (p.includes("certi") || p.includes("az-") || p.includes("certification")) {
    return "Certifications: AZ-400 (DevOps), AZ-204, AZ-900.";
  }
  if (p.includes("contact") || p.includes("email") || p.includes("phone")) {
    return "Email: kalusahu902@gmail.com — LinkedIn button on the page.";
  }
  if (p.includes("project") || p.includes("featured")) {
    return "Featured project: Secure Cloud Migration to Azure AKS with ingress & Azure Policy.";
  }
  // return null when no local KB match
  return null;
}

// Helper: call Gemini with retry/backoff
async function callGeminiWithRetry(prompt, system, retries = 3) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_KEY}`;
  const body = {
    contents: [{ parts: [{ text: `${system}\nUser: ${prompt}` }] }]
  };

  let attempt = 0;
  let delay = 500; // initial backoff ms

  while (attempt <= retries) {
    attempt++;
    try {
      console.log(`[gemini] attempt ${attempt} -> calling Gemini`);
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeout: 20000
      });

      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch(e) {
        // non-JSON response
        throw new Error(`Non-JSON response (status ${resp.status}): ${text}`);
      }

      if (!resp.ok) {
        // If 429, we'll retry (unless we've exhausted)
        if (resp.status === 429) {
          console.warn(`[gemini] 429 received (attempt ${attempt})`);
          if (attempt > retries) {
            const err = new Error("Rate limited by Gemini after retries");
            err.detail = data;
            throw err;
          } else {
            // exponential backoff before retrying
            await new Promise(r => setTimeout(r, delay));
            delay *= 2;
            continue;
          }
        }
        // other non-OK status: throw with provider detail
        const err = new Error(`Gemini error status ${resp.status}`);
        err.detail = data;
        throw err;
      }

      // success path
      if (!data?.candidates?.length) {
        const err = new Error("Gemini returned empty candidates");
        err.detail = data;
        throw err;
      }

      const reply = data.candidates[0].content.parts[0].text;
      return reply;

    } catch (err) {
      console.error(`[gemini] attempt ${attempt} failed:`, err.message || err);
      // if last attempt, rethrow
      if (attempt > retries) throw err;
      // otherwise wait and retry
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
  } // while
  throw new Error("Retries exhausted");
}

app.post("/api/generate", async (req, res) => {
  try {
    const { prompt = "", system = "You are SK Pinkun, the assistant for Kalu Ch Sahu." } = req.body;
    if (!prompt) return res.status(400).json({ error: "No prompt provided" });

    // 1) Try local KB first (fast & avoids cost / rate limits)
    const local = localProfileKB(prompt);
    if (local) {
      return res.json({ reply: local, source: "local" });
    }

    // 2) If no local KB match, call Gemini with retry/backoff
    if (!GEMINI_KEY) {
      // no key: fallback to local friendly reply
      return res.json({
        reply: "Gemini key is not configured on the server. I can still answer basic profile questions. Email: kalusahu902@gmail.com",
        source: "fallback"
      });
    }

    try {
      const reply = await callGeminiWithRetry(prompt, system, 3);
      return res.json({ reply, source: "gemini" });
    } catch (gemErr) {
      // If Gemini failed after retries, return an informative fallback to user
      console.error("[server] Gemini final failure:", gemErr.message, gemErr.detail ?? "");
      return res.json({
        reply:
          "Sorry — my language model is temporarily rate-limited. I can still answer basic questions about Kalu (skills, education, contact). Try asking: 'What are Kalu's skills?'.",
        source: "fallback",
        detail: gemErr.detail ?? gemErr.message
      });
    }

  } catch (err) {
    console.error("[server] error:", err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
});

app.get("/_health", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Gemini AI Server (retry) running on port ${PORT}`));
s
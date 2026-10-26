require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

// Jo users pehle process ho chuke (webhook ya polling, dono ke liye common)
// NOTE: Render restart par ye reset ho jata hai
const processed = new Set();

// ---------------------------------------------------------------
// Sprinklr access token: server khud banata hai (client_credentials)
// Token ~8 ghante chalta hai, isliye cache karke expire se pehle naya leta hai
// ---------------------------------------------------------------
let tokenCache = { token: null, expiresAt: 0 };

async function getSprinklrToken(force = false) {
  // Agar client_secret nahi diya, toh haath se daala hua token use karo
  if (!process.env.SPRINKLR_CLIENT_SECRET) return process.env.SPRINKLR_ACCESS_TOKEN;

  if (!force && tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const creds = {
    client_id: process.env.SPRINKLR_CLIENT_ID || process.env.SPRINKLR_API_KEY,
    client_secret: process.env.SPRINKLR_CLIENT_SECRET,
    grant_type: "client_credentials",
  };

  let resp;
  try {
    // Pehle form body ke saath try karo
    resp = await axios.post(
      process.env.SPRINKLR_TOKEN_URL,
      new URLSearchParams(creds).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
      }
    );
  } catch (err) {
    // Nahi chala toh query params ke saath try karo
    if (err.response && [400, 415].includes(err.response.status)) {
      resp = await axios.post(process.env.SPRINKLR_TOKEN_URL, null, {
        params: creds,
        headers: { Accept: "application/json" },
      });
    } else {
      throw err;
    }
  }

  const { access_token, expires_in } = resp.data;
  const ttl = Math.max(Number(expires_in || 3600) - 300, 60); // 5 minute pehle refresh
  tokenCache = { token: access_token, expiresAt: Date.now() + ttl * 1000 };
  console.log("Naya Sprinklr token liya, expires_in:", expires_in);
  return access_token;
}

// Users ki list lao. 401 aaye toh naya token lekar ek baar dobara try karo
async function fetchSprinklrUsers() {
  const call = async (force) =>
    axios.get(process.env.SPRINKLR_SCIM_URL, {
      headers: {
        Authorization: `Bearer ${await getSprinklrToken(force)}`,
        Key: process.env.SPRINKLR_API_KEY,
        Accept: "application/json",
      },
    });

  try {
    return await call(false);
  } catch (err) {
    if (err.response?.status === 401 && process.env.SPRINKLR_CLIENT_SECRET) {
      console.log("401, fetching the new user");
      return await call(true);
    }
    throw err;
  }
}

app.get("/", (req, res) => res.send("Webhook server is runnnig.."));

// ---------------------------------------------------------------
// Dusra step: user ki details Telegram (ya kisi API) ko bhejna
// ---------------------------------------------------------------
async function notifySecondApi(user, source) {
  const text =
    `Naya user bana (${source}):\n` +
    `Email: ${user.userName}\n` +
    `Naam: ${user.givenName} ${user.familyName}\n` +
    `Active: ${user.active}\n` +
    `ID: ${user.id}`;

  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    return axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: process.env.TELEGRAM_CHAT_ID, text }
    );
  }

  if (process.env.TARGET_API_URL) {
    return axios.post(
      process.env.TARGET_API_URL,
      {
        id: user.id,
        userName: user.userName,
        givenName: user.givenName,
        familyName: user.familyName,
        active: user.active,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.TARGET_API_KEY}`,
        },
      }
    );
  }

  throw new Error("Na Telegram set hai, na TARGET_API_URL");
}

// ---------------------------------------------------------------
// Raasta 1: Sprinklr webhook (UI / manual se bane users)
// ---------------------------------------------------------------
app.post("/webhook", async (req, res) => {
  if (req.query.token !== process.env.WEBHOOK_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body = req.body || {};
  res.status(200).json({ received: true });

  if (!body.type) {
    console.log("Verification / khaali request, skip");
    return;
  }
  console.log("Event aaya:", body.type, "| event id:", body.id);
  if (body.type !== "user.created") return;

  try {
    const p = body.payload || {};
    if (!p.id) return;
    if (processed.has(p.id)) {
      console.log("user already processed:", p.id);
      return;
    }
    processed.add(p.id);

    const user = {
      id: p.id,
      userName: p.userName,
      givenName: p.name?.givenName,
      familyName: p.name?.familyName,
      active: p.active,
    };
    const r = await notifySecondApi(user, "webhook");
    console.log("second API call success (webhook):", r.status, user.userName);
  } catch (err) {
    console.error("second API call fail (webhook):", err.response?.status, err.response?.data || err.message);
  }
});

// ---------------------------------------------------------------
// Raasta 2: Polling (API / SCIM se bane users, jinka webhook nahi aata)
// Sprinklr se users ki list mangta hai, jo naye dikhe unko bhejta hai
// ---------------------------------------------------------------
const WINDOW_MIN = Number(process.env.POLL_WINDOW_MIN || 10);
let polling = false;

// Sprinklr ka createdTime UTC mein hota hai: "2026-10-26 06:29:58"
function parseSprinklrTime(s) {
  if (!s) return null;
  const t = new Date(String(s).replace(" ", "T") + "Z").getTime();
  return Number.isNaN(t) ? null : t;
}

async function pollNewUsers() {
  if (polling) return { skipped: "last poll is running" };
  polling = true;

  try {
    const resp = await fetchSprinklrUsers();

    const data = resp.data;
    const list = Array.isArray(data)
      ? data
      : data.Resources || data.resources || data.users || data.data || [];

    if (!list.length) {
      console.log("Poll: list is empty or the format is different. Response keys:", Object.keys(data || {}));
    }

    const cutoff = Date.now() - WINDOW_MIN * 60 * 1000;
    const fresh = list.filter((u) => {
      const t = parseSprinklrTime(u.meta?.createdTime);
      return t && t >= cutoff && !processed.has(u.id);
    });

    console.log(`Poll: ${list.length} users check, ${fresh.length} found new`);

    for (const u of fresh) {
      processed.add(u.id);
      const user = {
        id: u.id,
        userName: u.userName,
        givenName: u.name?.givenName,
        familyName: u.name?.familyName,
        active: u.active,
      };
      try {
        const r = await notifySecondApi(user, "polling");
        console.log("Second API call success (poll):", r.status, user.userName);
      } catch (err) {
        console.error("Second API call fail (poll):", err.response?.status, err.response?.data || err.message);
      }
    }

    return { checked: list.length, notified: fresh.length };
  } catch (err) {
    console.error("Poll fail:", err.response?.status, err.response?.data || err.message);
    return { error: err.response?.status || err.message };
  } finally {
    polling = false;
  }
}

// Bahar se (cron-job.org) har minute is URL ko hit karo: server jagega aur poll hoga
app.get("/poll", async (req, res) => {
  if (req.query.token !== process.env.POLL_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const result = await pollNewUsers();
  res.json(result);
});

// Server jaga ho toh khud bhi har POLL_INTERVAL_SEC (default 60) second mein poll karo
if (process.env.SPRINKLR_SCIM_URL) {
  const every = Number(process.env.POLL_INTERVAL_SEC || 60) * 1000;
  setInterval(pollNewUsers, every);
  console.log(`Auto polling on: every ${every / 1000} second`);
}

app.listen(PORT, () => console.log(`Server port ${PORT} running`));

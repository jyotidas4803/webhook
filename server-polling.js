
require("dotenv").config();

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

// Already processed users
const processed = new Set();

// -------------------------------
// SPRINKLR TOKEN MANAGEMENT
// -------------------------------

let tokenCache = {
  token: null,
  expiresAt: 0,
};

async function getSprinklrToken(force = false) {
  if (!process.env.SPRINKLR_CLIENT_SECRET) {
    if (!process.env.SPRINKLR_ACCESS_TOKEN) {
      throw new Error("Sprinklr token not configured");
    }
    return process.env.SPRINKLR_ACCESS_TOKEN;
  }

  if (
    !force &&
    tokenCache.token &&
    Date.now() < tokenCache.expiresAt
  ) {
    return tokenCache.token;
  }

  const creds = {
    client_id:
      process.env.SPRINKLR_CLIENT_ID ||
      process.env.SPRINKLR_API_KEY,
    client_secret: process.env.SPRINKLR_CLIENT_SECRET,
    grant_type: "client_credentials",
  };

  let resp;

  try {
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
    if (
      err.response &&
      [400, 415].includes(err.response.status)
    ) {
      resp = await axios.post(
        process.env.SPRINKLR_TOKEN_URL,
        null,
        {
          params: creds,
          headers: {
            Accept: "application/json",
          },
        }
      );
    } else {
      throw err;
    }
  }

  const { access_token, expires_in } = resp.data;

  if (!access_token) {
    throw new Error("Token API did not return access_token");
  }

  const ttl = Math.max(
    Number(expires_in || 3600) - 300,
    60
  );

  tokenCache = {
    token: access_token,
    expiresAt: Date.now() + ttl * 1000,
  };

  console.log("Sprinklr token generated successfully");

  return access_token;
}

// -------------------------------
// FETCH ALL SPRINKLR USERS
// AUTOMATIC PAGINATION
// -------------------------------

async function fetchSprinklrUsers() {
  const allUsers = [];
  const pageSize = 100;

  let startIndex = 1;
  let totalResults = Infinity;

  while (startIndex <= totalResults) {
    const call = async (force) => {
      const token = await getSprinklrToken(force);

      return axios.get(process.env.SPRINKLR_SCIM_URL, {
        params: {
          startIndex,
          count: pageSize,
        },
        headers: {
          Authorization: `Bearer ${token}`,
          Key: process.env.SPRINKLR_API_KEY,
          Accept: "application/scim+json",
          "Content-Type": "application/scim+json",
        },
      });
    };

    let response;

    try {
      response = await call(false);
    } catch (err) {
      if (
        err.response?.status === 401 &&
        process.env.SPRINKLR_CLIENT_SECRET
      ) {
        console.log("Token expired. Refreshing...");
        response = await call(true);
      } else {
        throw err;
      }
    }

    const data = response.data;
    const users = data?.Resources || [];

    if (!Array.isArray(users)) {
      throw new Error("Invalid SCIM Resources format");
    }

    totalResults = Number(data.totalResults);

    if (!Number.isFinite(totalResults)) {
      throw new Error("Invalid SCIM totalResults");
    }

    allUsers.push(...users);

    console.log(
      `Fetched page starting at ${startIndex}: ${users.length} users`
    );

    if (users.length === 0) {
      if (startIndex <= totalResults) {
        throw new Error("SCIM returned an empty page before completion");
      }
      break;
    }

    startIndex += users.length;
  }

  console.log(`Total users fetched: ${allUsers.length}`);

  return {
    data: {
      Resources: allUsers,
    },
  };
}

// -------------------------------
// HOME ROUTE
// -------------------------------

app.get("/", (req, res) => {
  res.send("Webhook server is running");
});

// -------------------------------
// SECOND API - TELEGRAM
// -------------------------------

async function notifySecondApi(user, source) {
  const text =
    `New Sprinklr User Created (${source})\n\n` +
    `Email: ${user.userName || "N/A"}\n` +
    `Name: ${user.givenName || ""} ${user.familyName || ""}\n` +
    `Active: ${user.active}\n` +
    `ID: ${user.id}`;

  if (
    process.env.TELEGRAM_BOT_TOKEN &&
    process.env.TELEGRAM_CHAT_ID
  ) {
    return axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text,
      }
    );
  }

  if (process.env.TARGET_API_URL) {
    const headers = {
      "Content-Type": "application/json",
    };

    if (process.env.TARGET_API_KEY) {
      headers.Authorization =
        `Bearer ${process.env.TARGET_API_KEY}`;
    }

    return axios.post(
      process.env.TARGET_API_URL,
      {
        id: user.id,
        userName: user.userName,
        givenName: user.givenName,
        familyName: user.familyName,
        active: user.active,
      },
      { headers }
    );
  }

  throw new Error("Telegram or TARGET_API_URL not configured");
}

// -------------------------------
// WEBHOOK - UI CREATED USERS
// -------------------------------

app.post("/webhook", async (req, res) => {
  if (
    !process.env.WEBHOOK_TOKEN ||
    req.query.token !== process.env.WEBHOOK_TOKEN
  ) {
    return res.status(401).json({
      error: "Unauthorized",
    });
  }

  const body = req.body || {};

  res.status(200).json({
    received: true,
  });

  if (!body.type) {
    console.log("Webhook verification request received");
    return;
  }

  console.log("Webhook event:", body.type);

  if (body.type !== "user.created") {
    return;
  }

  const p = body.payload || {};

  if (!p.id || processed.has(String(p.id))) {
    return;
  }

  const user = {
    id: p.id,
    userName: p.userName,
    givenName: p.name?.givenName,
    familyName: p.name?.familyName,
    active: p.active,
  };

  try {
    const result = await notifySecondApi(
      user,
      "webhook"
    );

    processed.add(String(p.id));

    console.log(
      "Webhook notification success:",
      result.status
    );
  } catch (err) {
    console.error(
      "Webhook notification failed:",
      err.response?.status,
      err.response?.data || err.message
    );
  }
});

// -------------------------------
// POLLING CONFIGURATION
// -------------------------------

const WINDOW_MIN = Number(
  process.env.POLL_WINDOW_MIN || 10
);

let polling = false;

// Parse Sprinklr UTC timestamps
function parseSprinklrTime(value) {
  if (!value) return null;

  const str = String(value).trim();

  const normalized =
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)
      ? str.replace(" ", "T") + "Z"
      : str;

  const timestamp = new Date(normalized).getTime();

  return Number.isNaN(timestamp)
    ? null
    : timestamp;
}

// -------------------------------
// POLL NEW USERS
// -------------------------------

async function pollNewUsers() {
  if (polling) {
    return {
      skipped: "Previous poll still running",
    };
  }

  polling = true;

  try {
    const resp = await fetchSprinklrUsers();
    const data = resp.data;

    const list = Array.isArray(data)
      ? data
      : data?.Resources ||
        data?.resources ||
        data?.users ||
        data?.data ||
        [];

    if (!Array.isArray(list)) {
      throw new Error(
        "Unexpected SCIM response format"
      );
    }

    console.log(
      `Poll: ${list.length} users received`
    );

    const cutoff =
      Date.now() - WINDOW_MIN * 60 * 1000;

    const fresh = list.filter((u) => {
      const created = parseSprinklrTime(
        u.meta?.createdTime
      );

      return (
        created !== null &&
        created >= cutoff &&
        created <= Date.now() &&
        !processed.has(String(u.id))
      );
    });

    console.log(
      `Poll: ${fresh.length} new users found`
    );

    let notified = 0;
    let failed = 0;

    for (const u of fresh) {
      const user = {
        id: u.id,
        userName: u.userName,
        givenName: u.name?.givenName,
        familyName: u.name?.familyName,
        active: u.active,
      };

      try {
        const result = await notifySecondApi(
          user,
          "polling"
        );

        processed.add(String(u.id));
        notified++;

        console.log(
          "Telegram / second API success:",
          result.status,
          user.userName
        );
      } catch (err) {
        failed++;

        console.error(
          "Second API failed:",
          err.response?.status,
          err.response?.data || err.message
        );
      }
    }

    return {
      checked: list.length,
      found: fresh.length,
      notified,
      failed,
    };
  } catch (err) {
    console.error(
      "Poll failed:",
      err.response?.status,
      err.response?.data || err.message
    );

    return {
      error:
        err.response?.status ||
        err.message,
    };
  } finally {
    polling = false;
  }
}

// -------------------------------
// MANUAL POLLING ENDPOINT
// -------------------------------

app.get("/poll", async (req, res) => {
  if (
    !process.env.POLL_TOKEN ||
    req.query.token !== process.env.POLL_TOKEN
  ) {
    return res.status(401).json({
      error: "Unauthorized",
    });
  }

  const result = await pollNewUsers();

  if (result.error) {
    return res.status(502).json(result);
  }

  res.json(result);
});

// -------------------------------
// AUTOMATIC POLLING
// -------------------------------

if (process.env.SPRINKLR_SCIM_URL) {
  const interval =
    Number(process.env.POLL_INTERVAL_SEC || 60) *
    1000;

  setInterval(() => {
    pollNewUsers().catch((err) => {
      console.error("Polling timer error:", err.message);
    });
  }, interval);

  console.log(
    `Auto polling enabled: every ${interval / 1000} seconds`
  );
}

// -------------------------------
// START SERVER
// -------------------------------

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

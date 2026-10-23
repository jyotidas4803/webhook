require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

// Same user dobara process na ho
const processed = new Set();

app.get("/", (req, res) => res.send("Webhook server is runnnig"));

app.post("/webhook", async (req, res) => {
  // Step 1: token check
  if (req.query.token !== process.env.WEBHOOK_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body = req.body || {};

  // Step 2: Sprinklr turant 200 chahta hai (10 second ke andar)
  res.status(200).json({ received: true });

  // Step 3: verification call khaali {} bhejta hai, usko ignore karo
  if (!body.type) {
    console.log("Verification / khaali request, skip");
    return;
  }
  console.log("Event aaya:", body.type, "| event id:", body.id);

  // Step 4: sirf user.created event process karo
  if (body.type !== "user.created") {
    console.log("User create event nahi hai, skip");
    return;
  }

  try {
    // Asli user ka data body.payload ke andar hota hai
    const user = body.payload || {};
    const userId = user.id;

    if (!userId) {
      console.log("payload.id absent, skip");
      return;
    }
    if (processed.has(userId)) {
      console.log("Ye user pehle hi process ho chuka:", userId);
      return;
    }
    processed.add(userId);

    console.log("User:", userId, user.userName, user.name?.givenName, user.name?.familyName);

    // Yahan dusra API call. Body ko apne target API ke format ke hisaab se badalna
    const response = await axios.post(
      process.env.TARGET_API_URL,
      {
        userName: user.userName,
        givenName: user.name?.givenName,
        familyName: user.name?.familyName,
        active: user.active,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.TARGET_API_KEY}`,
        },
      }
    );

    console.log("Dusra API call success:", response.status);
  } catch (err) {
    console.error("Dusra API call fail:", err.response?.status, err.response?.data || err.message);
  }
});

app.listen(PORT, () => console.log(`Server port ${PORT} par chal raha hai`));

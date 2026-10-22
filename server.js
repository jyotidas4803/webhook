require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Same event dobara aaye toh dusri baar process na ho
const processed = new Set();

// Health check - browser mein kholke dekh sakti ho server chal raha hai ya nahi
app.get("/", (req, res) => res.send("Webhook server chal raha hai"));

app.post("/webhook", async (req, res) => {
  // Step 1: simple security - URL mein ?token=XXXX hona chahiye
  if (req.query.token !== process.env.WEBHOOK_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Step 2: payload dekho (pehli baar yahi log dekhna, Sprinklr kya bhej raha hai)
  const payload = req.body;
  console.log("Webhook aaya:", JSON.stringify(payload, null, 2));

  // Step 3: Sprinklr ko turant 200 bhej do, warna wo retry karega
  res.status(200).json({ received: true });

  // Step 4: ab dusra API call
  try {
    // NOTE: payload ke field names Sprinklr ke actual event ke hisaab se badalna
    const userId = payload.id || payload.userId || payload.email;

    if (!userId) {
      console.log("User id nahi mila payload mein, skip kar rahi hu");
      return;
    }
    if (processed.has(userId)) {
      console.log("Ye user pehle hi process ho chuka:", userId);
      return;
    }
    processed.add(userId);

    // Yahan apna dusra API call likho
    const response = await axios.post(
      process.env.TARGET_API_URL,
      {
        // Jo user data dusre API ko chahiye wo yahan map karo
        name: payload.name,
        email: payload.email,
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
    console.error("Dusra API call fail:", err.response?.data || err.message);
  }
});

app.listen(PORT, () => console.log(`Server port ${PORT} par chal raha hai`));

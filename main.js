import express from "express";
import postgres from "postgres";
import { setTimeout } from "node:timers/promises";
import fs from "node:fs";
import { parse } from "csv-parse/sync";

// 1. Environment Setup
const SIM_API_KEY = process.env.SIM_API_KEY || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || "";
const PORT = process.env.PORT || 3001;
const DATABASE_URL = process.env.DATABASE_URL || "";

if (!SIM_API_KEY || !TELEGRAM_BOT_TOKEN || !DATABASE_URL) {
  console.error("Missing required environment variables");
  process.exit(1);
}

// 2. Database Setup (PostgreSQL via Supabase)
const sql = postgres(DATABASE_URL);

// Initialize Tables
async function initDatabase() {
  await sql`
    CREATE TABLE IF NOT EXISTS top_holders (
      id SERIAL PRIMARY KEY,
      token_address TEXT,
      chain_id INTEGER,
      symbol TEXT,
      blockchain TEXT,
      holders_json TEXT,
      UNIQUE(token_address, chain_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS subscribers (
      chat_id TEXT PRIMARY KEY,
      subscribed_at TEXT
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      token_address TEXT,
      chain_id INTEGER,
      active INTEGER DEFAULT 1
    )
  `;
}

// 3. Express Setup
const app = express();
app.use(express.json()); // Parse JSON bodies

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Helper to map Dune blockchain names to Chain IDs
function getChainId(blockchain) {
  const map = {
    ethereum: 1,
    optimism: 10,
    bnb: 56,
    polygon: 137,
    base: 8453,
    arbitrum: 42161,
    avalanche_c: 43114,
  };
  return map[blockchain.toLowerCase()] || 1;
}

function loadTokensFromCSV() {
  try {
    const fileContent = fs.readFileSync("tokens.csv", "utf-8");
    const records = parse(fileContent, {
      columns: true, // Auto-detect headers
      skip_empty_lines: true,
      trim: true,
    });
    return records;
  } catch (error) {
    console.error("Error loading tokens.csv. Make sure the file exists.", error);
    return [];
  }
}

// Fetch Holders for a Token
async function fetchTokenHolders(tokenAddress, chainId, limit = 3) {
  const url = `https://api.sim.dune.com/v1/evm/token-holders/${chainId}/${tokenAddress}?limit=${limit}`;

  const response = await fetch(url, {
    headers: { "X-Sim-Api-Key": SIM_API_KEY },
  });

  if (!response.ok) {
    console.warn(`Failed to fetch holders for ${tokenAddress}: ${response.status}`);
    return [];
  }

  const data = await response.json();
  return data.holders || [];
}

// Store Top Holder Addresses
async function fetchAllTopHolders() {
  const tokens = loadTokensFromCSV();
  let totalHolders = 0;

  console.log(`Processing ${tokens.length} tokens from CSV...`);

  for (const token of tokens) {
    const chainId = getChainId(token.blockchain);
    
    // Skip if we don't support this chain
    if (!chainId) continue;

    const holders = await fetchTokenHolders(token.contract_address, chainId);

    if (holders.length > 0) {
      const tokenAddress = token.contract_address.toLowerCase();
      const holdersJson = JSON.stringify(holders);
      
      await sql`
        INSERT INTO top_holders (token_address, chain_id, symbol, blockchain, holders_json)
        VALUES (${tokenAddress}, ${chainId}, ${token.symbol}, ${token.blockchain}, ${holdersJson})
        ON CONFLICT (token_address, chain_id) 
        DO UPDATE SET symbol = ${token.symbol}, blockchain = ${token.blockchain}, holders_json = ${holdersJson}
      `;
      totalHolders += holders.length;
      console.log(`Found ${holders.length} top holders for ${token.symbol}`);
    }

    // Respect rate limits: 4 requests per second
    await setTimeout(250);
  }

  return { totalHolders, tokensProcessed: tokens.length };
}

// Endpoint to trigger this manually
app.post("/setup/fetch-holders", async (req, res) => {
  try {
    const result = await fetchAllTopHolders();
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create a Webhook
async function createWebhook(config) {
  const url = "https://api.sim.dune.com/beta/evm/subscriptions/webhooks";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-Sim-Api-Key": SIM_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(config),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create webhook: ${error}`);
  }

  return response.json();
}

// Create Webhooks for All Top Holders
async function createWebhooksForTopHolders() {
  const webhookIds = [];
  const rows = await sql`SELECT * FROM top_holders`;

  for (const row of rows) {
    const holders = JSON.parse(row.holders_json);
    const addresses = holders.map((h) => h.wallet_address).filter(Boolean);

    if (addresses.length === 0) continue;

    const webhook = await createWebhook({
      name: `Top Holders Tracker - ${row.symbol} on ${row.blockchain}`,
      url: `${WEBHOOK_BASE_URL}/balances`,
      type: "balances",
      addresses: addresses,
      chain_ids: [row.chain_id],
      token_address: row.token_address,
    });

    if (webhook?.id) {
      await sql`
        INSERT INTO webhooks (id, token_address, chain_id) 
        VALUES (${webhook.id}, ${row.token_address}, ${row.chain_id})
        ON CONFLICT (id) DO UPDATE SET token_address = ${row.token_address}, chain_id = ${row.chain_id}
      `;
      webhookIds.push(webhook.id);
      console.log(`Created webhook for ${row.symbol}`);
    }

    await setTimeout(250);
  }

  return { webhooksCreated: webhookIds.length, webhookIds };
}

// Endpoint to trigger webhook creation
app.post("/setup/create-webhooks", async (req, res) => {
  try {
    const result = await createWebhooksForTopHolders();
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Handle Balance Change Events
app.post("/balances", async (req, res) => {
  console.log(`[${new Date().toISOString()}] Received /balances webhook call with ${req.body.balance_changes?.length || 0} changes`);
  
  const balanceChanges = req.body.balance_changes || [];
  
  // Sim sends the Chain ID in the header
  const chainId = parseInt(req.headers["dune-webhook-chain-id"] || "1");
  const processedTxs = new Set();

  for (const change of balanceChanges) {
    // Deduplicate by transaction hash within this batch
    if (processedTxs.has(change.transaction_hash)) continue;
    processedTxs.add(change.transaction_hash);

    // Skip small transactions (e.g., less than $100)
    if (change.value_delta_usd < 100) continue;

    // Format and send notification
    const message = formatBalanceMessage(change, chainId);
    await broadcastToSubscribers(message);
  }

  res.json({ ok: true, processed: processedTxs.size });
});

// Manage Subscribers
async function addSubscriber(chatId) {
  const subscribedAt = new Date().toISOString();
  await sql`
    INSERT INTO subscribers (chat_id, subscribed_at) 
    VALUES (${chatId}, ${subscribedAt})
    ON CONFLICT (chat_id) DO NOTHING
  `;
}

async function getAllSubscribers() {
  const rows = await sql`SELECT chat_id FROM subscribers`;
  return rows.map(r => r.chat_id);
}

// Send Messages
async function sendTelegramMessage(text, chatId) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });

  return response.ok;
}

async function broadcastToSubscribers(text) {
  const subscribers = await getAllSubscribers();
  for (const chatId of subscribers) {
    await sendTelegramMessage(text, chatId);
  }
}

// Format Alert Messages
function formatNumber(value) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}

function getExplorerLink(txHash, chainId) {
  const explorers = {
    1: "https://etherscan.io/tx/",
    10: "https://optimistic.etherscan.io/tx/",
    56: "https://bscscan.com/tx/",
    137: "https://polygonscan.com/tx/",
    8453: "https://basescan.org/tx/",
    42161: "https://arbiscan.io/tx/",
    43114: "https://snowtrace.io/tx/",
  };
  return `${explorers[chainId] || explorers[1]}${txHash}`;
}

function formatBalanceMessage(change, chainId) {
  const usdValue = change.value_delta_usd || 0;
  const symbol = change.asset?.symbol || "???";
  const decimals = change.asset?.decimals || 18;
  const direction = change.direction;

  // Calculate token amount
  const rawAmount = parseFloat(change.amount_delta);
  const amount = rawAmount / Math.pow(10, decimals);

  // Determine emoji count based on value
  let emojiCount = 1;
  if (usdValue >= 10_000_000) emojiCount = 5;
  else if (usdValue >= 1_000_000) emojiCount = 4;
  else if (usdValue >= 500_000) emojiCount = 3;
  else if (usdValue >= 100_000) emojiCount = 2;

  const emoji = "🚨 ".repeat(emojiCount).trim();
  const directionEmoji = direction === "in" ? "📥" : "📤";
  const directionText = direction === "in" ? "received" : "sent";

  const holder = change.subscribed_address;
  const holderShort = `${holder.slice(0, 6)}...${holder.slice(-4)}`;
  const txLink = getExplorerLink(change.transaction_hash, chainId);

  return `${emoji} ${directionEmoji} *${formatNumber(amount)} ${symbol}* ($${formatNumber(usdValue)}) ${directionText}

Holder: \`${holderShort}\`

[View Transaction](${txLink}) · Powered by [Sim APIs](https://sim.dune.com)`;
}

// Handle Telegram Commands
app.post("/telegram/webhook", async (req, res) => {
  const body = req.body;
  const message = body.message;

  if (message?.text) {
    const chatId = message.chat.id.toString();
    const text = message.text;

    if (text.startsWith("/start")) {
      await addSubscriber(chatId);
      await sendTelegramMessage(
        "📊 *Welcome to Top Holders Tracker!*\n\n" +
          "You're now subscribed to top holder alerts.\n\n" +
          "Commands:\n/start - Subscribe\n/status - Check subscription",
        chatId
      );
    } else if (text.startsWith("/status")) {
      const subscribers = await getAllSubscribers();
      const isSubscribed = subscribers.includes(chatId);
      await sendTelegramMessage(
        isSubscribed
          ? "✅ You're subscribed to top holder alerts!"
          : "❌ Not subscribed. Send /start to subscribe.",
        chatId
      );
    }
  }

  res.json({ ok: true });
});

// Manage Webhooks - List (with pagination)
async function listWebhooks() {
  const url = "https://api.sim.dune.com/beta/evm/subscriptions/webhooks";
  const response = await fetch(url, {
    headers: { "X-Sim-Api-Key": SIM_API_KEY },
  });
  return response.json();
}

// Fetch ALL webhooks with pagination
async function listAllWebhooks() {
  const allWebhooks = [];
  const seenIds = new Set();
  let offset = 0;
  const limit = 300; // Increased to grab all webhooks in fewer requests
  const maxIterations = 50; // Safety limit
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;
    const url = `https://api.sim.dune.com/beta/evm/subscriptions/webhooks?limit=${limit}&offset=${offset}`;
    const response = await fetch(url, {
      headers: { "X-Sim-Api-Key": SIM_API_KEY },
    });

    if (!response.ok) {
      console.error(`Failed to fetch webhooks at offset ${offset}: ${response.status}`);
      break;
    }

    const data = await response.json();
    const webhooks = data.webhooks || [];

    if (webhooks.length === 0) {
      break; // No more webhooks
    }

    // Check for duplicates - if API doesn't support offset, we'll see same IDs
    let newCount = 0;
    for (const wh of webhooks) {
      if (!seenIds.has(wh.id)) {
        seenIds.add(wh.id);
        allWebhooks.push(wh);
        newCount++;
      }
    }

    console.log(`Fetched ${webhooks.length} webhooks, ${newCount} new (total unique: ${allWebhooks.length})`);

    // If no new webhooks, API isn't paginating properly - stop to avoid infinite loop
    if (newCount === 0) {
      console.log("No new webhooks found - API may not support offset pagination. Stopping.");
      break;
    }

    if (webhooks.length < limit) {
      break; // Last page
    }

    offset += limit;
    await setTimeout(100); // Rate limit
  }

  if (iterations >= maxIterations) {
    console.warn(`Hit max iterations (${maxIterations}). May have more webhooks.`);
  }

  return allWebhooks;
}

// Manage Webhooks - Update Status
async function updateWebhookStatus(webhookId, active) {
  const url = `https://api.sim.dune.com/beta/evm/subscriptions/webhooks/${webhookId}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "X-Sim-Api-Key": SIM_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ active }),
  });
  return response.ok;
}

// Management Endpoints
app.get("/setup/view-webhooks", async (req, res) => {
  try {
    const webhooks = await listAllWebhooks();
    const active = webhooks.filter(w => w.active).length;
    const inactive = webhooks.length - active;
    res.json({ ok: true, total: webhooks.length, active, inactive, webhooks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/setup/pause-webhooks", async (req, res) => {
  try {
    // Fetch ALL webhooks from the API with pagination
    const allWebhooks = await listAllWebhooks();
    console.log(`Found ${allWebhooks.length} total webhooks to pause`);

    let paused = 0;
    let skipped = 0;
    let failed = 0;

    for (const webhook of allWebhooks) {
      // Skip already inactive webhooks
      if (!webhook.active) {
        skipped++;
        continue;
      }

      const success = await updateWebhookStatus(webhook.id, false);
      if (success) {
        paused++;
        // Also update local DB if this webhook exists there
        await sql`UPDATE webhooks SET active = 0 WHERE id = ${webhook.id}`;
        console.log(`Paused: ${webhook.name || webhook.id}`);
      } else {
        failed++;
        console.error(`Failed to pause: ${webhook.name || webhook.id}`);
      }
      await setTimeout(100);
    }

    res.json({ ok: true, paused, skipped, failed, total: allWebhooks.length });
  } catch (error) {
    console.error("Error pausing webhooks:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/setup/resume-webhooks", async (req, res) => {
  try {
    // Fetch ALL webhooks from the API with pagination
    const allWebhooks = await listAllWebhooks();
    console.log(`Found ${allWebhooks.length} total webhooks to resume`);

    let resumed = 0;
    let skipped = 0;
    let failed = 0;

    for (const webhook of allWebhooks) {
      // Skip already active webhooks
      if (webhook.active) {
        skipped++;
        continue;
      }

      const success = await updateWebhookStatus(webhook.id, true);
      if (success) {
        resumed++;
        // Also update local DB if this webhook exists there
        await sql`UPDATE webhooks SET active = 1 WHERE id = ${webhook.id}`;
        console.log(`Resumed: ${webhook.name || webhook.id}`);
      } else {
        failed++;
        console.error(`Failed to resume: ${webhook.name || webhook.id}`);
      }
      await setTimeout(100);
    }

    res.json({ ok: true, resumed, skipped, failed, total: allWebhooks.length });
  } catch (error) {
    console.error("Error resuming webhooks:", error);
    res.status(500).json({ error: error.message });
  }
});

// Resume only webhooks that belong to THIS app (stored in database)
app.post("/setup/resume-local-webhooks", async (req, res) => {
  try {
    const localWebhooks = await sql`SELECT id FROM webhooks`;
    console.log(`Found ${localWebhooks.length} local webhooks to resume`);

    let resumed = 0;
    let failed = 0;

    for (const webhook of localWebhooks) {
      const success = await updateWebhookStatus(webhook.id, true);
      if (success) {
        resumed++;
        await sql`UPDATE webhooks SET active = 1 WHERE id = ${webhook.id}`;
        console.log(`Resumed local webhook: ${webhook.id}`);
      } else {
        failed++;
        console.error(`Failed to resume: ${webhook.id}`);
      }
      await setTimeout(100);
    }

    res.json({ ok: true, resumed, failed, total: localWebhooks.length });
  } catch (error) {
    console.error("Error resuming local webhooks:", error);
    res.status(500).json({ error: error.message });
  }
});

// Start the server
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});

const express = require("express");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const path = require("path");

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

const required = ["DATABASE_URL", "ADMIN_USERNAME", "ADMIN_PASSWORD", "MINECRAFT_API_SECRET", "JWT_SECRET"];
for (const key of required) {
  if (!process.env[key]) console.warn(`Missing environment variable: ${key}`);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("localhost")
    ? { rejectUnauthorized: false }
    : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      uuid TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      kills INTEGER NOT NULL DEFAULT 0,
      deaths INTEGER NOT NULL DEFAULT 0,
      playtime_seconds BIGINT NOT NULL DEFAULT 0,
      money NUMERIC(18,2) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer /, "");
  try {
    const data = jwt.verify(token || "", process.env.JWT_SECRET);
    if (data.role !== "admin") throw new Error("Invalid role");
    next();
  } catch {
    res.status(401).json({ error: "Admin login required" });
  }
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/players", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT uuid, username, kills, deaths, playtime_seconds, money, updated_at FROM players"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load leaderboard" });
  }
});

app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD || !process.env.JWT_SECRET) {
    return res.status(503).json({ error: "Admin login is not configured" });
  }
  if (username !== process.env.ADMIN_USERNAME || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Incorrect username or password" });
  }
  const token = jwt.sign({ role: "admin" }, process.env.JWT_SECRET, { expiresIn: "8h" });
  res.json({ token });
});

app.put("/api/admin/players/:uuid", requireAdmin, async (req, res) => {
  const { username, kills, deaths, playtime_seconds, money } = req.body || {};
  try {
    const result = await pool.query(
      `INSERT INTO players (uuid, username, kills, deaths, playtime_seconds, money)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (uuid) DO UPDATE SET
       username=EXCLUDED.username, kills=EXCLUDED.kills, deaths=EXCLUDED.deaths,
       playtime_seconds=EXCLUDED.playtime_seconds, money=EXCLUDED.money, updated_at=NOW()
       RETURNING *`,
      [req.params.uuid, String(username || "Player").slice(0,16),
       Math.max(0, Number(kills) || 0), Math.max(0, Number(deaths) || 0),
       Math.max(0, Number(playtime_seconds) || 0), Math.max(0, Number(money) || 0)]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update player" });
  }
});

// Called by the Minecraft server plugin. Keep the secret on the server, never in browser code.
app.post("/api/minecraft/sync", async (req, res) => {
  if (!process.env.MINECRAFT_API_SECRET ||
      req.get("x-minecraft-secret") !== process.env.MINECRAFT_API_SECRET) {
    return res.status(401).json({ error: "Unauthorized Minecraft server" });
  }
  const players = Array.isArray(req.body?.players) ? req.body.players.slice(0, 200) : [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const p of players) {
      if (!p.uuid || !p.username) continue;
      await client.query(
        `INSERT INTO players (uuid, username, kills, deaths, playtime_seconds, money)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (uuid) DO UPDATE SET
         username=EXCLUDED.username, kills=EXCLUDED.kills, deaths=EXCLUDED.deaths,
         playtime_seconds=EXCLUDED.playtime_seconds, money=EXCLUDED.money, updated_at=NOW()`,
        [String(p.uuid), String(p.username).slice(0,16),
         Math.max(0, Number(p.kills) || 0), Math.max(0, Number(p.deaths) || 0),
         Math.max(0, Number(p.playtime_seconds) || 0), Math.max(0, Number(p.money) || 0)]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true, received: players.length });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Minecraft sync failed" });
  } finally {
    client.release();
  }
});

const port = process.env.PORT || 3000;
initDb().then(() => app.listen(port, "0.0.0.0", () => {
  console.log(`School SMP website listening on port ${port}`);
})).catch(err => {
  console.error("Database initialization failed:", err);
  process.exit(1);
});

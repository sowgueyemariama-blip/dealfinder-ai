"use strict";
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "12mb" }));

// Render impose le port 10000 par défaut, on l'écoute obligatoirement
const PORT = process.env.PORT || 10000; 
const ADMIN_EMAIL = "sowgueye.mariama@gmail.com";
const JWT_SECRET = process.env.JWT_SECRET || "dealfinder-dev-secret-change-me";
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
function dbPath(name) { return path.join(DATA_DIR, name + ".json"); }

let mongoCollection = null;

async function readDB(name, fallback) {
  if (mongoCollection) {
    try {
      const doc = await mongoCollection.findOne({ _id: name });
      return doc ? doc.value : fallback;
    } catch (e) { return fallback; }
  }
  try {
    const p = dbPath(name);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) { return fallback; }
}

async function writeDB(name, data) {
  if (mongoCollection) {
    try {
      await mongoCollection.updateOne({ _id: name }, { $set: { value: data } }, { upsert: true });
      return;
    } catch (e) { console.error("Écriture échec", e.message); }
  }
  fs.writeFileSync(dbPath(name), JSON.stringify(data, null, 2), "utf8");
}

let users, products, affiliate, apiKeys, notifications, favorites, history, stats;

async function persistAll() {
  await Promise.all([
    writeDB("users", users), writeDB("products", products), writeDB("affiliate", affiliate),
    writeDB("keys", apiKeys), writeDB("notifications", notifications),
    writeDB("favorites", favorites), writeDB("history", history), writeDB("stats", stats)
  ]);
}

function seedAffiliate() { return []; }
function seedProducts() {
  const O = (store, price, cur, stock, ship, h, link) => ({ store, price, cur, stock, ship, h, link: link || "", updatedAt: Date.now() - h * 3600 * 1000 });
  const P = (id, cat, brand, name, tags, specs, image, offers) => ({ id, cat, brand, name, tags, specs, image: image || "", offers, createdAt: Date.now() });
  return [
    P("p1", "telephones", "Samsung", "Samsung Galaxy A15 — 128 Go", ["samsung", "galaxy", "a15"], ["128 Go · 4 Go RAM"], "", [O("TechMarché", 94900, "FCFA", true, 2000, 2)])
  ];
}

// CETTE FONCTION DÉMARRE LE PORT TOUT DE SUITE POUR RENDER
async function bootstrap() {
  users = await readDB("users", {});
  products = await readDB("products", null);
  affiliate = await readDB("affiliate", null);
  apiKeys = await readDB("keys", []);
  notifications = await readDB("notifications", []);
  favorites = await readDB("favorites", {});
  history = await readDB("history", {});
  stats = await readDB("stats", { searches: 0, clicks: 0, shares: 0, favs: 0 });

  if (!products) { products = seedProducts(); await writeDB("products", products); }
  if (!affiliate) { affiliate = seedAffiliate(); await writeDB("affiliate", affiliate); }

  const uri = process.env.MONGODB_URI;
  if (uri) {
    try {
      const { MongoClient } = require("mongodb");
      const client = new MongoClient(uri);
      await client.connect();
      mongoCollection = client.db("dealfinder").collection("appdata");
      console.log("Connecté à MongoDB Atlas !");
    } catch (e) {
      console.error("Repli local :", e.message);
    }
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(body).digest("base64url");
  return body + "." + sig;
}
function verifyToken(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", JWT_SECRET).update(body).digest("base64url");
  if (sig !== expected) return null;
  try { return JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch (e) { return null; }
}
function authMiddleware(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: "unauthorized" });
  req.user = payload;
  next();
}
function adminOnly(req, res, next) {
  if (!req.user || req.user.email !== ADMIN_EMAIL) return res.status(403).json({ error: "forbidden" });
  next();
}

app.get("/api/health", (req, res) => res.json({ status: "ok" }));
app.get("/api/categories", (req, res) => res.json([]));
app.get("/api/products", (req, res) => res.json({ products: [] }));

// LANCEMENT DU PORT IMMÉDIAT
app.listen(PORT, "0.0.0.0", () => {
  console.log("Serveur actif sur le port " + PORT);
  bootstrap().catch(err => console.error(err));
});

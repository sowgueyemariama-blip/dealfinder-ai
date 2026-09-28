"use strict";
/* ================================================================
   DealFinder AI — server.js
   Backend Express pour l'app frontend (index.html) déployée sur Render.
   Version unifiée et corrigée avec démarrage réseau immédiat et MongoDB Atlas.
   ================================================================ */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "12mb" })); // photos envoyées en base64 depuis l'admin

// Render impose le port 10000 par défaut, on l'écoute obligatoirement
const PORT = process.env.PORT || 10000;
const ADMIN_EMAIL = "sowgueye.mariama@gmail.com";
const JWT_SECRET = process.env.JWT_SECRET || "dealfinder-dev-secret-change-me";
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

/* ---------------------------------------------------------------
   0. Stockage : MongoDB Atlas si MONGODB_URI est définie (persistance
      définitive), sinon fichiers JSON locaux (repli de secours).
   --------------------------------------------------------------- */
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
function dbPath(name) { return path.join(DATA_DIR, name + ".json"); }

let mongoCollection = null;

async function readDB(name, fallback) {
  if (mongoCollection) {
    try {
      const doc = await mongoCollection.findOne({ _id: name });
      return doc ? doc.value : fallback;
    } catch (e) { console.error("Lecture MongoDB échouée pour " + name, e.message); return fallback; }
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
    } catch (e) { console.error("Écriture MongoDB échouée pour " + name, e.message); }
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

/* ---------------------------------------------------------------
   1. Données de départ (utilisées seulement si les fichiers ou la collection n'existent pas)
   --------------------------------------------------------------- */
function seedAffiliate() {
  return [];
}

function seedProducts() {
  const O = (store, price, cur, stock, ship, h, link) => ({ store, price, cur, stock, ship, h, link: link || "", updatedAt: Date.now() - h * 3600 * 1000 });
  const P = (id, cat, brand, name, tags, specs, image, offers) => ({ id, cat, brand, name, tags, specs, image: image || "", offers, createdAt: Date.now() });
  return [
    P("p1", "telephones", "Samsung", "Samsung Galaxy A15 — 128 Go",
      ["samsung", "galaxy", "a15", "telephone", "smartphone"],
      ["Écran 6,5\" Super AMOLED", "128 Go · 4 Go RAM", "Batterie 5000 mAh"], "",
      [O("TechMarché", 94900, "FCFA", true, 2000, 2), O("Electro+", 97900, "FCFA", true, 0, 5),
       O("MegaDeal Store", 96500, "FCFA", true, 1500, 24), O("BoutiqueSahel", 93900, "FCFA", false, 1500, 48)]),
    P("p3", "telephones", "Tecno", "Tecno Spark 20 — 128 Go",
      ["tecno", "spark", "telephone", "smartphone"],
      ["Écran 90 Hz", "128 Go · 8 Go RAM"], "",
      [O("Electro+", 68900, "FCFA", true, 1000, 3), O("BoutiqueSahel", 69900, "FCFA", true, 0, 10)]),
    P("p4", "telephones", "Xiaomi", "Xiaomi Redmi 13C — 128 Go",
      ["xiaomi", "redmi", "telephone", "smartphone"],
      ["128 Go · 6 Go RAM", "Caméra 50 Mpx"], "",
      [O("Electro+", 79900, "FCFA", true, 0, 4), O("TechMarché", 81500, "FCFA", true, 1500, 12)]),
    P("p9", "audio", "JBL", "JBL Tune 520BT — casque sans fil",
      ["jbl", "casque", "sans fil", "bluetooth", "audio"],
      ["Bluetooth 5.3", "Autonomie 57 h"], "",
      [O("AudioCenter", 21500, "FCFA", true, 1000, 2), O("TechMarché", 22900, "FCFA", true, 1500, 8), O("Electro+", 21900, "FCFA", true, 0, 14)]),
    P("p11", "audio", "Oraimo", "Oraimo FreePods 4 — écouteurs sans fil",
      ["oraimo", "ecouteurs", "sans fil", "bluetooth", "audio"],
      ["Bluetooth 5.2", "Étui de charge"], "",
      [O("Electro+", 12500, "FCFA", true, 500, 1), O("AudioCenter", 13200, "FCFA", true, 1000, 9)]),
    P("p14", "chaussures", "Nike", "Nike Court Vision Low",
      ["nike", "baskets", "chaussures", "sneakers"],
      ["Baskets cuir synthétique", "Semelle caoutchouc"], "",
      [O("ModeExpress", 34900, "FCFA", true, 2000, 12), O("MegaDeal Store", 35900, "FCFA", true, 1500, 24)]),
    P("p19", "jeux", "Sony", "Manette de jeu sans fil",
      ["manette", "jeux", "gaming", "sans fil"],
      ["Bluetooth", "Batterie 12 h"], "",
      [O("MegaDeal Store", 42900, "FCFA", true, 1500, 9), O("TechMarché", 44500, "FCFA", true, 0, 22)]),
    P("p23", "electronique", "Amazfit", "Montre connectée Amazfit Bip 5",
      ["amazfit", "montre", "connectee", "electronique", "gps"],
      ["GPS intégré", "Autonomie 10 jours"], "",
      [O("Electro+", 34900, "FCFA", true, 0, 5), O("TechMarché", 36900, "FCFA", true, 1500, 16)])
  ];
}

/* ---------------------------------------------------------------
   0bis. Initialisation des données et connexion MongoDB
   --------------------------------------------------------------- */
async function bootstrap() {
  const uri = process.env.MONGODB_URI;
  if (uri) {
    try {
      const { MongoClient } = require("mongodb");
      const client = new MongoClient(uri);
      await client.connect();
      const dbName = process.env.MONGODB_DB || "dealfinder";
      mongoCollection = client.db(dbName).collection("appdata");
      console.log("Connecté à MongoDB Atlas — persistance définitive activée.");
    } catch (e) {
      console.error("Connexion MongoDB impossible, repli sur les fichiers locaux :", e.message);
      mongoCollection = null;
    }
  } else {
    console.warn("MONGODB_URI non définie : stockage en fichiers locaux temporaires.");
  }

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
}

/* ---------------------------------------------------------------
   2. Sécurité & Authentification JWT (HMAC)
   --------------------------------------------------------------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(body).digest("base64url");
  return body + "." + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", JWT_SECRET).update(body).digest("base64url");
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (e) { return null; }
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

/* ---------------------------------------------------------------
   3. Routes Publiques : Santé, Authentification, Recherche & Produits
   --------------------------------------------------------------- */
app.get("/api/health", async (req, res) => {
  res.json({ status: "ok", time: Date.now() });
});

app.post("/api/auth/register", async (req, res) => {
  const name = (req.body && req.body.name || "").trim();
  const email = (req.body && req.body.email || "").trim().toLowerCase();
  if (name.length < 2) return res.status(400).json({ error: "invalid_name" });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "invalid_email" });

  const existing = users[email];
  users[email] = { name: existing ? existing.name : name, email, createdAt: existing ? existing.createdAt : Date.now() };
  await persistAll();

  const token = signToken({ email, name: users[email].name, exp: Date.now() + TOKEN_TTL_MS });
  res.json({ token, user: users[email] });
});

app.get("/api/auth/me", authMiddleware, async (req, res) => {
  const u = users[req.user.email];
  if (!u) return res.status(404).json({ error: "not_found" });
  res.json({ user: u });
});

function bestOffer(p) {
  const inStock = p.offers.filter(o => o.stock);
  const pool = inStock.length ? inStock : p.offers;
  return pool.reduce((a, b) => (fcfa(b) < fcfa(a) ? b : a), pool[0]);
}
const TO_FCFA = { FCFA: 1, EUR: 655.957, USD: 610, GBP: 775 };
function fcfa(o) { return o.price * (TO_FCFA[o.cur] || 1); }


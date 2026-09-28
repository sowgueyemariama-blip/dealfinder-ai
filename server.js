"use strict";
/* ================================================================
   DealFinder AI — server.js
   Version corrigée : Ouverture du port à la milliseconde près pour Render.
   ================================================================ */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "12mb" }));

const PORT = process.env.PORT || 10000;
const ADMIN_EMAIL = "sowgueye.mariama@gmail.com";
const JWT_SECRET = process.env.JWT_SECRET || "dealfinder-dev-secret-change-me";
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// OUVRE LE PORT TOUT DE SUITE (RÉPARE LE PORT TIMEOUT)
app.listen(PORT, "0.0.0.0", () => {
  console.log("Serveur actif sur le port " + PORT);
  bootstrap().catch(err => console.error("Erreur d'initialisation :", err));
});

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
    P("p1", "telephones", "Samsung", "Samsung Galaxy A15 — 128 Go", ["samsung", "galaxy", "a15"], ["128 Go · 4 Go RAM"], "", [O("TechMarché", 94900, "FCFA", true, 2000, 2)]),
    P("p3", "telephones", "Tecno", "Tecno Spark 20 — 128 Go", ["tecno", "spark"], ["128 Go · 8 Go RAM"], "", [O("Electro+", 68900, "FCFA", true, 1000, 3)]),
    P("p4", "telephones", "Xiaomi", "Xiaomi Redmi 13C — 128 Go", ["xiaomi", "redmi"], ["128 Go · 6 Go RAM"], "", [O("Electro+", 79900, "FCFA", true, 0, 4)]),
    P("p9", "audio", "JBL", "JBL Tune 520BT", ["jbl", "casque"], ["Bluetooth 5.3"], "", [O("AudioCenter", 21500, "FCFA", true, 1000, 2)]),
    P("p11", "audio", "Oraimo", "Oraimo FreePods 4", ["oraimo", "ecouteurs"], ["Bluetooth 5.2"], "", [O("Electro+", 12500, "FCFA", true, 500, 1)]),
    P("p14", "chaussures", "Nike", "Nike Court Vision Low", ["nike", "baskets"], ["Baskets cuir synthétique"], "", [O("ModeExpress", 34900, "FCFA", true, 2000, 12)]),
    P("p19", "jeux", "Sony", "Manette de jeu sans fil", ["manette", "jeux"], ["Bluetooth"], "", [O("MegaDeal Store", 42900, "FCFA", true, 1500, 9)]),
    P("p23", "electronique", "Amazfit", "Montre connectée Amazfit Bip 5", ["amazfit", "montre"], ["GPS intégré"], "", [O("Electro+", 34900, "FCFA", true, 0, 5)])
  ];
}

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

app.get("/api/health", (req, res) => res.json({ status: "ok", time: Date.now() }));

function bestOffer(p) {
  const inStock = p.offers.filter(o => o.stock);
  const pool = inStock.length ? inStock : p.offers;
  return pool.reduce((a, b) => (fcfa(b) < fcfa(a) ? b : a), pool[0]);
}
const TO_FCFA = { FCFA: 1, EUR: 655.957, USD: 610, GBP: 775 };
function fcfa(o) { return o.price * (TO_FCFA[o.cur] || 1); }

app.get("/api/categories", async (req, res) => {
  const cats = {};
  products.forEach(p => { cats[p.cat] = (cats[p.cat] || 0) + 1; });
  res.json(Object.keys(cats).map(id => ({ id, count: cats[id] })));
});

function norm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function tokenize(q) { return norm(q).split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !STOPWORDS.has(t)); }
const STOPWORDS = new Set(["de","du","des","le","la","les","un","une","et","à","a","au","aux","pour","avec","sur","en","ce","ces","cette"]);

function productHaystack(p) { return norm([p.name, p.brand, p.cat, ...(p.tags || []), ...(p.specs || [])].join(" ")); }
function matchScore(p, tokens) {
  if (!tokens.length) return 0;
  const hay = productHaystack(p);
  const nameWords = norm(p.name).split(/[^a-z0-9]+/).filter(Boolean);
  let score = 0;
  for (const tok of tokens) {
    if (hay.includes(tok)) score += 1;
    if (nameWords.includes(tok)) score += 1;
  }
  return score;
}
function findAffiliateByName(storeName) {
  if (!storeName) return null;
  return affiliate.find(m => norm(m.name) === norm(storeName)) || null;
}

function baseFilter(list, { cat, brand, merchants, inStock, knownShip, min, max }) {
    if (cat) list = list.filter(p => norm(p.cat) === norm(cat));
    if (brand) list = list.filter(p => norm(p.brand) === norm(String(brand)));
    if (merchants) {
      const set = new Set(String(merchants).split(",").map(norm));
      list = list.filter(p => p.offers.some(o => set.has(norm(o.store))));
    }
    if (inStock === "1" || inStock === "true") list = list.filter(p => p.offers.some(o => o.stock));
    if (min) list = list.filter(p => fcfa(bestOffer(p)) >= Number(min));
    if (max) list = list.filter(p => fcfa(bestOffer(p)) <= Number(max));
    return list;
}

app.get("/api/products", async (req, res) => {
  const { q, cat, brand, min, max, merchants, inStock, sort } = req.query;
  const tokens = q ? tokenize(q) : [];
  let list = baseFilter(products.slice(), { cat, brand, merchants, inStock, min, max });
  let usedFallback = false;
  if (tokens.length) {
    const scored = list.map(p => ({ p, s: matchScore(p, tokens) })).filter(x => x.s > 0);
    if (scored.length) { scored.sort((a, b) => b.s - a.s); list = scored.map(x => x.p); }
    else { usedFallback = true; list = baseFilter(products.slice(), { cat, brand, merchants, inStock, min, max }); if (!cat && !brand) list = []; }
  }
  if (sort === "price_asc") list.sort((a, b) => fcfa(bestOffer(a)) - fcfa(bestOffer(b)));
  else if (sort === "price_desc") list.sort((a, b) => fcfa(bestOffer(b)) - fcfa(bestOffer(a)));
  const out = list.map(p => decorate(p));
  res.json({ usedFallback, count: out.length, products: out, suggestions: [] });
});

function decorate(p) {
  const best = bestOffer(p);
  const aff = findAffiliateByName(best.store);
  return { id: p.id, cat: p.cat, brand: p.brand, name: p.name, image: p.image, specs: p.specs, best: { ...best, merchantName: best.store, isAffiliate: !!(aff && aff.template) } };
}

app.get("/api/merchants", async (req, res) => { res.json({ items: [] }); });
app.get("/api/products/:id", async (req, res) => {
  const p = products.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "not_found" });
  res.json(p);
});

app.post("/api/products/:id/click", async (req, res) => { stats.clicks++; await persistAll(); res.json({ ok: true }); });
app.get("/api/favorites", authMiddleware, async (req, res) => { res.json({ ids: favorites[req.user.email] || [] }); });

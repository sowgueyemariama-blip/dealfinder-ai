"use strict";
/* ================================================================
   DealFinder AI — server.js
   Backend Express pour l'app frontend (index.html) déployée sur Render.
   Persistance : fichiers JSON dans ./data (simple, sans base externe).
   ================================================================ */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = "sowgueye.mariama@gmail.com";
const JWT_SECRET = process.env.JWT_SECRET || "dealfinder-dev-secret-change-me";
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

/* ---------------------------------------------------------------
   0. Stockage fichier JSON (simple, remplaçable par une vraie BDD)
   --------------------------------------------------------------- */
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function dbPath(name) { return path.join(DATA_DIR, name + ".json"); }
function readDB(name, fallback) {
  try {
    const p = dbPath(name);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) { return fallback; }
}
function writeDB(name, data) {
  fs.writeFileSync(dbPath(name), JSON.stringify(data, null, 2), "utf8");
}

let users = readDB("users", {});           // email -> {name,email,createdAt}
let products = readDB("products", null);   // array de produits (voir seedProducts)
let affiliate = readDB("affiliate", null); // { merchantId: {name, template, affiliate:boolean} }
let apiKeys = readDB("keys", []);          // [{id,label,key,createdAt}]
let notifications = readDB("notifications", []); // [{id,title,body,createdAt}]
let favorites = readDB("favorites", {});   // email -> [productId,...]
let history = readDB("history", {});       // email -> [{q,at}]
let stats = readDB("stats", { searches: 0, clicks: 0, shares: 0, favs: 0 });

function persistAll() {
  writeDB("users", users);
  writeDB("products", products);
  writeDB("affiliate", affiliate);
  writeDB("keys", apiKeys);
  writeDB("notifications", notifications);
  writeDB("favorites", favorites);
  writeDB("history", history);
  writeDB("stats", stats);
}

/* ---------------------------------------------------------------
   1. Données de départ (utilisées seulement si data/products.json
      n'existe pas encore)
   --------------------------------------------------------------- */
function seedAffiliate() {
  return {
    tm: { name: "TechMarché", affiliate: true, template: "" },
    ep: { name: "Electro+", affiliate: true, template: "" },
    bs: { name: "BoutiqueSahel", affiliate: false, template: "" },
    md: { name: "MegaDeal Store", affiliate: true, template: "" },
    ac: { name: "AudioCenter", affiliate: true, template: "" },
    me: { name: "ModeExpress", affiliate: false, template: "" },
    cm: { name: "CasaMeuble", affiliate: false, template: "" }
  };
}

function seedProducts() {
  const O = (m, price, cur, stock, ship, h, link) => ({ m, price, cur, stock, ship, h, link: link || "", updatedAt: Date.now() - h * 3600 * 1000 });
  const P = (id, cat, brand, name, tags, specs, image, offers) => ({ id, cat, brand, name, tags, specs, image: image || "", offers, createdAt: Date.now() });
  return [
    P("p1", "telephones", "Samsung", "Samsung Galaxy A15 — 128 Go",
      ["samsung", "galaxy", "a15", "telephone", "smartphone"],
      ["Écran 6,5\" Super AMOLED", "128 Go · 4 Go RAM", "Batterie 5000 mAh"], "",
      [O("tm", 94900, "FCFA", true, 2000, 2), O("ep", 97900, "FCFA", true, 0, 5),
       O("md", 96500, "FCFA", true, 1500, 24), O("bs", 93900, "FCFA", false, 1500, 48)]),
    P("p3", "telephones", "Tecno", "Tecno Spark 20 — 128 Go",
      ["tecno", "spark", "telephone", "smartphone"],
      ["Écran 90 Hz", "128 Go · 8 Go RAM"], "",
      [O("ep", 68900, "FCFA", true, 1000, 3), O("bs", 69900, "FCFA", true, 0, 10)]),
    P("p4", "telephones", "Xiaomi", "Xiaomi Redmi 13C — 128 Go",
      ["xiaomi", "redmi", "telephone", "smartphone"],
      ["128 Go · 6 Go RAM", "Caméra 50 Mpx"], "",
      [O("ep", 79900, "FCFA", true, 0, 4), O("tm", 81500, "FCFA", true, 1500, 12)]),
    P("p9", "audio", "JBL", "JBL Tune 520BT — casque sans fil",
      ["jbl", "casque", "sans fil", "bluetooth", "audio"],
      ["Bluetooth 5.3", "Autonomie 57 h"], "",
      [O("ac", 21500, "FCFA", true, 1000, 2), O("tm", 22900, "FCFA", true, 1500, 8), O("ep", 21900, "FCFA", true, 0, 14)]),
    P("p11", "audio", "Oraimo", "Oraimo FreePods 4 — écouteurs sans fil",
      ["oraimo", "ecouteurs", "sans fil", "bluetooth", "audio"],
      ["Bluetooth 5.2", "Étui de charge"], "",
      [O("ep", 12500, "FCFA", true, 500, 1), O("ac", 13200, "FCFA", true, 1000, 9)]),
    P("p14", "chaussures", "Nike", "Nike Court Vision Low",
      ["nike", "baskets", "chaussures", "sneakers"],
      ["Baskets cuir synthétique", "Semelle caoutchouc"], "",
      [O("me", 34900, "FCFA", true, 2000, 12), O("md", 35900, "FCFA", true, 1500, 24)]),
    P("p19", "jeux", "Sony", "Manette de jeu sans fil",
      ["manette", "jeux", "gaming", "sans fil"],
      ["Bluetooth", "Batterie 12 h"], "",
      [O("md", 42900, "FCFA", true, 1500, 9), O("tm", 44500, "FCFA", true, 0, 22)]),
    P("p23", "electronique", "Amazfit", "Montre connectée Amazfit Bip 5",
      ["amazfit", "montre", "connectee", "electronique", "gps"],
      ["GPS intégré", "Autonomie 10 jours"], "",
      [O("ep", 34900, "FCFA", true, 0, 5), O("tm", 36900, "FCFA", true, 1500, 16)])
  ];
}

if (!products) { products = seedProducts(); writeDB("products", products); }
if (!affiliate) { affiliate = seedAffiliate(); writeDB("affiliate", affiliate); }

/* ---------------------------------------------------------------
   2. Auth — jetons simples signés (HMAC), pas de mot de passe
      (l'app ne demande que nom + e-mail)
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
  req.user = payload; // { email, name, exp }
  next();
}
function adminOnly(req, res, next) {
  if (!req.user || req.user.email !== ADMIN_EMAIL) return res.status(403).json({ error: "forbidden" });
  next();
}

/* ---------------------------------------------------------------
   3. Santé
   --------------------------------------------------------------- */
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: Date.now() });
});

/* ---------------------------------------------------------------
   4. Authentification
   --------------------------------------------------------------- */
app.post("/api/auth/register", (req, res) => {
  const name = (req.body && req.body.name || "").trim();
  const email = (req.body && req.body.email || "").trim().toLowerCase();
  if (name.length < 2) return res.status(400).json({ error: "invalid_name" });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "invalid_email" });

  const existing = users[email];
  users[email] = { name: existing ? existing.name : name, email, createdAt: existing ? existing.createdAt : Date.now() };
  persistAll();

  const token = signToken({ email, name: users[email].name, exp: Date.now() + TOKEN_TTL_MS });
  res.json({ token, user: users[email] });
});

app.get("/api/auth/me", authMiddleware, (req, res) => {
  const u = users[req.user.email];
  if (!u) return res.status(404).json({ error: "not_found" });
  res.json({ user: u });
});

/* ---------------------------------------------------------------
   5. Produits — recherche / détail / catégories
   --------------------------------------------------------------- */
function bestOffer(p) {
  const inStock = p.offers.filter(o => o.stock);
  const pool = inStock.length ? inStock : p.offers;
  return pool.reduce((a, b) => (fcfa(b) < fcfa(a) ? b : a), pool[0]);
}
const TO_FCFA = { FCFA: 1, EUR: 655.957, USD: 610, GBP: 775 };
function fcfa(o) { return o.price * (TO_FCFA[o.cur] || 1); }

app.get("/api/categories", (req, res) => {
  const cats = {};
  products.forEach(p => { cats[p.cat] = (cats[p.cat] || 0) + 1; });
  res.json(Object.keys(cats).map(id => ({ id, count: cats[id] })));
});

app.get("/api/products", (req, res) => {
  const { q, cat, brand, min, max, merchants, inStock, knownShip, sort } = req.query;
  let list = products.slice();

  if (q) {
    const nq = String(q).toLowerCase();
    list = list.filter(p =>
      p.name.toLowerCase().includes(nq) ||
      p.brand.toLowerCase().includes(nq) ||
      (p.tags || []).some(t => t.toLowerCase().includes(nq))
    );
  }
  if (cat) list = list.filter(p => p.cat === cat);
  if (brand) list = list.filter(p => p.brand.toLowerCase() === String(brand).toLowerCase());
  if (merchants) {
    const set = new Set(String(merchants).split(","));
    list = list.filter(p => p.offers.some(o => set.has(o.m)));
  }
  if (inStock === "1" || inStock === "true") {
    list = list.filter(p => p.offers.some(o => o.stock));
  }
  if (knownShip === "1" || knownShip === "true") {
    list = list.filter(p => p.offers.some(o => o.ship >= 0));
  }
  if (min) list = list.filter(p => fcfa(bestOffer(p)) >= Number(min));
  if (max) list = list.filter(p => fcfa(bestOffer(p)) <= Number(max));

  if (sort === "price_asc") list.sort((a, b) => fcfa(bestOffer(a)) - fcfa(bestOffer(b)));
  else if (sort === "price_desc") list.sort((a, b) => fcfa(bestOffer(b)) - fcfa(bestOffer(a)));
  else if (sort === "new") list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const out = list.map(p => ({
    id: p.id, cat: p.cat, brand: p.brand, name: p.name, image: p.image,
    specs: p.specs, offersCount: p.offers.length, best: bestOffer(p)
  }));

  stats.searches++; persistAll();
  res.json({ count: out.length, offersCompared: list.reduce((s, p) => s + p.offers.length, 0), products: out });
});

app.get("/api/products/:id", (req, res) => {
  const p = products.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "not_found" });
  const offers = p.offers.map(o => ({
    ...o,
    merchantName: (affiliate[o.m] && affiliate[o.m].name) || o.m,
    isAffiliate: !!(affiliate[o.m] && affiliate[o.m].affiliate),
    finalLink: buildAffiliateLink(o)
  }));
  res.json({ ...p, offers });
});

function buildAffiliateLink(offer) {
  const merch = affiliate[offer.m];
  if (!merch) return offer.link || "";
  if (!merch.affiliate || !merch.template) return offer.link || "";
  // Le lien produit est combiné au modèle de lien d'affiliation défini en admin.
  return merch.template.split("{LINK}").join(encodeURIComponent(offer.link || ""));
}

/* Suivi d'un clic "Voir l'offre" (stat + redirection tracée) */
app.post("/api/products/:id/click", (req, res) => {
  const p = products.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "not_found" });
  stats.clicks++; persistAll();
  res.json({ ok: true });
});

/* ---------------------------------------------------------------
   6. Favoris & historique (utilisateur connecté)
   --------------------------------------------------------------- */
app.get("/api/favorites", authMiddleware, (req, res) => {
  const ids = favorites[req.user.email] || [];
  res.json({ ids });
});
app.post("/api/favorites", authMiddleware, (req, res) => {
  const id = req.body && req.body.productId;
  if (!id) return res.status(400).json({ error: "missing_productId" });
  const list = favorites[req.user.email] || [];
  if (!list.includes(id)) list.push(id);
  favorites[req.user.email] = list;
  stats.favs++; persistAll();
  res.json({ ids: list });
});
app.delete("/api/favorites/:id", authMiddleware, (req, res) => {
  const list = (favorites[req.user.email] || []).filter(x => x !== req.params.id);
  favorites[req.user.email] = list;
  persistAll();
  res.json({ ids: list });
});

app.get("/api/history", authMiddleware, (req, res) => {
  res.json({ items: history[req.user.email] || [] });
});
app.post("/api/history", authMiddleware, (req, res) => {
  const q = (req.body && req.body.q || "").trim();
  if (!q) return res.status(400).json({ error: "missing_q" });
  const list = history[req.user.email] || [];
  list.unshift({ q, at: Date.now() });
  history[req.user.email] = list.slice(0, 30);
  persistAll();
  res.json({ items: history[req.user.email] });
});

/* Partage (stat uniquement) */
app.post("/api/share", (req, res) => {
  stats.shares++; persistAll();
  res.json({ ok: true });
});

/* Effacer les données d'un compte */
app.delete("/api/account/data", authMiddleware, (req, res) => {
  delete favorites[req.user.email];
  delete history[req.user.email];
  persistAll();
  res.json({ ok: true });
});

/* ---------------------------------------------------------------
   7. Notifications (diffusion à tous les utilisateurs)
   --------------------------------------------------------------- */
app.get("/api/notifications", (req, res) => {
  res.json({ items: notifications.slice(-50).reverse() });
});

/* ---------------------------------------------------------------
   8. Statistiques anonymisées (lecture publique, agrégées)
   --------------------------------------------------------------- */
app.get("/api/stats", (req, res) => {
  res.json(stats);
});

/* ================================================================
   9. Panneau d'administration — réservé à ADMIN_EMAIL
   ================================================================ */
const admin = express.Router();
admin.use(authMiddleware, adminOnly);

/* -- Produits -- */
admin.get("/products", (req, res) => res.json({ items: products }));

admin.post("/products", (req, res) => {
  const b = req.body || {};
  const id = b.id || ("p" + crypto.randomBytes(4).toString("hex"));
  if (products.some(p => p.id === id)) return res.status(409).json({ error: "id_exists" });
  const product = {
    id,
    cat: b.cat || "autres",
    brand: b.brand || "",
    name: b.name || "",
    tags: b.tags || [],
    specs: b.specs || [],
    image: b.image || "",
    offers: b.offers || [],
    createdAt: Date.now()
  };
  products.push(product);
  persistAll();
  res.status(201).json({ item: product });
});

admin.put("/products/:id", (req, res) => {
  const idx = products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not_found" });
  products[idx] = { ...products[idx], ...req.body, id: products[idx].id };
  persistAll();
  res.json({ item: products[idx] });
});

admin.delete("/products/:id", (req, res) => {
  const before = products.length;
  products = products.filter(p => p.id !== req.params.id);
  persistAll();
  res.json({ ok: true, deleted: before - products.length });
});

/* Import en masse : liens, un par ligne → produits pré-remplis */
admin.post("/products/bulk-import", (req, res) => {
  const links = (req.body && req.body.links) || [];
  const created = links.filter(Boolean).map(url => {
    const id = "p" + crypto.randomBytes(4).toString("hex");
    const product = {
      id, cat: "autres", brand: "", name: guessNameFromUrl(url),
      tags: [], specs: [], image: "",
      offers: [{ m: detectMerchantFromUrl(url), price: 0, cur: "FCFA", stock: true, ship: -1, h: 0, link: url, updatedAt: Date.now() }],
      createdAt: Date.now()
    };
    products.push(product);
    return product;
  });
  persistAll();
  res.status(201).json({ items: created });
});

function guessNameFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const slug = parts.length ? parts[parts.length - 1] : u.hostname;
    return decodeURIComponent(slug)
      .replace(/\.(html?|php|aspx)$/i, "")
      .replace(/[-_+]+/g, " ")
      .replace(/\b(dp|p|product|produit|ref|item|id)\b[\w-]*\b/gi, "")
      .replace(/\b\d{6,}\b/g, "")
      .replace(/\s+/g, " ").trim() || "";
  } catch (e) { return ""; }
}
function detectMerchantFromUrl(url) {
  const u = (url || "").toLowerCase();
  const MAP = [["jumia", "jumia"], ["shein", "shein"], ["amazon", "amazon"], ["aliexpress", "aliexpress"],
    ["temu", "temu"], ["ebay", "ebay"], ["wish", "wish"], ["konga", "konga"], ["alibaba", "alibaba"]];
  for (const [k, id] of MAP) if (u.includes(k)) return id;
  return "autre";
}

/* -- Affiliation (par boutique) -- */
admin.get("/affiliate", (req, res) => res.json({ merchants: affiliate }));
admin.put("/affiliate/:merchantId", (req, res) => {
  const id = req.params.merchantId;
  const cur = affiliate[id] || { name: id, affiliate: false, template: "" };
  affiliate[id] = {
    name: req.body.name != null ? req.body.name : cur.name,
    affiliate: req.body.affiliate != null ? !!req.body.affiliate : cur.affiliate,
    template: req.body.template != null ? req.body.template : cur.template
  };
  persistAll();
  res.json({ merchant: affiliate[id] });
});

/* -- Clés API -- */
admin.get("/keys", (req, res) => res.json({ items: apiKeys }));
admin.post("/keys", (req, res) => {
  const label = (req.body && req.body.label || "").trim();
  const value = (req.body && req.body.value || "").trim();
  if (!label || !value) return res.status(400).json({ error: "missing_fields" });
  const item = { id: crypto.randomBytes(4).toString("hex"), label, key: value, createdAt: Date.now() };
  apiKeys.push(item);
  persistAll();
  res.status(201).json({ item });
});
admin.delete("/keys/:id", (req, res) => {
  apiKeys = apiKeys.filter(k => k.id !== req.params.id);
  persistAll();
  res.json({ ok: true });
});

/* -- Notifications (diffusion à tous) -- */
admin.get("/notifications", (req, res) => res.json({ items: notifications }));
admin.post("/notifications", (req, res) => {
  const title = (req.body && req.body.title || "").trim();
  const body = (req.body && req.body.body || "").trim();
  if (!title) return res.status(400).json({ error: "missing_title" });
  const item = { id: crypto.randomBytes(4).toString("hex"), title, body, createdAt: Date.now() };
  notifications.push(item);
  persistAll();
  res.status(201).json({ item });
});
admin.delete("/notifications/:id", (req, res) => {
  notifications = notifications.filter(n => n.id !== req.params.id);
  persistAll();
  res.json({ ok: true });
});

/* -- Console (état général, pour diagnostic rapide) -- */
admin.get("/console", (req, res) => {
  res.json({
    productsCount: products.length,
    usersCount: Object.keys(users).length,
    keysCount: apiKeys.length,
    notificationsCount: notifications.length,
    stats
  });
});

app.use("/api/admin", admin);

/* ---------------------------------------------------------------
   10. Gestion des erreurs
   --------------------------------------------------------------- */
app.use((req, res) => res.status(404).json({ error: "route_not_found" }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "server_error" });
});

app.listen(PORT, () => {
  console.log("DealFinder AI backend démarré sur le port " + PORT);
});
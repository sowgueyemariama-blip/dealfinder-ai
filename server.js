"use strict";
/* ================================================================
   DealFinder AI — server.js
   Backend Express pour l'app frontend (index.html) déployée sur Render.

   PERSISTANCE — LIS CECI, C'EST IMPORTANT :
   Par défaut, les données sont stockées dans des fichiers JSON locaux
   (./data). Sur Render (plan gratuit), le disque est ÉPHÉMÈRE : il est
   réinitialisé à chaque redémarrage du service (mise en veille après
   inactivité, redéploiement, etc.) — ce n'est pas un bug du code, c'est
   le fonctionnement du plan gratuit. Résultat concret : un produit ou
   un lien d'affiliation ajouté peut disparaître après un redémarrage.

   POUR UNE PERSISTANCE VRAIMENT DÉFINITIVE ("pour la vie") :
   1. Crée un cluster MongoDB Atlas gratuit (gratuit à vie, ~5 minutes,
      aucune carte bancaire requise) : https://www.mongodb.com/cloud/atlas/register
   2. Récupère ton URI de connexion ("mongodb+srv://...")
   3. Sur Render, ajoute une variable d'environnement MONGODB_URI avec
      cette valeur, puis exécute `npm install mongodb` avant de déployer.
   Dès que MONGODB_URI est définie, TOUTES les données (produits, comptes,
   favoris, boutiques affiliées...) sont lues/écrites dans MongoDB Atlas —
   un service externe totalement indépendant de Render, qui ne s'efface
   donc jamais au redémarrage. Sans cette variable, l'app fonctionne
   quand même (fichiers locaux), mais avec le risque de perte ci-dessus.
   ================================================================ */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "12mb" })); // photos envoyées en base64 depuis l'admin

const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = "sowgueye.mariama@gmail.com";
const JWT_SECRET = process.env.JWT_SECRET || "dealfinder-dev-secret-change-me";
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

/* ---------------------------------------------------------------
   0. Stockage : MongoDB Atlas si MONGODB_URI est définie (persistance
      définitive), sinon fichiers JSON locaux (repli, non garanti sur
      Render gratuit — voir avertissement ci-dessus).
   --------------------------------------------------------------- */
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
function dbPath(name) { return path.join(DATA_DIR, name + ".json"); }

let mongoCollection = null; // défini si MONGODB_URI configurée avec succès

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
   1. Données de départ (utilisées seulement si data/products.json
      n'existe pas encore)
   --------------------------------------------------------------- */
function seedAffiliate() {
  // Aucune boutique préconfigurée : c'est l'administrateur qui les ajoute
  // lui-même (nom de la boutique + lien d'affiliation), rien n'est imposé.
  return [];
}

function seedProducts() {
  // Le premier paramètre de O() est désormais le NOM de la boutique en texte
  // libre (pas un identifiant fixe) — cohérent avec l'admin qui écrit lui-même
  // le nom de la boutique, aussi bien pour un produit que pour un lien d'affiliation.
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
   0bis. Démarrage : connecte MongoDB si configuré, charge les données,
   puis lance le serveur — tout est asynchrone pour ne rien bloquer.
   --------------------------------------------------------------- */
async function bootstrap() {
  const uri = process.env.MONGODB_URI;
  if (uri) {
    try {
      const { MongoClient } = require("mongodb"); // npm install mongodb (seulement si tu utilises MONGODB_URI)
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
    console.warn("MONGODB_URI non définie : stockage en fichiers locaux, non garanti au redémarrage sur Render gratuit.");
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

  app.listen(PORT, () => {
    console.log("DealFinder AI backend démarré sur le port " + PORT);
  });
}

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
app.get("/api/health", async (req, res) => {
  res.json({ status: "ok", time: Date.now() });
});

/* ---------------------------------------------------------------
   4. Authentification
   --------------------------------------------------------------- */
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

app.get("/api/categories", async (req, res) => {
  const cats = {};
  products.forEach(p => { cats[p.cat] = (cats[p.cat] || 0) + 1; });
  res.json(Object.keys(cats).map(id => ({ id, count: cats[id] })));
});

/* Normalisation : minuscules + suppression des accents, pour un matching fiable
   quel que soit l'orthographe utilisé ("Téléphone" doit retrouver "telephone"). */
function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
const STOPWORDS = new Set(["de","du","des","le","la","les","un","une","et","à","a","au","aux","pour","avec","sur","en","ce","ces","cette"]);
function tokenize(q) {
  return norm(q).split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !STOPWORDS.has(t));
}
function productHaystack(p) {
  return norm([p.name, p.brand, p.cat, ...(p.tags || []), ...(p.specs || [])].join(" "));
}
/* Score de correspondance : plus il y a de mots de la recherche retrouvés
   (en sous-chaîne, dans le nom/marque/tags/specs), plus le produit est pertinent.
   Un match sur le nom complet ou un mot entier du nom compte double. */
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

/* Trouve une boutique ajoutée par l'admin à partir du nom écrit sur un produit
   (comparaison insensible aux accents/majuscules — pas d'ID à faire correspondre). */
function findAffiliateByName(storeName) {
  if (!storeName) return null;
  const n = norm(storeName);
  return affiliate.find(m => norm(m.name) === n) || null;
}

function baseFilter(list, { cat, brand, merchants, inStock, knownShip, min, max }) {
    if (cat) list = list.filter(p => norm(p.cat) === norm(cat));
    if (brand) list = list.filter(p => norm(p.brand) === norm(String(brand)));
    if (merchants) {
      const set = new Set(String(merchants).split(",").map(norm));
      list = list.filter(p => p.offers.some(o => set.has(norm(o.store))));
    }
    if (inStock === "1" || inStock === "true") list = list.filter(p => p.offers.some(o => o.stock));
    if (knownShip === "1" || knownShip === "true") list = list.filter(p => p.offers.some(o => o.ship >= 0));
    if (min) list = list.filter(p => fcfa(bestOffer(p)) >= Number(min));
    if (max) list = list.filter(p => fcfa(bestOffer(p)) <= Number(max));
    return list;
}

app.get("/api/products", async (req, res) => {
  const { q, cat, brand, min, max, merchants, inStock, knownShip, sort } = req.query;
  const tokens = q ? tokenize(q) : [];
  const filters = { cat, brand, merchants, inStock, knownShip, min, max };

  // Étape 1 : correspondance par mots-clés (tolérante aux accents/casse), la plus précise.
  let list = baseFilter(products.slice(), filters);
  let usedFallback = false;
  if (tokens.length) {
    const scored = list.map(p => ({ p, s: matchScore(p, tokens) })).filter(x => x.s > 0);
    if (scored.length) {
      scored.sort((a, b) => b.s - a.s);
      list = scored.map(x => x.p);
    } else {
      // Étape 2 : aucun mot ne correspond exactement — on élargit à la catégorie/marque
      // déduite de la recherche, pour ne jamais renvoyer "aucun résultat" à tort.
      usedFallback = true;
      list = baseFilter(products.slice(), filters);
      if (!cat && !brand) list = []; // vraiment rien à proposer comme base large
    }
  }

  if (sort === "price_asc") list.sort((a, b) => fcfa(bestOffer(a)) - fcfa(bestOffer(b)));
  else if (sort === "price_desc") list.sort((a, b) => fcfa(bestOffer(b)) - fcfa(bestOffer(a)));
  else if (sort === "new") list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const out = list.map(p => decorate(p));

  // Suggestions "même catégorie" — toujours fournies pour compléter les résultats.
  let suggestions = [];
  const suggCat = cat || (out.length ? out[0].cat : null);
  if (suggCat) {
    suggestions = products
      .filter(p => p.cat === suggCat && !out.some(o => o.id === p.id))
      .slice(0, 8)
      .map(p => decorate(p));
  } else if (!out.length) {
    suggestions = products.slice(-8).reverse().map(p => decorate(p));
  }

  if (q) { stats.searches++; await persistAll(); }
  res.json({
    usedFallback,
    count: out.length,
    offersCompared: list.reduce((s, p) => s + p.offers.length, 0),
    products: out,
    suggestions
  });
});

function decorate(p) {
  const best = bestOffer(p);
  const aff = findAffiliateByName(best.store);
  return {
    id: p.id, cat: p.cat, brand: p.brand, name: p.name, image: p.image,
    specs: p.specs, offersCount: p.offers.length,
    best: {
      ...best,
      merchantName: best.store,
      isAffiliate: !!(aff && aff.template)
    }
  };
}

/* Liste publique des boutiques connues (celles ajoutées en admin + celles
   déjà utilisées sur des produits), pour les filtres de recherche. */
app.get("/api/merchants", async (req, res) => {
  const names = new Set(affiliate.map(m => m.name));
  products.forEach(p => p.offers.forEach(o => { if (o.store) names.add(o.store); }));
  res.json({ items: Array.from(names).map(name => ({ id: name, name, affiliate: !!findAffiliateByName(name) })) });
});

app.get("/api/products/:id", async (req, res) => {
  const p = products.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "not_found" });
  const offers = p.offers.map(o => {
    const aff = findAffiliateByName(o.store);
    return {
      ...o,
      merchantName: o.store,
      isAffiliate: !!(aff && aff.template),
      finalLink: buildAffiliateLink(o)
    };
  });
  res.json({ ...p, offers });
});

function buildAffiliateLink(offer) {
  const merch = findAffiliateByName(offer.store);
  if (!merch || !merch.template) return offer.link || "";
  // Le lien produit est combiné au modèle de lien d'affiliation défini en admin.
  return merch.template.split("{LINK}").join(encodeURIComponent(offer.link || ""));
}

/* Suivi d'un clic "Voir l'offre" (stat + redirection tracée) */
app.post("/api/products/:id/click", async (req, res) => {
  const p = products.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "not_found" });
  stats.clicks++; await persistAll();
  res.json({ ok: true });
});

/* ---------------------------------------------------------------
   6. Favoris & historique (utilisateur connecté)
   --------------------------------------------------------------- */
app.get("/api/favorites", authMiddleware, async (req, res) => {
  const ids = favorites[req.user.email] || [];
  res.json({ ids });
});
app.post("/api/favorites", authMiddleware, async (req, res) => {
  const id = req.body && req.body.productId;
  if (!id) return res.status(400).json({ error: "missing_productId" });
  const list = favorites[req.user.email] || [];
  if (!list.includes(id)) list.push(id);
  favorites[req.user.email] = list;
  stats.favs++; await persistAll();
  res.json({ ids: list });
});
app.delete("/api/favorites/:id", authMiddleware, async (req, res) => {
  const list = (favorites[req.user.email] || []).filter(x => x !== req.params.id);
  favorites[req.user.email] = list;
  await persistAll();
  res.json({ ids: list });
});

app.get("/api/history", authMiddleware, async (req, res) => {
  res.json({ items: history[req.user.email] || [] });
});
app.post("/api/history", authMiddleware, async (req, res) => {
  const q = (req.body && req.body.q || "").trim();
  if (!q) return res.status(400).json({ error: "missing_q" });
  const list = history[req.user.email] || [];
  list.unshift({ q, at: Date.now() });
  history[req.user.email] = list.slice(0, 30);
  await persistAll();
  res.json({ items: history[req.user.email] });
});

/* Partage (stat uniquement) */
app.post("/api/share", async (req, res) => {
  stats.shares++; await persistAll();
  res.json({ ok: true });
});

/* Effacer les données d'un compte */
app.delete("/api/account/data", authMiddleware, async (req, res) => {
  delete favorites[req.user.email];
  delete history[req.user.email];
  await persistAll();
  res.json({ ok: true });
});

/* ---------------------------------------------------------------
   7. Notifications (diffusion à tous les utilisateurs)
   --------------------------------------------------------------- */
app.get("/api/notifications", async (req, res) => {
  res.json({ items: notifications.slice(-50).reverse() });
});

/* ---------------------------------------------------------------
   8. Statistiques anonymisées (lecture publique, agrégées)
   --------------------------------------------------------------- */
app.get("/api/stats", async (req, res) => {
  res.json(stats);
});

/* ================================================================
   9. Panneau d'administration — réservé à ADMIN_EMAIL
   ================================================================ */
const admin = express.Router();
admin.use(authMiddleware, adminOnly);

/* -- Produits -- */
admin.get("/products", (req, res) => res.json({ items: products }));

admin.post("/products", async (req, res) => {
  const b = req.body || {};
  if (!b.image || !String(b.image).trim()) {
    return res.status(400).json({ error: "missing_image" }); // la photo est obligatoire
  }
  const offers = (b.offers || []).map(o => ({
    store: (o.store || "").trim(),
    price: Number(o.price) || 0,
    cur: o.cur || "FCFA",
    stock: o.stock !== false,
    ship: o.ship != null ? o.ship : -1,
    link: o.link || "",
    updatedAt: Date.now()
  }));
  if (offers.length && offers.some(o => !o.store)) {
    return res.status(400).json({ error: "missing_store" }); // le nom de la boutique est obligatoire
  }
  const id = b.id || ("p" + crypto.randomBytes(4).toString("hex"));
  if (products.some(p => p.id === id)) return res.status(409).json({ error: "id_exists" });
  const product = {
    id,
    cat: b.cat || "Autres",
    brand: b.brand || "",
    name: b.name || "Produit sans nom",
    tags: b.tags || [],
    specs: b.specs || [],
    image: b.image || "",
    offers,
    createdAt: Date.now()
  };
  products.push(product);
  await persistAll();
  res.status(201).json({ item: product });
});

admin.put("/products/:id", async (req, res) => {
  const idx = products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not_found" });
  products[idx] = { ...products[idx], ...req.body, id: products[idx].id };
  await persistAll();
  res.json({ item: products[idx] });
});

admin.delete("/products/:id", async (req, res) => {
  const before = products.length;
  products = products.filter(p => p.id !== req.params.id);
  await persistAll();
  res.json({ ok: true, deleted: before - products.length });
});

/* Import en masse : liens, un par ligne → produits pré-remplis (nom de
   boutique deviné à titre indicatif, l'admin peut le changer librement) */
admin.post("/products/bulk-import", async (req, res) => {
  const links = (req.body && req.body.links) || [];
  const created = links.filter(Boolean).map(url => {
    const id = "p" + crypto.randomBytes(4).toString("hex");
    const product = {
      id, cat: "Autres", brand: "", name: guessNameFromUrl(url),
      tags: [], specs: [], image: "",
      offers: [{ store: detectStoreNameFromUrl(url) || "", price: 0, cur: "FCFA", stock: true, ship: -1, link: url, updatedAt: Date.now() }],
      createdAt: Date.now()
    };
    products.push(product);
    return product;
  });
  await persistAll();
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
function detectStoreNameFromUrl(url) {
  const u = (url || "").toLowerCase();
  const MAP = [["jumia", "Jumia"], ["shein", "Shein"], ["amazon", "Amazon"], ["aliexpress", "AliExpress"],
    ["temu", "Temu"], ["ebay", "eBay"], ["wish", "Wish"], ["konga", "Konga"], ["alibaba", "Alibaba"]];
  for (const [k, name] of MAP) if (u.includes(k)) return name;
  return "";
}

/* -- Affiliation : liste libre de boutiques ajoutées par l'admin --
   Juste un nom de boutique + un lien d'affiliation, rien de préconfiguré. */
admin.get("/affiliate", (req, res) => res.json({ items: affiliate }));
admin.post("/affiliate", async (req, res) => {
  const name = (req.body && req.body.name || "").trim();
  const template = (req.body && req.body.template || "").trim();
  if (!name) return res.status(400).json({ error: "missing_name" });
  const item = { id: crypto.randomBytes(4).toString("hex"), name, template };
  affiliate.push(item);
  await persistAll();
  res.status(201).json({ item });
});
admin.put("/affiliate/:id", async (req, res) => {
  const item = affiliate.find(m => m.id === req.params.id);
  if (!item) return res.status(404).json({ error: "not_found" });
  if (req.body.name != null) item.name = String(req.body.name).trim();
  if (req.body.template != null) item.template = String(req.body.template).trim();
  await persistAll();
  res.json({ item });
});
admin.delete("/affiliate/:id", async (req, res) => {
  affiliate = affiliate.filter(m => m.id !== req.params.id);
  await persistAll();
  res.json({ ok: true });
});

/* -- Clés API -- */
admin.get("/keys", (req, res) => res.json({ items: apiKeys }));
admin.post("/keys", async (req, res) => {
  const label = (req.body && req.body.label || "").trim();
  const value = (req.body && req.body.value || "").trim();
  if (!label || !value) return res.status(400).json({ error: "missing_fields" });
  const item = { id: crypto.randomBytes(4).toString("hex"), label, key: value, createdAt: Date.now() };
  apiKeys.push(item);
  await persistAll();
  res.status(201).json({ item });
});
admin.delete("/keys/:id", async (req, res) => {
  apiKeys = apiKeys.filter(k => k.id !== req.params.id);
  await persistAll();
  res.json({ ok: true });
});

/* -- Notifications (diffusion à tous) -- */
admin.get("/notifications", (req, res) => res.json({ items: notifications }));
admin.post("/notifications", async (req, res) => {
  const title = (req.body && req.body.title || "").trim();
  const body = (req.body && req.body.body || "").trim();
  if (!title) return res.status(400).json({ error: "missing_title" });
  const item = { id: crypto.randomBytes(4).toString("hex"), title, body, createdAt: Date.now() };
  notifications.push(item);
  await persistAll();
  res.status(201).json({ item });
});
admin.delete("/notifications/:id", async (req, res) => {
  notifications = notifications.filter(n => n.id !== req.params.id);
  await persistAll();
  res.json({ ok: true });
});

/* -- Console (état général, pour diagnostic rapide) -- */
admin.get("/console", async (req, res) => {
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

bootstrap().catch(err => {
  console.error("Échec du démarrage :", err);
  process.exit(1);
});"use strict";
/* ================================================================
   DealFinder AI — server.js
   Backend Express pour l'app frontend (index.html) déployée sur Render.

   PERSISTANCE — LIS CECI, C'EST IMPORTANT :
   Par défaut, les données sont stockées dans des fichiers JSON locaux
   (./data). Sur Render (plan gratuit), le disque est ÉPHÉMÈRE : il est
   réinitialisé à chaque redémarrage du service (mise en veille après
   inactivité, redéploiement, etc.) — ce n'est pas un bug du code, c'est
   le fonctionnement du plan gratuit. Résultat concret : un produit ou
   un lien d'affiliation ajouté peut disparaître après un redémarrage.

   POUR UNE PERSISTANCE VRAIMENT DÉFINITIVE ("pour la vie") :
   1. Crée un cluster MongoDB Atlas gratuit (gratuit à vie, ~5 minutes,
      aucune carte bancaire requise) : https://www.mongodb.com/cloud/atlas/register
   2. Récupère ton URI de connexion ("mongodb+srv://...")
   3. Sur Render, ajoute une variable d'environnement MONGODB_URI avec
      cette valeur, puis exécute `npm install mongodb` avant de déployer.
   Dès que MONGODB_URI est définie, TOUTES les données (produits, comptes,
   favoris, boutiques affiliées...) sont lues/écrites dans MongoDB Atlas —
   un service externe totalement indépendant de Render, qui ne s'efface
   donc jamais au redémarrage. Sans cette variable, l'app fonctionne
   quand même (fichiers locaux), mais avec le risque de perte ci-dessus.
   ================================================================ */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "12mb" })); // photos envoyées en base64 depuis l'admin

const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = "sowgueye.mariama@gmail.com";
const JWT_SECRET = process.env.JWT_SECRET || "dealfinder-dev-secret-change-me";
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

/* ---------------------------------------------------------------
   0. Stockage : MongoDB Atlas si MONGODB_URI est définie (persistance
      définitive), sinon fichiers JSON locaux (repli, non garanti sur
      Render gratuit — voir avertissement ci-dessus).
   --------------------------------------------------------------- */
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
function dbPath(name) { return path.join(DATA_DIR, name + ".json"); }

let mongoCollection = null; // défini si MONGODB_URI configurée avec succès

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
   1. Données de départ (utilisées seulement si data/products.json
      n'existe pas encore)
   --------------------------------------------------------------- */
function seedAffiliate() {
  // Aucune boutique préconfigurée : c'est l'administrateur qui les ajoute
  // lui-même (nom de la boutique + lien d'affiliation), rien n'est imposé.
  return [];
}

function seedProducts() {
  // Le premier paramètre de O() est désormais le NOM de la boutique en texte
  // libre (pas un identifiant fixe) — cohérent avec l'admin qui écrit lui-même
  // le nom de la boutique, aussi bien pour un produit que pour un lien d'affiliation.
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
   0bis. Démarrage : connecte MongoDB si configuré, charge les données,
   puis lance le serveur — tout est asynchrone pour ne rien bloquer.
   --------------------------------------------------------------- */
async function bootstrap() {
  const uri = process.env.MONGODB_URI;
  if (uri) {
    try {
      const { MongoClient } = require("mongodb"); // npm install mongodb (seulement si tu utilises MONGODB_URI)
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
    console.warn("MONGODB_URI non définie : stockage en fichiers locaux, non garanti au redémarrage sur Render gratuit.");
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

  app.listen(PORT, () => {
    console.log("DealFinder AI backend démarré sur le port " + PORT);
  });
}

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
app.get("/api/health", async (req, res) => {
  res.json({ status: "ok", time: Date.now() });
});

/* ---------------------------------------------------------------
   4. Authentification
   --------------------------------------------------------------- */
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

app.get("/api/categories", async (req, res) => {
  const cats = {};
  products.forEach(p => { cats[p.cat] = (cats[p.cat] || 0) + 1; });
  res.json(Object.keys(cats).map(id => ({ id, count: cats[id] })));
});

/* Normalisation : minuscules + suppression des accents, pour un matching fiable
   quel que soit l'orthographe utilisé ("Téléphone" doit retrouver "telephone"). */
function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
const STOPWORDS = new Set(["de","du","des","le","la","les","un","une","et","à","a","au","aux","pour","avec","sur","en","ce","ces","cette"]);
function tokenize(q) {
  return norm(q).split(/[^a-z0-9]+/).filter(t => t.length >= 2 && !STOPWORDS.has(t));
}
function productHaystack(p) {
  return norm([p.name, p.brand, p.cat, ...(p.tags || []), ...(p.specs || [])].join(" "));
}
/* Score de correspondance : plus il y a de mots de la recherche retrouvés
   (en sous-chaîne, dans le nom/marque/tags/specs), plus le produit est pertinent.
   Un match sur le nom complet ou un mot entier du nom compte double. */
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

/* Trouve une boutique ajoutée par l'admin à partir du nom écrit sur un produit
   (comparaison insensible aux accents/majuscules — pas d'ID à faire correspondre). */
function findAffiliateByName(storeName) {
  if (!storeName) return null;
  const n = norm(storeName);
  return affiliate.find(m => norm(m.name) === n) || null;
}

function baseFilter(list, { cat, brand, merchants, inStock, knownShip, min, max }) {
    if (cat) list = list.filter(p => norm(p.cat) === norm(cat));
    if (brand) list = list.filter(p => norm(p.brand) === norm(String(brand)));
    if (merchants) {
      const set = new Set(String(merchants).split(",").map(norm));
      list = list.filter(p => p.offers.some(o => set.has(norm(o.store))));
    }
    if (inStock === "1" || inStock === "true") list = list.filter(p => p.offers.some(o => o.stock));
    if (knownShip === "1" || knownShip === "true") list = list.filter(p => p.offers.some(o => o.ship >= 0));
    if (min) list = list.filter(p => fcfa(bestOffer(p)) >= Number(min));
    if (max) list = list.filter(p => fcfa(bestOffer(p)) <= Number(max));
    return list;
}

app.get("/api/products", async (req, res) => {
  const { q, cat, brand, min, max, merchants, inStock, knownShip, sort } = req.query;
  const tokens = q ? tokenize(q) : [];
  const filters = { cat, brand, merchants, inStock, knownShip, min, max };

  // Étape 1 : correspondance par mots-clés (tolérante aux accents/casse), la plus précise.
  let list = baseFilter(products.slice(), filters);
  let usedFallback = false;
  if (tokens.length) {
    const scored = list.map(p => ({ p, s: matchScore(p, tokens) })).filter(x => x.s > 0);
    if (scored.length) {
      scored.sort((a, b) => b.s - a.s);
      list = scored.map(x => x.p);
    } else {
      // Étape 2 : aucun mot ne correspond exactement — on élargit à la catégorie/marque
      // déduite de la recherche, pour ne jamais renvoyer "aucun résultat" à tort.
      usedFallback = true;
      list = baseFilter(products.slice(), filters);
      if (!cat && !brand) list = []; // vraiment rien à proposer comme base large
    }
  }

  if (sort === "price_asc") list.sort((a, b) => fcfa(bestOffer(a)) - fcfa(bestOffer(b)));
  else if (sort === "price_desc") list.sort((a, b) => fcfa(bestOffer(b)) - fcfa(bestOffer(a)));
  else if (sort === "new") list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const out = list.map(p => decorate(p));

  // Suggestions "même catégorie" — toujours fournies pour compléter les résultats.
  let suggestions = [];
  const suggCat = cat || (out.length ? out[0].cat : null);
  if (suggCat) {
    suggestions = products
      .filter(p => p.cat === suggCat && !out.some(o => o.id === p.id))
      .slice(0, 8)
      .map(p => decorate(p));
  } else if (!out.length) {
    suggestions = products.slice(-8).reverse().map(p => decorate(p));
  }

  if (q) { stats.searches++; await persistAll(); }
  res.json({
    usedFallback,
    count: out.length,
    offersCompared: list.reduce((s, p) => s + p.offers.length, 0),
    products: out,
    suggestions
  });
});

function decorate(p) {
  const best = bestOffer(p);
  const aff = findAffiliateByName(best.store);
  return {
    id: p.id, cat: p.cat, brand: p.brand, name: p.name, image: p.image,
    specs: p.specs, offersCount: p.offers.length,
    best: {
      ...best,
      merchantName: best.store,
      isAffiliate: !!(aff && aff.template)
    }
  };
}

/* Liste publique des boutiques connues (celles ajoutées en admin + celles
   déjà utilisées sur des produits), pour les filtres de recherche. */
app.get("/api/merchants", async (req, res) => {
  const names = new Set(affiliate.map(m => m.name));
  products.forEach(p => p.offers.forEach(o => { if (o.store) names.add(o.store); }));
  res.json({ items: Array.from(names).map(name => ({ id: name, name, affiliate: !!findAffiliateByName(name) })) });
});

app.get("/api/products/:id", async (req, res) => {
  const p = products.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "not_found" });
  const offers = p.offers.map(o => {
    const aff = findAffiliateByName(o.store);
    return {
      ...o,
      merchantName: o.store,
      isAffiliate: !!(aff && aff.template),
      finalLink: buildAffiliateLink(o)
    };
  });
  res.json({ ...p, offers });
});

function buildAffiliateLink(offer) {
  const merch = findAffiliateByName(offer.store);
  if (!merch || !merch.template) return offer.link || "";
  // Le lien produit est combiné au modèle de lien d'affiliation défini en admin.
  return merch.template.split("{LINK}").join(encodeURIComponent(offer.link || ""));
}

/* Suivi d'un clic "Voir l'offre" (stat + redirection tracée) */
app.post("/api/products/:id/click", async (req, res) => {
  const p = products.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "not_found" });
  stats.clicks++; await persistAll();
  res.json({ ok: true });
});

/* ---------------------------------------------------------------
   6. Favoris & historique (utilisateur connecté)
   --------------------------------------------------------------- */
app.get("/api/favorites", authMiddleware, async (req, res) => {
  const ids = favorites[req.user.email] || [];
  res.json({ ids });
});
app.post("/api/favorites", authMiddleware, async (req, res) => {
  const id = req.body && req.body.productId;
  if (!id) return res.status(400).json({ error: "missing_productId" });
  const list = favorites[req.user.email] || [];
  if (!list.includes(id)) list.push(id);
  favorites[req.user.email] = list;
  stats.favs++; await persistAll();
  res.json({ ids: list });
});
app.delete("/api/favorites/:id", authMiddleware, async (req, res) => {
  const list = (favorites[req.user.email] || []).filter(x => x !== req.params.id);
  favorites[req.user.email] = list;
  await persistAll();
  res.json({ ids: list });
});

app.get("/api/history", authMiddleware, async (req, res) => {
  res.json({ items: history[req.user.email] || [] });
});
app.post("/api/history", authMiddleware, async (req, res) => {
  const q = (req.body && req.body.q || "").trim();
  if (!q) return res.status(400).json({ error: "missing_q" });
  const list = history[req.user.email] || [];
  list.unshift({ q, at: Date.now() });
  history[req.user.email] = list.slice(0, 30);
  await persistAll();
  res.json({ items: history[req.user.email] });
});

/* Partage (stat uniquement) */
app.post("/api/share", async (req, res) => {
  stats.shares++; await persistAll();
  res.json({ ok: true });
});

/* Effacer les données d'un compte */
app.delete("/api/account/data", authMiddleware, async (req, res) => {
  delete favorites[req.user.email];
  delete history[req.user.email];
  await persistAll();
  res.json({ ok: true });
});

/* ---------------------------------------------------------------
   7. Notifications (diffusion à tous les utilisateurs)
   --------------------------------------------------------------- */
app.get("/api/notifications", async (req, res) => {
  res.json({ items: notifications.slice(-50).reverse() });
});

/* ---------------------------------------------------------------
   8. Statistiques anonymisées (lecture publique, agrégées)
   --------------------------------------------------------------- */
app.get("/api/stats", async (req, res) => {
  res.json(stats);
});

/* ================================================================
   9. Panneau d'administration — réservé à ADMIN_EMAIL
   ================================================================ */
const admin = express.Router();
admin.use(authMiddleware, adminOnly);

/* -- Produits -- */
admin.get("/products", (req, res) => res.json({ items: products }));

admin.post("/products", async (req, res) => {
  const b = req.body || {};
  if (!b.image || !String(b.image).trim()) {
    return res.status(400).json({ error: "missing_image" }); // la photo est obligatoire
  }
  const offers = (b.offers || []).map(o => ({
    store: (o.store || "").trim(),
    price: Number(o.price) || 0,
    cur: o.cur || "FCFA",
    stock: o.stock !== false,
    ship: o.ship != null ? o.ship : -1,
    link: o.link || "",
    updatedAt: Date.now()
  }));
  if (offers.length && offers.some(o => !o.store)) {
    return res.status(400).json({ error: "missing_store" }); // le nom de la boutique est obligatoire
  }
  const id = b.id || ("p" + crypto.randomBytes(4).toString("hex"));
  if (products.some(p => p.id === id)) return res.status(409).json({ error: "id_exists" });
  const product = {
    id,
    cat: b.cat || "Autres",
    brand: b.brand || "",
    name: b.name || "Produit sans nom",
    tags: b.tags || [],
    specs: b.specs || [],
    image: b.image || "",
    offers,
    createdAt: Date.now()
  };
  products.push(product);
  await persistAll();
  res.status(201).json({ item: product });
});

admin.put("/products/:id", async (req, res) => {
  const idx = products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not_found" });
  products[idx] = { ...products[idx], ...req.body, id: products[idx].id };
  await persistAll();
  res.json({ item: products[idx] });
});

admin.delete("/products/:id", async (req, res) => {
  const before = products.length;
  products = products.filter(p => p.id !== req.params.id);
  await persistAll();
  res.json({ ok: true, deleted: before - products.length });
});

/* Import en masse : liens, un par ligne → produits pré-remplis (nom de
   boutique deviné à titre indicatif, l'admin peut le changer librement) */
admin.post("/products/bulk-import", async (req, res) => {
  const links = (req.body && req.body.links) || [];
  const created = links.filter(Boolean).map(url => {
    const id = "p" + crypto.randomBytes(4).toString("hex");
    const product = {
      id, cat: "Autres", brand: "", name: guessNameFromUrl(url),
      tags: [], specs: [], image: "",
      offers: [{ store: detectStoreNameFromUrl(url) || "", price: 0, cur: "FCFA", stock: true, ship: -1, link: url, updatedAt: Date.now() }],
      createdAt: Date.now()
    };
    products.push(product);
    return product;
  });
  await persistAll();
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
function detectStoreNameFromUrl(url) {
  const u = (url || "").toLowerCase();
  const MAP = [["jumia", "Jumia"], ["shein", "Shein"], ["amazon", "Amazon"], ["aliexpress", "AliExpress"],
    ["temu", "Temu"], ["ebay", "eBay"], ["wish", "Wish"], ["konga", "Konga"], ["alibaba", "Alibaba"]];
  for (const [k, name] of MAP) if (u.includes(k)) return name;
  return "";
}

/* -- Affiliation : liste libre de boutiques ajoutées par l'admin --
   Juste un nom de boutique + un lien d'affiliation, rien de préconfiguré. */
admin.get("/affiliate", (req, res) => res.json({ items: affiliate }));
admin.post("/affiliate", async (req, res) => {
  const name = (req.body && req.body.name || "").trim();
  const template = (req.body && req.body.template || "").trim();
  if (!name) return res.status(400).json({ error: "missing_name" });
  const item = { id: crypto.randomBytes(4).toString("hex"), name, template };
  affiliate.push(item);
  await persistAll();
  res.status(201).json({ item });
});
admin.put("/affiliate/:id", async (req, res) => {
  const item = affiliate.find(m => m.id === req.params.id);
  if (!item) return res.status(404).json({ error: "not_found" });
  if (req.body.name != null) item.name = String(req.body.name).trim();
  if (req.body.template != null) item.template = String(req.body.template).trim();
  await persistAll();
  res.json({ item });
});
admin.delete("/affiliate/:id", async (req, res) => {
  affiliate = affiliate.filter(m => m.id !== req.params.id);
  await persistAll();
  res.json({ ok: true });
});

/* -- Clés API -- */
admin.get("/keys", (req, res) => res.json({ items: apiKeys }));
admin.post("/keys", async (req, res) => {
  const label = (req.body && req.body.label || "").trim();
  const value = (req.body && req.body.value || "").trim();
  if (!label || !value) return res.status(400).json({ error: "missing_fields" });
  const item = { id: crypto.randomBytes(4).toString("hex"), label, key: value, createdAt: Date.now() };
  apiKeys.push(item);
  await persistAll();
  res.status(201).json({ item });
});
admin.delete("/keys/:id", async (req, res) => {
  apiKeys = apiKeys.filter(k => k.id !== req.params.id);
  await persistAll();
  res.json({ ok: true });
});

/* -- Notifications (diffusion à tous) -- */
admin.get("/notifications", (req, res) => res.json({ items: notifications }));
admin.post("/notifications", async (req, res) => {
  const title = (req.body && req.body.title || "").trim();
  const body = (req.body && req.body.body || "").trim();
  if (!title) return res.status(400).json({ error: "missing_title" });
  const item = { id: crypto.randomBytes(4).toString("hex"), title, body, createdAt: Date.now() };
  notifications.push(item);
  await persistAll();
  res.status(201).json({ item });
});
admin.delete("/notifications/:id", async (req, res) => {
  notifications = notifications.filter(n => n.id !== req.params.id);
  await persistAll();
  res.json({ ok: true });
});

/* -- Console (état général, pour diagnostic rapide) -- */
admin.get("/console", async (req, res) => {
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

bootstrap().catch(err => {
  console.error("Échec du démarrage :", err);
  process.exit(1);
});
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // 10mb : les photos en base64 peuvent être volumineuses

const dataDir = path.join(__dirname, 'backend', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
const dbPath = path.join(dataDir, 'dealfinder.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

/* ================================================================
   SCHÉMA
   ================================================================ */
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    brand TEXT,
    cat TEXT DEFAULT 'autres',
    price REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'FCFA',
    merchant_name TEXT NOT NULL DEFAULT 'Boutique partenaire',
    product_url TEXT NOT NULL,
    image TEXT NOT NULL,
    in_stock INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS apikeys (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS favorites (
    email TEXT NOT NULL,
    product_id TEXT NOT NULL,
    saved_price REAL,
    currency TEXT,
    saved_at INTEGER NOT NULL,
    PRIMARY KEY (email, product_id)
  );
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    query TEXT NOT NULL,
    n_results INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT,
    merchant_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS share_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT,
    type TEXT,
    created_at INTEGER NOT NULL
  );
`);

/* ================================================================
   🛡️ SÉCURITÉ ADMINISTRATEUR EXCLUSIF UNIQUE
   ================================================================ */
const EXCLUSIVE_ADMIN = "sowgueye.mariama@gmail.com";

function userByToken(token) {
  if (!token) return null;
  return db.prepare("SELECT * FROM users WHERE token = ?").get(token) || null;
}
function bearerToken(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}
// Compatible avec les deux façons d'authentifier l'administrateur :
// l'en-tête direct x-admin-auth-email, OU un token de session dont
// l'e-mail associé est bien l'administrateur exclusif.
function verifyAdminPermission(req, res, next) {
  const headerEmail = req.headers['x-admin-auth-email'];
  if (headerEmail === EXCLUSIVE_ADMIN) return next();
  const u = userByToken(bearerToken(req));
  if (u && u.email === EXCLUSIVE_ADMIN) return next();
  return res.status(403).json({ error: "Accès refusé. Vous n'êtes pas l'administrateur unique." });
}
// Identifie un utilisateur normal (facultatif — favoris/historique) sans bloquer si absent.
function optionalUser(req, res, next) {
  req.user = userByToken(bearerToken(req));
  next();
}
function requireUser(req, res, next) {
  req.user = userByToken(bearerToken(req));
  if (!req.user) return res.status(401).json({ error: "Non connecté." });
  next();
}

/* ================================================================
   OUTILS
   ================================================================ */
const TO_FCFA = { FCFA: 1, EUR: 655.957, USD: 610, GBP: 775 };
function toFcfa(price, cur) { return price * (TO_FCFA[cur] || 1); }
function normText(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
const STOPWORDS = new Set(["le","la","les","de","des","du","un","une","et","en","pour","avec","sur","dans","par",
  "moins","plus","max","maximum","budget","cher","entre","sous","que","quel","quelle","combien"]);

function parseBudget(rawQuery) {
  const q = normText(rawQuery);
  let cur = 'FCFA';
  if (/€|eur\b/.test(q)) cur = 'EUR';
  else if (/\$|usd\b/.test(q)) cur = 'USD';
  else if (/£|gbp\b/.test(q)) cur = 'GBP';
  const range = q.match(/entre\s*([\d][\d\s.,]*)\s*(?:et|-)\s*([\d][\d\s.,]*)/);
  const max = q.match(/(?:a moins de|moins de|pas plus de|sous|max(?:imum)?(?: de)?|budget(?: max)?(?: de)?|inferieur(?:e)? a|en dessous de|<)\s*([\d][\d\s.,]*)/);
  const num = s => parseFloat(String(s).replace(/[\s.]/g, '').replace(',', '.')) || 0;
  if (range) return { min: num(range[1]) * TO_FCFA[cur], max: num(range[2]) * TO_FCFA[cur] };
  if (max) return { min: null, max: num(max[1]) * TO_FCFA[cur] };
  return { min: null, max: null };
}
function slugMerchant(name) {
  return normText(name).replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'boutique';
}
function maskKey(v) {
  if (!v) return '';
  if (v.length <= 6) return v[0] + '***';
  return v.slice(0, 4) + '••••••' + v.slice(-2);
}
function rowToOffer(row) {
  const hours = Math.max(0, Math.round((Date.now() - row.created_at) / 3600000));
  return {
    id: 'a' + row.id,
    cat: row.cat || 'autres',
    brand: row.brand || '',
    name: row.name,
    tags: [],
    specs: [],
    offers: [{
      m: slugMerchant(row.merchant_name),
      merchantName: row.merchant_name,
      price: row.price,
      cur: row.currency,
      stock: !!row.in_stock,
      ship: -1,
      h: hours,
      productUrl: row.product_url,
      remote: true
    }]
  };
}
function rowToFlat(row) {
  return {
    id: 'a' + row.id,
    cat: row.cat || 'autres',
    brand: row.brand || '',
    title: row.name,
    name: row.name,
    price: row.price,
    currency: row.currency,
    merchant_name: row.merchant_name,
    merchant: row.merchant_name,
    image: row.image,
    in_stock: !!row.in_stock,
    product_url: row.product_url,
    url: row.product_url
  };
}
function getSetting(key) {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return r ? r.value : null;
}

/* ================================================================
   SANTÉ
   ================================================================ */
app.get('/api/health', (req, res) => {
  res.json({ status: "online", secure: true });
});

/* ================================================================
   RECHERCHE — trouve directement le produit demandé.
   ================================================================ */
app.post('/api/search', (req, res) => {
  const raw = (req.body && req.body.query || '').toString();
  if (!raw.trim()) return res.json({ products: [], merchants: [], demo: false });

  const { min, max } = parseBudget(raw);
  const tokens = normText(raw).split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));

  const all = db.prepare("SELECT * FROM products WHERE image IS NOT NULL AND image != '' AND product_url IS NOT NULL AND product_url != ''").all();

  let scored = all.map(row => {
    const hay = normText(row.name + ' ' + (row.brand || '') + ' ' + row.merchant_name);
    let score = 0;
    tokens.forEach(w => { if (hay.includes(w)) score += 1; });
    // correspondance exacte de la requête entière = très forte priorité (« trouve directement »)
    if (hay.includes(normText(raw).trim())) score += 5;
    return { row, score };
  }).filter(x => x.score > 0 || tokens.length === 0);

  if (min != null) scored = scored.filter(x => toFcfa(x.row.price, x.row.currency) >= min);
  if (max != null) scored = scored.filter(x => toFcfa(x.row.price, x.row.currency) <= max);

  scored.sort((a, b) => b.score - a.score || a.row.price - b.row.price);

  const products = scored.slice(0, 40).map(x => rowToOffer(x.row));
  const merchantMap = new Map();
  scored.forEach(x => merchantMap.set(slugMerchant(x.row.merchant_name), x.row.merchant_name));
  const merchants = [...merchantMap.entries()].map(([id, name]) => ({ id, name }));

  res.json({ products, merchants, demo: false });
});

/* ================================================================
   SUGGESTIONS PUBLIQUES (page « aucun résultat » + catégories)
   ================================================================ */
app.get('/api/products', (req, res) => {
  try {
    const rows = db.prepare(
      "SELECT * FROM products WHERE image IS NOT NULL AND image != '' AND product_url IS NOT NULL AND product_url != '' ORDER BY created_at DESC LIMIT 60"
    ).all();
    res.json({ products: rows.map(rowToFlat) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================================================================
   ANNONCE ACTIVE (bannière vue par tous les utilisateurs)
   ================================================================ */
app.get('/api/announcement', (req, res) => {
  const a = db.prepare("SELECT * FROM announcements WHERE active = 1 ORDER BY created_at DESC LIMIT 1").get();
  res.json({ announcement: a ? { id: a.id, title: a.title, body: a.body } : null });
});

/* ================================================================
   COMPTE (facultatif — favoris / historique / accès admin)
   ================================================================ */
app.post('/api/auth/register', (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  if (name.length < 2) return res.status(400).json({ error: 'invalid_name' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'invalid_email' });
  let u = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  const token = crypto.randomBytes(24).toString('hex');
  if (u) {
    db.prepare("UPDATE users SET name = ?, token = ? WHERE email = ?").run(name, token, email);
  } else {
    db.prepare("INSERT INTO users (email, name, token, created_at) VALUES (?, ?, ?, ?)").run(email, name, token, Date.now());
  }
  res.json({ token, name, email });
});
app.post('/api/auth/logout', optionalUser, (req, res) => {
  if (req.user) db.prepare("UPDATE users SET token = ? WHERE email = ?").run(crypto.randomBytes(24).toString('hex'), req.user.email);
  res.json({ success: true });
});
app.get('/api/me', requireUser, (req, res) => {
  res.json({ name: req.user.name, email: req.user.email });
});

app.get('/api/favorites', requireUser, (req, res) => {
  const rows = db.prepare("SELECT * FROM favorites WHERE email = ?").all(req.user.email);
  res.json({ favorites: rows.map(r => ({ productId: r.product_id, savedPrice: r.saved_price, currency: r.currency, savedAt: r.saved_at })) });
});
app.post('/api/favorites', requireUser, (req, res) => {
  const { productId, savedPrice, currency } = req.body;
  if (!productId) return res.status(400).json({ error: 'productId requis' });
  db.prepare(`INSERT INTO favorites (email, product_id, saved_price, currency, saved_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(email, product_id) DO UPDATE SET saved_price=excluded.saved_price, currency=excluded.currency`)
    .run(req.user.email, productId, savedPrice || null, currency || 'FCFA', Date.now());
  res.json({ success: true });
});
app.delete('/api/favorites', requireUser, (req, res) => {
  const { productId } = req.body;
  db.prepare("DELETE FROM favorites WHERE email = ? AND product_id = ?").run(req.user.email, productId);
  res.json({ success: true });
});

app.get('/api/history', requireUser, (req, res) => {
  const rows = db.prepare("SELECT query, created_at FROM history WHERE email = ? ORDER BY created_at DESC LIMIT 8").all(req.user.email);
  res.json({ history: rows.map(r => ({ query: r.query, createdAt: r.created_at })) });
});
app.post('/api/history', requireUser, (req, res) => {
  const { query, nResults } = req.body;
  if (!query) return res.status(400).json({ error: 'query requis' });
  db.prepare("INSERT INTO history (email, query, n_results, created_at) VALUES (?, ?, ?, ?)")
    .run(req.user.email, query, nResults || 0, Date.now());
  res.json({ success: true });
});

/* ================================================================
   CLIC SUR « VOIR L'OFFRE » — combine le lien produit + le lien
   d'affiliation pour que la boutique sache que la vente vient de
   l'application, puis redirige.
   ================================================================ */
app.post('/api/clicks', optionalUser, (req, res) => {
  const { productId, merchantId } = req.body;
  const idNum = parseInt(String(productId || '').replace(/^a/, ''), 10);
  const row = idNum ? db.prepare("SELECT * FROM products WHERE id = ?").get(idNum) : null;
  db.prepare("INSERT INTO clicks (product_id, merchant_id, created_at) VALUES (?, ?, ?)")
    .run(productId || null, merchantId || null, Date.now());
  if (!row) return res.status(404).json({ error: 'Produit introuvable' });

  const tag = getSetting('affiliateTag') || '';
  const tpl = getSetting('trackingTemplate') || '';
  const clickId = 'DF-' + Date.now().toString(36).toUpperCase();
  let url = row.product_url;
  if (tag) {
    if (tpl && tpl.includes('{url}')) {
      url = tpl.replace('{url}', encodeURIComponent(row.product_url)).replace('{tag}', encodeURIComponent(tag)).replace('{clickId}', clickId);
    } else {
      const sep = row.product_url.includes('?') ? '&' : '?';
      url = row.product_url + sep + 'ref=' + encodeURIComponent(tag) + '&clickId=' + clickId;
    }
  }
  res.json({ url });
});

app.post('/api/share-events', optionalUser, (req, res) => {
  const { productId, type } = req.body;
  db.prepare("INSERT INTO share_events (product_id, type, created_at) VALUES (?, ?, ?)").run(productId || null, type || 'product', Date.now());
  res.json({ success: true });
});

/* ================================================================
   ADMINISTRATION — réservée à sowgueye.mariama@gmail.com
   ================================================================ */

// --- Produits : photo obligatoire, marque JAMAIS demandée ---
app.get('/api/admin/products', verifyAdminPermission, (req, res) => {
  const rows = db.prepare("SELECT * FROM products ORDER BY created_at DESC").all();
  res.json({
    products: rows.map(r => ({
      id: 'a' + r.id, name: r.name, brand: r.brand || '', cat: r.cat,
      price: r.price, currency: r.currency, merchant_name: r.merchant_name,
      product_url: r.product_url, image: r.image, stock: !!r.in_stock
    }))
  });
});
app.post('/api/admin/products', verifyAdminPermission, (req, res) => {
  const { name, price, currency, merchant_name, product_url, image, cat } = req.body;
  if (!name || !isFinite(parseFloat(price)) || !product_url) {
    return res.status(400).json({ error: "Nom, prix et lien boutique requis." });
  }
  if (!image || !image.trim()) {
    return res.status(400).json({ error: "La photo du produit est obligatoire." });
  }
  const info = db.prepare(`INSERT INTO products (name, brand, cat, price, currency, merchant_name, product_url, image, in_stock, created_at)
                            VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 1, ?)`)
    .run(name.trim(), (cat || 'autres'), parseFloat(price), (currency || 'FCFA').toUpperCase(),
         (merchant_name || 'Boutique partenaire').trim(), product_url.trim(), image.trim(), Date.now());
  res.json({ success: true, id: 'a' + info.lastInsertRowid });
});
app.put('/api/admin/products/:id', verifyAdminPermission, (req, res) => {
  const idNum = parseInt(String(req.params.id).replace(/^a/, ''), 10);
  const row = db.prepare("SELECT * FROM products WHERE id = ?").get(idNum);
  if (!row) return res.status(404).json({ error: "Produit introuvable." });
  const price = req.body.price != null ? parseFloat(req.body.price) : row.price;
  const stock = req.body.stock != null ? (req.body.stock ? 1 : 0) : row.in_stock;
  const product_url = req.body.product_url != null && req.body.product_url.trim() ? req.body.product_url.trim() : row.product_url;
  db.prepare("UPDATE products SET price = ?, in_stock = ?, product_url = ? WHERE id = ?").run(price, stock, product_url, idNum);
  res.json({ success: true });
});
app.delete('/api/admin/products/:id', verifyAdminPermission, (req, res) => {
  const idNum = parseInt(String(req.params.id).replace(/^a/, ''), 10);
  db.prepare("DELETE FROM products WHERE id = ?").run(idNum);
  res.json({ success: true });
});

// --- Affiliation : tag + gabarit de lien, appliqués automatiquement à tous ---
app.get('/api/admin/settings', verifyAdminPermission, (req, res) => {
  res.json({
    affiliateTag: getSetting('affiliateTag') || '',
    trackingTemplate: getSetting('trackingTemplate') || ''
  });
});
app.post('/api/admin/settings', verifyAdminPermission, (req, res) => {
  const { affiliateTag, trackingTemplate } = req.body;
  if (trackingTemplate && !trackingTemplate.includes('{url}')) {
    return res.status(400).json({ error: "Le modèle doit contenir {url}." });
  }
  const set = (k, v) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);
  if (affiliateTag) set('affiliateTag', affiliateTag.trim());
  if (trackingTemplate) set('trackingTemplate', trackingTemplate.trim());
  res.json({ success: true });
});

// --- Clés (API keys) : acceptées et appliquées immédiatement ---
app.get('/api/admin/apikeys', verifyAdminPermission, (req, res) => {
  const rows = db.prepare("SELECT * FROM apikeys ORDER BY name").all();
  const keys = {};
  rows.forEach(r => { keys['apikey_' + r.name] = maskKey(r.value); });
  res.json({ keys });
});
app.post('/api/admin/apikeys', verifyAdminPermission, (req, res) => {
  const { name, value } = req.body;
  if (!name || !value) return res.status(400).json({ error: "Nom et valeur requis." });
  db.prepare(`INSERT INTO apikeys (name, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(name.trim(), value.trim(), Date.now());
  res.json({ success: true });
});
app.delete('/api/admin/apikeys', verifyAdminPermission, (req, res) => {
  const { name } = req.body;
  db.prepare("DELETE FROM apikeys WHERE name = ?").run((name || '').replace(/^apikey_/, ''));
  res.json({ success: true });
});

// --- Annonces : publiées instantanément, vues par tous ---
app.get('/api/admin/announcements', verifyAdminPermission, (req, res) => {
  const rows = db.prepare("SELECT * FROM announcements ORDER BY created_at DESC LIMIT 30").all();
  res.json({ announcements: rows.map(r => ({ id: r.id, title: r.title, body: r.body, active: !!r.active })) });
});
app.post('/api/admin/announcements', verifyAdminPermission, (req, res) => {
  const { title, body } = req.body;
  if (!title || title.trim().length < 3) return res.status(400).json({ error: "Titre trop court." });
  if (title.length > 200) return res.status(400).json({ error: "Titre trop long." });
  if (body && body.length > 2000) return res.status(400).json({ error: "Message trop long." });
  db.prepare("UPDATE announcements SET active = 0 WHERE active = 1"); // une seule annonce active à la fois
  const info = db.prepare("INSERT INTO announcements (title, body, active, created_at) VALUES (?, ?, 1, ?)")
    .run(title.trim(), (body || '').trim(), Date.now());
  res.json({ success: true, id: info.lastInsertRowid });
});
app.post('/api/admin/announcements/:id/deactivate', verifyAdminPermission, (req, res) => {
  db.prepare("UPDATE announcements SET active = 0 WHERE id = ?").run(parseInt(req.params.id, 10));
  res.json({ success: true });
});

// --- Vue d'ensemble ---
app.get('/api/admin/overview', verifyAdminPermission, (req, res) => {
  const nProducts = db.prepare("SELECT COUNT(*) n FROM products").get().n;
  const nClicks = db.prepare("SELECT COUNT(*) n FROM clicks").get().n;
  const nShares = db.prepare("SELECT COUNT(*) n FROM share_events").get().n;
  const nSearches = db.prepare("SELECT COUNT(*) n FROM history").get().n;
  const nUsers = db.prepare("SELECT COUNT(*) n FROM users").get().n;
  res.json({ products: nProducts, clicks: nClicks, shares: nShares, searches: nSearches, users: nUsers });
});

/* ================================================================
   DÉMARRAGE
   ================================================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Serveur DealFinder — administration + recherche + affiliation actifs sur le port " + PORT));
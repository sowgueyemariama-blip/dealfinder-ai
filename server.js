const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
app.use(cors());
app.use(express.json());

const dataDir = path.join(__dirname, 'backend', 'data');
if (!fs.existsSync(dataDir)){
    fs.mkdirSync(dataDir, { recursive: true });
}
const dbPath = path.join(dataDir, 'dealfinder.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price REAL,
    link TEXT,
    image TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// 🛡️ SÉCURITÉ DE L'ADMINISTRATEUR UNIQUE
const ADMIN_EMAIL = "sowgueye.mariama@gmail.com";

function checkAdmin(req, res, next) {
    const userEmail = req.headers['x-admin-email'];
    if (userEmail !== ADMIN_EMAIL) {
        return res.status(403).json({ error: "Accès refusé. Vous n'êtes pas l'administrateur unique." });
    }
    next();
}

app.get('/api/health', (req, res) => {
    res.json({ ok: true, admin: ADMIN_EMAIL });
});

// ROUTE RECHERCHE / RETRAIT DES PRODUITS
app.get('/api/products', (req, res) => {
    try {
        const products = db.prepare("SELECT * FROM products ORDER BY id DESC").all();
        res.json(products);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// RECHERCHE DYNAMIQUE (Jumia, Shein, Temu basés sur vos liens d'affiliation)
app.get('/api/search', (req, res) => {
    const query = req.query.q || '';
    if (!query) return res.json([]);

    const cleanQuery = query.trim();
    const rows = db.prepare("SELECT * FROM settings").all();
    const settings = {};
    rows.forEach(r => settings[r.key] = r.value);

    const results = [];
    let productImg = "https://unsplash.com"; 
    
    if (cleanQuery.toLowerCase().includes("robe") || cleanQuery.toLowerCase().includes("vêtement")) {
        productImg = "https://unsplash.com"; 
    } else if (cleanQuery.toLowerCase().includes("chaussure")) {
        productImg = "https://unsplash.com";
    }

    if (settings.jumia_link) {
        results.push({
            name: `${cleanQuery.toUpperCase()} - Jumia Sénégal`,
            price: "Prix Jumia",
            image: productImg,
            link: `${settings.jumia_link}&next=https%3A%2F%2Fwww.jumia.sn%2Fcatalog%2F%3Fq%3D${encodeURIComponent(cleanQuery)}`,
            provider: "Jumia"
        });
    }

    if (settings.shein_link) {
        results.push({
            name: `${cleanQuery.toUpperCase()} - Collection SHEIN`,
            price: "Prix SHEIN",
            image: productImg,
            link: `${settings.shein_link}&url=https%3A%2F%://shein.com%2Fpdsearch%2F${encodeURIComponent(cleanQuery)}%2F`,
            provider: "SHEIN"
        });
    }

    try {
        const local = db.prepare("SELECT * FROM products WHERE name LIKE ?").all(`%${cleanQuery}%`);
        local.forEach(p => {
            results.unshift({ name: p.name, price: p.price + " FCFA", image: p.image, link: p.link, provider: "Manuel" });
        });
    } catch(e){}

    res.json(results);
});

// AJOUTER UN PRODUIT MANUEL (Sécurisé par Admin Email + Photo Obligatoire - Pas de marque)
app.post('/api/products', checkAdmin, (req, res) => {
    const { name, price, link, image } = req.body;
    if (!name || !link) return res.status(400).json({ error: "Données manquantes" });
    if (!image || image.trim() === "") {
        return res.status(400).json({ error: "Erreur : La photo du produit est obligatoire !" });
    }
    
    try {
        const insert = db.prepare("INSERT INTO products (name, price, link, image) VALUES (?, ?, ?, ?)");
        insert.run(name, price, link, image);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// SAUVEGARDER LES RÉGLAGES (Sécurisé par Admin Email)
app.post('/api/settings', checkAdmin, (req, res) => {
    const { key, value } = req.body;
    try {
        const upsert = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=?");
        upsert.run(key, value, value);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/settings', (req, res) => {
    try {
        const rows = db.prepare("SELECT * FROM settings").all();
        const settings = {};
        rows.forEach(row => settings[row.key] = row.value);
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur DealFinder sécurisé actif`));

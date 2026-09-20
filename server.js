const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
app.use(cors());
app.use(express.json());

// 1. GESTION DE L'ENTREPÔT (Base de données intégrée)
const dataDir = path.join(__dirname, 'backend', 'data');
if (!fs.existsSync(dataDir)){
    fs.mkdirSync(dataDir, { recursive: true });
}
const dbPath = path.join(dataDir, 'dealfinder.db');
const db = new Database(dbPath);

// Création automatique des tables
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

// 2. ROUTES POUR VOTRE PANNEAU ADMINISTRATEUR (Console)
// Route de santé (pour tester si le serveur répond "ok")
app.get('/api/health', (req, res) => {
    res.json({ ok: true, message: "Le serveur DealFinder fonctionne parfaitement !" });
});

// Récupérer les produits pour les suggestions
app.get('/api/products', (req, res) => {
    try {
        const products = db.prepare("SELECT * FROM products ORDER BY id DESC").all();
        res.json(products);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Ajouter un produit depuis la console
app.post('/api/products', (req, res) => {
    const { name, price, link, image } = req.body;
    if (!name) return res.status(400).json({ error: "Le nom du produit est requis" });
    
    try {
        const insert = db.prepare("INSERT INTO products (name, price, link, image) VALUES (?, ?, ?, ?)");
        const result = insert.run(name, price, link, image);
        res.json({ success: true, id: result.lastInsertRowid });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Sauvegarder un réglage (Clés API, Affiliations, Annonces)
app.post('/api/settings', (req, res) => {
    const { key, value } = req.body;
    try {
        const upsert = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=?");
        upsert.run(key, value, value);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Récupérer les réglages
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

// Démarrage du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serveur en ligne sur le port ${PORT}`);
});

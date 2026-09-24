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

// Table d'origine (sans le champ marque, nettoyé)
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    link TEXT NOT NULL,
    image TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// 🛡️ SÉCURITÉ ADMINISTRATEUR UNIQUE EXCLUSIF
const EXCLUSIVE_ADMIN = "sowgueye.mariama@gmail.com";

function verifyAdminPermission(req, res, next) {
    const incomingEmail = req.headers['x-admin-auth-email'];
    if (incomingEmail !== EXCLUSIVE_ADMIN) {
        return res.status(403).json({ error: "Accès refusé. Vous n'êtes pas l'administrateur unique." });
    }
    next();
}

app.get('/api/health', (req, res) => {
    res.json({ status: "online", secure: true });
});

// ROUTE RECHERCHE UTILISATEUR
app.get('/api/search', (req, res) => {
    const query = req.query.q || '';
    if (!query) return res.json([]);
    const cleanQuery = query.trim().toLowerCase();

    try {
        const products = db.prepare("SELECT * FROM products WHERE lower(name) LIKE ?").all(`%${cleanQuery}%`);
        res.json(products);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// AJOUTER UN PRODUIT (Sécurisé + Photo obligatoire)
app.post('/api/products', verifyAdminPermission, (req, res) => {
    const { name, price, link, image } = req.body;
    
    if (!name || !price || !link) return res.status(400).json({ error: "Champs requis manquants." });
    if (!image || image.trim() === "") {
        return res.status(400).json({ error: "La photo du produit est obligatoire." });
    }

    try {
        const statement = db.prepare("INSERT INTO products (name, price, link, image) VALUES (?, ?, ?, ?)");
        const result = statement.run(name, price, link, image);
        res.json({ success: true, id: result.lastInsertRowid });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ENREGISTRER LES MODIFICATIONS (Sécurisé)
app.post('/api/settings', verifyAdminPermission, (req, res) => {
    const { key, value } = req.body;
    try {
        const statement = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=?");
        statement.run(key, value, value);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// RÉCUPÉRER LES RÉGLAGES
app.get('/api/settings', (req, res) => {
    try {
        const rows = db.prepare("SELECT * FROM settings").all();
        const config = {};
        rows.forEach(r => config[r.key] = r.value);
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Serveur DealFinder d'origine réactivé"));

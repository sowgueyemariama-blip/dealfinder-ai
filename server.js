const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
app.use(cors());
app.use(express.json());

// Emplacement de stockage de la base de données
const dataDir = path.join(__dirname, 'backend', 'data');
if (!fs.existsSync(dataDir)){
    fs.mkdirSync(dataDir, { recursive: true });
}
const dbPath = path.join(dataDir, 'dealfinder.db');
const db = new Database(dbPath);

// Configuration des tables (Sans marque, avec gestion dynamique des boutiques)
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    link TEXT NOT NULL,
    image TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS affiliations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_name TEXT NOT NULL UNIQUE,
    global_link TEXT NOT NULL
  );
`);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// MOTEUR DE RECHERCHE DYNAMIQUE ET GÉNÉRATIF
app.get('/api/search', (req, res) => {
    const query = req.query.q || '';
    if (!query) return res.json([]);

    const cleanQuery = query.trim();
    const results = [];

    // Sélection intelligente de l'image de couverture selon le mot tapé
    let productImg = "https://unsplash.com"; 
    if (cleanQuery.toLowerCase().includes("robe") || cleanQuery.toLowerCase().includes("vêtement")) {
        productImg = "https://unsplash.com"; 
    } else if (cleanQuery.toLowerCase().includes("chaussure") || cleanQuery.toLowerCase().includes("nike")) {
        productImg = "https://unsplash.com";
    } else if (cleanQuery.toLowerCase().includes("phone") || cleanQuery.toLowerCase().includes("samsung")) {
        productImg = "https://unsplash.com";
    }

    try {
        // 1. Récupération automatique de toutes vos affiliations enregistrées dans le panneau
        const shops = db.prepare("SELECT * FROM affiliations").all();
        
        shops.forEach(shop => {
            let finalLink = shop.global_link.trim();
            
            // Adaptation automatique des structures de liens profonds
            if (shop.shop_name.toLowerCase().includes("jumia")) {
                finalLink += `&next=https%3A%2F%2Fwww.jumia.sn%2Fcatalog%2F%3Fq%3D${encodeURIComponent(cleanQuery)}`;
            } else if (shop.shop_name.toLowerCase().includes("shein")) {
                finalLink += `&url=https%3A%2F%://shein.com%2Fpdsearch%2F${encodeURIComponent(cleanQuery)}%2F`;
            } else {
                finalLink += `&search=${encodeURIComponent(cleanQuery)}`;
            }

            results.push({
                name: `${cleanQuery.toUpperCase()} - Offre ${shop.shop_name}`,
                price: Math.floor(Math.random() * (35000 - 5000) + 5000) + " FCFA",
                image: productImg,
                link: finalLink,
                provider: shop.shop_name
            });
        });

        // 2. Scan et inclusion des produits ajoutés à la main
        const localProducts = db.prepare("SELECT * FROM products WHERE name LIKE ?").all(`%${cleanQuery}%`);
        localProducts.forEach(lp => {
            results.unshift({
                name: lp.name,
                price: lp.price + " FCFA",
                image: lp.image,
                link: lp.link,
                provider: "Manuel"
            });
        });

    } catch(e) {}

    res.json(results);
});

// SAUVEGARDER OU METTRE À JOUR UNE AFFILIATION
app.post('/api/affiliations', (req, res) => {
    const { shop_name, global_link } = req.body;
    if (!shop_name || !global_link) return res.status(400).json({ error: "Données manquantes" });

    try {
        db.prepare(`
            INSERT INTO affiliations (shop_name, global_link) 
            VALUES (?, ?) 
            ON CONFLICT(shop_name) DO UPDATE SET global_link = ?
        `).run(shop_name, global_link, global_link);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// RECUPERER TOUTES LES BOUTIQUES CRÉÉES
app.get('/api/affiliations', (req, res) => {
    try {
        const rows = db.prepare("SELECT * FROM affiliations").all();
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// AJOUT DE PRODUIT MANUEL (PHOTO STRICTEMENT REQUISE - AUCUNE COLONNE MARQUE)
app.post('/api/products', (req, res) => {
    const { name, price, link, image } = req.body;
    
    if (!name || !price || !link) return res.status(400).json({ error: "Champs requis manquants." });
    if (!image || image.trim() === "") {
        return res.status(400).json({ error: "L'ajout a échoué : la photo du produit est obligatoire !" });
    }

    try {
        db.prepare("INSERT INTO products (name, price, link, image) VALUES (?, ?, ?, ?)").run(name, price, link, image);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Serveur DealFinder connecté et actif !"));

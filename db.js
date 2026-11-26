const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const isVercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true' || !!process.env.VERCEL_ENV;
let DB_PATH = path.join(__dirname, 'restaurant.db');

if (isVercel) {
  const tmpDbPath = path.join('/tmp', 'restaurant.db');
  if (fs.existsSync(DB_PATH) && !fs.existsSync(tmpDbPath)) {
    try {
      fs.copyFileSync(DB_PATH, tmpDbPath);
    } catch (e) {
      console.error('Failed to copy db to /tmp:', e);
    }
  }
  DB_PATH = tmpDbPath;
}

const db = new DatabaseSync(DB_PATH);

// Helper for hashing passwords with sha256 + salt
function hashPassword(password, salt = 'maison_resto_salt_2026') {
  return crypto.createHash('sha256').update(password + salt).digest('hex');
}

function initDatabase() {
  // Enable foreign keys and WAL mode for reliability
  db.exec('PRAGMA foreign_keys = ON;');

  // Users table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner', 'kasir', 'dapur')),
      phone TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Sessions table for token-based auth
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Categories table
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      icon TEXT,
      sort_order INTEGER DEFAULT 0
    );
  `);

  // Menu items table
  db.exec(`
    CREATE TABLE IF NOT EXISTS menu_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price REAL NOT NULL,
      description TEXT,
      image_url TEXT,
      is_available INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Ingredients (Bahan Baku) table
  db.exec(`
    CREATE TABLE IF NOT EXISTS ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      unit TEXT NOT NULL, -- 'kg', 'gram', 'liter', 'ml', 'pcs', 'butir'
      current_stock REAL NOT NULL DEFAULT 0,
      min_stock REAL NOT NULL DEFAULT 5,
      cost_per_unit REAL NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Recipes table (Menghubungkan Menu dengan Bahan Baku)
  db.exec(`
    CREATE TABLE IF NOT EXISTS recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      menu_item_id INTEGER NOT NULL,
      ingredient_id INTEGER NOT NULL,
      quantity_required REAL NOT NULL, -- jumlah bahan per 1 porsi
      FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE,
      FOREIGN KEY (ingredient_id) REFERENCES ingredients(id) ON DELETE CASCADE,
      UNIQUE(menu_item_id, ingredient_id)
    );
  `);

  // Stock Incoming (Pencatatan Bahan Masuk / Restock)
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_incoming (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ingredient_id INTEGER NOT NULL,
      quantity REAL NOT NULL,
      cost_per_unit REAL NOT NULL,
      total_cost REAL NOT NULL,
      supplier TEXT,
      notes TEXT,
      recorded_by INTEGER,
      date TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ingredient_id) REFERENCES ingredients(id) ON DELETE CASCADE
    );
  `);

  // Stock movement log (history keluar masuk stok)
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ingredient_id INTEGER NOT NULL,
      change_amount REAL NOT NULL,
      balance_after REAL NOT NULL,
      reason TEXT NOT NULL, -- 'order_deduction', 'incoming_restock', 'manual_adjustment'
      reference_id TEXT, -- e.g. order_id or incoming_id
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ingredient_id) REFERENCES ingredients(id) ON DELETE CASCADE
    );
  `);

  // Orders table
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_code TEXT UNIQUE NOT NULL,
      customer_name TEXT NOT NULL,
      table_number TEXT NOT NULL,
      total_amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'cooking', 'ready', 'completed', 'cancelled')),
      payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid', 'paid')),
      payment_method TEXT, -- 'cash', 'qris', 'debit', 'credit'
      paid_amount REAL DEFAULT 0,
      change_amount REAL DEFAULT 0,
      cashier_id INTEGER,
      notes TEXT,
      stock_deducted INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Order items table
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      menu_item_id INTEGER NOT NULL,
      menu_name TEXT NOT NULL,
      price REAL NOT NULL,
      quantity INTEGER NOT NULL,
      subtotal REAL NOT NULL,
      notes TEXT,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    );
  `);

  // Expenses table (Pengeluaran restoran: bahan baku, gaji, utilitas, sewa, dll)
  db.exec(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL, -- 'Bahan Baku', 'Gaji & Upah', 'Utilitas & Listrik', 'Operasional & Maintenance', 'Lain-lain'
      title TEXT NOT NULL,
      amount REAL NOT NULL,
      date TEXT NOT NULL,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  seedData();
}

function seedData() {
  // Check if users already exist
  const existingUsers = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (existingUsers.count > 0) {
    return;
  }

  console.log('Seeding initial data for Maison Resto...');

  // 1. Seed Users (Owner, Kasir, Dapur)
  const insertUser = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, phone)
    VALUES (?, ?, ?, ?, ?)
  `);

  insertUser.run('Monsieur Laurent (Owner)', 'owner@maisonresto.com', hashPassword('owner123'), 'owner', '081122334455');
  insertUser.run('Jean Kasir', 'kasir@maisonresto.com', hashPassword('kasir123'), 'kasir', '081234567890');
  insertUser.run('Chef Pierre (Dapur & Gudang)', 'dapur@maisonresto.com', hashPassword('dapur123'), 'dapur', '081398765432');

  // 2. Seed Categories
  const insertCategory = db.prepare(`INSERT INTO categories (name, icon, sort_order) VALUES (?, ?, ?)`);
  insertCategory.run('Appetizer', '🥗', 1);
  insertCategory.run('Main Course', '🥩', 2);
  insertCategory.run('Pasta & Risotto', '🍝', 3);
  insertCategory.run('Dessert', '🍰', 4);
  insertCategory.run('Beverage', '🍸', 5);

  // 3. Seed Ingredients (Bahan Baku)
  const insertIngredient = db.prepare(`
    INSERT INTO ingredients (name, unit, current_stock, min_stock, cost_per_unit)
    VALUES (?, ?, ?, ?, ?)
  `);

  // Format: [name, unit, current_stock, min_stock, cost_per_unit]
  const ingredientsData = [
    ['Daging Wagyu Ribeye MB9', 'kg', 12.5, 3.0, 650000],
    ['Norwegian Fresh Salmon', 'kg', 8.0, 2.5, 280000],
    ['Bebek Marinasi Confit', 'ekor', 15.0, 5.0, 120000],
    ['Iga Domba Australia (Lamb Rack)', 'kg', 6.0, 2.0, 380000],
    ['Lobster Segar Karibia', 'ekor', 10.0, 3.0, 190000],
    ['Beras Arborio Premium', 'kg', 25.0, 5.0, 65000],
    ['Minyak Truffle Hitam', 'liter', 3.5, 1.0, 450000],
    ['Jamur Portobello & Champignon', 'kg', 7.0, 2.0, 75000],
    ['French Butter Elle & Vire', 'kg', 18.0, 4.0, 160000],
    ['Heavy Cream Anchor', 'liter', 20.0, 5.0, 85000],
    ['Keju Parmigiano Reggiano DOP', 'kg', 5.0, 1.5, 350000],
    ['Valrhona Dark Chocolate 70%', 'kg', 9.0, 2.0, 320000],
    ['Biji Kopi Arabica Gayo Specialty', 'kg', 14.0, 3.0, 180000],
    ['Yuzu Puree Jepang', 'liter', 4.0, 1.0, 220000],
    ['Telur Ayam Organik Omega 3', 'butir', 120.0, 30.0, 3500],
    ['Bawang Putih & Herbs De Provence', 'kg', 8.0, 2.0, 45000],
    ['Escargot Helix Lucorum', 'kaleng', 3.0, 4.0, 110000], // Low stock intentionally for alert demo!
    ['Daun Selada Mesclun Organik', 'kg', 2.0, 3.0, 40000]   // Low stock intentionally for alert demo!
  ];

  const ingredientMap = {};
  for (const item of ingredientsData) {
    const res = insertIngredient.run(item[0], item[1], item[2], item[3], item[4]);
    ingredientMap[item[0]] = Number(res.lastInsertRowid);
  }

  // 4. Seed Menu Items
  const insertMenu = db.prepare(`
    INSERT INTO menu_items (name, category, price, description, image_url, is_available)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const menuData = [
    {
      name: 'Wagyu Ribeye MB9+ Grand Cru',
      category: 'Main Course',
      price: 485000,
      description: 'Daging Wagyu MB9+ 250g dipanggang sempurna dengan aroma herbes de Provence, truffle butter, dan baby potato.',
      image_url: 'https://images.unsplash.com/photo-1544025162-d76694265947?w=700&auto=format&fit=crop&q=80',
      is_available: 1,
      recipes: [
        { ingredient: 'Daging Wagyu Ribeye MB9', qty: 0.25 },
        { ingredient: 'French Butter Elle & Vire', qty: 0.03 },
        { ingredient: 'Bawang Putih & Herbs De Provence', qty: 0.02 }
      ]
    },
    {
      name: 'Pan-Seared Norwegian Salmon',
      category: 'Main Course',
      price: 295000,
      description: 'Fillet salmon Norwegia segar dengan kulit renyah, saus lemon butter dill krimi, dan asparagus panggang.',
      image_url: 'https://images.unsplash.com/photo-1467003909585-2f8a72700288?w=700&auto=format&fit=crop&q=80',
      is_available: 1,
      recipes: [
        { ingredient: 'Norwegian Fresh Salmon', qty: 0.20 },
        { ingredient: 'French Butter Elle & Vire', qty: 0.03 },
        { ingredient: 'Heavy Cream Anchor', qty: 0.05 }
      ]
    },
    {
      name: 'Canard Confit à l\'Orange',
      category: 'Main Course',
      price: 265000,
      description: 'Paha bebek Prancis dimasak lambat 12 jam hingga empuk beraroma jeruk manis karamel dan kentang pomme purée.',
      image_url: 'https://images.unsplash.com/photo-1514944298352-78881ff1f8b3?w=700&auto=format&fit=crop&q=80',
      is_available: 1,
      recipes: [
        { ingredient: 'Bebek Marinasi Confit', qty: 1.0 },
        { ingredient: 'French Butter Elle & Vire', qty: 0.02 },
        { ingredient: 'Bawang Putih & Herbs De Provence', qty: 0.015 }
      ]
    },
    {
      name: 'Herb-Crusted Lamb Rack Provençale',
      category: 'Main Course',
      price: 385000,
      description: 'Iga domba Australia berbalut rempah wangi dan remah roti herbal, disajikan dengan jus domba kental.',
      image_url: 'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=700&auto=format&fit=crop&q=80',
      is_available: 1,
      recipes: [
        { ingredient: 'Iga Domba Australia (Lamb Rack)', qty: 0.30 },
        { ingredient: 'Bawang Putih & Herbs De Provence', qty: 0.03 },
        { ingredient: 'French Butter Elle & Vire', qty: 0.02 }
      ]
    },
    {
      name: 'Truffle Beef Risotto Al Funghi',
      category: 'Pasta & Risotto',
      price: 235000,
      description: 'Beras Arborio krimi dengan kaldu jamur Portobello, serpihan keju Parmigiano 24 bulan, dan tetesan minyak truffle hitam.',
      image_url: 'https://images.unsplash.com/photo-1633964913295-ceb43826e7c9?w=700&auto=format&fit=crop&q=80',
      is_available: 1,
      recipes: [
        { ingredient: 'Beras Arborio Premium', qty: 0.12 },
        { ingredient: 'Jamur Portobello & Champignon', qty: 0.08 },
        { ingredient: 'Minyak Truffle Hitam', qty: 0.015 },
        { ingredient: 'Keju Parmigiano Reggiano DOP', qty: 0.03 }
      ]
    },
    {
      name: 'Fresh Lobster Fettuccine Alfredo',
      category: 'Pasta & Risotto',
      price: 320000,
      description: 'Pasta fettuccine buatan tangan dengan daging lobster utuh manis dalam balutan saus krim keju parmesan sutra.',
      image_url: 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=700&auto=format&fit=crop&q=80',
      is_available: 1,
      recipes: [
        { ingredient: 'Lobster Segar Karibia', qty: 1.0 },
        { ingredient: 'Heavy Cream Anchor', qty: 0.08 },
        { ingredient: 'Keju Parmigiano Reggiano DOP', qty: 0.03 },
        { ingredient: 'French Butter Elle & Vire', qty: 0.02 }
      ]
    },
    {
      name: 'Escargots à la Bourguignonne',
      category: 'Appetizer',
      price: 165000,
      description: 'Siput darat Prancis klasik dipanggang dalam cangkang dengan mentega bawang putih herba dan parsley segar.',
      image_url: 'https://images.unsplash.com/photo-1551248429-40975aa4de74?w=700&auto=format&fit=crop&q=80',
      is_available: 1,
      recipes: [
        { ingredient: 'Escargot Helix Lucorum', qty: 0.25 },
        { ingredient: 'French Butter Elle & Vire', qty: 0.04 },
        { ingredient: 'Bawang Putih & Herbs De Provence', qty: 0.02 }
      ]
    },
    {
      name: 'Truffle Velouté Forestière',
      category: 'Appetizer',
      price: 135000,
      description: 'Sup krim jamur liar dengan aroma harum minyak truffle hitam, disajikan hangat dengan crouton renyah.',
      image_url: 'https://images.unsplash.com/photo-1547592166-23ac45744acd?w=700&auto=format&fit=crop&q=80',
      is_available: 1,
      recipes: [
        { ingredient: 'Jamur Portobello & Champignon', qty: 0.10 },
        { ingredient: 'Heavy Cream Anchor', qty: 0.08 },
        { ingredient: 'Minyak Truffle Hitam', qty: 0.01 }
      ]
    },
    {
      name: 'Salade Maison aux Noix',
      category: 'Appetizer',
      price: 125000,
      description: 'Selada mesclun organik dengan keju kambing lembut, potongan pir karamel, kacang walnut, dan mustard vinaigrette.',
      image_url: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=700&auto=format&fit=crop&q=80',
      is_available: 1,
      recipes: [
        { ingredient: 'Daun Selada Mesclun Organik', qty: 0.15 },
        { ingredient: 'Keju Parmigiano Reggiano DOP', qty: 0.02 }
      ]
    },
    {
      name: 'Valrhona Lava Fondant Noir',
      category: 'Dessert',
      price: 145000,
      description: 'Kue cokelat leleh hangat menggunakan 70% Valrhona grand cru, disajikan dengan es krim vanila bourbon madagaskar.',
      image_url: 'https://images.unsplash.com/photo-1606313564200-e75d5e30476c?w=700&auto=format&fit=crop&q=80',
      is_available: 1,
      recipes: [
        { ingredient: 'Valrhona Dark Chocolate 70%', qty: 0.07 },
        { ingredient: 'French Butter Elle & Vire', qty: 0.04 },
        { ingredient: 'Telur Ayam Organik Omega 3', qty: 2.0 }
      ]
    },
    {
      name: 'Classic Crème Brûlée à la Vanille',
      category: 'Dessert',
      price: 115000,
      description: 'Kastard vanila lembut dengan lapisan gula karamel renyah tipis yang dibakar saat disajikan.',
      image_url: 'https://images.unsplash.com/photo-1470124182917-cc6e71b22ecc?w=700&auto=format&fit=crop&q=80',
      is_available: 1,
      recipes: [
        { ingredient: 'Heavy Cream Anchor', qty: 0.10 },
        { ingredient: 'Telur Ayam Organik Omega 3', qty: 3.0 }
      ]
    },
    {
      name: 'Gold Velvet Royal Mocktail',
      category: 'Beverage',
      price: 85000,
      description: 'Minuman mocktail khas Maison dengan ekstrak yuzu Jepang, madu bunga liar, edible gold dust, dan sparkling water.',
      image_url: 'https://images.unsplash.com/photo-1551024709-8f23befc6f87?w=700&auto=format&fit=crop&q=80',
      is_available: 1,
      recipes: [
        { ingredient: 'Yuzu Puree Jepang', qty: 0.06 }
      ]
    },
    {
      name: 'Maison Specialty Espresso Macchiato',
      category: 'Beverage',
      price: 55000,
      description: 'Espresso biji arabica Gayo dengan sentuhan microfoam susu lembut beraroma hazelnut.',
      image_url: 'https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?w=700&auto=format&fit=crop&q=80',
      is_available: 1,
      recipes: [
        { ingredient: 'Biji Kopi Arabica Gayo Specialty', qty: 0.02 },
        { ingredient: 'Heavy Cream Anchor', qty: 0.03 }
      ]
    }
  ];

  const insertRecipe = db.prepare(`
    INSERT INTO recipes (menu_item_id, ingredient_id, quantity_required)
    VALUES (?, ?, ?)
  `);

  for (const item of menuData) {
    const res = insertMenu.run(item.name, item.category, item.price, item.description, item.image_url, item.is_available);
    const menuId = Number(res.lastInsertRowid);
    for (const r of item.recipes) {
      const ingId = ingredientMap[r.ingredient];
      if (ingId) {
        insertRecipe.run(menuId, ingId, r.qty);
      }
    }
  }

  // 5. Seed Initial Stock Incoming & Expenses
  const insertStockIn = db.prepare(`
    INSERT INTO stock_incoming (ingredient_id, quantity, cost_per_unit, total_cost, supplier, notes, date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertExpense = db.prepare(`
    INSERT INTO expenses (category, title, amount, date, notes)
    VALUES (?, ?, ?, ?, ?)
  `);

  // Sample stock incoming records
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  
  // Date helpers for historical simulation
  const daysAgo = (days) => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().split('T')[0];
  };

  insertStockIn.run(ingredientMap['Daging Wagyu Ribeye MB9'], 10, 650000, 6500000, 'PT Meat Import Prima', 'Pengiriman mingguan batch A', daysAgo(3));
  insertExpense.run('Bahan Baku', 'Pembelian Daging Wagyu 10kg', 6500000, daysAgo(3), 'Invoice #MIP-9921');

  insertStockIn.run(ingredientMap['Norwegian Fresh Salmon'], 8, 280000, 2240000, 'PT Ocean Fishindo', 'Salmon segar kualitas sashimi', daysAgo(2));
  insertExpense.run('Bahan Baku', 'Restock Salmon Norwegia 8kg', 2240000, daysAgo(2), 'Invoice #OF-442');

  insertStockIn.run(ingredientMap['French Butter Elle & Vire'], 20, 160000, 3200000, 'Gourmet Dairy France', 'Mentega Prancis unsalted', daysAgo(5));
  insertExpense.run('Bahan Baku', 'French Butter Restock', 3200000, daysAgo(5), 'Invoice #GDF-112');

  // Operational Expenses
  insertExpense.run('Gaji & Upah', 'Gaji Tim Dapur & Pelayanan Periode Berjalan', 18500000, daysAgo(10), 'Payroll 6 staff');
  insertExpense.run('Utilitas & Listrik', 'Tagihan Listrik & Gas Restoran', 4200000, daysAgo(7), 'PLN & PGN resto');
  insertExpense.run('Operasional & Maintenance', 'Perawatan Espresso Machine & Chiller Dapur', 1500000, daysAgo(4), 'Service berkala teknisi');

  // 6. Seed Sample Orders (Past & Present)
  const insertOrder = db.prepare(`
    INSERT INTO orders (order_code, customer_name, table_number, total_amount, status, payment_status, payment_method, paid_amount, change_amount, cashier_id, notes, stock_deducted, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertOrderItem = db.prepare(`
    INSERT INTO order_items (order_id, menu_item_id, menu_name, price, quantity, subtotal, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Sample order 1 (Completed & Paid - yesterday)
  const o1 = insertOrder.run('ORD-2026-001', 'Bpk. Hendra Wijaya', 'Meja 04', 1045000, 'completed', 'paid', 'qris', 1045000, 0, 2, 'Medium rare wagyu', 1, daysAgo(1) + ' 13:30:00', daysAgo(1) + ' 14:15:00');
  const o1Id = Number(o1.lastInsertRowid);
  insertOrderItem.run(o1Id, 1, 'Wagyu Ribeye MB9+ Grand Cru', 485000, 2, 970000, 'Medium Rare');
  insertOrderItem.run(o1Id, 12, 'Gold Velvet Royal Mocktail', 85000, 1, 85000, 'Kurangi es batu');

  // Sample order 2 (Completed & Paid - 2 days ago)
  const o2 = insertOrder.run('ORD-2026-002', 'Ibu Clarissa Tan', 'Meja VIP 01', 1285000, 'completed', 'paid', 'debit', 1285000, 0, 2, 'Anniversary dinner', 1, daysAgo(2) + ' 19:20:00', daysAgo(2) + ' 20:45:00');
  const o2Id = Number(o2.lastInsertRowid);
  insertOrderItem.run(o2Id, 2, 'Pan-Seared Norwegian Salmon', 295000, 2, 590000, 'Saus dipisah');
  insertOrderItem.run(o2Id, 5, 'Truffle Beef Risotto Al Funghi', 235000, 1, 235000, '');
  insertOrderItem.run(o2Id, 10, 'Valrhona Lava Fondant Noir', 145000, 2, 290000, 'Tambah lilin kecil');
  insertOrderItem.run(o2Id, 12, 'Gold Velvet Royal Mocktail', 85000, 2, 170000, '');

  // Sample order 3 (Paid, currently cooking - today)
  const o3 = insertOrder.run('ORD-2026-003', 'Dr. Adrian Pratama', 'Meja 08', 785000, 'cooking', 'paid', 'cash', 800000, 15000, 2, 'Meja dekat jendela', 1, todayStr + ' 18:45:00', todayStr + ' 18:50:00');
  const o3Id = Number(o3.lastInsertRowid);
  insertOrderItem.run(o3Id, 1, 'Wagyu Ribeye MB9+ Grand Cru', 485000, 1, 485000, 'Well done');
  insertOrderItem.run(o3Id, 5, 'Truffle Beef Risotto Al Funghi', 235000, 1, 235000, '');
  insertOrderItem.run(o3Id, 13, 'Maison Specialty Espresso Macchiato', 55000, 1, 55000, 'Less sweet');

  // Sample order 4 (New order from customer - pending & unpaid in queue)
  const o4 = insertOrder.run('ORD-2026-004', 'Siti Rahmawati', 'Meja 02', 615000, 'pending', 'unpaid', null, 0, 0, null, 'Tolong sajikan bersamaan', 0, todayStr + ' 19:15:00', todayStr + ' 19:15:00');
  const o4Id = Number(o4.lastInsertRowid);
  insertOrderItem.run(o4Id, 2, 'Pan-Seared Norwegian Salmon', 295000, 1, 295000, '');
  insertOrderItem.run(o4Id, 6, 'Fresh Lobster Fettuccine Alfredo', 320000, 1, 320000, 'Extra parmesan');

  console.log('Seed data successfully created!');
}

// Function to deduct stock based on recipes for an order
function deductStockForOrder(orderId) {
  const order = db.prepare('SELECT id, stock_deducted, order_code FROM orders WHERE id = ?').get(orderId);
  if (!order || order.stock_deducted === 1) {
    return { success: false, message: 'Stock already deducted or order not found' };
  }

  const items = db.prepare('SELECT menu_item_id, quantity, menu_name FROM order_items WHERE order_id = ?').all(orderId);

  db.exec('BEGIN TRANSACTION');
  try {
    for (const item of items) {
      const recipes = db.prepare(`
        SELECT r.ingredient_id, r.quantity_required, i.name as ingredient_name, i.current_stock
        FROM recipes r
        JOIN ingredients i ON r.ingredient_id = i.id
        WHERE r.menu_item_id = ?
      `).all(item.menu_item_id);

      for (const recipe of recipes) {
        const totalQtyDeduction = recipe.quantity_required * item.quantity;
        const newBalance = Math.max(0, recipe.current_stock - totalQtyDeduction);

        // Update ingredient stock
        db.prepare('UPDATE ingredients SET current_stock = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(newBalance, recipe.ingredient_id);

        // Insert stock log
        db.prepare(`
          INSERT INTO stock_logs (ingredient_id, change_amount, balance_after, reason, reference_id, notes)
          VALUES (?, ?, ?, 'order_deduction', ?, ?)
        `).run(
          recipe.ingredient_id,
          -totalQtyDeduction,
          newBalance,
          order.order_code,
          `Otomatis resep pesanan ${order.order_code} (${item.quantity}x ${item.menu_name})`
        );
      }
    }

    // Mark order as stock deducted
    db.prepare('UPDATE orders SET stock_deducted = 1 WHERE id = ?').run(orderId);
    db.exec('COMMIT');
    return { success: true };
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('Error deducting stock:', err);
    throw err;
  }
}

module.exports = {
  db,
  initDatabase,
  hashPassword,
  deductStockForOrder
};

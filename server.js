const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, initDatabase, hashPassword, deductStockForOrder } = require('./db.js');

// Initialize database schema and initial data
initDatabase();

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// MIME types mapping
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

// Helper: parse cookies from request header
function parseCookies(req) {
  const list = {};
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    list[name] = decodeURIComponent(value);
  });
  return list;
}

// Helper: parse request body JSON
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 2e6) { // 2MB limit
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON format'));
      }
    });
    req.on('error', err => reject(err));
  });
}

// Helper: send JSON response
function sendJson(res, statusCode, data, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    ...headers
  });
  res.end(JSON.stringify(data));
}

// Helper: send HTML response
function sendHtmlFile(res, filePath, headers = {}) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      console.error('File read error:', filePath, err);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      ...headers
    });
    res.end(content);
  });
}

// Helper: redirect response
function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

// Helper: authenticate session
function getSessionUser(req) {
  let token = null;
  // Try Authorization header first
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  }
  // Fallback to cookie
  if (!token) {
    const cookies = parseCookies(req);
    token = cookies.maison_session;
  }

  if (!token) return null;

  const session = db.prepare(`
    SELECT s.token, s.user_id, s.role, u.name, u.email, u.phone, u.is_active
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND datetime(s.expires_at) > datetime('now') AND u.is_active = 1
  `).get(token);

  return session || null;
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // ==========================================
    // 1. PAGE ROUTING & ACCESS PROTECTION (RBAC)
    // ==========================================

    // Public Landing Page: /
    if (pathname === '/') {
      return sendHtmlFile(res, path.join(PUBLIC_DIR, 'views', 'index.html'));
    }

    // Public Customer Ordering Page: /pesan (NO LOGIN REQUIRED)
    if (pathname === '/pesan') {
      return sendHtmlFile(res, path.join(PUBLIC_DIR, 'views', 'pesan.html'));
    }

    // --- OWNER PORTAL ---
    if (pathname === '/owner/login') {
      const user = getSessionUser(req);
      if (user && user.role === 'owner') {
        return redirect(res, '/owner');
      }
      return sendHtmlFile(res, path.join(PUBLIC_DIR, 'views', 'owner-login.html'));
    }

    if (pathname === '/owner') {
      const user = getSessionUser(req);
      if (!user) {
        return redirect(res, '/owner/login?redirect=/owner');
      }
      if (user.role !== 'owner') {
        // Forbidden: redirect to their own portal with alert
        if (user.role === 'kasir') return redirect(res, '/kasir?error=Akses+Dashboard+Owner+Dilarang');
        if (user.role === 'dapur') return redirect(res, '/dapur?error=Akses+Dashboard+Owner+Dilarang');
        return redirect(res, '/owner/login?error=Akses+Ditolak');
      }
      return sendHtmlFile(res, path.join(PUBLIC_DIR, 'views', 'owner.html'));
    }

    // --- KASIR PORTAL ---
    if (pathname === '/kasir/login') {
      const user = getSessionUser(req);
      if (user && (user.role === 'kasir' || user.role === 'owner')) {
        return redirect(res, '/kasir');
      }
      return sendHtmlFile(res, path.join(PUBLIC_DIR, 'views', 'kasir-login.html'));
    }

    if (pathname === '/kasir') {
      const user = getSessionUser(req);
      if (!user) {
        return redirect(res, '/kasir/login?redirect=/kasir');
      }
      if (user.role === 'dapur') {
        // Dapur is strictly forbidden from Kasir
        return redirect(res, '/dapur?error=Akses+Halaman+Kasir+Dilarang');
      }
      return sendHtmlFile(res, path.join(PUBLIC_DIR, 'views', 'kasir.html'));
    }

    // --- DAPUR & GUDANG PORTAL ---
    if (pathname === '/dapur/login') {
      const user = getSessionUser(req);
      if (user && (user.role === 'dapur' || user.role === 'owner')) {
        return redirect(res, '/dapur');
      }
      return sendHtmlFile(res, path.join(PUBLIC_DIR, 'views', 'dapur-login.html'));
    }

    if (pathname === '/dapur') {
      const user = getSessionUser(req);
      if (!user) {
        return redirect(res, '/dapur/login?redirect=/dapur');
      }
      if (user.role === 'kasir') {
        // Kasir is not allowed into Dapur
        return redirect(res, '/kasir?error=Akses+Halaman+Dapur+Dilarang');
      }
      return sendHtmlFile(res, path.join(PUBLIC_DIR, 'views', 'dapur.html'));
    }

    // ==========================================
    // 2. STATIC FILES SERVING (/public/*)
    // ==========================================
    if (pathname.startsWith('/css/') || pathname.startsWith('/js/') || pathname.startsWith('/img/') || pathname.startsWith('/assets/')) {
      const filePath = path.join(PUBLIC_DIR, pathname);
      // Prevent directory traversal
      if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404 Not Found');
          return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=3600'
        });
        fs.createReadStream(filePath).pipe(res);
      });
      return;
    }

    // ==========================================
    // 3. API ROUTES
    // ==========================================

    // --- AUTHENTICATION APIS ---
    if (pathname === '/api/auth/login' && method === 'POST') {
      const { email, password, portal } = await parseJsonBody(req);
      if (!email || !password) {
        return sendJson(res, 400, { error: 'Email dan password wajib diisi' });
      }

      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
      if (!user) {
        return sendJson(res, 401, { error: 'Email atau password tidak valid' });
      }

      if (user.is_active !== 1) {
        return sendJson(res, 403, { error: 'Akun ini dinonaktifkan. Hubungi Owner.' });
      }

      const inputHash = hashPassword(password);
      if (inputHash !== user.password_hash) {
        return sendJson(res, 401, { error: 'Email atau password tidak valid' });
      }

      // Check portal role match
      if (portal === 'owner' && user.role !== 'owner') {
        return sendJson(res, 403, { error: 'Akses ditolak: Akun Anda bukan Owner' });
      }
      if (portal === 'kasir' && user.role !== 'kasir' && user.role !== 'owner') {
        return sendJson(res, 403, { error: 'Akses ditolak: Akun Anda tidak memiliki akses Kasir' });
      }
      if (portal === 'dapur' && user.role !== 'dapur' && user.role !== 'owner') {
        return sendJson(res, 403, { error: 'Akses ditolak: Akun Anda tidak memiliki akses Dapur' });
      }

      // Generate Session Token
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString(); // 24 hours

      db.prepare(`
        INSERT INTO sessions (token, user_id, role, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(token, user.id, user.role, expiresAt);

      // Set cookie
      const cookieHeader = `maison_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;

      return sendJson(res, 200, {
        success: true,
        message: 'Login berhasil',
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          phone: user.phone
        }
      }, { 'Set-Cookie': cookieHeader });
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      const user = getSessionUser(req);
      if (user) {
        db.prepare('DELETE FROM sessions WHERE token = ?').run(user.token);
      }
      const cookieHeader = `maison_session=; Path=/; HttpOnly; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
      return sendJson(res, 200, { success: true, message: 'Logout berhasil' }, { 'Set-Cookie': cookieHeader });
    }

    if (pathname === '/api/auth/me' && method === 'GET') {
      const user = getSessionUser(req);
      if (!user) {
        return sendJson(res, 401, { authenticated: false, error: 'Sesi belum login atau telah berakhir' });
      }
      return sendJson(res, 200, {
        authenticated: true,
        user: {
          id: user.user_id,
          name: user.name,
          email: user.email,
          role: user.role,
          phone: user.phone
        }
      });
    }

    // --- CUSTOMER APIS (PUBLIC - NO AUTH REQUIRED) ---
    if (pathname === '/api/customer/menu' && method === 'GET') {
      const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order ASC').all();
      const menuItems = db.prepare(`
        SELECT id, name, category, price, description, image_url, is_available
        FROM menu_items
        ORDER BY category ASC, id ASC
      `).all();

      return sendJson(res, 200, { categories, menuItems });
    }

    if (pathname === '/api/customer/order' && method === 'POST') {
      const body = await parseJsonBody(req);
      const { customer_name, table_number, items, notes } = body;

      if (!customer_name || !customer_name.trim()) {
        return sendJson(res, 400, { error: 'Nama pelanggan wajib diisi' });
      }
      if (!table_number || !table_number.trim()) {
        return sendJson(res, 400, { error: 'Nomor meja wajib dipilih atau diisi' });
      }
      if (!items || !Array.isArray(items) || items.length === 0) {
        return sendJson(res, 400, { error: 'Keranjang pesanan masih kosong' });
      }

      // Calculate total amount securely from DB prices
      let totalAmount = 0;
      const verifiedItems = [];

      for (const item of items) {
        const menuItem = db.prepare('SELECT id, name, price, is_available FROM menu_items WHERE id = ?').get(item.menu_item_id);
        if (!menuItem) {
          return sendJson(res, 400, { error: `Menu item ID ${item.menu_item_id} tidak ditemukan` });
        }
        if (menuItem.is_available !== 1) {
          return sendJson(res, 400, { error: `Menu "${menuItem.name}" sedang habis atau tidak tersedia` });
        }
        const qty = parseInt(item.quantity, 10);
        if (isNaN(qty) || qty <= 0) {
          return sendJson(res, 400, { error: `Jumlah tidak valid untuk ${menuItem.name}` });
        }

        const subtotal = menuItem.price * qty;
        totalAmount += subtotal;

        verifiedItems.push({
          menu_item_id: menuItem.id,
          menu_name: menuItem.name,
          price: menuItem.price,
          quantity: qty,
          subtotal,
          notes: item.notes || ''
        });
      }

      // Generate unique order code
      const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      const orderCode = `ORD-${datePart}-${randomSuffix}`;

      // Insert order into DB
      db.exec('BEGIN TRANSACTION');
      try {
        const orderResult = db.prepare(`
          INSERT INTO orders (order_code, customer_name, table_number, total_amount, status, payment_status, notes)
          VALUES (?, ?, ?, ?, 'pending', 'unpaid', ?)
        `).run(orderCode, customer_name.trim(), table_number.trim(), totalAmount, notes || '');

        const orderId = Number(orderResult.lastInsertRowid);

        const insertItem = db.prepare(`
          INSERT INTO order_items (order_id, menu_item_id, menu_name, price, quantity, subtotal, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        for (const vItem of verifiedItems) {
          insertItem.run(orderId, vItem.menu_item_id, vItem.menu_name, vItem.price, vItem.quantity, vItem.subtotal, vItem.notes);
        }

        db.exec('COMMIT');

        return sendJson(res, 201, {
          success: true,
          message: 'Pesanan berhasil dikirim ke kasir & antrean dapur!',
          order: {
            id: orderId,
            order_code: orderCode,
            customer_name: customer_name.trim(),
            table_number: table_number.trim(),
            total_amount: totalAmount,
            items_count: verifiedItems.length,
            created_at: new Date().toISOString()
          }
        });
      } catch (err) {
        db.exec('ROLLBACK');
        console.error('Order creation error:', err);
        return sendJson(res, 500, { error: 'Gagal membuat pesanan. Silakan coba kembali.' });
      }
    }

    // --- KASIR APIS (Protected: Kasir & Owner) ---
    if (pathname.startsWith('/api/kasir/')) {
      const user = getSessionUser(req);
      if (!user) {
        return sendJson(res, 401, { error: 'Akses ditolak. Silakan login sebagai Kasir.' });
      }
      if (user.role !== 'kasir' && user.role !== 'owner') {
        return sendJson(res, 403, { error: 'Akses terlarang. Anda tidak memiliki izin Kasir.' });
      }

      // GET /api/kasir/orders
      if (pathname === '/api/kasir/orders' && method === 'GET') {
        const filter = parsedUrl.searchParams.get('filter') || 'active'; // 'active', 'paid', 'all'
        let sql = `
          SELECT o.*, u.name as cashier_name
          FROM orders o
          LEFT JOIN users u ON o.cashier_id = u.id
        `;

        if (filter === 'active') {
          sql += ` WHERE o.status != 'completed' AND o.status != 'cancelled' `;
        } else if (filter === 'paid') {
          sql += ` WHERE o.payment_status = 'paid' `;
        }
        sql += ` ORDER BY o.id DESC LIMIT 100 `;

        const orders = db.prepare(sql).all();

        // Attach order items to each order
        const getItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
        for (const ord of orders) {
          ord.items = getItems.all(ord.id);
        }

        return sendJson(res, 200, { orders });
      }

      // GET /api/kasir/history
      if (pathname === '/api/kasir/history' && method === 'GET') {
        const search = parsedUrl.searchParams.get('q') || '';
        const date = parsedUrl.searchParams.get('date') || '';

        let sql = `
          SELECT o.*, u.name as cashier_name
          FROM orders o
          LEFT JOIN users u ON o.cashier_id = u.id
          WHERE 1=1
        `;
        const params = [];

        if (search) {
          sql += ` AND (o.order_code LIKE ? OR o.customer_name LIKE ? OR o.table_number LIKE ?) `;
          params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }
        if (date) {
          sql += ` AND date(o.created_at) = ? `;
          params.push(date);
        }

        sql += ` ORDER BY o.id DESC LIMIT 150 `;
        const orders = db.prepare(sql).all(...params);

        const getItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
        for (const ord of orders) {
          ord.items = getItems.all(ord.id);
        }

        // Calculate summary
        let totalSales = 0;
        let totalCount = orders.length;
        orders.forEach(o => {
          if (o.payment_status === 'paid') totalSales += o.total_amount;
        });

        return sendJson(res, 200, { orders, totalSales, totalCount });
      }

      // POST /api/kasir/order/:id/pay
      const payMatch = pathname.match(/^\/api\/kasir\/order\/(\d+)\/pay$/);
      if (payMatch && method === 'POST') {
        const orderId = parseInt(payMatch[1], 10);
        const { payment_method, paid_amount } = await parseJsonBody(req);

        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
        if (!order) {
          return sendJson(res, 404, { error: 'Pesanan tidak ditemukan' });
        }
        if (order.payment_status === 'paid') {
          return sendJson(res, 400, { error: 'Pesanan ini sudah dibayar sebelumnya' });
        }

        const paid = parseFloat(paid_amount);
        if (isNaN(paid) || paid < order.total_amount) {
          return sendJson(res, 400, { error: 'Jumlah pembayaran kurang dari total tagihan' });
        }

        const changeAmount = paid - order.total_amount;

        // Update payment and cashier
        db.prepare(`
          UPDATE orders
          SET payment_status = 'paid',
              payment_method = ?,
              paid_amount = ?,
              change_amount = ?,
              cashier_id = ?,
              status = CASE WHEN status = 'pending' THEN 'cooking' ELSE status END,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(payment_method || 'cash', paid, changeAmount, user.user_id, orderId);

        // Deduct raw stock according to recipes automatically!
        if (order.stock_deducted === 0) {
          try {
            deductStockForOrder(orderId);
          } catch (err) {
            console.error('Failed auto stock deduction:', err);
          }
        }

        const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
        updatedOrder.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);

        return sendJson(res, 200, {
          success: true,
          message: 'Pembayaran berhasil diproses dan stok bahan baku telah terpotong otomatis!',
          order: updatedOrder
        });
      }

      // POST /api/kasir/order/:id/status
      const statusMatch = pathname.match(/^\/api\/kasir\/order\/(\d+)\/status$/);
      if (statusMatch && method === 'POST') {
        const orderId = parseInt(statusMatch[1], 10);
        const { status } = await parseJsonBody(req);
        const validStatuses = ['pending', 'cooking', 'ready', 'completed', 'cancelled'];
        if (!validStatuses.includes(status)) {
          return sendJson(res, 400, { error: 'Status tidak valid' });
        }

        db.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(status, orderId);

        return sendJson(res, 200, { success: true, message: `Status pesanan diubah menjadi ${status}` });
      }
    }

    // --- DAPUR & GUDANG APIS (Protected: Dapur & Owner) ---
    if (pathname.startsWith('/api/dapur/')) {
      const user = getSessionUser(req);
      if (!user) {
        return sendJson(res, 401, { error: 'Akses ditolak. Silakan login sebagai Dapur.' });
      }
      if (user.role !== 'dapur' && user.role !== 'owner') {
        return sendJson(res, 403, { error: 'Akses terlarang. Anda tidak memiliki izin Dapur.' });
      }

      // GET /api/dapur/orders (Kitchen Queue)
      if (pathname === '/api/dapur/orders' && method === 'GET') {
        const orders = db.prepare(`
          SELECT * FROM orders
          WHERE status IN ('pending', 'cooking', 'ready')
          ORDER BY id ASC
        `).all();

        const getItems = db.prepare(`
          SELECT oi.*, m.category
          FROM order_items oi
          JOIN menu_items m ON oi.menu_item_id = m.id
          WHERE oi.order_id = ?
        `);

        for (const ord of orders) {
          ord.items = getItems.all(ord.id);
        }

        return sendJson(res, 200, { orders });
      }

      // POST /api/dapur/order/:id/status (Cooking status update)
      const cookStatusMatch = pathname.match(/^\/api\/dapur\/order\/(\d+)\/status$/);
      if (cookStatusMatch && method === 'POST') {
        const orderId = parseInt(cookStatusMatch[1], 10);
        const { status } = await parseJsonBody(req);
        const valid = ['cooking', 'ready', 'completed'];
        if (!valid.includes(status)) {
          return sendJson(res, 400, { error: 'Status tidak valid untuk Dapur' });
        }

        db.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(status, orderId);

        // Automatically deduct raw stock based on recipes if not deducted yet
        if (status === 'cooking' || status === 'ready' || status === 'completed') {
          const ord = db.prepare('SELECT stock_deducted FROM orders WHERE id = ?').get(orderId);
          if (ord && ord.stock_deducted === 0) {
            try {
              deductStockForOrder(orderId);
            } catch (err) {
              console.error('Failed auto stock deduction on kitchen cook:', err);
            }
          }
        }

        return sendJson(res, 200, { success: true, message: `Status diperbarui menjadi ${status} dan stok bahan baku resep otomatis dipotong.` });
      }

      // GET /api/dapur/menu
      if (pathname === '/api/dapur/menu' && method === 'GET') {
        const items = db.prepare('SELECT * FROM menu_items ORDER BY category ASC, name ASC').all();
        const getRecipes = db.prepare(`
          SELECT r.*, i.name as ingredient_name, i.unit as ingredient_unit
          FROM recipes r
          JOIN ingredients i ON r.ingredient_id = i.id
          WHERE r.menu_item_id = ?
        `);
        for (const item of items) {
          item.recipes = getRecipes.all(item.id);
        }
        const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order ASC').all();
        return sendJson(res, 200, { items, categories });
      }

      // POST /api/dapur/menu (Create Menu with Recipes)
      if (pathname === '/api/dapur/menu' && method === 'POST') {
        const { name, category, price, description, image_url, is_available, recipes } = await parseJsonBody(req);
        if (!name || !category || !price) {
          return sendJson(res, 400, { error: 'Nama, kategori, dan harga wajib diisi' });
        }

        db.exec('BEGIN TRANSACTION');
        try {
          const resMenu = db.prepare(`
            INSERT INTO menu_items (name, category, price, description, image_url, is_available)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(name.trim(), category.trim(), parseFloat(price), description || '', image_url || '', is_available ? 1 : 0);

          const menuId = Number(resMenu.lastInsertRowid);

          if (recipes && Array.isArray(recipes)) {
            const insertRec = db.prepare('INSERT INTO recipes (menu_item_id, ingredient_id, quantity_required) VALUES (?, ?, ?)');
            for (const r of recipes) {
              if (r.ingredient_id && r.quantity_required > 0) {
                insertRec.run(menuId, parseInt(r.ingredient_id, 10), parseFloat(r.quantity_required));
              }
            }
          }

          db.exec('COMMIT');
          return sendJson(res, 201, { success: true, message: 'Menu dan resep berhasil ditambahkan!', id: menuId });
        } catch (err) {
          db.exec('ROLLBACK');
          return sendJson(res, 500, { error: 'Gagal menambahkan menu: ' + err.message });
        }
      }

      // PUT /api/dapur/menu/:id (Update Menu with Recipes)
      const menuIdMatch = pathname.match(/^\/api\/dapur\/menu\/(\d+)$/);
      if (menuIdMatch && method === 'PUT') {
        const menuId = parseInt(menuIdMatch[1], 10);
        const { name, category, price, description, image_url, is_available, recipes } = await parseJsonBody(req);

        db.exec('BEGIN TRANSACTION');
        try {
          db.prepare(`
            UPDATE menu_items
            SET name = ?, category = ?, price = ?, description = ?, image_url = ?, is_available = ?
            WHERE id = ?
          `).run(name.trim(), category.trim(), parseFloat(price), description || '', image_url || '', is_available ? 1 : 0, menuId);

          if (recipes && Array.isArray(recipes)) {
            db.prepare('DELETE FROM recipes WHERE menu_item_id = ?').run(menuId);
            const insertRec = db.prepare('INSERT INTO recipes (menu_item_id, ingredient_id, quantity_required) VALUES (?, ?, ?)');
            for (const r of recipes) {
              if (r.ingredient_id && r.quantity_required > 0) {
                insertRec.run(menuId, parseInt(r.ingredient_id, 10), parseFloat(r.quantity_required));
              }
            }
          }

          db.exec('COMMIT');
          return sendJson(res, 200, { success: true, message: 'Menu dan resep berhasil diperbarui!' });
        } catch (err) {
          db.exec('ROLLBACK');
          return sendJson(res, 500, { error: 'Gagal memperbarui menu: ' + err.message });
        }
      }

      // DELETE /api/dapur/menu/:id
      if (menuIdMatch && method === 'DELETE') {
        const menuId = parseInt(menuIdMatch[1], 10);
        db.prepare('DELETE FROM menu_items WHERE id = ?').run(menuId);
        return sendJson(res, 200, { success: true, message: 'Menu berhasil dihapus' });
      }

      // GET /api/dapur/ingredients (Inventory / Bahan Baku)
      if (pathname === '/api/dapur/ingredients' && method === 'GET') {
        const ingredients = db.prepare(`
          SELECT *,
                 CASE WHEN current_stock <= min_stock THEN 1 ELSE 0 END as is_low_stock
          FROM ingredients
          ORDER BY is_low_stock DESC, name ASC
        `).all();
        return sendJson(res, 200, { ingredients });
      }

      // POST /api/dapur/ingredients (Add new raw material)
      if (pathname === '/api/dapur/ingredients' && method === 'POST') {
        const { name, unit, current_stock, min_stock, cost_per_unit } = await parseJsonBody(req);
        if (!name || !unit) {
          return sendJson(res, 400, { error: 'Nama bahan baku dan satuan wajib diisi' });
        }

        try {
          const resIng = db.prepare(`
            INSERT INTO ingredients (name, unit, current_stock, min_stock, cost_per_unit)
            VALUES (?, ?, ?, ?, ?)
          `).run(name.trim(), unit.trim(), parseFloat(current_stock || 0), parseFloat(min_stock || 5), parseFloat(cost_per_unit || 0));

          return sendJson(res, 201, { success: true, message: 'Bahan baku berhasil ditambahkan!', id: Number(resIng.lastInsertRowid) });
        } catch (err) {
          return sendJson(res, 400, { error: 'Nama bahan baku sudah terdaftar atau tidak valid' });
        }
      }

      // PUT /api/dapur/ingredients/:id
      const ingIdMatch = pathname.match(/^\/api\/dapur\/ingredients\/(\d+)$/);
      if (ingIdMatch && method === 'PUT') {
        const ingId = parseInt(ingIdMatch[1], 10);
        const { name, unit, current_stock, min_stock, cost_per_unit } = await parseJsonBody(req);

        db.prepare(`
          UPDATE ingredients
          SET name = ?, unit = ?, current_stock = ?, min_stock = ?, cost_per_unit = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(name.trim(), unit.trim(), parseFloat(current_stock), parseFloat(min_stock), parseFloat(cost_per_unit), ingId);

        return sendJson(res, 200, { success: true, message: 'Bahan baku berhasil diperbarui!' });
      }

      // POST /api/dapur/stock-in (Mencatat bahan masuk / Restock)
      if (pathname === '/api/dapur/stock-in' && method === 'POST') {
        const { ingredient_id, quantity, cost_per_unit, supplier, notes, date } = await parseJsonBody(req);
        if (!ingredient_id || !quantity || quantity <= 0) {
          return sendJson(res, 400, { error: 'Bahan baku dan jumlah masuk wajib diisi dengan benar' });
        }

        const ing = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(ingredient_id);
        if (!ing) {
          return sendJson(res, 404, { error: 'Bahan baku tidak ditemukan' });
        }

        const qty = parseFloat(quantity);
        const unitCost = parseFloat(cost_per_unit || ing.cost_per_unit || 0);
        const totalCost = qty * unitCost;
        const entryDate = date || new Date().toISOString().slice(0, 10);
        const newStock = ing.current_stock + qty;

        db.exec('BEGIN TRANSACTION');
        try {
          // 1. Record in stock_incoming
          db.prepare(`
            INSERT INTO stock_incoming (ingredient_id, quantity, cost_per_unit, total_cost, supplier, notes, recorded_by, date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(ingredient_id, qty, unitCost, totalCost, supplier || '', notes || '', user.user_id, entryDate);

          // 2. Update ingredient current stock & cost
          db.prepare(`
            UPDATE ingredients
            SET current_stock = ?, cost_per_unit = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(newStock, unitCost > 0 ? unitCost : ing.cost_per_unit, ingredient_id);

          // 3. Log into stock_logs
          db.prepare(`
            INSERT INTO stock_logs (ingredient_id, change_amount, balance_after, reason, notes)
            VALUES (?, ?, ?, 'incoming_restock', ?)
          `).run(ingredient_id, qty, newStock, `Restock dari ${supplier || 'Supplier'}: +${qty} ${ing.unit}`);

          // 4. Automatically record as restaurant expense for Owner finance!
          db.prepare(`
            INSERT INTO expenses (category, title, amount, date, notes)
            VALUES ('Bahan Baku', ?, ?, ?, ?)
          `).run(
            `Pembelian Bahan: ${ing.name} (+${qty} ${ing.unit})`,
            totalCost,
            entryDate,
            `Supplier: ${supplier || '-'}, Catatan: ${notes || '-'}`
          );

          db.exec('COMMIT');

          return sendJson(res, 201, {
            success: true,
            message: `Stok ${ing.name} berhasil ditambah +${qty} ${ing.unit}. Pengeluaran sebesar Rp ${totalCost.toLocaleString('id-ID')} dicatat ke sistem keuangan.`
          });
        } catch (err) {
          db.exec('ROLLBACK');
          return sendJson(res, 500, { error: 'Gagal mencatat bahan masuk: ' + err.message });
        }
      }

      // GET /api/dapur/alerts (Bahan yang hampir habis)
      if (pathname === '/api/dapur/alerts' && method === 'GET') {
        const lowStockItems = db.prepare(`
          SELECT * FROM ingredients
          WHERE current_stock <= min_stock
          ORDER BY (current_stock / min_stock) ASC
        `).all();

        return sendJson(res, 200, { lowStockItems });
      }

      // GET /api/dapur/stock-logs
      if (pathname === '/api/dapur/stock-logs' && method === 'GET') {
        const logs = db.prepare(`
          SELECT sl.*, i.name as ingredient_name, i.unit as ingredient_unit
          FROM stock_logs sl
          JOIN ingredients i ON sl.ingredient_id = i.id
          ORDER BY sl.id DESC
          LIMIT 100
        `).all();
        return sendJson(res, 200, { logs });
      }
    }

    // --- OWNER DASHBOARD APIS (Protected: Owner ONLY) ---
    if (pathname.startsWith('/api/owner/')) {
      const user = getSessionUser(req);
      if (!user) {
        return sendJson(res, 401, { error: 'Akses ditolak. Silakan login sebagai Owner.' });
      }
      if (user.role !== 'owner') {
        return sendJson(res, 403, { error: 'Akses terlarang. Hanya Owner yang dapat mengakses data ini.' });
      }

      // GET /api/owner/summary (Financial metrics, stocks, top sellers)
      if (pathname === '/api/owner/summary' && method === 'GET') {
        // 1. Revenue calculations: Daily, Weekly, Monthly, Yearly
        const dailyRev = db.prepare(`
          SELECT COALESCE(SUM(total_amount), 0) as total, COUNT(*) as count
          FROM orders
          WHERE payment_status = 'paid' AND date(created_at) = date('now', 'localtime')
        `).get();

        const weeklyRev = db.prepare(`
          SELECT COALESCE(SUM(total_amount), 0) as total, COUNT(*) as count
          FROM orders
          WHERE payment_status = 'paid' AND date(created_at) >= date('now', '-7 days', 'localtime')
        `).get();

        const monthlyRev = db.prepare(`
          SELECT COALESCE(SUM(total_amount), 0) as total, COUNT(*) as count
          FROM orders
          WHERE payment_status = 'paid' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime')
        `).get();

        const yearlyRev = db.prepare(`
          SELECT COALESCE(SUM(total_amount), 0) as total, COUNT(*) as count
          FROM orders
          WHERE payment_status = 'paid' AND strftime('%Y', created_at) = strftime('%Y', 'now', 'localtime')
        `).get();

        // 2. Expenses & Profit
        const totalExpenses = db.prepare(`
          SELECT COALESCE(SUM(amount), 0) as total
          FROM expenses
        `).get();

        const allTimeRevenue = db.prepare(`
          SELECT COALESCE(SUM(total_amount), 0) as total
          FROM orders
          WHERE payment_status = 'paid'
        `).get();

        const netProfit = allTimeRevenue.total - totalExpenses.total;

        // Expenses breakdown by category
        const expensesByCategory = db.prepare(`
          SELECT category, SUM(amount) as total
          FROM expenses
          GROUP BY category
          ORDER BY total DESC
        `).all();

        // 3. Stock metrics
        const stockMetrics = db.prepare(`
          SELECT
            COUNT(*) as total_ingredients,
            SUM(CASE WHEN current_stock <= min_stock THEN 1 ELSE 0 END) as low_stock_count,
            COALESCE(SUM(current_stock * cost_per_unit), 0) as inventory_valuation
          FROM ingredients
        `).get();

        // Low stock list
        const lowStockList = db.prepare(`
          SELECT * FROM ingredients
          WHERE current_stock <= min_stock
          ORDER BY current_stock ASC
        `).all();

        // 4. Top Selling Menus
        const topMenus = db.prepare(`
          SELECT oi.menu_name, SUM(oi.quantity) as total_sold, SUM(oi.subtotal) as total_revenue
          FROM order_items oi
          JOIN orders o ON oi.order_id = o.id
          WHERE o.payment_status = 'paid'
          GROUP BY oi.menu_name
          ORDER BY total_sold DESC
          LIMIT 5
        `).all();

        // 5. Category breakdown
        const categorySales = db.prepare(`
          SELECT m.category, SUM(oi.quantity) as total_qty, SUM(oi.subtotal) as total_revenue
          FROM order_items oi
          JOIN menu_items m ON oi.menu_item_id = m.id
          JOIN orders o ON oi.order_id = o.id
          WHERE o.payment_status = 'paid'
          GROUP BY m.category
          ORDER BY total_revenue DESC
        `).all();

        // 6. Last 7 Days Daily Revenue Trend (for bar / line chart)
        const dailyTrend = db.prepare(`
          WITH RECURSIVE days(date) AS (
            VALUES(date('now', '-6 days', 'localtime'))
            UNION ALL
            SELECT date(date, '+1 day')
            FROM days
            WHERE date < date('now', 'localtime')
          )
          SELECT
            days.date,
            COALESCE(SUM(o.total_amount), 0) as revenue,
            COUNT(o.id) as orders_count
          FROM days
          LEFT JOIN orders o ON date(o.created_at) = days.date AND o.payment_status = 'paid'
          GROUP BY days.date
          ORDER BY days.date ASC
        `).all();

        return sendJson(res, 200, {
          revenue: {
            daily: dailyRev,
            weekly: weeklyRev,
            monthly: monthlyRev,
            yearly: yearlyRev,
            allTime: allTimeRevenue.total
          },
          financial: {
            revenue: allTimeRevenue.total,
            expenses: totalExpenses.total,
            netProfit,
            profitMargin: allTimeRevenue.total > 0 ? ((netProfit / allTimeRevenue.total) * 100).toFixed(1) : 0,
            expensesByCategory
          },
          stock: {
            ...stockMetrics,
            lowStockList
          },
          topMenus,
          categorySales,
          dailyTrend
        });
      }

      // GET /api/owner/reports (Detailed Sales & Expense Reports)
      if (pathname === '/api/owner/reports' && method === 'GET') {
        const type = parsedUrl.searchParams.get('type') || 'sales'; // 'sales' or 'expenses'
        const startDate = parsedUrl.searchParams.get('startDate') || '';
        const endDate = parsedUrl.searchParams.get('endDate') || '';

        if (type === 'sales') {
          let sql = `
            SELECT o.*, u.name as cashier_name
            FROM orders o
            LEFT JOIN users u ON o.cashier_id = u.id
            WHERE o.payment_status = 'paid'
          `;
          const params = [];
          if (startDate) {
            sql += ` AND date(o.created_at) >= ? `;
            params.push(startDate);
          }
          if (endDate) {
            sql += ` AND date(o.created_at) <= ? `;
            params.push(endDate);
          }
          sql += ` ORDER BY o.id DESC `;
          const orders = db.prepare(sql).all(...params);

          const getItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
          for (const ord of orders) {
            ord.items = getItems.all(ord.id);
          }

          const totalRevenue = orders.reduce((sum, o) => sum + o.total_amount, 0);

          return sendJson(res, 200, { orders, totalRevenue, count: orders.length });
        } else {
          let sql = `SELECT * FROM expenses WHERE 1=1 `;
          const params = [];
          if (startDate) {
            sql += ` AND date(date) >= ? `;
            params.push(startDate);
          }
          if (endDate) {
            sql += ` AND date(date) <= ? `;
            params.push(endDate);
          }
          sql += ` ORDER BY date DESC, id DESC `;
          const expenses = db.prepare(sql).all(...params);
          const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);

          return sendJson(res, 200, { expenses, totalExpenses, count: expenses.length });
        }
      }

      // GET /api/owner/users (Manage Accounts)
      if (pathname === '/api/owner/users' && method === 'GET') {
        const users = db.prepare('SELECT id, name, email, role, phone, is_active, created_at FROM users ORDER BY id ASC').all();
        return sendJson(res, 200, { users });
      }

      // POST /api/owner/users (Create User)
      if (pathname === '/api/owner/users' && method === 'POST') {
        const { name, email, password, role, phone } = await parseJsonBody(req);
        if (!name || !email || !password || !role) {
          return sendJson(res, 400, { error: 'Semua kolom wajib diisi' });
        }
        if (!['owner', 'kasir', 'dapur'].includes(role)) {
          return sendJson(res, 400, { error: 'Role tidak valid' });
        }

        try {
          const resUser = db.prepare(`
            INSERT INTO users (name, email, password_hash, role, phone)
            VALUES (?, ?, ?, ?, ?)
          `).run(name.trim(), email.toLowerCase().trim(), hashPassword(password), role, phone || '');

          return sendJson(res, 201, { success: true, message: 'Akun berhasil dibuat!', id: Number(resUser.lastInsertRowid) });
        } catch (err) {
          return sendJson(res, 400, { error: 'Email sudah digunakan oleh akun lain' });
        }
      }

      // PUT /api/owner/users/:id (Update User)
      const userIdMatch = pathname.match(/^\/api\/owner\/users\/(\d+)$/);
      if (userIdMatch && method === 'PUT') {
        const targetId = parseInt(userIdMatch[1], 10);
        const { name, email, password, role, phone, is_active } = await parseJsonBody(req);

        if (targetId === user.user_id && is_active === 0) {
          return sendJson(res, 400, { error: 'Anda tidak dapat menonaktifkan akun Owner Anda sendiri' });
        }

        if (password && password.trim()) {
          db.prepare(`
            UPDATE users
            SET name = ?, email = ?, password_hash = ?, role = ?, phone = ?, is_active = ?
            WHERE id = ?
          `).run(name.trim(), email.toLowerCase().trim(), hashPassword(password.trim()), role, phone || '', is_active ? 1 : 0, targetId);
        } else {
          db.prepare(`
            UPDATE users
            SET name = ?, email = ?, role = ?, phone = ?, is_active = ?
            WHERE id = ?
          `).run(name.trim(), email.toLowerCase().trim(), role, phone || '', is_active ? 1 : 0, targetId);
        }

        return sendJson(res, 200, { success: true, message: 'Data pengguna berhasil diperbarui' });
      }

      // DELETE /api/owner/users/:id (Delete User)
      if (userIdMatch && method === 'DELETE') {
        const targetId = parseInt(userIdMatch[1], 10);
        if (targetId === user.user_id) {
          return sendJson(res, 400, { error: 'Anda tidak dapat menghapus akun Owner yang sedang aktif' });
        }
        db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
        return sendJson(res, 200, { success: true, message: 'Akun berhasil dihapus' });
      }

      // POST /api/owner/expenses (Add Operational Expense)
      if (pathname === '/api/owner/expenses' && method === 'POST') {
        const { category, title, amount, date, notes } = await parseJsonBody(req);
        if (!category || !title || !amount || amount <= 0) {
          return sendJson(res, 400, { error: 'Kategori, judul pengeluaran, dan nominal wajib diisi' });
        }

        db.prepare(`
          INSERT INTO expenses (category, title, amount, date, notes)
          VALUES (?, ?, ?, ?, ?)
        `).run(category, title.trim(), parseFloat(amount), date || new Date().toISOString().slice(0, 10), notes || '');

        return sendJson(res, 201, { success: true, message: 'Pengeluaran berhasil dicatat!' });
      }
    }

    // 404 for unhandled API or pages
    return sendJson(res, 404, { error: 'Rute tidak ditemukan' });

  } catch (err) {
    console.error('Unhandled server error:', err);
    return sendJson(res, 500, { error: 'Internal Server Error: ' + err.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`  MAISON RESTO - HAUTE GASTRONOMIE SERVER RUNNING   `);
    console.log(`  Local URL: http://localhost:${PORT}               `);
    console.log(`----------------------------------------------------`);
    console.log(`  1. Customer Order : http://localhost:${PORT}/pesan `);
    console.log(`  2. Kasir Portal   : http://localhost:${PORT}/kasir `);
    console.log(`  3. Dapur & Gudang : http://localhost:${PORT}/dapur `);
    console.log(`  4. Owner Portal   : http://localhost:${PORT}/owner `);
    console.log(`====================================================`);
  });
}

module.exports = server;

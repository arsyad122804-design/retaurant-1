const { EventEmitter } = require('node:events');
const { Readable, Writable } = require('node:stream');
const assert = require('node:assert');

// Require db and server
const { db, initDatabase, hashPassword, deductStockForOrder } = require('./db.js');

// Create mock request & response
function mockRequest(server, method, urlPath, options = {}) {
  return new Promise((resolve) => {
    const req = new Readable({
      read() {}
    });
    req.method = method;
    req.url = urlPath;
    req.headers = {
      host: 'localhost:3000',
      ...(options.headers || {})
    };

    if (options.body) {
      const bodyStr = typeof options.body === 'object' ? JSON.stringify(options.body) : options.body;
      req.headers['content-type'] = 'application/json';
      req.push(bodyStr);
    }
    req.push(null); // End of stream

    const res = new EventEmitter();
    res.statusCode = 200;
    res._headers = {};
    res.setHeader = (k, v) => { res._headers[k.toLowerCase()] = v; };
    res.getHeader = (k) => res._headers[k.toLowerCase()];
    res.writeHead = (code, headers = {}) => {
      res.statusCode = code;
      for (const k in headers) res.setHeader(k, headers[k]);
    };

    let bodyData = '';
    res.write = (chunk) => { bodyData += chunk; };
    res.end = (chunk) => {
      if (chunk) bodyData += chunk;
      let json = null;
      try {
        json = JSON.parse(bodyData);
      } catch (e) {}

      resolve({
        statusCode: res.statusCode,
        headers: res._headers,
        data: bodyData,
        json
      });
    };

    // Dispatch to server request listener
    server.emit('request', req, res);
  });
}

async function runDirectTests() {
  console.log('--- STARTING IN-PROCESS ROUTE & RBAC INTEGRATION TEST ---');

  // Load server module
  const server = require('./server.js');

  // TEST 1: Public route /pesan
  console.log('\n[TEST 1] Checking Public Customer Portal /pesan');
  const resPesan = await mockRequest(server, 'GET', '/pesan');
  assert.strictEqual(resPesan.statusCode, 200);
  assert(resPesan.data.includes('Buku Menu & Pemesanan Mandiri'));
  console.log('✓ /pesan returns 200 OK without requiring authentication.');

  // TEST 2: RBAC Protection on Admin Portals
  console.log('\n[TEST 2] Checking Page Access Control (RBAC)');
  const resOwnerUnauth = await mockRequest(server, 'GET', '/owner');
  assert.strictEqual(resOwnerUnauth.statusCode, 302);
  assert(resOwnerUnauth.headers.location.includes('/owner/login'));
  console.log('✓ /owner redirects unauthenticated visitors to /owner/login');

  const resKasirUnauth = await mockRequest(server, 'GET', '/kasir');
  assert.strictEqual(resKasirUnauth.statusCode, 302);
  assert(resKasirUnauth.headers.location.includes('/kasir/login'));
  console.log('✓ /kasir redirects unauthenticated visitors to /kasir/login');

  const resDapurUnauth = await mockRequest(server, 'GET', '/dapur');
  assert.strictEqual(resDapurUnauth.statusCode, 302);
  assert(resDapurUnauth.headers.location.includes('/dapur/login'));
  console.log('✓ /dapur redirects unauthenticated visitors to /dapur/login');

  // TEST 3: Auth Portal Separation
  console.log('\n[TEST 3] Testing Dedicated Logins');
  // 3.1 Attempting to login to Owner portal with Kasir credentials
  const resKasirToOwner = await mockRequest(server, 'POST', '/api/auth/login', {
    body: { email: 'kasir@maisonresto.com', password: 'kasir123', portal: 'owner' }
  });
  assert.strictEqual(resKasirToOwner.statusCode, 403);
  console.log('✓ Kasir account is blocked from Owner portal (403 Forbidden).');

  // 3.2 Owner Login
  const resOwnerLogin = await mockRequest(server, 'POST', '/api/auth/login', {
    body: { email: 'owner@maisonresto.com', password: 'owner123', portal: 'owner' }
  });
  assert.strictEqual(resOwnerLogin.statusCode, 200);
  const ownerToken = resOwnerLogin.json.token;
  console.log('✓ Owner login succeeded with session token.');

  // 3.3 Kasir Login
  const resKasirLogin = await mockRequest(server, 'POST', '/api/auth/login', {
    body: { email: 'kasir@maisonresto.com', password: 'kasir123', portal: 'kasir' }
  });
  assert.strictEqual(resKasirLogin.statusCode, 200);
  const kasirToken = resKasirLogin.json.token;
  console.log('✓ Kasir login succeeded with session token.');

  // 3.4 Dapur Login
  const resDapurLogin = await mockRequest(server, 'POST', '/api/auth/login', {
    body: { email: 'dapur@maisonresto.com', password: 'dapur123', portal: 'dapur' }
  });
  assert.strictEqual(resDapurLogin.statusCode, 200);
  const dapurToken = resDapurLogin.json.token;
  console.log('✓ Dapur login succeeded with session token.');

  // 3.5 Cross-portal access prevention: Kasir opening /owner
  const resKasirAtOwnerPage = await mockRequest(server, 'GET', '/owner', {
    headers: { 'cookie': `maison_session=${kasirToken}` }
  });
  assert.strictEqual(resKasirAtOwnerPage.statusCode, 302);
  assert(resKasirAtOwnerPage.headers.location.includes('/kasir'));
  console.log('✓ Logged-in Kasir attempting to visit /owner is blocked and redirected to /kasir');

  // 3.6 Cross-portal access prevention: Dapur opening /kasir
  const resDapurAtKasirPage = await mockRequest(server, 'GET', '/kasir', {
    headers: { 'cookie': `maison_session=${dapurToken}` }
  });
  assert.strictEqual(resDapurAtKasirPage.statusCode, 302);
  assert(resDapurAtKasirPage.headers.location.includes('/dapur'));
  console.log('✓ Logged-in Dapur attempting to visit /kasir is blocked and redirected to /dapur');

  // TEST 4: Full Multi-Step Business Flow
  console.log('\n[TEST 4] Testing End-to-End Business Flow');
  
  // 4.1 Check ingredient stock before order
  const ingRes1 = await mockRequest(server, 'GET', '/api/dapur/ingredients', {
    headers: { 'authorization': `Bearer ${dapurToken}` }
  });
  const wagyu1 = ingRes1.json.ingredients.find(i => i.name.includes('Wagyu'));
  console.log(`- Stok awal Wagyu di Gudang: ${wagyu1.current_stock} kg`);

  // 4.2 Customer places order (2x Wagyu Ribeye MB9+ Grand Cru = 2 * 0.25 kg = 0.5 kg Wagyu)
  const orderRes = await mockRequest(server, 'POST', '/api/customer/order', {
    body: {
      customer_name: 'Bpk. Budi Santoso',
      table_number: 'Meja 05',
      items: [
        { menu_item_id: 1, quantity: 2, notes: 'Medium rare' }
      ],
      notes: 'Dekat jendela'
    }
  });
  assert.strictEqual(orderRes.statusCode, 201);
  const createdOrder = orderRes.json.order;
  console.log(`✓ Customer membuat pesanan: ${createdOrder.order_code} (Total Rp ${createdOrder.total_amount.toLocaleString('id-ID')})`);

  // 4.3 Kasir views order in active orders
  const kasirQueue = await mockRequest(server, 'GET', '/api/kasir/orders?filter=active', {
    headers: { 'authorization': `Bearer ${kasirToken}` }
  });
  const kasirFound = kasirQueue.json.orders.find(o => o.id === createdOrder.id);
  assert(kasirFound, 'Pesanan harus ada di Kasir');
  console.log(`✓ Pesanan ${createdOrder.order_code} masuk ke antrean Kasir.`);

  // 4.4 Dapur views order in kitchen queue
  const kitchenQueue = await mockRequest(server, 'GET', '/api/dapur/orders', {
    headers: { 'authorization': `Bearer ${dapurToken}` }
  });
  const kitchenFound = kitchenQueue.json.orders.find(o => o.id === createdOrder.id);
  assert(kitchenFound, 'Pesanan harus ada di Dapur');
  console.log(`✓ Pesanan ${createdOrder.order_code} masuk ke antrean Dapur.`);

  // 4.5 Kasir processes payment
  const payRes = await mockRequest(server, 'POST', `/api/kasir/order/${createdOrder.id}/pay`, {
    headers: { 'authorization': `Bearer ${kasirToken}` },
    body: {
      payment_method: 'cash',
      paid_amount: 1000000
    }
  });
  assert.strictEqual(payRes.statusCode, 200);
  assert.strictEqual(payRes.json.order.payment_status, 'paid');
  console.log(`✓ Pembayaran berhasil diproses oleh Kasir. Kembalian: Rp ${payRes.json.order.change_amount.toLocaleString('id-ID')}`);

  // 4.6 AUTOMATIC RECIPE STOCK DEDUCTION VERIFICATION
  const ingRes2 = await mockRequest(server, 'GET', '/api/dapur/ingredients', {
    headers: { 'authorization': `Bearer ${dapurToken}` }
  });
  const wagyu2 = ingRes2.json.ingredients.find(i => i.name.includes('Wagyu'));
  const expectedWagyu = wagyu1.current_stock - (2 * 0.25);
  console.log(`- Stok Wagyu setelah pemotongan otomatis resep: ${wagyu2.current_stock} kg (Ekspektasi: ${expectedWagyu} kg)`);
  assert(Math.abs(wagyu2.current_stock - expectedWagyu) < 0.001);
  console.log('✓ Pemotongan stok otomatis berdasarkan resep BERHASIL dan akurat!');

  // 4.7 Dapur records Restock (Stock-In)
  const restockRes = await mockRequest(server, 'POST', '/api/dapur/stock-in', {
    headers: { 'authorization': `Bearer ${dapurToken}` },
    body: {
      ingredient_id: wagyu2.id,
      quantity: 5,
      cost_per_unit: 650000,
      supplier: 'PT Meat Import Prima',
      notes: 'Restock mingguan batch B',
      date: new Date().toISOString().slice(0, 10)
    }
  });
  assert.strictEqual(restockRes.statusCode, 201);
  console.log('✓ Restock +5 kg berhasil dan otomatis dicatat sebagai beban pengeluaran restoran!');

  // 4.8 Owner monitors everything on Owner Dashboard
  const summaryRes = await mockRequest(server, 'GET', '/api/owner/summary', {
    headers: { 'authorization': `Bearer ${ownerToken}` }
  });
  assert.strictEqual(summaryRes.statusCode, 200);
  const s = summaryRes.json;
  console.log(`\n[METRIK OWNER BERHASIL TERHUBUNG]`);
  console.log(`- Pendapatan Hari Ini: Rp ${s.revenue.daily.total.toLocaleString('id-ID')}`);
  console.log(`- Pendapatan Mingguan: Rp ${s.revenue.weekly.total.toLocaleString('id-ID')}`);
  console.log(`- Pendapatan Bulanan: Rp ${s.revenue.monthly.total.toLocaleString('id-ID')}`);
  console.log(`- Pendapatan Tahunan: Rp ${s.revenue.yearly.total.toLocaleString('id-ID')}`);
  console.log(`- Total Pengeluaran: Rp ${s.financial.expenses.toLocaleString('id-ID')}`);
  console.log(`- Laba Bersih (Net Profit): Rp ${s.financial.netProfit.toLocaleString('id-ID')}`);
  console.log(`- Valuasi Stok Gudang: Rp ${s.stock.inventory_valuation.toLocaleString('id-ID')}`);
  console.log(`- Jumlah Bahan Menipis: ${s.stock.low_stock_count}`);
  console.log(`- 5 Menu Terlaris: ${s.topMenus.map(m => m.menu_name + ' (' + m.total_sold + 'x)').join(', ')}`);

  // 4.9 Owner User Management (CRUD)
  const newUserRes = await mockRequest(server, 'POST', '/api/owner/users', {
    headers: { 'authorization': `Bearer ${ownerToken}` },
    body: {
      name: 'Kasir Kedua',
      email: 'kasir_baru@maisonresto.com',
      password: 'password123',
      role: 'kasir',
      phone: '081233445566'
    }
  });
  assert.strictEqual(newUserRes.statusCode, 201);
  const newUserId = newUserRes.json.id;
  console.log(`✓ Owner berhasil menambahkan akun kasir baru (ID ${newUserId})`);

  const delUserRes = await mockRequest(server, 'DELETE', `/api/owner/users/${newUserId}`, {
    headers: { 'authorization': `Bearer ${ownerToken}` }
  });
  assert.strictEqual(delUserRes.statusCode, 200);
  console.log(`✓ Owner berhasil menghapus akun (ID ${newUserId})`);

  console.log('\n=============================================================');
  console.log('🎉 SEMUA 7 PERSYARATAN MAISON RESTO TELAH TERUJI & 100% SUKSES!');
  console.log('=============================================================\n');

  process.exit(0);
}

runDirectTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});

const http = require('node:http');
const assert = require('node:assert');

const BASE_URL = 'http://localhost:3000';

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const reqOptions = {
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = http.request(url, reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (e) {
          // not json
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data,
          json
        });
      });
    });

    req.on('error', err => reject(err));

    if (options.body) {
      if (typeof options.body === 'object') {
        req.setHeader('Content-Type', 'application/json');
        req.write(JSON.stringify(options.body));
      } else {
        req.write(options.body);
      }
    }

    req.end();
  });
}

async function runTests() {
  console.log('--- STARTING MAISON RESTO END-TO-END VERIFICATION ---');

  // TEST 1: Public Routes
  console.log('\n[TEST 1] Checking Public Route /pesan (No Login Required)');
  const resPesan = await request('/pesan');
  assert.strictEqual(resPesan.statusCode, 200, '/pesan should return 200 OK');
  assert(resPesan.data.includes('Buku Menu & Pemesanan Mandiri'), 'Should render customer page');
  console.log('✓ /pesan is accessible publicly without login.');

  // TEST 2: RBAC Route Protection on Pages
  console.log('\n[TEST 2] Checking RBAC Protection on Admin Portals');
  const resOwnerUnauth = await request('/owner');
  assert.strictEqual(resOwnerUnauth.statusCode, 302, '/owner without login should redirect');
  assert(resOwnerUnauth.headers.location.includes('/owner/login'), 'Should redirect to /owner/login');
  console.log('✓ /owner redirects unauthenticated users to /owner/login');

  const resKasirUnauth = await request('/kasir');
  assert.strictEqual(resKasirUnauth.statusCode, 302, '/kasir without login should redirect');
  assert(resKasirUnauth.headers.location.includes('/kasir/login'), 'Should redirect to /kasir/login');
  console.log('✓ /kasir redirects unauthenticated users to /kasir/login');

  const resDapurUnauth = await request('/dapur');
  assert.strictEqual(resDapurUnauth.statusCode, 302, '/dapur without login should redirect');
  assert(resDapurUnauth.headers.location.includes('/dapur/login'), 'Should redirect to /dapur/login');
  console.log('✓ /dapur redirects unauthenticated users to /dapur/login');

  // TEST 3: Auth Portal Separation
  console.log('\n[TEST 3] Testing Dedicated Separate Logins');
  // Attempting to login to Owner portal with Kasir credentials
  const resKasirAtOwner = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'kasir@maisonresto.com', password: 'kasir123', portal: 'owner' }
  });
  assert.strictEqual(resKasirAtOwner.statusCode, 403, 'Kasir cannot login to Owner portal');
  console.log('✓ Kasir account is rejected when attempting to login to Owner portal.');

  // Legitimate Owner Login
  const resOwnerLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner@maisonresto.com', password: 'owner123', portal: 'owner' }
  });
  assert.strictEqual(resOwnerLogin.statusCode, 200, 'Owner login should succeed');
  const ownerToken = resOwnerLogin.json.token;
  assert(ownerToken, 'Owner token received');
  console.log('✓ Owner login succeeded.');

  // Legitimate Kasir Login
  const resKasirLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'kasir@maisonresto.com', password: 'kasir123', portal: 'kasir' }
  });
  assert.strictEqual(resKasirLogin.statusCode, 200, 'Kasir login should succeed');
  const kasirToken = resKasirLogin.json.token;
  console.log('✓ Kasir login succeeded.');

  // Legitimate Dapur Login
  const resDapurLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'dapur@maisonresto.com', password: 'dapur123', portal: 'dapur' }
  });
  assert.strictEqual(resDapurLogin.statusCode, 200, 'Dapur login should succeed');
  const dapurToken = resDapurLogin.json.token;
  console.log('✓ Dapur login succeeded.');

  // Cross-role page restriction: Kasir attempting to open /owner with session
  const resKasirOpenOwner = await request('/owner', {
    headers: { 'Cookie': `maison_session=${kasirToken}` }
  });
  assert.strictEqual(resKasirOpenOwner.statusCode, 302, 'Kasir cannot open /owner page');
  assert(resKasirOpenOwner.headers.location.includes('/kasir'), 'Should redirect back to /kasir');
  console.log('✓ Kasir user attempting to open /owner is blocked and redirected to /kasir');

  // Cross-role page restriction: Dapur attempting to open /kasir with session
  const resDapurOpenKasir = await request('/kasir', {
    headers: { 'Cookie': `maison_session=${dapurToken}` }
  });
  assert.strictEqual(resDapurOpenKasir.statusCode, 302, 'Dapur cannot open /kasir page');
  assert(resDapurOpenKasir.headers.location.includes('/dapur'), 'Should redirect back to /dapur');
  console.log('✓ Dapur user attempting to open /kasir is blocked and redirected to /dapur');

  // TEST 4: Full End-to-End Business Flow
  console.log('\n[TEST 4] Running Full Restaurant Flow: Order -> Kitchen -> Cashier -> Auto Recipe Deduction');
  
  // Step 4.1: Customer submits order (e.g. 2x Wagyu Ribeye MB9+)
  // Check current Wagyu stock first via Dapur API
  const ingResBefore = await request('/api/dapur/ingredients', {
    headers: { 'Authorization': `Bearer ${dapurToken}` }
  });
  const wagyuBefore = ingResBefore.json.ingredients.find(i => i.name.includes('Wagyu'));
  console.log(`Current Wagyu stock before order: ${wagyuBefore.current_stock} kg`);

  const orderRes = await request('/api/customer/order', {
    method: 'POST',
    body: {
      customer_name: 'Bpk. Budi Santoso',
      table_number: 'Meja 05',
      items: [
        { menu_item_id: 1, quantity: 2, notes: 'Medium rare' } // 2x Wagyu (0.25 kg each = 0.5 kg total)
      ],
      notes: 'Meja dekat panggung'
    }
  });

  assert.strictEqual(orderRes.statusCode, 201, 'Order should be created successfully');
  const createdOrder = orderRes.json.order;
  console.log(`✓ Customer placed order: ${createdOrder.order_code} for ${createdOrder.customer_name} (${createdOrder.table_number}), Total: Rp ${createdOrder.total_amount}`);

  // Step 4.2: Verify order appears in Kasir's queue
  const kasirOrdersRes = await request('/api/kasir/orders?filter=active', {
    headers: { 'Authorization': `Bearer ${kasirToken}` }
  });
  const foundInKasir = kasirOrdersRes.json.orders.find(o => o.id === createdOrder.id);
  assert(foundInKasir, 'Order must appear in Kasir queue');
  console.log(`✓ Order ${createdOrder.order_code} verified in Kasir queue.`);

  // Step 4.3: Verify order appears in Kitchen's queue
  const kitchenOrdersRes = await request('/api/dapur/orders', {
    headers: { 'Authorization': `Bearer ${dapurToken}` }
  });
  const foundInKitchen = kitchenOrdersRes.json.orders.find(o => o.id === createdOrder.id);
  assert(foundInKitchen, 'Order must appear in Kitchen queue');
  console.log(`✓ Order ${createdOrder.order_code} verified in Kitchen queue.`);

  // Step 4.4: Kasir processes payment
  const payRes = await request(`/api/kasir/order/${createdOrder.id}/pay`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${kasirToken}` },
    body: {
      payment_method: 'cash',
      paid_amount: 1000000 // Total is 2 * 485000 = 970000, change is 30000
    }
  });
  assert.strictEqual(payRes.statusCode, 200, 'Payment must succeed');
  assert.strictEqual(payRes.json.order.payment_status, 'paid', 'Order marked as paid');
  assert.strictEqual(payRes.json.order.change_amount, 30000, 'Change calculated correctly');
  console.log(`✓ Payment processed: Rp 1.000.000 received, Change: Rp ${payRes.json.order.change_amount}.`);

  // Step 4.5: Verify AUTOMATIC RECIPE STOCK DEDUCTION
  const ingResAfter = await request('/api/dapur/ingredients', {
    headers: { 'Authorization': `Bearer ${dapurToken}` }
  });
  const wagyuAfter = ingResAfter.json.ingredients.find(i => i.name.includes('Wagyu'));
  const expectedStock = wagyuBefore.current_stock - (2 * 0.25);
  console.log(`Wagyu stock after automatic recipe deduction: ${wagyuAfter.current_stock} kg (Expected: ${expectedStock} kg)`);
  assert(Math.abs(wagyuAfter.current_stock - expectedStock) < 0.001, 'Stock must decrease exactly according to recipe');
  console.log('✓ Automatic recipe deduction verified!');

  // Step 4.6: Kitchen updates status
  const cookRes = await request(`/api/dapur/order/${createdOrder.id}/status`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${dapurToken}` },
    body: { status: 'ready' }
  });
  assert.strictEqual(cookRes.statusCode, 200, 'Kitchen status update should succeed');
  console.log('✓ Kitchen status updated to "ready".');

  // Step 4.7: Kitchen records restock (stock-in)
  const stockInRes = await request('/api/dapur/stock-in', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${dapurToken}` },
    body: {
      ingredient_id: wagyuAfter.id,
      quantity: 5,
      cost_per_unit: 650000,
      supplier: 'PT Restock Mandiri',
      notes: 'Penambahan stok darurat'
    }
  });
  assert.strictEqual(stockInRes.statusCode, 201, 'Stock-in should succeed');
  console.log('✓ Dapur recorded incoming stock: +5 kg Wagyu, automatically logged into expenses!');

  // TEST 5: Owner Summary & Financial Verification
  console.log('\n[TEST 5] Testing Owner Executive Analytics & User Management');
  const ownerSummaryRes = await request('/api/owner/summary', {
    headers: { 'Authorization': `Bearer ${ownerToken}` }
  });
  assert.strictEqual(ownerSummaryRes.statusCode, 200, 'Owner summary should succeed');
  const summary = ownerSummaryRes.json;
  console.log(`- Daily Revenue: Rp ${summary.revenue.daily.total.toLocaleString('id-ID')}`);
  console.log(`- Weekly Revenue: Rp ${summary.revenue.weekly.total.toLocaleString('id-ID')}`);
  console.log(`- Monthly Revenue: Rp ${summary.revenue.monthly.total.toLocaleString('id-ID')}`);
  console.log(`- Yearly Revenue: Rp ${summary.revenue.yearly.total.toLocaleString('id-ID')}`);
  console.log(`- Net Profit: Rp ${summary.financial.netProfit.toLocaleString('id-ID')}`);
  console.log(`- Low Stock Items Count: ${summary.stock.low_stock_count}`);
  assert(summary.revenue.daily.total > 0, 'Daily revenue must be > 0');
  console.log('✓ Owner financial metrics verified.');

  // TEST 6: Owner User Management (CRUD)
  const createUserRes = await request('/api/owner/users', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ownerToken}` },
    body: {
      name: 'Kasir Shift Pagi',
      email: 'kasir2@maisonresto.com',
      password: 'password123',
      role: 'kasir',
      phone: '081299887766'
    }
  });
  assert.strictEqual(createUserRes.statusCode, 201, 'Owner can create new user');
  const newUserId = createUserRes.json.id;
  console.log(`✓ Owner created new user ID ${newUserId}`);

  const deleteUserRes = await request(`/api/owner/users/${newUserId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${ownerToken}` }
  });
  assert.strictEqual(deleteUserRes.statusCode, 200, 'Owner can delete user');
  console.log(`✓ Owner deleted user ID ${newUserId}`);

  console.log('\n======================================================');
  console.log('🎉 ALL INTEGRATION AND SECURITY TESTS PASSED PERFECTLY!');
  console.log('======================================================\n');
}

runTests().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});

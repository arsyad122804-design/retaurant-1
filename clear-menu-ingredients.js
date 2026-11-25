const { db } = require('./db.js');

try {
  db.exec('PRAGMA foreign_keys = OFF;');
  
  // Clear order items & orders
  db.exec('DELETE FROM order_items;');
  db.exec('DELETE FROM orders;');
  
  // Clear recipes
  db.exec('DELETE FROM recipes;');
  
  // Clear stock logs & incoming
  db.exec('DELETE FROM stock_logs;');
  db.exec('DELETE FROM stock_incoming;');
  
  // Clear menu items & ingredients
  db.exec('DELETE FROM menu_items;');
  db.exec('DELETE FROM ingredients;');
  
  // Clear expenses
  db.exec('DELETE FROM expenses;');

  // Reset autoincrement counters for menu & ingredients
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('menu_items', 'ingredients', 'recipes', 'orders', 'order_items', 'stock_logs', 'stock_incoming', 'expenses');");
  
  db.exec('PRAGMA foreign_keys = ON;');

  const menuCount = db.prepare('SELECT COUNT(*) as c FROM menu_items').get().c;
  const ingCount = db.prepare('SELECT COUNT(*) as c FROM ingredients').get().c;
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;

  console.log(`Pembersihan Berhasil!`);
  console.log(`- Bahan Baku di Gudang: ${ingCount} item`);
  console.log(`- Menu di Pesan Tamu : ${menuCount} item`);
  console.log(`- Akun Pengguna Tetap Utuh: ${userCount} akun (Owner, Kasir, Dapur)`);
} catch (e) {
  console.error('Error saat membersihkan:', e);
}

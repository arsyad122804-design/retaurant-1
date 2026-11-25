const { db } = require('./db.js');

try {
  // Check if already exists
  const existing = db.prepare('SELECT id FROM ingredients WHERE name = ?').get('Daging Ayam Utuh Organik');
  let ayamId;

  if (existing) {
    ayamId = existing.id;
  } else {
    const resIng = db.prepare('INSERT INTO ingredients (name, unit, current_stock, min_stock, cost_per_unit) VALUES (?, ?, ?, ?, ?)')
      .run('Daging Ayam Utuh Organik', 'ekor', 20.0, 5.0, 45000);
    ayamId = Number(resIng.lastInsertRowid);
  }

  const existingMenu = db.prepare('SELECT id FROM menu_items WHERE name = ?').get('Poulet Rôti aux Fines Herbes (Ayam Panggang Maison)');
  let menuId;

  if (existingMenu) {
    menuId = existingMenu.id;
  } else {
    const resMenu = db.prepare('INSERT INTO menu_items (name, category, price, description, image_url, is_available) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        'Poulet Rôti aux Fines Herbes (Ayam Panggang Maison)',
        'Main Course',
        165000,
        '1 ekor ayam organik utuh dipanggang perlahan dengan mentega Prancis, bawang putih, dan herba rosemary segar.',
        'https://images.unsplash.com/photo-1598103442097-8b74394b95c6?w=700&auto=format&fit=crop&q=80',
        1
      );
    menuId = Number(resMenu.lastInsertRowid);
  }

  // Recipes
  const butter = db.prepare("SELECT id FROM ingredients WHERE name LIKE '%French Butter%'").get();
  const herbs = db.prepare("SELECT id FROM ingredients WHERE name LIKE '%Bawang Putih%'").get();

  db.prepare('DELETE FROM recipes WHERE menu_item_id = ?').run(menuId);
  db.prepare('INSERT INTO recipes (menu_item_id, ingredient_id, quantity_required) VALUES (?, ?, ?)').run(menuId, ayamId, 1.0);
  if (butter) db.prepare('INSERT INTO recipes (menu_item_id, ingredient_id, quantity_required) VALUES (?, ?, ?)').run(menuId, butter.id, 0.03);
  if (herbs) db.prepare('INSERT INTO recipes (menu_item_id, ingredient_id, quantity_required) VALUES (?, ?, ?)').run(menuId, herbs.id, 0.02);

  console.log('SUCCESS! Ayam Ingredient ID:', ayamId, 'Menu ID:', menuId);
} catch (e) {
  console.error(e);
}

'use strict';
require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME || 'nutridesk', multipleStatements: true });
  try {
    await c.beginTransaction();
    const [cols] = await c.query("SHOW COLUMNS FROM foods LIKE 'normalized_name'");
    if (!cols.length) await c.query("ALTER TABLE foods ADD COLUMN normalized_name VARCHAR(200) GENERATED ALWAYS AS (LOWER(TRIM(name))) STORED, ADD UNIQUE KEY uq_food_normalized_name (normalized_name)");
    await c.query(`
      INSERT INTO foods (name, kcal, carbs, protein, fat, source)
      SELECT MIN(TRIM(ri.name)),
             ROUND(SUM(ri.kcal) * 100 / NULLIF(SUM(ri.amount_g),0), 2),
             ROUND(SUM(ri.carbs) * 100 / NULLIF(SUM(ri.amount_g),0), 2),
             ROUND(SUM(ri.protein) * 100 / NULLIF(SUM(ri.amount_g),0), 2),
             ROUND(SUM(ri.fat) * 100 / NULLIF(SUM(ri.amount_g),0), 2),
             'recipe-derived'
      FROM recipe_ingredients ri
      WHERE ri.amount_g > 0 AND TRIM(ri.name) <> ''
      GROUP BY LOWER(TRIM(ri.name))
      ON DUPLICATE KEY UPDATE id=id
    `);
    await c.query(`UPDATE recipe_ingredients ri JOIN foods f ON f.normalized_name=LOWER(TRIM(ri.name)) SET ri.food_id=f.id WHERE ri.food_id IS NULL`);
    const [[stats]] = await c.query('SELECT (SELECT COUNT(*) FROM foods) foods, COUNT(*) ingredients, COUNT(food_id) linked, COUNT(*)-COUNT(food_id) unlinked FROM recipe_ingredients');
    if (Number(stats.unlinked) !== 0) throw new Error(`${stats.unlinked} Zutaten konnten nicht verknüpft werden`);
    await c.commit();
    console.log(JSON.stringify(stats));
  } catch (e) { await c.rollback(); throw e; } finally { await c.end(); }
})().catch(e => { console.error(e); process.exit(1); });

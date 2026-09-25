'use strict';
require('dotenv').config();
const mysql = require('mysql2/promise');

// Solide Alltagsbasis pro 100 g. Markenprodukte kommen weiterhin aus OpenFoodFacts;
// diese generischen Einträge sorgen dafür, dass Tracker und Rezepte auch ohne Barcode
// mit üblichen Lebensmitteln funktionieren.
const foods = [
  ['Apfel',52,14,0.3,0.2],['Banane',89,23,1.1,0.3],['Birne',57,15,0.4,0.1],['Orange',47,12,0.9,0.1],['Mandarine',53,13,0.8,0.3],['Zitrone',29,9,1.1,0.3],['Limette',30,11,0.7,0.2],['Kiwi',61,15,1.1,0.5],['Mango',60,15,0.8,0.4],['Ananas',50,13,0.5,0.1],['Wassermelone',30,8,0.6,0.2],['Honigmelone',36,9,0.5,0.1],['Erdbeeren',32,8,0.7,0.3],['Himbeeren',52,12,1.2,0.7],['Heidelbeeren',57,14,0.7,0.3],['Weintrauben',69,18,0.7,0.2],['Pfirsich',39,10,0.9,0.3],['Nektarine',44,11,1.1,0.3],['Kirschen',63,16,1.1,0.2],['Avocado',160,9,2,15],
  ['Kartoffeln gekocht',87,20,1.9,0.1],['Süßkartoffel',86,20,1.6,0.1],['Karotte',41,10,0.9,0.2],['Tomate',18,3.9,0.9,0.2],['Cherrytomaten',18,3.9,0.9,0.2],['Gurke',15,3.6,0.7,0.1],['Paprika rot',31,6,1,0.3],['Paprika gelb',27,6.3,1,0.2],['Zucchini',17,3.1,1.2,0.3],['Aubergine',25,6,1,0.2],['Brokkoli',34,6.6,2.8,0.4],['Blumenkohl',25,5,1.9,0.3],['Spinat',23,3.6,2.9,0.4],['Grünkohl',49,8.8,4.3,0.9],['Kopfsalat',15,2.9,1.4,0.2],['Rucola',25,3.7,2.6,0.7],['Champignons',22,3.3,3.1,0.3],['Zwiebel',40,9.3,1.1,0.1],['Knoblauch',149,33,6.4,0.5],['Mais gekocht',96,21,3.4,1.5],['Erbsen gekocht',84,15,5.4,0.4],['Grüne Bohnen',31,7,1.8,0.2],['Rote Bete',43,10,1.6,0.2],
  ['Haferflocken',372,59,13.5,7],['Vollkornbrot',247,41,13,4.2],['Roggenbrot',259,48,8.5,3.3],['Toastbrot',265,49,9,3.2],['Brötchen',274,55,9,1.5],['Reis gekocht',130,28,2.7,0.3],['Vollkornreis gekocht',123,26,2.7,1],['Nudeln gekocht',158,31,5.8,0.9],['Vollkornnudeln gekocht',149,30,5.7,1.4],['Couscous gekocht',112,23,3.8,0.2],['Bulgur gekocht',83,19,3.1,0.2],['Quinoa gekocht',120,21,4.4,1.9],['Hirse gekocht',119,23.7,3.5,1],['Wrap Weizen',310,52,8,8],
  ['Kichererbsen gekocht',164,27,8.9,2.6],['Linsen gekocht',116,20,9,0.4],['Kidneybohnen gekocht',127,23,8.7,0.5],['Weiße Bohnen gekocht',139,25,9.7,0.4],['Tofu natur',144,2.8,15.7,8.7],['Tempeh',193,7.6,20.3,10.8],['Hummus',166,14,7.9,9.6],
  ['Hähnchenbrust roh',120,0,22.5,2.6],['Putenbrust roh',114,0,24,1.2],['Rinderhack 10% Fett',176,0,20,10],['Rindersteak',187,0,26,8],['Schweinefilet',120,0,22,3.5],['Lachs roh',208,0,20,13],['Thunfisch in Wasser',116,0,26,1],['Kabeljau',82,0,18,0.7],['Garnelen',99,0.2,24,0.3],['Ei',143,0.7,12.6,9.5],
  ['Milch 1,5%',47,4.9,3.4,1.5],['Milch 3,5%',64,4.7,3.3,3.5],['Haferdrink ungesüßt',40,6.7,1,1.5],['Sojadrink ungesüßt',33,0.7,3.3,1.8],['Naturjoghurt 1,5%',58,5.3,4.1,1.5],['Griechischer Joghurt 10%',133,3.8,5.7,10],['Skyr natur',63,4,11,0.2],['Magerquark',67,4,12,0.2],['Hüttenkäse',98,3.4,12.4,4.3],['Mozzarella',254,2.8,18.7,19.5],['Gouda',356,2.2,25,27],['Feta',265,3.9,14.2,21.5],['Halloumi',321,2,25,24],
  ['Mandeln',579,22,21,50],['Walnüsse',654,14,15,65],['Cashewkerne',553,30,18,44],['Erdnussbutter',588,20,25,50],['Chiasamen',486,42,17,31],['Leinsamen',534,29,18,42],['Olivenöl',884,0,0,100],['Rapsöl',884,0,0,100],['Butter',717,0.1,0.9,81],
  ['Honig',304,82,0.3,0],['Zucker',387,100,0,0],['Zartbitterschokolade 70%',598,46,7.8,43],['Vollmilchschokolade',535,59,7.7,30],['Marmelade',250,60,0.4,0.1],['Tomatenpassata',29,4.8,1.4,0.2],['Kokosmilch',197,2.8,2,21],['Gemüsebrühe zubereitet',5,0.6,0.2,0.2]
];

(async () => {
  const db = await mysql.createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME || 'nutridesk' });
  let added = 0;
  try {
    await db.beginTransaction();
    for (const [name, kcal, carbs, protein, fat] of foods) {
      const [r] = await db.execute('INSERT IGNORE INTO foods (name,kcal,carbs,protein,fat,source) VALUES (?,?,?,?,?,?)', [name, kcal, carbs, protein, fat, 'nutridesk-curated']);
      added += Number(r.affectedRows) || 0;
    }
    await db.commit();
    const [[row]] = await db.execute('SELECT COUNT(*) AS total FROM foods');
    console.log(JSON.stringify({ added, total: Number(row.total) }));
  } catch (e) { await db.rollback(); throw e; } finally { await db.end(); }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });

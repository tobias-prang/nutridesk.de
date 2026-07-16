'use strict';

// Kochgewicht -> Kaufgewicht. Die Rezeptmengen sind bei "(gekocht)" das Gewicht nach dem Garen,
// gekauft wird aber die trockene Ware.
const RAW_FACTOR = [
  [/^(basmati|sushi)?reis \(gekocht\)/, 0.37],
  [/nudeln \(gekocht\)|spaghetti \(gekocht\)|penne \(gekocht\)|fusilli \(gekocht\)|tagliatelle \(gekocht\)/, 0.45],
  [/glasnudeln \(gekocht\)|reisnudeln \(gekocht\)|udon-nudeln \(gekocht\)/, 0.42],
  [/linsen \(gekocht\)|urad dal \(gekocht\)/, 0.35],
  [/quinoa \(gekocht\)|bulgur \(gekocht\)|couscous \(gekocht\)|buchweizen \(gekocht\)/, 0.35],
];

// [Muster, Groesse in g, Einheit-Singular, Einheit-Plural, Groessen-Label, Preis je Packung, Vorrat]
const PACKS = [
  // Fette, Oele, Essig
  [/^oliven[oö]l/, 500, 'Flasche', 'Flaschen', '500 ml', 4.5, 1],
  [/^(raps|sonnenblumen)[oö]l/, 1000, 'Flasche', 'Flaschen', '1 l', 2.5, 1],
  [/^(sesam|lein|palm|walnuss)[oö]l/, 250, 'Flasche', 'Flaschen', '250 ml', 4.0, 1],
  [/essig$|^balsamico/, 500, 'Flasche', 'Flaschen', '500 ml', 2.2, 1],

  // Gewuerze: kleine Glaeser, klassische Vorratsware
  [/^safran/, 1, 'Briefchen', 'Briefchen', '1 g', 4.5, 1],
  [/^salz/, 500, 'Packung', 'Packungen', '500 g', 0.6, 1],
  [/^zucker/, 1000, 'Packung', 'Packungen', '1 kg', 1.1, 1],
  [/^backpulver/, 16, 'Päckchen', 'Päckchen', '16 g', 0.25, 1],
  [/^(pfeffer|paprikapulver|kurkuma|zimt|oregano|thymian|rosmarin|salbei|k[uü]mmel|kreuzk[uü]mmel|muskatnuss|piment|kardamom|lorbeerblatt|chiliflocken|vanille|bohnenkraut|senfsamen|bockshornklee|sumach|currypulver|garam masala|ras el hanout|za.atar|cajun-gew|jerk-gew|berbere-gew|fajitagew|kr[aä]uter der provence)/, 20, 'Glas', 'Gläser', '20 g', 1.6, 1],

  // Frische Kraeuter: Bund oder Topf
  [/^(petersilie|basilikum|schnittlauch|dill|minze|kresse|frischer koriander|curryblätter|zitronengras)/, 30, 'Bund', 'Bund', '30 g', 1.2, 0],

  // Pasten, Saucen, Wuerzmittel
  [/^(sojasauce|teriyakisauce|hoisinsauce|austernsauce|kecap manis|fischsauce)/, 250, 'Flasche', 'Flaschen', '250 ml', 2.6, 1],
  [/^(sriracha|piri-piri-sauce)/, 250, 'Flasche', 'Flaschen', '250 ml', 2.4, 1],
  [/^ketchup/, 500, 'Flasche', 'Flaschen', '500 ml', 2.0, 1],
  [/senf$|^senf|^dijon-senf/, 200, 'Glas', 'Gläser', '200 g', 1.2, 1],
  [/^tomatenmark/, 200, 'Tube', 'Tuben', '200 g', 1.0, 1],
  [/^(harissa|sambal oelek|gochujang|miso-paste|tandoori-paste|tamarindenpaste|aji-amarillo-paste|rote currypaste)/, 200, 'Glas', 'Gläser', '200 g', 2.8, 1],
  [/^(ahornsirup|granatapfelsirup)/, 250, 'Flasche', 'Flaschen', '250 ml', 4.5, 1],
  [/^honig/, 500, 'Glas', 'Gläser', '500 g', 5.0, 1],
  [/^(mayonnaise)/, 250, 'Glas', 'Gläser', '250 ml', 2.0, 1],
  [/^pesto/, 190, 'Glas', 'Gläser', '190 g', 2.5, 1],
  [/^kapern/, 100, 'Glas', 'Gläser', '100 g', 2.0, 1],
  [/^meerrettich/, 100, 'Glas', 'Gläser', '100 g', 1.8, 1],
  [/^hefeflocken/, 100, 'Packung', 'Packungen', '100 g', 3.0, 1],
  [/^backkakao/, 125, 'Packung', 'Packungen', '125 g', 2.0, 1],
  [/^nori/, 25, 'Packung', 'Packungen', '25 g', 2.5, 1],
  [/^röstzwiebeln/, 100, 'Packung', 'Packungen', '100 g', 1.5, 1],
  [/^zartbitterschokolade/, 100, 'Tafel', 'Tafeln', '100 g', 1.5, 0],

  // Stueckware
  [/^ei$/, 60, 'Stück', 'Stück', '', 0.35, 0],
  [/^zitrone/, 100, 'Stück', 'Stück', '', 0.4, 0],
  [/^limette/, 60, 'Stück', 'Stück', '', 0.35, 0],
  [/^knoblauch/, 50, 'Knolle', 'Knollen', '', 0.6, 0],
  [/^ingwer/, 80, 'Stück', 'Stück', '', 0.7, 0],
  [/^(chilischote|jalapeños)/, 50, 'Packung', 'Packungen', '50 g', 1.0, 0],
  [/^frühlingszwiebeln/, 100, 'Bund', 'Bund', '', 0.9, 0],

  // Milchprodukte
  [/^milch/, 1000, 'Packung', 'Packungen', '1 l', 1.2, 0],
  [/^butter/, 250, 'Stück', 'Stück', '250 g', 2.4, 0],
  [/^ghee/, 250, 'Glas', 'Gläser', '250 g', 4.5, 1],
  [/^(naturjoghurt|griechischer joghurt|skyr|magerquark)/, 500, 'Becher', 'Becher', '500 g', 1.3, 0],
  [/^(frischkäse|mascarpone|schmand|ricotta|hüttenkäse)/, 200, 'Becher', 'Becher', '200 g', 1.6, 0],
  [/^kochsahne/, 200, 'Packung', 'Packungen', '200 ml', 0.8, 0],
  [/^geriebener käse/, 200, 'Packung', 'Packungen', '200 g', 2.2, 0],
  [/^proteinpulver/, 1000, 'Dose', 'Dosen', '1 kg', 25.0, 1],

  // Konserven
  [/\(dose\)/, 150, 'Dose', 'Dosen', '150 g', 1.6, 0],
  [/^(kidneybohnen|schwarze bohnen|weiße bohnen|schwarzaugenbohnen|kichererbsen) \(gekocht\)/, 240, 'Dose', 'Dosen', '400 g', 1.1, 0],

  // Getreide, Basis
  [/^mehl|^kichererbsenmehl/, 1000, 'Packung', 'Packungen', '1 kg', 1.3, 1],
  [/^haferflocken/, 500, 'Packung', 'Packungen', '500 g', 1.2, 1],
  [/^(reis|basmatireis|sushireis) \(gekocht\)/, 500, 'Packung', 'Packungen', '500 g', 1.8, 0],
  [/nudeln \(gekocht\)|spaghetti \(gekocht\)|penne \(gekocht\)|fusilli \(gekocht\)|tagliatelle \(gekocht\)/, 500, 'Packung', 'Packungen', '500 g', 1.6, 0],
  [/^(quinoa|bulgur|couscous|buchweizen) \(gekocht\)/, 500, 'Packung', 'Packungen', '500 g', 2.8, 0],
  [/^linsen \(gekocht\)|^rote linsen \(gekocht\)|^belugalinsen \(gekocht\)/, 500, 'Packung', 'Packungen', '500 g', 2.2, 0],
  [/^(semmelbrösel|panko)/, 200, 'Packung', 'Packungen', '200 g', 1.2, 1],
  [/^(cornflakes|müsli|granola)/, 500, 'Packung', 'Packungen', '500 g', 2.8, 0],
  [/^(vollkorntoast|vollkornbrot|fladenbrot|naan)/, 500, 'Packung', 'Packungen', '', 2.2, 0],
  [/^(vollkornbrötchen|burger-bun)/, 75, 'Stück', 'Stück', '', 0.4, 0],
  [/^(maistortilla|weizentortilla)/, 320, 'Packung', 'Packungen', '8 Stück', 1.8, 0],
  [/^knäckebrot/, 250, 'Packung', 'Packungen', '250 g', 1.5, 1],
  [/^reiswaffeln/, 100, 'Packung', 'Packungen', '100 g', 1.2, 1],

  // Proteine
  [/^(tofu natur|räuchertofu|tempeh|seitan)/, 200, 'Packung', 'Packungen', '200 g', 2.5, 0],
  [/^(erbsen|edamame)/, 450, 'Packung', 'Packungen', '450 g', 2.0, 0],

  // Teig, Beilagen, Fertigware
  [/^ofenpommes/, 750, 'Beutel', 'Beutel', '750 g', 2.2, 0],
  [/^(gnocchi|sp[aä]tzle)/, 400, 'Packung', 'Packungen', '400 g', 1.8, 0],
  [/^(tortellini|maultaschen)/, 250, 'Packung', 'Packungen', '250 g', 2.2, 0],
  [/^(lasagneplatten|cannelloni)/, 250, 'Packung', 'Packungen', '250 g', 1.8, 0],
  [/^kartoffelkl[oö][sß]|^semmelkn[oö]del/, 750, 'Packung', 'Packungen', '6 Stück', 2.2, 0],
  [/^kartoffelp[uü]ree/, 1200, 'Packung', 'Packungen', '200 g Pulver', 1.4, 1],
  [/^(bl[aä]tterteig|filoteig|pizzateig)/, 275, 'Packung', 'Packungen', '275 g', 1.8, 0],
  [/^gyoza-teigbl/, 275, 'Packung', 'Packungen', '275 g', 2.5, 0],
  [/^reispapier/, 100, 'Packung', 'Packungen', '100 g', 2.2, 1],
  [/^(weichweizen|mais)grie[sß]/, 500, 'Packung', 'Packungen', '500 g', 1.4, 1],
  [/^(risottoreis|hirse) \(roh\)|^risottoreis|^hirse/, 500, 'Packung', 'Packungen', '500 g', 2.4, 0],
  [/^quinoaflocken/, 500, 'Packung', 'Packungen', '500 g', 3.0, 1],
  [/^tortillachips/, 200, 'Packung', 'Packungen', '200 g', 1.8, 0],
  [/^(baguette|ciabatta)/, 250, 'Stück', 'Stück', '', 1.2, 0],

  // Glaeser, Dosen, Getraenke
  [/^kokosmilch/, 400, 'Dose', 'Dosen', '400 ml', 1.2, 0],
  [/^passierte tomaten/, 500, 'Packung', 'Packungen', '500 g', 1.0, 1],
  [/^gem[uü]sebr[uü]he/, 5000, 'Glas', 'Gläser', 'Pulver für 5 l', 2.5, 1],
  [/^(ajvar|bbq-sauce|guacamole|hummus|kimchi|sauerkraut|apfelmus|apfelrotkohl|artischockenherzen|wasserkastanien|bambussprossen|weinbl[aä]tter)/, 250, 'Glas', 'Gläser', '250 g', 2.2, 0],
  [/^(oliven|gew[uü]rzgurke)/, 200, 'Glas', 'Gläser', '200 g', 1.8, 0],
  [/^datteln/, 200, 'Packung', 'Packungen', '200 g', 2.5, 0],
  [/^(sojadrink|mandeldrink)/, 1000, 'Packung', 'Packungen', '1 l', 1.6, 0],
  [/^(sojajoghurt|kokosjoghurt)/, 400, 'Becher', 'Becher', '400 g', 1.6, 0],
  [/^bier/, 500, 'Flasche', 'Flaschen', '500 ml', 1.0, 0],
  [/^(wei[sß]wein|rotwein)/, 750, 'Flasche', 'Flaschen', '750 ml', 5.0, 0],

  // Portionskaese
  [/^(mozzarella|burrata|camembert)/, 125, 'Packung', 'Packungen', '125 g', 1.3, 0],
  [/^(feta|paneer|schmelzk[aä]se)/, 200, 'Packung', 'Packungen', '200 g', 2.2, 0],
  [/^halloumi/, 225, 'Packung', 'Packungen', '225 g', 2.8, 0],
  [/^nacho-k[aä]sesauce/, 250, 'Glas', 'Gläser', '250 g', 2.5, 1],

  // Nuesse, Kerne, Mus
  [/^(erdnussbutter|mandelmus|tahin)/, 250, 'Glas', 'Gläser', '250 g', 4.0, 1],
  [/^(sesam|leinsamen|chiasamen|kokosraspel)/, 200, 'Packung', 'Packungen', '200 g', 2.2, 1],
  [/^(mandeln|walnüsse|haselnüsse|cashewkerne|erdnüsse|pistazien|pinienkerne|kürbiskerne)/, 200, 'Packung', 'Packungen', '200 g', 3.2, 0],
  [/^(rosinen|sultaninen|cranberries|preiselbeeren|berberitzen)/, 200, 'Packung', 'Packungen', '200 g', 2.2, 1],
];

function rawFactor(name) {
  const n = String(name || '').toLowerCase();
  for (const [re, f] of RAW_FACTOR) if (re.test(n)) return f;
  return 1;
}

function packFor(name) {
  const n = String(name || '').toLowerCase();
  for (const [re, size, unit, unitPl, sizeLabel, price, pantry] of PACKS) {
    if (re.test(n)) return { size, unit, unitPl, sizeLabel, price, pantry: !!pantry };
  }
  return null;
}

// Aus der benoetigten Menge (Kochgewicht) wird die tatsaechlich kaufbare Menge.
// Ohne Packungsregel bleibt es lose Ware, die man nach Gewicht kauft (Obst, Fleisch, Kaese).
function buyFor(cat, name, cookedG, pricePerKg) {
  const g = Math.max(0, Math.round(cookedG * rawFactor(name)));
  const p = packFor(name);
  if (!p) {
    const qty = g >= 1000 ? Math.round(g / 100) / 10 : g;
    return { qty, unit: g >= 1000 ? 'kg' : 'g', price: Math.round((g / 1000) * pricePerKg * 100) / 100, grams: g, pantry: false };
  }
  const packs = Math.max(1, Math.ceil(g / p.size));
  const label = packs === 1 ? p.unit : p.unitPl;
  const suffix = p.sizeLabel ? (packs === 1 ? ' (' + p.sizeLabel + ')' : ' (à ' + p.sizeLabel + ')') : '';
  return { qty: packs, unit: (label + suffix).slice(0, 48), price: Math.round(packs * p.price * 100) / 100, grams: g, pantry: p.pantry };
}

module.exports = { buyFor, packFor, rawFactor };

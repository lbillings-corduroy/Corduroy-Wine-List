const functions = require('firebase-functions');
const admin = require('firebase-admin');
const axios = require('axios');

admin.initializeApp();

const TOAST_API_URL = process.env.TOAST_API_URL || 'https://ws-api.toasttab.com';
const TOAST_CLIENT_ID = process.env.TOAST_CLIENT_ID;
const TOAST_CLIENT_SECRET = process.env.TOAST_CLIENT_SECRET;
const TOAST_RESTAURANT_GUID = process.env.TOAST_RESTAURANT_GUID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const WINE_MENU_GUID = '2d490bef-759b-447f-9af4-5bf0971948ba';
const BEER_MENU_GUID = 'ae7ea1cf-e85d-497a-a210-9a7271daa0ac';
const POURS_MENU_GUID = 'c07d9143-a7c5-497a-8434-2ab85d44ea48';

const EXCLUDE_KEYWORDS = ['cooking', 'cook wine', 'cork fee', 'wine dinner', 'liter'];

function shouldExclude(name) {
  const lower = name.toLowerCase();
  return EXCLUDE_KEYWORDS.some(k => lower.includes(k));
}

function cleanWineName(name) {
  return name
    .replace(/\s+Glass$/i, '')
    .replace(/\s+Bottle$/i, '')
    .replace(/\s+1L\s+Bottle$/i, '')
    .replace(/\s+1\s*Liter\s+Bottle$/i, '')
    .trim();
}

// ─── Toast Auth ───────────────────────────────────────────────────────────────

async function getToastToken() {
  const response = await axios.post(
    `${TOAST_API_URL}/authentication/v1/authentication/login`,
    { clientId: TOAST_CLIENT_ID, clientSecret: TOAST_CLIENT_SECRET, userAccessType: 'TOAST_MACHINE_CLIENT' },
    { headers: { 'Content-Type': 'application/json' } }
  );
  return response.data.token.accessToken;
}

async function getMenus(token) {
  const response = await axios.get(`${TOAST_API_URL}/menus/v2/menus`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Toast-Restaurant-External-ID': TOAST_RESTAURANT_GUID }
  });
  return response.data;
}

async function getStockData(token) {
  try {
    const response = await axios.get(`${TOAST_API_URL}/stock/v1/inventory`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Toast-Restaurant-External-ID': TOAST_RESTAURANT_GUID }
    });
    return response.data;
  } catch (e) {
    console.log('Stock unavailable:', e.message);
    return [];
  }
}

// ─── Generic Item Extraction (Beer, Pours, Cocktails) ────────────────────────

function findGroupByGuid(groups, guid) {
  for (const group of groups) {
    if (group.guid === guid) return group;
    if (group.menuGroups && group.menuGroups.length > 0) {
      const found = findGroupByGuid(group.menuGroups, guid);
      if (found) return found;
    }
  }
  return null;
}

function extractItemsFromMenu(menus, menuGuid, stockData) {
  const items = [];

  const stockMap = {};
  if (Array.isArray(stockData)) {
    stockData.forEach(item => { if (item.menuItem?.guid) stockMap[item.menuItem.guid] = item; });
  }

  function extractGroup(group, topGroup) {
    if (group.menuItems && group.menuItems.length > 0) {
      group.menuItems.forEach(item => {
        if (shouldExclude(item.name)) return;
        const stockInfo = stockMap[item.guid];
        const isHiddenByVisibility = Array.isArray(item.visibility) && item.visibility.length === 0;
        const isAvailable = (!stockInfo || stockInfo.status !== 'OUT_OF_STOCK') && !isHiddenByVisibility;
        if (!items.find(i => i.id === item.guid)) {
          items.push({
            id: item.guid,
            name: item.name,
            price: item.price || item.pricingRules?.[0]?.price || null,
            groupPrice: group.price || null,
            tier: topGroup,
            subgroup: group.name,
            available: isAvailable,
            description: item.description || null,
            toastImageUrl: item.image || item.images?.[0] || item.imageUrl || null,
            masterId: item.masterId
          });
        }
      });
    }
    if (group.menuGroups && group.menuGroups.length > 0) {
      group.menuGroups.forEach(sub => extractGroup(sub, topGroup));
    }
  }

  // First try: match as a top-level menu
  const menu = menus.menus.find(m => m.guid === menuGuid);
  if (menu) {
    if (menu.menuGroups) {
      menu.menuGroups.forEach(g => extractGroup(g, g.name));
    }
    return items;
  }

  // Fallback: search for it as a group inside any menu
  console.log(`Menu ${menuGuid} not found at top level — searching as group...`);
  for (const m of menus.menus) {
    const group = findGroupByGuid(m.menuGroups || [], menuGuid);
    if (group) {
      console.log(`Found group "${group.name}" inside menu "${m.name}"`);

      extractGroup(group, group.name);
      return items;
    }
  }

  console.log(`Menu/group ${menuGuid} not found anywhere`);
  return items;
}

// ─── Wine Extraction ──────────────────────────────────────────────────────────

function extractItemsFromGroup(group, stockMap, topTier, wines) {
  if (group.menuItems && group.menuItems.length > 0) {
    group.menuItems.forEach(item => {
      if (shouldExclude(item.name)) return;
      const stockInfo = stockMap[item.guid];
      // Toast marks items out of stock by clearing the visibility array to []
      const isHiddenByVisibility = Array.isArray(item.visibility) && item.visibility.length === 0;
      const isAvailable = (!stockInfo || stockInfo.status !== 'OUT_OF_STOCK') && !isHiddenByVisibility;
      // DEBUG: log visibility for wines that are NOT showing as hidden (to catch different OOS formats)
      if (item.name && item.name.toLowerCase().includes('chevalier')) {
        console.log(`OOS DEBUG "${item.name}": GUID=${item.guid} visibility=${JSON.stringify(item.visibility)} outOfStock=${item.outOfStock} isDeferred=${item.isDeferred} isHidden=${isHiddenByVisibility} isAvailable=${isAvailable}`);
      }
      if (!wines.find(w => w.id === item.guid)) {
        wines.push({
          id: item.guid,
          name: item.name,
          price: item.price || null,
          tier: topTier,
          subgroup: group.name,
          available: isAvailable,
          toastImageUrl: item.image || item.images?.[0] || item.imageUrl || null,
          masterId: item.masterId
        });
      }
    });
  }
  if (group.menuGroups && group.menuGroups.length > 0) {
    group.menuGroups.forEach(sub => extractItemsFromGroup(sub, stockMap, topTier, wines));
  }
}

function extractWines(menus, stockData) {
  const wines = [];
  const wineMenu = menus.menus.find(m => m.guid === WINE_MENU_GUID);
  if (!wineMenu) { console.log('Wine menu not found'); return wines; }
  const stockMap = {};
  if (Array.isArray(stockData)) {
    stockData.forEach(item => { if (item.menuItem?.guid) stockMap[item.menuItem.guid] = item; });
  }
  if (wineMenu.menuGroups) {
    wineMenu.menuGroups.forEach(g => extractItemsFromGroup(g, stockMap, g.name, wines));
  }
  return wines;
}

// ─── Smart Merge Glass/Bottle ─────────────────────────────────────────────────

function mergeGlassBottle(wines) {
  const merged = [];
  const processed = new Set();

  wines.forEach(wine => {
    if (processed.has(wine.id)) return;
    const isGlass = /\sGLASS$/i.test(wine.name);
    const isBottle = /\sBOTTLE$/i.test(wine.name) || /\s1L\sBOTTLE$/i.test(wine.name);

    if (isGlass || isBottle) {
      const baseName = cleanWineName(wine.name);
      const pair = wines.find(w =>
        w.id !== wine.id &&
        !processed.has(w.id) &&
        cleanWineName(w.name) === baseName &&
        (/\sGLASS$/i.test(w.name) || /\sBOTTLE$/i.test(w.name) || /\s1L\sBOTTLE$/i.test(w.name))
      );

      let glassPrice = null;
      let bottlePrice = null;
      let primaryId = wine.id;
      // If either glass or bottle is OOS, the merged wine is OOS
      let mergedAvailable = wine.available;

      if (isGlass) {
        glassPrice = wine.price;
        if (pair) {
          bottlePrice = pair.price;
          processed.add(pair.id);
          primaryId = pair.id;
          mergedAvailable = wine.available !== false && pair.available !== false;
        }
      } else {
        bottlePrice = wine.price;
        primaryId = wine.id;
        if (pair) {
          glassPrice = pair.price;
          processed.add(pair.id);
          mergedAvailable = wine.available !== false && pair.available !== false;
        }
      }

      processed.add(wine.id);
      merged.push({
        id: primaryId, name: baseName, glassPrice, bottlePrice,
        tier: wine.tier, subgroup: wine.subgroup, available: mergedAvailable,
        toastImageUrl: wine.toastImageUrl || null, masterId: wine.masterId
      });
    } else {
      processed.add(wine.id);
      merged.push({ ...wine, glassPrice: null, bottlePrice: wine.price, price: null });
    }
  });

  console.log(`Merged: ${wines.length} raw → ${merged.length} wines`);
  return merged;
}

// ─── Vintage Parser ───────────────────────────────────────────────────────────

function parseVintage(name) {
  const match = name.match(/\b(19|20)\d{2}\b/);
  return match ? parseInt(match[0]) : null;
}

// ─── Varietal Normalizer ──────────────────────────────────────────────────────

const VARIETAL_MAP = {
  'cabernet sauvignon': 'Cabernet Sauvignon', 'cabernet': 'Cabernet Sauvignon',
  'pinot noir': 'Pinot Noir', 'chardonnay': 'Chardonnay', 'merlot': 'Merlot',
  'malbec': 'Malbec', 'sauvignon blanc': 'Sauvignon Blanc', 'pinot grigio': 'Pinot Grigio',
  'pinot gris': 'Pinot Grigio', 'riesling': 'Riesling', 'moscato': 'Moscato',
  'prosecco': 'Prosecco', 'champagne': 'Champagne', 'sparkling': 'Sparkling',
  'rosé': 'Rosé', 'rose': 'Rosé', 'port': 'Port', 'tawny': 'Port',
  'zinfandel': 'Zinfandel', 'shiraz': 'Shiraz', 'syrah': 'Shiraz',
  'viognier': 'Viognier', 'albarino': 'Albariño', 'albariño': 'Albariño',
  'chianti': 'Sangiovese', 'sangiovese': 'Sangiovese', 'tempranillo': 'Tempranillo',
  'garnacha': 'Grenache', 'grenache': 'Grenache', 'red blend': 'Red Blend',
  'bordeaux blend': 'Bordeaux Blend', 'rhône blend': 'Red Blend', 'gsm blend': 'Red Blend',
  'gsm': 'Red Blend', 'white blend': 'White Blend', 'sparkling blend': 'Sparkling',
  'port blend': 'Port', 'fortified': 'Port',
};

function normalizeVarietal(raw) {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();
  if (VARIETAL_MAP[lower]) return VARIETAL_MAP[lower];
  for (const [key, val] of Object.entries(VARIETAL_MAP)) {
    if (lower.includes(key)) return val;
  }
  if (lower.includes('/') || lower.includes(',') || lower.includes('&')) {
    if (lower.includes('white') || lower.includes('blanc') || lower.includes('chardonnay') || lower.includes('viognier')) return 'White Blend';
    return 'Red Blend';
  }
  const words = raw.split(' ');
  return words.length <= 3 ? raw : 'Red Blend';
}

// ─── Claude Enrichment — Wine ─────────────────────────────────────────────────

async function enrichWineWithClaude(wineName, vintage) {
  if (!ANTHROPIC_API_KEY) return null;
  const vintageNote = vintage ? `The vintage is ${vintage}.` : 'This is a house pour with no specific vintage.';
  const prompt = `You are a professional sommelier and wine data expert. I need accurate information about this wine for a restaurant iPad wine list.

Wine: "${wineName}"
${vintageNote}

Tasks:
1. Identify the correct wine (fix any spelling/capitalization errors in the name)
2. If you are uncertain what wine this is, set "uncertain" to true

Respond in JSON only (no other text):
{
  "correctedName": "properly spelled and capitalized wine name, or same as input if correct",
  "uncertain": false,
  "uncertainReason": null,
  "varietal": "PRIMARY grape only — use ONE of these exact values: Cabernet Sauvignon, Pinot Noir, Chardonnay, Merlot, Malbec, Sauvignon Blanc, Pinot Grigio, Riesling, Moscato, Prosecco, Champagne, Sparkling, Rosé, Port, Zinfandel, Shiraz, Viognier, Albariño, Sangiovese, Tempranillo, Grenache, Red Blend, Bordeaux Blend, White Blend. Pick the single closest match.",
  "region": "concise region and country, e.g. Napa Valley, California",
  "description": "2-3 sentence sommelier tasting note for a restaurant guest. Be evocative and appetizing.",
  "reviews": "notable critic scores if known, e.g. 92pts Wine Spectator, or null",
  "labelImageQuery": "Google image search query for a clean flat label image (not bottle), e.g. Duckhorn Merlot 2022 label"
}`;

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-sonnet-4-6', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] },
      { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );
    const text = response.data.content[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    const data = JSON.parse(clean);
    data.varietal = normalizeVarietal(data.varietal);
    return data;
  } catch (e) {
    console.error(`Claude enrichment failed for ${wineName}:`, e.message);
    return null;
  }
}

// ─── Claude Enrichment — Beer ─────────────────────────────────────────────────

async function enrichBeerWithClaude(beerName) {
  if (!ANTHROPIC_API_KEY) return null;
  const prompt = `You are a craft beer expert. I need accurate information about this beer for a restaurant menu app.

Beer: "${beerName}"

Respond in JSON only (no other text):
{
  "correctedName": "properly spelled and capitalized beer name, or same as input if correct",
  "uncertain": false,
  "uncertainReason": null,
  "style": "beer style, e.g. IPA, Lager, Stout, Wheat, Pale Ale, Pilsner, Sour, Porter",
  "brewery": "brewery name and location, e.g. Sierra Nevada, Chico CA",
  "abv": "ABV if known, e.g. 5.6%, or null",
  "description": "2 sentence tasting note — approachable, appetizing, guest-friendly.",
  "imageQuery": "Google image search query for this beer can or bottle label, e.g. Sierra Nevada Torpedo IPA can"
}`;

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-sonnet-4-6', max_tokens: 600, messages: [{ role: 'user', content: prompt }] },
      { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );
    const text = response.data.content[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error(`Beer enrichment failed for ${beerName}:`, e.message);
    return null;
  }
}

// ─── Claude Enrichment — Premium Pours ───────────────────────────────────────

async function enrichPourWithClaude(pourName) {
  if (!ANTHROPIC_API_KEY) return null;
  const prompt = `You are a spirits expert. I need accurate information about this spirit for a restaurant premium pours menu.

Spirit: "${pourName}"

Respond in JSON only (no other text):
{
  "correctedName": "properly spelled and capitalized spirit name, or same as input if correct",
  "uncertain": false,
  "uncertainReason": null,
  "category": "spirit category, e.g. Bourbon, Scotch, Rye Whiskey, Tequila, Mezcal, Rum, Gin, Vodka, Cognac, Brandy",
  "producer": "distillery or producer name and region, e.g. Buffalo Trace, Frankfort KY",
  "abv": "ABV if known, e.g. 45%, or null",
  "age": "age statement if known, e.g. 12 Year, or null",
  "description": "2 sentence tasting note — evocative, guest-friendly, suitable for a premium bar menu.",
  "imageQuery": "Google image search query for this spirit bottle label, e.g. Buffalo Trace Bourbon bottle"
}`;

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-sonnet-4-6', max_tokens: 600, messages: [{ role: 'user', content: prompt }] },
      { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );
    const text = response.data.content[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error(`Pour enrichment failed for ${pourName}:`, e.message);
    return null;
  }
}

// ─── Main Wine Sync ───────────────────────────────────────────────────────────

exports.syncWineMenu = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .pubsub.schedule('every 30 minutes')
  .onRun(async (context) => {
    try {
      console.log('Starting Toast API sync...');
      const token = await getToastToken();
      const menus = await getMenus(token);
      const stockData = await getStockData(token);
      const rawWines = extractWines(menus, stockData);
      const freshWines = mergeGlassBottle(rawWines);

      const db = admin.database();
      const enrichmentSnap = await db.ref('wineEnrichment').once('value');
      const existingEnrichment = enrichmentSnap.val() || {};

      await db.ref('wines').remove();
      const winesById = {};
      freshWines.forEach(w => { winesById[w.id] = w; });
      await db.ref('wines').set(winesById);
      await db.ref('wineOrder').set(freshWines.map(w => w.id));
      await db.ref('lastUpdated').set(Date.now());
      console.log(`Saved ${freshWines.length} merged wines`);

      const toEnrich = freshWines.filter(w => {
        const existing = existingEnrichment[w.id];
        if (!existing) return true;
        // Re-enrich if name changed (clears approved/manuallyEdited via full .set())
        if (!existing.sourceName || existing.sourceName !== w.name) return true;
        // Skip if manager has manually edited this wine
        if (existing.manuallyEdited) return false;
        return false;
      });
      let enrichedCount = 0;

      for (const wine of toEnrich) {
        const vintage = parseVintage(wine.name);
        const enrichment = await enrichWineWithClaude(wine.name, vintage);
        if (enrichment) {
          await db.ref(`wineEnrichment/${wine.id}`).set({
            sourceName: wine.name,
            correctedName: enrichment.correctedName || wine.name,
            uncertain: enrichment.uncertain || false,
            uncertainReason: enrichment.uncertainReason || null,
            varietal: enrichment.varietal || null,
            region: enrichment.region || null,
            description: enrichment.description || null,
            reviews: enrichment.reviews || null,
            labelImageQuery: enrichment.labelImageQuery || null,
            vintage: vintage,
            enrichedAt: Date.now()
          });
          enrichedCount++;
          if (enrichment.uncertain) console.log(`⚠️ UNCERTAIN: ${wine.name} — ${enrichment.uncertainReason}`);
        }
        await new Promise(r => setTimeout(r, 500));
      }

      console.log(`Wine enrichment complete — ${enrichedCount} wines enriched`);
      return null;
    } catch (error) {
      console.error('Sync error:', error.message);
      if (error.response) console.error('API response:', JSON.stringify(error.response.data));
      return null;
    }
  });

// ─── Beer Sync ────────────────────────────────────────────────────────────────

exports.syncBeerMenu = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .pubsub.schedule('every 30 minutes')
  .onRun(async (context) => {
    try {
      console.log('Starting Beer menu sync...');
      const token = await getToastToken();
      const menus = await getMenus(token);
      const stockData = await getStockData(token);
      const freshBeers = extractItemsFromMenu(menus, BEER_MENU_GUID, stockData);

      const db = admin.database();
      const enrichmentSnap = await db.ref('beerEnrichment').once('value');
      const existingEnrichment = enrichmentSnap.val() || {};

      await db.ref('beers').remove();
      const beersById = {};
      freshBeers.forEach(b => { beersById[b.id] = b; });
      await db.ref('beers').set(beersById);
      await db.ref('beerOrder').set(freshBeers.map(b => b.id));
      await db.ref('beerLastUpdated').set(Date.now());
      console.log(`Saved ${freshBeers.length} beers`);

      const toEnrich = freshBeers.filter(b => {
        const existing = existingEnrichment[b.id];
        if (!existing) return true;
        if (!existing.sourceName || existing.sourceName !== b.name) return true;
        if (existing.manuallyEdited) return false;
        return false;
      });
      let enrichedCount = 0;

      for (const beer of toEnrich) {
        const enrichment = await enrichBeerWithClaude(beer.name);
        if (enrichment) {
          await db.ref(`beerEnrichment/${beer.id}`).set({
            sourceName: beer.name,
            correctedName: enrichment.correctedName || beer.name,
            uncertain: enrichment.uncertain || false,
            uncertainReason: enrichment.uncertainReason || null,
            style: enrichment.style || null,
            brewery: enrichment.brewery || null,
            abv: enrichment.abv || null,
            description: enrichment.description || null,
            imageQuery: enrichment.imageQuery || null,
            enrichedAt: Date.now()
          });
          enrichedCount++;
        }
        await new Promise(r => setTimeout(r, 500));
      }

      console.log(`Beer enrichment complete — ${enrichedCount} beers enriched`);
      return null;
    } catch (error) {
      console.error('Beer sync error:', error.message);
      return null;
    }
  });

// ─── Premium Pours Sync ───────────────────────────────────────────────────────

exports.syncPoursMenu = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .pubsub.schedule('every 30 minutes')
  .onRun(async (context) => {
    try {
      console.log('Starting Premium Pours sync...');
      const token = await getToastToken();
      const menus = await getMenus(token);
      const stockData = await getStockData(token);
      const freshPours = extractItemsFromMenu(menus, POURS_MENU_GUID, stockData);

      const db = admin.database();
      const enrichmentSnap = await db.ref('poursEnrichment').once('value');
      const existingEnrichment = enrichmentSnap.val() || {};

      await db.ref('pours').remove();
      const poursById = {};
      freshPours.forEach(p => { poursById[p.id] = p; });
      await db.ref('pours').set(poursById);
      await db.ref('poursOrder').set(freshPours.map(p => p.id));
      await db.ref('poursLastUpdated').set(Date.now());
      console.log(`Saved ${freshPours.length} pours`);

      const toEnrich = freshPours.filter(p => {
        const existing = existingEnrichment[p.id];
        if (!existing) return true;
        if (!existing.sourceName || existing.sourceName !== p.name) return true;
        if (existing.manuallyEdited) return false;
        return false;
      });
      let enrichedCount = 0;

      for (const pour of toEnrich) {
        const enrichment = await enrichPourWithClaude(pour.name);
        if (enrichment) {
          await db.ref(`poursEnrichment/${pour.id}`).set({
            sourceName: pour.name,
            correctedName: enrichment.correctedName || pour.name,
            uncertain: enrichment.uncertain || false,
            uncertainReason: enrichment.uncertainReason || null,
            category: enrichment.category || null,
            producer: enrichment.producer || null,
            abv: enrichment.abv || null,
            age: enrichment.age || null,
            description: enrichment.description || null,
            imageQuery: enrichment.imageQuery || null,
            enrichedAt: Date.now()
          });
          enrichedCount++;
        }
        await new Promise(r => setTimeout(r, 500));
      }

      console.log(`Pours enrichment complete — ${enrichedCount} pours enriched`);
      return null;
    } catch (error) {
      console.error('Pours sync error:', error.message);
      return null;
    }
  });

// ─── HTTP Endpoint — Wines ────────────────────────────────────────────────────

exports.getWines = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const db = admin.database();
    const [winesSnap, enrichmentSnap, lastUpdatedSnap, wineOrderSnap] = await Promise.all([
      db.ref('wines').once('value'),
      db.ref('wineEnrichment').once('value'),
      db.ref('lastUpdated').once('value'),
      db.ref('wineOrder').once('value')
    ]);

    const winesById = winesSnap.val() || {};
    const wineOrder = wineOrderSnap.val() || [];
    const enrichment = enrichmentSnap.val() || {};
    const lastUpdated = lastUpdatedSnap.val();

    const orderedWines = wineOrder.length > 0
      ? wineOrder.map(id => winesById[id]).filter(Boolean)
      : Object.values(winesById);

    const mergedWines = orderedWines.map(wine => {
      const e = enrichment[wine.id] || {};
      return {
        ...wine,
        name: e.correctedName || wine.name,
        imageUrl: wine.toastImageUrl || null,
        varietal: e.varietal || null,
        region: e.region || null,
        description: e.description || null,
        reviews: e.reviews || null,
        labelImageQuery: e.labelImageQuery || null,
        vintage: e.vintage || null,
        uncertain: e.uncertain || false,
        uncertainReason: e.uncertainReason || null,
      };
    });

    res.json({ wines: mergedWines, lastUpdated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── HTTP Endpoint — Beers ────────────────────────────────────────────────────

exports.getBeers = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const db = admin.database();
    const [beersSnap, enrichmentSnap, lastUpdatedSnap, orderSnap] = await Promise.all([
      db.ref('beers').once('value'),
      db.ref('beerEnrichment').once('value'),
      db.ref('beerLastUpdated').once('value'),
      db.ref('beerOrder').once('value')
    ]);

    const beersById = beersSnap.val() || {};
    const beerOrder = orderSnap.val() || [];
    const enrichment = enrichmentSnap.val() || {};
    const lastUpdated = lastUpdatedSnap.val();

    const ordered = beerOrder.length > 0
      ? beerOrder.map(id => beersById[id]).filter(Boolean)
      : Object.values(beersById);

    const merged = ordered.map(beer => {
      const e = enrichment[beer.id] || {};
      // Use item price, fall back to group inherited price
      const price = beer.price || beer.groupPrice || null;
      return {
        ...beer,
        name: e.correctedName || beer.name,
        price,
        imageUrl: beer.toastImageUrl || null,
        style: e.style || null,
        brewery: e.brewery || null,
        abv: e.abv || null,
        description: e.description || null,
        uncertain: e.uncertain || false,
        uncertainReason: e.uncertainReason || null,
      };
    });

    res.json({ beers: merged, lastUpdated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── HTTP Endpoint — Premium Pours ───────────────────────────────────────────

exports.getPours = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const db = admin.database();
    const [poursSnap, enrichmentSnap, lastUpdatedSnap, orderSnap] = await Promise.all([
      db.ref('pours').once('value'),
      db.ref('poursEnrichment').once('value'),
      db.ref('poursLastUpdated').once('value'),
      db.ref('poursOrder').once('value')
    ]);

    const poursById = poursSnap.val() || {};
    const poursOrder = orderSnap.val() || [];
    const enrichment = enrichmentSnap.val() || {};
    const lastUpdated = lastUpdatedSnap.val();

    const ordered = poursOrder.length > 0
      ? poursOrder.map(id => poursById[id]).filter(Boolean)
      : Object.values(poursById);

    const merged = ordered.map(pour => {
      const e = enrichment[pour.id] || {};
      const price = pour.price || pour.groupPrice || null;
      return {
        ...pour,
        name: e.correctedName || pour.name,
        price,
        imageUrl: pour.toastImageUrl || null,
        category: e.category || null,
        producer: e.producer || null,
        abv: e.abv || null,
        age: e.age || null,
        description: e.description || null,
        uncertain: e.uncertain || false,
        uncertainReason: e.uncertainReason || null,
      };
    });

    res.json({ pours: merged, lastUpdated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Manual Enrichment Trigger ────────────────────────────────────────────────

exports.triggerEnrichment = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    try {
      const db = admin.database();
      const winesSnap = await db.ref('wines').once('value');
      const wines = winesSnap.val();
      const wineList = Array.isArray(wines) ? wines : Object.values(wines || {});

      const enrichmentSnap = await db.ref('wineEnrichment').once('value');
      const existingEnrichment = enrichmentSnap.val() || {};

      // LIMITED TO 3 FOR TESTING — remove .slice(0, 3) to enrich all wines
      const toEnrich = wineList.filter(w => !existingEnrichment[w.id]).slice(0, 3);
      console.log(`${toEnrich.length} wines to enrich (test mode — max 3)`);

      let enrichedCount = 0;
      const uncertain = [];

      for (const wine of toEnrich) {
        const vintage = parseVintage(wine.name);
        const enrichment = await enrichWineWithClaude(wine.name, vintage);
        if (enrichment) {
          await db.ref(`wineEnrichment/${wine.id}`).set({
            correctedName: enrichment.correctedName || wine.name,
            uncertain: enrichment.uncertain || false,
            uncertainReason: enrichment.uncertainReason || null,
            varietal: enrichment.varietal || null,
            region: enrichment.region || null,
            description: enrichment.description || null,
            reviews: enrichment.reviews || null,
            labelImageQuery: enrichment.labelImageQuery || null,
            vintage: vintage,
            enrichedAt: Date.now()
          });
          enrichedCount++;
          if (enrichment.uncertain) uncertain.push({ name: wine.name, reason: enrichment.uncertainReason });
          console.log(`✓ ${wine.name} → ${enrichment.correctedName} (${enrichment.varietal})`);
        }
        await new Promise(r => setTimeout(r, 500));
      }

      res.json({
        message: 'Test enrichment complete',
        enriched: enrichedCount,
        alreadyEnriched: wineList.length - wineList.filter(w => !existingEnrichment[w.id]).length,
        total: wineList.length,
        uncertainWines: uncertain,
        note: 'Remove .slice(0, 3) to enrich all wines'
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

// ─── Food Menu Constants ──────────────────────────────────────────────────────

const FOOD_GROUPS = [
  { name: 'Soups & Salads', guid: 'c12bef8f-e3e0-4a50-8007-7edaddd2f4a2' },
  { name: 'Starters',       guid: '17cc57c6-8192-42bb-82a4-7a873b2dcf67' },
  { name: 'Entrees',        guid: '05bad67c-e484-4cca-91a9-59f11ac42628' },
];

// ─── Food Extraction ──────────────────────────────────────────────────────────

function extractFoodItems(menus, stockData) {
  const stockMap = {};
  if (Array.isArray(stockData)) {
    stockData.forEach(item => { if (item.menuItem?.guid) stockMap[item.menuItem.guid] = item; });
  }

  const allItems = [];

  for (const { name: courseName, guid } of FOOD_GROUPS) {
    // Search all menus for this group GUID
    let group = null;
    for (const menu of menus.menus) {
      group = findGroupByGuid(menu.menuGroups || [], guid);
      if (group) break;
    }

    if (!group) {
      console.log(`Food group "${courseName}" (${guid}) not found`);
      continue;
    }

    // Recursively collect all items from this group and its sub-groups
    function collectItems(g) {
      if (g.menuItems && g.menuItems.length > 0) {
        g.menuItems.forEach(item => {
          const price = item.price || null;
          // Skip zero-price course markers
          if (!price || price === 0) return;
          // Skip out of stock — check both stock inventory API and item's own outOfStock flag
          const stockInfo = stockMap[item.guid];
          if (stockInfo && stockInfo.status === 'OUT_OF_STOCK') return;
          // Toast marks out of stock by clearing visibility to []
          if (Array.isArray(item.visibility) && item.visibility.length === 0) return;
          // Avoid duplicates
          if (allItems.find(i => i.id === item.guid)) return;

          allItems.push({
            id: item.guid,
            name: item.name,
            price,
            course: courseName,
            description: item.description || null,
            available: true,
          });
        });
      }
      if (g.menuGroups && g.menuGroups.length > 0) {
        g.menuGroups.forEach(sub => collectItems(sub));
      }
    }

    collectItems(group);
    console.log(`Food group "${courseName}" — found ${allItems.filter(i => i.course === courseName).length} items`);
  }

  return allItems;
}

// ─── Food Menu Sync ───────────────────────────────────────────────────────────

exports.syncFoodMenu = functions
  .runWith({ timeoutSeconds: 120, memory: '256MB' })
  .pubsub.schedule('every 30 minutes')
  .onRun(async (context) => {
    try {
      console.log('Starting Food menu sync...');
      const token = await getToastToken();
      const menus = await getMenus(token);
      const stockData = await getStockData(token);
      const freshItems = extractFoodItems(menus, stockData);

      const db = admin.database();
      const foodById = {};
      freshItems.forEach(item => { foodById[item.id] = item; });
      await db.ref('foodItems').set(foodById);
      await db.ref('foodOrder').set(freshItems.map(i => i.id));
      await db.ref('foodLastUpdated').set(Date.now());

      console.log(`Food sync complete — saved ${freshItems.length} items`);
      return null;
    } catch (error) {
      console.error('Food sync error:', error.message);
      return null;
    }
  });

// ─── HTTP Endpoint — Food Items ───────────────────────────────────────────────

exports.getFoodItems = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const db = admin.database();
    const [foodSnap, orderSnap, lastUpdatedSnap] = await Promise.all([
      db.ref('foodItems').once('value'),
      db.ref('foodOrder').once('value'),
      db.ref('foodLastUpdated').once('value'),
    ]);

    const foodById = foodSnap.val() || {};
    const foodOrder = orderSnap.val() || [];
    const lastUpdated = lastUpdatedSnap.val();

    const ordered = foodOrder.length > 0
      ? foodOrder.map(id => foodById[id]).filter(Boolean)
      : Object.values(foodById);

    res.json({ foodItems: ordered, lastUpdated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Sommelier Pairing Endpoint ───────────────────────────────────────────────

exports.getPairing = functions
  .runWith({ timeoutSeconds: 60, memory: '256MB' })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).send('');

    try {
      const { type, itemId } = req.body;
      const db = admin.database();

      // ── Wine → Food ───────────────────────────────────────────────────────
      if (type === 'wine_to_food') {
        const [wineSnap, enrichSnap, foodSnap] = await Promise.all([
          db.ref(`wines/${itemId}`).once('value'),
          db.ref(`wineEnrichment/${itemId}`).once('value'),
          db.ref('foodItems').once('value'),
        ]);
        const wine = wineSnap.val();
        if (!wine) return res.status(404).json({ error: 'Wine not found' });
        const enrich = enrichSnap.val() || {};
        const foodItems = Object.values(foodSnap.val() || {});

        const wineName = enrich.correctedName || wine.name;
        const foodList = foodItems
          .map(f => `- ${f.name} (${f.course})${f.description ? ': ' + f.description : ''}`)
          .join('\n');

        const excludeDishes = req.body.excludeDishes || [];
        const excludeNote = excludeDishes.length > 0
          ? `\n\nIMPORTANT: Do NOT suggest these dishes — the guest has already seen them: ${excludeDishes.join(', ')}. Choose different dishes if at all possible.`
          : '';

        const prompt = `You are the sommelier at Appalachia Kitchen, an upscale mountain restaurant at Corduroy Inn & Lodge on Snowshoe Mountain, West Virginia. A guest is considering this wine:

Wine: ${wineName}${enrich.varietal ? `\nVarietal: ${enrich.varietal}` : ''}${enrich.region ? `\nRegion: ${enrich.region}` : ''}${enrich.description ? `\nTasting notes: ${enrich.description}` : ''}

From our current menu, suggest exactly 2-3 dishes that pair beautifully with this wine. Choose ONLY from this list:
${foodList}${excludeNote}

Respond in JSON only (no other text):
{"pairings":[{"name":"exact dish name","course":"course name","reason":"one evocative sentence why this pairing works"}]}`;

        const response = await axios.post(
          'https://api.anthropic.com/v1/messages',
          { model: 'claude-sonnet-4-6', max_tokens: 600, messages: [{ role: 'user', content: prompt }] },
          { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
        );
        const text = response.data.content[0].text;
        const result = JSON.parse(text.replace(/```json|```/g, '').trim());
        return res.json(result);
      }

      // ── Food → Wine ───────────────────────────────────────────────────────
      if (type === 'food_to_wine') {
        const [foodSnap, winesSnap, enrichSnap] = await Promise.all([
          db.ref(`foodItems/${itemId}`).once('value'),
          db.ref('wines').once('value'),
          db.ref('wineEnrichment').once('value'),
        ]);
        const food = foodSnap.val();
        if (!food) return res.status(404).json({ error: 'Food item not found' });

        const winesById = winesSnap.val() || {};
        const enrichment = enrichSnap.val() || {};

        // Sort wines by price and split into thirds so tiers reflect actual prices
        const wineObjects = Object.values(winesById)
          .filter(w => (w.bottlePrice || w.glassPrice) && w.available !== false)
          .map(w => {
            const e = enrichment[w.id] || {};
            return {
              id: w.id,
              name: e.correctedName || w.name,
              varietal: e.varietal || null,
              region: e.region || null,
              glassPrice: w.glassPrice || null,
              bottlePrice: w.bottlePrice || null,
              toastImageUrl: w.toastImageUrl || null,
              sortPrice: w.bottlePrice || w.glassPrice || 0
            };
          })
          .sort((a, b) => a.sortPrice - b.sortPrice);

        const third = Math.ceil(wineObjects.length / 3);
        const tierGroups = {
          'Value': wineObjects.slice(0, third),
          'Mid-Range': wineObjects.slice(third, third * 2),
          'Premium': wineObjects.slice(third * 2)
        };

        const formatWine = w => {
          const prices = [];
          if (w.glassPrice) prices.push(`glass $${Math.round(w.glassPrice)}`);
          if (w.bottlePrice) prices.push(`bottle $${Math.round(w.bottlePrice)}`);
          return `- ID:${w.id} | ${w.name}${w.varietal ? ` (${w.varietal})` : ''}${w.region ? `, ${w.region}` : ''} | ${prices.join(', ')}`;
        };

        const wineListByTier = Object.entries(tierGroups)
          .map(([tier, ws]) => `${tier.toUpperCase()} WINES (pick one from this section for the ${tier} recommendation):\n${ws.map(formatWine).join('\n')}`)
          .join('\n\n');

        const excludeWineIds = req.body.excludeWineIds || {};
        const excludeLines = Object.entries(excludeWineIds)
          .map(([level, id]) => {
            const w = wineObjects.find(w => w.id === id);
            return w ? `${level}: ${w.name}` : null;
          }).filter(Boolean);
        const excludeNote = excludeLines.length > 0
          ? `\n\nIMPORTANT: The guest has already seen these — choose DIFFERENT wines for each tier if at all possible:\n${excludeLines.join('\n')}`
          : '';

        const prompt = `You are the sommelier at Appalachia Kitchen, an upscale mountain restaurant at Corduroy Inn & Lodge on Snowshoe Mountain, West Virginia. A guest is ordering:

Dish: ${food.name}${food.description ? `\nDescription: ${food.description}` : ''}
Course: ${food.course}

Suggest exactly three wines that pair beautifully with this dish — one from each price tier below. You MUST pick from the correct section for each tier.
${wineListByTier}${excludeNote}

Respond in JSON only (no other text):
{"pairings":[{"level":"Value","id":"wine-id","name":"wine name","varietal":"varietal","region":"region","glassPrice":null,"bottlePrice":null,"reason":"one evocative sentence"},{"level":"Mid-Range",...},{"level":"Premium",...}]}`;

        const response = await axios.post(
          'https://api.anthropic.com/v1/messages',
          { model: 'claude-sonnet-4-6', max_tokens: 800, messages: [{ role: 'user', content: prompt }] },
          { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
        );
        const text = response.data.content[0].text;
        const result = JSON.parse(text.replace(/```json|```/g, '').trim());
        // Enrich pairings with image URLs and verified prices from our data
        const enrichedPairings = (result.pairings || []).map(p => {
          const w = wineObjects.find(wo => wo.id === p.id);
          return {
            ...p,
            imageUrl: w ? (w.toastImageUrl || null) : null,
            glassPrice: w ? w.glassPrice : p.glassPrice,
            bottlePrice: w ? w.bottlePrice : p.bottlePrice,
          };
        });
        return res.json({ pairings: enrichedPairings });
      }


      // ── Drink → Food (Beer & Pours) ──────────────────────────────────────
      if (type === 'drink_to_food') {
        const { itemName, itemDescription, itemStyle, itemCategory, itemABV, excludeDishes = [] } = req.body;
        const foodSnap = await db.ref('foodItems').once('value');
        const foodItems = Object.values(foodSnap.val() || {}).filter(f => !f.excluded);
        const foodList = foodItems
          .map(f => `- ${f.name} (${f.course})${f.description ? ': ' + f.description : ''}`)
          .join('\n');
        const drinkDesc = [itemStyle || itemCategory, itemABV ? `${itemABV} ABV` : null, itemDescription].filter(Boolean).join(' · ');
        const excludeNote = excludeDishes.length > 0
          ? `\n\nIMPORTANT: Do NOT suggest these dishes — the guest has already seen them: ${excludeDishes.join(', ')}. Choose different dishes if at all possible.`
          : '';

        const prompt = `You are the sommelier at Appalachia Kitchen, an upscale mountain restaurant at Corduroy Inn & Lodge on Snowshoe Mountain, West Virginia. A guest is considering:

Drink: ${itemName}${drinkDesc ? `\nDetails: ${drinkDesc}` : ''}

From our current menu, suggest exactly 2-3 dishes that pair beautifully with this drink. Choose ONLY from this list:
${foodList}${excludeNote}

Respond in JSON only (no other text):
{"pairings":[{"name":"exact dish name","course":"course name","reason":"one evocative sentence why this pairing works"}]}`;

        const response = await axios.post(
          'https://api.anthropic.com/v1/messages',
          { model: 'claude-sonnet-4-6', max_tokens: 600, messages: [{ role: 'user', content: prompt }] },
          { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
        );
        const text = response.data.content[0].text;
        const result = JSON.parse(text.replace(/```json|```/g, '').trim());
        return res.json(result);
      }

      return res.status(400).json({ error: 'Invalid type' });
    } catch (error) {
      console.error('Pairing error:', error.message);
      return res.status(500).json({ error: error.message });
    }
  });

// ─── Food Item Exclusion ──────────────────────────────────────────────────────

exports.setFoodExclusion = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  try {
    const { itemId, excluded } = req.body;
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    const db = admin.database();
    await db.ref(`foodItems/${itemId}/excluded`).set(excluded === true);
    res.json({ ok: true, itemId, excluded });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Specialty Cocktails Sync ─────────────────────────────────────────────────

const COCKTAILS_MENU_GUID = '5c973234-da58-48e7-8f12-86888abd0563';
const NAB_MENU_GUID = 'fa091def-5bc2-434e-a436-64b29ce7932f';

exports.syncCocktailsMenu = functions
  .runWith({ timeoutSeconds: 120, memory: '256MB' })
  .pubsub.schedule('every 30 minutes')
  .onRun(async (context) => {
    try {
      console.log('Starting Specialty Cocktails sync...');
      const token = await getToastToken();
      const menus = await getMenus(token);
      const stockData = await getStockData(token);
      const freshItems = extractItemsFromMenu(menus, COCKTAILS_MENU_GUID, stockData);

      const db = admin.database();
      const itemsById = {};
      freshItems.forEach(i => { itemsById[i.id] = i; });
      await db.ref('cocktails').set(itemsById);
      await db.ref('cocktailsOrder').set(freshItems.map(i => i.id));
      await db.ref('cocktailsLastUpdated').set(Date.now());
      console.log(`Cocktails sync complete — saved ${freshItems.length} items`);
      return null;
    } catch (error) {
      console.error('Cocktails sync error:', error.message);
      return null;
    }
  });

exports.getCocktails = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const db = admin.database();
    const [snap, orderSnap, lastUpdatedSnap] = await Promise.all([
      db.ref('cocktails').once('value'),
      db.ref('cocktailsOrder').once('value'),
      db.ref('cocktailsLastUpdated').once('value'),
    ]);
    const byId = snap.val() || {};
    const order = orderSnap.val() || [];
    const ordered = order.length > 0 ? order.map(id => byId[id]).filter(Boolean) : Object.values(byId);
    res.json({ cocktails: ordered.map(i => ({ ...i, imageUrl: i.toastImageUrl || null })), lastUpdated: lastUpdatedSnap.val() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Non-Alcoholic Beverages Sync ────────────────────────────────────────────

exports.syncNABMenu = functions
  .runWith({ timeoutSeconds: 120, memory: '256MB' })
  .pubsub.schedule('every 30 minutes')
  .onRun(async (context) => {
    try {
      console.log('Starting Non-Alcoholic Beverages sync...');
      const token = await getToastToken();
      const menus = await getMenus(token);
      const stockData = await getStockData(token);
      const freshItems = extractItemsFromMenu(menus, NAB_MENU_GUID, stockData);

      const db = admin.database();
      const itemsById = {};
      freshItems.forEach(i => { itemsById[i.id] = i; });
      await db.ref('nab').set(itemsById);
      await db.ref('nabOrder').set(freshItems.map(i => i.id));
      await db.ref('nabLastUpdated').set(Date.now());
      console.log(`NAB sync complete — saved ${freshItems.length} items`);
      return null;
    } catch (error) {
      console.error('NAB sync error:', error.message);
      return null;
    }
  });

exports.getNAB = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const db = admin.database();
    const [snap, orderSnap, lastUpdatedSnap] = await Promise.all([
      db.ref('nab').once('value'),
      db.ref('nabOrder').once('value'),
      db.ref('nabLastUpdated').once('value'),
    ]);
    const byId = snap.val() || {};
    const order = orderSnap.val() || [];
    const ordered = order.length > 0 ? order.map(id => byId[id]).filter(Boolean) : Object.values(byId);
    res.json({ nab: ordered.map(i => ({ ...i, imageUrl: i.toastImageUrl || null })), lastUpdated: lastUpdatedSnap.val() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Manager Update Enrichment ────────────────────────────────────────────────

exports.managerUpdateEnrichment = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  try {
    const { itemId, itemType, updates } = req.body;
    if (!itemId || !itemType) return res.status(400).json({ error: 'itemId and itemType required' });
    const db = admin.database();

    if (itemType === 'food') {
      const snap = await db.ref(`foodItems/${itemId}`).once('value');
      const existing = snap.val() || {};
      await db.ref(`foodItems/${itemId}`).set({ ...existing, ...updates, lastEditedAt: Date.now() });
    } else {
      const enrichPath = itemType === 'wine' ? 'wineEnrichment' : itemType === 'beer' ? 'beerEnrichment' : 'poursEnrichment';
      const snap = await db.ref(`${enrichPath}/${itemId}`).once('value');
      const existing = snap.val() || {};
      await db.ref(`${enrichPath}/${itemId}`).set({
        ...existing,
        ...updates,
        manuallyEdited: true,
        lastEditedAt: Date.now()
      });
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

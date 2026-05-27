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

const EXCLUDE_KEYWORDS = ['cooking', 'cook wine', 'cork fee', 'wine dinner', 'liter'];

function shouldExclude(name) {
  const lower = name.toLowerCase();
  return EXCLUDE_KEYWORDS.some(k => lower.includes(k));
}

// Strip Glass/Bottle suffix and clean the name
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

// ─── Wine Extraction ──────────────────────────────────────────────────────────

function extractItemsFromGroup(group, stockMap, topTier, wines) {
  if (group.menuItems && group.menuItems.length > 0) {
    group.menuItems.forEach(item => {
      if (shouldExclude(item.name)) return;
      const stockInfo = stockMap[item.guid];
      const isAvailable = !stockInfo || stockInfo.status !== 'OUT_OF_STOCK';
      if (!wines.find(w => w.id === item.guid)) {
        console.log('ITEM FIELDS:', item.name, JSON.stringify(Object.keys(item)));
        wines.push({
          id: item.guid,
          name: item.name,
          price: item.price || null,
          tier: topTier,
          subgroup: group.name,
          available: isAvailable,
          toastImageUrl: item.imageUrl || item.imageUrls?.[0] || item.image || null,
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

    const nameUpper = wine.name.toUpperCase();
    const isGlass = /\sGLASS$/i.test(wine.name);
    const isBottle = /\sBOTTLE$/i.test(wine.name) || /\s1L\sBOTTLE$/i.test(wine.name);

    if (isGlass || isBottle) {
      const baseName = cleanWineName(wine.name);

      // Find matching pair by base name
      const pair = wines.find(w =>
        w.id !== wine.id &&
        !processed.has(w.id) &&
        cleanWineName(w.name) === baseName &&
        (/\sGLASS$/i.test(w.name) || /\sBOTTLE$/i.test(w.name) || /\s1L\sBOTTLE$/i.test(w.name))
      );

      let glassPrice = null;
      let bottlePrice = null;
      let primaryId = wine.id;

      if (isGlass) {
        glassPrice = wine.price;
        if (pair) {
          bottlePrice = pair.price;
          processed.add(pair.id);
          primaryId = pair.id; // Use bottle ID as primary
        }
      } else {
        bottlePrice = wine.price;
        primaryId = wine.id;
        if (pair) {
          glassPrice = pair.price;
          processed.add(pair.id);
        }
      }

      processed.add(wine.id);

      merged.push({
        id: primaryId,
        name: baseName,
        glassPrice,
        bottlePrice,
        tier: wine.tier,
        subgroup: wine.subgroup,
        available: wine.available,
        toastImageUrl: wine.toastImageUrl || null,
        masterId: wine.masterId
      });

    } else {
      // No suffix — bottle only
      processed.add(wine.id);
      merged.push({
        ...wine,
        glassPrice: null,
        bottlePrice: wine.price,
        price: undefined
      });
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
  'cabernet sauvignon': 'Cabernet Sauvignon',
  'cabernet': 'Cabernet Sauvignon',
  'pinot noir': 'Pinot Noir',
  'chardonnay': 'Chardonnay',
  'merlot': 'Merlot',
  'malbec': 'Malbec',
  'sauvignon blanc': 'Sauvignon Blanc',
  'pinot grigio': 'Pinot Grigio',
  'pinot gris': 'Pinot Grigio',
  'riesling': 'Riesling',
  'moscato': 'Moscato',
  'prosecco': 'Prosecco',
  'champagne': 'Champagne',
  'sparkling': 'Sparkling',
  'rosé': 'Rosé',
  'rose': 'Rosé',
  'port': 'Port',
  'tawny': 'Port',
  'zinfandel': 'Zinfandel',
  'shiraz': 'Shiraz',
  'syrah': 'Shiraz',
  'viognier': 'Viognier',
  'albarino': 'Albariño',
  'albariño': 'Albariño',
  'chianti': 'Sangiovese',
  'sangiovese': 'Sangiovese',
  'tempranillo': 'Tempranillo',
  'garnacha': 'Grenache',
  'grenache': 'Grenache',
  'red blend': 'Red Blend',
  'bordeaux blend': 'Bordeaux Blend',
  'rhône blend': 'Red Blend',
  'gsm blend': 'Red Blend',
  'gsm': 'Red Blend',
  'white blend': 'White Blend',
  'sparkling blend': 'Sparkling',
  'port blend': 'Port',
  'fortified': 'Port',
};

function normalizeVarietal(raw) {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();
  // Direct match
  if (VARIETAL_MAP[lower]) return VARIETAL_MAP[lower];
  // Partial match — if the raw name contains a known varietal
  for (const [key, val] of Object.entries(VARIETAL_MAP)) {
    if (lower.includes(key)) return val;
  }
  // If it contains slashes or commas it's a blend
  if (lower.includes('/') || lower.includes(',') || lower.includes('&')) {
    if (lower.includes('white') || lower.includes('blanc') || lower.includes('chardonnay') || lower.includes('viognier')) return 'White Blend';
    return 'Red Blend';
  }
  // Return as-is if short enough, otherwise Red Blend
  const words = raw.split(' ');
  return words.length <= 3 ? raw : 'Red Blend';
}

// ─── Claude Enrichment ────────────────────────────────────────────────────────

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
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      }
    );

    const text = response.data.content[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    const data = JSON.parse(clean);

    // Normalize varietal to our standard list
    data.varietal = normalizeVarietal(data.varietal);
    return data;

  } catch (e) {
    console.error(`Claude enrichment failed for ${wineName}:`, e.message);
    return null;
  }
}

// ─── Main Sync Function ───────────────────────────────────────────────────────

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

      await db.ref('wines').set(freshWines);
      await db.ref('lastUpdated').set(Date.now());
      console.log(`Saved ${freshWines.length} merged wines`);

      const toEnrich = freshWines.filter(w => !existingEnrichment[w.id]);
      let enrichedCount = 0;

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
          if (enrichment.uncertain) {
            console.log(`⚠️ UNCERTAIN: ${wine.name} — ${enrichment.uncertainReason}`);
          }
        }
        await new Promise(r => setTimeout(r, 500));
      }

      console.log(`Enrichment complete — ${enrichedCount} wines enriched`);
      return null;

    } catch (error) {
      console.error('Sync error:', error.message);
      if (error.response) console.error('API response:', JSON.stringify(error.response.data));
      return null;
    }
  });

// ─── HTTP Endpoint ────────────────────────────────────────────────────────────

exports.getWines = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const db = admin.database();
    const [winesSnap, enrichmentSnap, lastUpdatedSnap] = await Promise.all([
      db.ref('wines').once('value'),
      db.ref('wineEnrichment').once('value'),
      db.ref('lastUpdated').once('value')
    ]);

    const wines = winesSnap.val();
    const enrichment = enrichmentSnap.val() || {};
    const lastUpdated = lastUpdatedSnap.val();

    const mergedWines = (Array.isArray(wines) ? wines : Object.values(wines || {})).map(wine => {
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

// ─── Manual Enrichment Trigger (LIMITED TO 3 FOR TESTING) ────────────────────

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

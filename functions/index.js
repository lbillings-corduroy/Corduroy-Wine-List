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

// ─── Price Extraction ─────────────────────────────────────────────────────────

function extractPrices(item) {
  // Base price (cellar wines - bottle only)
  if (item.price) {
    return { glassPrice: null, bottlePrice: item.price };
  }

  // Size prices (house wines - glass and bottle)
  if (item.sizePrices && item.sizePrices.length > 0) {
    let glassPrice = null;
    let bottlePrice = null;

    item.sizePrices.forEach(sp => {
      const sizeName = (sp.size && sp.size.name || '').toLowerCase();
      if (sizeName.includes('glass') || sizeName === 'glass') {
        glassPrice = sp.price;
      } else if (sizeName.includes('bottle') || sizeName === 'bottle') {
        bottlePrice = sp.price;
      }
    });

    // If we couldn't match by name, use first as glass, second as bottle
    if (!glassPrice && !bottlePrice && item.sizePrices.length >= 2) {
      glassPrice = item.sizePrices[0].price;
      bottlePrice = item.sizePrices[1].price;
    } else if (!glassPrice && !bottlePrice && item.sizePrices.length === 1) {
      bottlePrice = item.sizePrices[0].price;
    }

    return { glassPrice, bottlePrice };
  }

  return { glassPrice: null, bottlePrice: null };
}

// ─── Wine Extraction ──────────────────────────────────────────────────────────

function extractItemsFromGroup(group, stockMap, topTier, wines) {
  if (group.menuItems && group.menuItems.length > 0) {
    group.menuItems.forEach(item => {
      const stockInfo = stockMap[item.guid];
      const isAvailable = !stockInfo || stockInfo.status !== 'OUT_OF_STOCK';
      const { glassPrice, bottlePrice } = extractPrices(item);

      if (!wines.find(w => w.id === item.guid)) {
        wines.push({
          id: item.guid,
          name: item.name,
          toastDescription: item.description || '',
          glassPrice: glassPrice,
          bottlePrice: bottlePrice,
          tier: topTier,
          subgroup: group.name,
          available: isAvailable,
          toastImageUrl: item.imageUrl || null,
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
  console.log(`Extracted ${wines.length} wines`);
  return wines;
}

// ─── Vintage Parser ───────────────────────────────────────────────────────────

function parseVintage(name) {
  const match = name.match(/\b(19|20)\d{2}\b/);
  return match ? parseInt(match[0]) : null;
}

// ─── Claude Enrichment ────────────────────────────────────────────────────────

async function enrichWineWithClaude(wineName, vintage) {
  if (!ANTHROPIC_API_KEY) {
    console.log('No Anthropic API key — skipping enrichment');
    return null;
  }

  const vintageNote = vintage ? `The vintage is ${vintage}.` : 'This is a house pour with no specific vintage.';

  const prompt = `You are a professional sommelier. I need detailed information about this wine for a restaurant wine list iPad app.

Wine: "${wineName}"
${vintageNote}

Please research this wine and provide the following in JSON format only (no other text):
{
  "varietal": "the primary grape varietal(s), e.g. Cabernet Sauvignon, Pinot Noir, Chardonnay, Red Blend, etc.",
  "region": "wine region and country, e.g. Napa Valley, California or Burgundy, France",
  "description": "2-3 sentence sommelier tasting note describing aromas, flavors, and finish. Write for a restaurant guest, not a wine expert. Be evocative and appetizing.",
  "reviews": "any notable critic scores or awards if known, e.g. 92pts Wine Spectator, or null if unknown",
  "labelImageQuery": "a specific Google image search query to find a clean flat label image (not bottle photo) for this wine, e.g. Duckhorn Merlot Napa 2022 label flat"
}

If you don't recognize the wine, make reasonable inferences from the name and provide your best assessment. Always return valid JSON.`;

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
    return JSON.parse(clean);
  } catch (e) {
    console.error(`Claude enrichment failed for ${wineName}:`, e.message);
    if (e.response) console.error('Response:', JSON.stringify(e.response.data));
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
      const freshWines = extractWines(menus, stockData);

      const db = admin.database();
      const enrichmentSnap = await db.ref('wineEnrichment').once('value');
      const existingEnrichment = enrichmentSnap.val() || {};

      await db.ref('wines').set(freshWines);
      await db.ref('lastUpdated').set(Date.now());
      console.log(`Saved ${freshWines.length} wines to Firebase`);

      const toEnrich = freshWines.filter(w => !existingEnrichment[w.id]);
      let enrichedCount = 0;

      for (const wine of toEnrich) {
        console.log(`Enriching: ${wine.name}`);
        const vintage = parseVintage(wine.name);
        const enrichment = await enrichWineWithClaude(wine.name, vintage);
        if (enrichment) {
          await db.ref(`wineEnrichment/${wine.id}`).set({
            varietal: enrichment.varietal || null,
            region: enrichment.region || null,
            description: enrichment.description || null,
            reviews: enrichment.reviews || null,
            labelImageQuery: enrichment.labelImageQuery || null,
            vintage: vintage,
            enrichedAt: Date.now()
          });
          enrichedCount++;
        }
        await new Promise(r => setTimeout(r, 500));
      }

      console.log(`Enrichment complete — ${enrichedCount} new wines enriched`);
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

    const mergedWines = (Array.isArray(wines) ? wines : Object.values(wines || {})).map(wine => ({
      ...wine,
      varietal: enrichment[wine.id]?.varietal || null,
      region: enrichment[wine.id]?.region || null,
      description: enrichment[wine.id]?.description || null,
      reviews: enrichment[wine.id]?.reviews || null,
      labelImageQuery: enrichment[wine.id]?.labelImageQuery || null,
      vintage: enrichment[wine.id]?.vintage || null,
    }));

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
      for (const wine of toEnrich) {
        console.log(`Enriching: ${wine.name}`);
        const vintage = parseVintage(wine.name);
        const enrichment = await enrichWineWithClaude(wine.name, vintage);

        if (enrichment) {
          await db.ref(`wineEnrichment/${wine.id}`).set({
            varietal: enrichment.varietal || null,
            region: enrichment.region || null,
            description: enrichment.description || null,
            reviews: enrichment.reviews || null,
            labelImageQuery: enrichment.labelImageQuery || null,
            vintage: vintage,
            enrichedAt: Date.now()
          });
          enrichedCount++;
          console.log(`✓ ${wine.name} — ${enrichment.varietal}`);
        }

        await new Promise(r => setTimeout(r, 500));
      }

      res.json({
        message: `Test enrichment complete`,
        enriched: enrichedCount,
        alreadyEnriched: wineList.length - wineList.filter(w => !existingEnrichment[w.id]).length,
        total: wineList.length,
        note: 'Remove .slice(0, 3) in triggerEnrichment to enrich all wines'
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

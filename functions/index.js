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

// ─── Settings Loader ──────────────────────────────────────────────────────────
// Reads app settings from Firebase. Falls back to hardcoded GUIDs if settings
// haven't been configured yet, so existing behavior is preserved on first deploy.

async function getAppSettings() {
  try {
    const db = admin.database();
    const snap = await db.ref('appSettings').once('value');
    return snap.val() || {};
  } catch (e) {
    console.log('Could not load appSettings:', e.message);
    return {};
  }
}

// Returns menus of a given menuType from settings, with fallback to hardcoded defaults.
function getMenusOfType(settings, menuType) {
  const configured = (settings?.menus || []).filter(m => m.menuType === menuType && m.guid);
  if (configured.length > 0) return configured;
  // Fallback defaults — used until admin configures settings
  const defaults = {
    wine:         [{ guid: WINE_MENU_GUID,     label: 'Wine List' }],
    beer_pours:   [{ guid: BEER_MENU_GUID,     label: 'Beer List' }, { guid: POURS_MENU_GUID, label: 'Premium Pours' }],
    cocktails_na: [{ guid: COCKTAILS_MENU_GUID, label: 'Specialty Cocktails' }, { guid: NAB_MENU_GUID, label: 'Non-Alcoholic Beverages' }],
    food:         [],
  };
  return defaults[menuType] || [];
}

// Returns true if a menu is currently available based on the Toast-sourced availability
// cached in appSettings.toastAvailability. If no cached data exists, assumes available.
// Restaurant timezone — Toast availability times are in local restaurant time, not UTC
const RESTAURANT_TIMEZONE = 'America/New_York';

function isMenuAvailableNow(menu, toastAvailabilityCache) {
  const ta = toastAvailabilityCache && toastAvailabilityCache[menu.guid];
  if (!ta) return true;

  // Use restaurant local time, not server UTC
  const localStr = new Date().toLocaleString('en-US', { timeZone: RESTAURANT_TIMEZONE });
  const localNow = new Date(localStr);
  const dayFull = ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'][localNow.getDay()];
  const dayAbbr = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][localNow.getDay()];

  if (ta.toastDays && ta.toastDays.length > 0) {
    const upperDays = ta.toastDays.map(d => d.toUpperCase());
    if (!upperDays.includes(dayFull) && !upperDays.includes(dayAbbr.toUpperCase())) return false;
  }

  if (ta.toastHours && ta.toastHours.open && ta.toastHours.close) {
    const parseTime = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    const nowMins = localNow.getHours() * 60 + localNow.getMinutes();
    const openMins = parseTime(ta.toastHours.open);
    let closeMins = parseTime(ta.toastHours.close);
    if (closeMins <= openMins) closeMins += 24 * 60;
    if (nowMins < openMins || nowMins >= closeMins) return false;
  }

  return true;
}

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
    const data = response.data;
    console.log(`Stock API: ${Array.isArray(data) ? data.length : '?'} items`);
    return data;
  } catch (e) {
    console.log('Stock unavailable:', e.message, 'Status:', e.response?.status, 'Data:', JSON.stringify(e.response?.data));
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
    stockData.forEach(item => { const g = item.guid || item.menuItem?.guid; if (g) stockMap[g] = item; });
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
    stockData.forEach(item => { const g = item.guid || item.menuItem?.guid; if (g) stockMap[g] = item; });
  }
  if (wineMenu.menuGroups) {
    wineMenu.menuGroups.forEach(g => extractItemsFromGroup(g, stockMap, g.name, wines));
  }
  return wines;
}

// Settings-aware version: accepts any GUID instead of the hardcoded constant
function extractWinesFromGuid(menus, menuGuid, stockData) {
  const wines = [];
  const wineMenu = menus.menus.find(m => m.guid === menuGuid);
  if (!wineMenu) {
    // Also search as a group inside any menu
    for (const m of menus.menus) {
      const group = findGroupByGuid(m.menuGroups || [], menuGuid);
      if (group) {
        const stockMap = {};
        if (Array.isArray(stockData)) stockData.forEach(item => { const g = item.guid || item.menuItem?.guid; if (g) stockMap[g] = item; });
        extractItemsFromGroup(group, stockMap, group.name, wines);
        return wines;
      }
    }
    console.log(`Wine menu/group ${menuGuid} not found`);
    return wines;
  }
  const stockMap = {};
  if (Array.isArray(stockData)) {
    stockData.forEach(item => { const g = item.guid || item.menuItem?.guid; if (g) stockMap[g] = item; });
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

async function enrichWineWithClaude(wineName, vintage, hints = {}) {
  if (!ANTHROPIC_API_KEY) return null;
  const vintageNote = vintage ? `The vintage is ${vintage}.` : 'This is a house pour with no specific vintage.';

  // Build hint block from any manager-confirmed fields
  const hintLines = [];
  if (hints.region)   hintLines.push(`- Region: "${hints.region}" (confirmed by manager — treat as fact, do not override)`);
  if (hints.varietal) hintLines.push(`- Varietal: "${hints.varietal}" (confirmed by manager — treat as fact, do not override)`);
  if (hints.correctedName && hints.correctedName !== wineName) hintLines.push(`- Corrected name: "${hints.correctedName}" (confirmed by manager)`);
  const hintBlock = hintLines.length > 0
    ? `\nThe restaurant manager has confirmed the following details — treat these as facts and do not change them:\n${hintLines.join('\n')}\n`
    : '';

  const prompt = `You are a professional sommelier and wine data expert. I need accurate information about this wine for a restaurant iPad wine list.

Wine: "${wineName}"
${vintageNote}${hintBlock}
Tasks:
1. Identify the correct wine (fix any spelling/capitalization errors in the name)
2. If you are uncertain what wine this is, set "uncertain" to true. However, if the manager has confirmed the region above, use that to resolve your uncertainty — do not mark as uncertain just because the name is ambiguous.

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

async function enrichBeerWithClaude(beerName, hints = {}) {
  if (!ANTHROPIC_API_KEY) return null;
  const hintLines = [];
  if (hints.brewery) hintLines.push(`- Brewery: "${hints.brewery}" (confirmed by manager — treat as fact)`);
  if (hints.style)   hintLines.push(`- Style: "${hints.style}" (confirmed by manager — treat as fact)`);
  const hintBlock = hintLines.length > 0
    ? `\nThe restaurant manager has confirmed the following:\n${hintLines.join('\n')}\n`
    : '';
  const prompt = `You are a craft beer expert. I need accurate information about this beer for a restaurant menu app.

Beer: "${beerName}"${hintBlock}

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

async function enrichPourWithClaude(pourName, hints = {}) {
  if (!ANTHROPIC_API_KEY) return null;
  const hintLines = [];
  if (hints.producer)  hintLines.push(`- Producer/Distillery: "${hints.producer}" (confirmed by manager — treat as fact)`);
  if (hints.category)  hintLines.push(`- Category: "${hints.category}" (confirmed by manager — treat as fact)`);
  const hintBlock = hintLines.length > 0
    ? `\nThe restaurant manager has confirmed the following:\n${hintLines.join('\n')}\n`
    : '';
  const prompt = `You are a spirits expert. I need accurate information about this spirit for a restaurant premium pours menu.

Spirit: "${pourName}"${hintBlock}

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
  .pubsub.schedule('15 17 * * *')
  .onRun(async (context) => {
    try {
      console.log('Starting Toast API sync...');
      const settings = await getAppSettings();
      const wineMenus = getMenusOfType(settings, 'wine');
      if (wineMenus.length === 0) { console.log('No wine menus configured'); return null; }

      const token = await getToastToken();
      const menus = await getMenus(token);
      const stockData = await getStockData(token);

      // Merge wines across all configured wine menu GUIDs
      let allRawWines = [];
      for (const wm of wineMenus) {
        const raw = extractWinesFromGuid(menus, wm.guid, stockData);
        allRawWines = [...allRawWines, ...raw];
      }
      const freshWines = mergeGlassBottle(allRawWines);

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
  .pubsub.schedule('16 17 * * *')
  .onRun(async (context) => {
    try {
      console.log('Starting Beer menu sync...');
      const settings = await getAppSettings();
      // beer_pours menus: only sync the ones labelled as beer (first GUID by convention, or all if only one)
      const beerPourMenus = getMenusOfType(settings, 'beer_pours');
      // Separate beer from pours by looking for "beer" in the label (case-insensitive), else use first
      const beerMenus = beerPourMenus.filter(m => /beer/i.test(m.label));
      const toSync = beerMenus.length > 0 ? beerMenus : (beerPourMenus.length > 0 ? [beerPourMenus[0]] : [{ guid: BEER_MENU_GUID, label: 'Beer List' }]);

      const token = await getToastToken();
      const menus = await getMenus(token);
      const stockData = await getStockData(token);
      let freshBeers = [];
      for (const bm of toSync) {
        freshBeers = [...freshBeers, ...extractItemsFromMenu(menus, bm.guid, stockData)];
      }

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

      await purgeOrphanedEnrichment(db, 'beers', 'beerEnrichment', freshBeers.map(b => b.id), 'beer');

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
  .pubsub.schedule('17 17 * * *')
  .onRun(async (context) => {
    try {
      console.log('Starting Premium Pours sync...');
      const settings = await getAppSettings();
      const beerPourMenus = getMenusOfType(settings, 'beer_pours');
      const pourMenus = beerPourMenus.filter(m => /pour|spirit|whiskey|bourbon|tequila|premium/i.test(m.label));
      const toSync = pourMenus.length > 0 ? pourMenus : (beerPourMenus.length > 1 ? [beerPourMenus[1]] : [{ guid: POURS_MENU_GUID, label: 'Premium Pours' }]);

      const token = await getToastToken();
      const menus = await getMenus(token);
      const stockData = await getStockData(token);
      let freshPours = [];
      for (const pm of toSync) {
        freshPours = [...freshPours, ...extractItemsFromMenu(menus, pm.guid, stockData)];
      }

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

      await purgeOrphanedEnrichment(db, 'pours', 'poursEnrichment', freshPours.map(p => p.id), 'pours');

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

    // Hide uncertain items from customers, but let manager screen see all via ?admin=1
    const approvedWines = req.query.admin === '1'
      ? mergedWines
      : mergedWines.filter(w => !w.uncertain || enrichment[w.id]?.approved);
    res.json({ wines: approvedWines, lastUpdated });
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

    const approvedBeers = req.query.admin === '1'
      ? merged
      : merged.filter(b => !b.uncertain || enrichment[b.id]?.approved);
    res.json({ beers: approvedBeers, lastUpdated });
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

    const approvedPours = req.query.admin === '1'
      ? merged
      : merged.filter(p => !p.uncertain || enrichment[p.id]?.approved);
    res.json({ pours: approvedPours, lastUpdated });
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
  { name: 'Dessert',        guid: '3c87ad2b-a3e8-44c4-9fd1-da741d9b0501' },
];

// ─── Food Extraction ──────────────────────────────────────────────────────────

function extractFoodItems(menus, stockData) {
  const stockMap = {};
  if (Array.isArray(stockData)) {
    stockData.forEach(item => { const g = item.guid || item.menuItem?.guid; if (g) stockMap[g] = item; });
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

// Settings-aware version: accepts a dynamic groups array instead of hardcoded FOOD_GROUPS
function extractFoodItemsFromGroups(menus, stockData, groups) {
  const stockMap = {};
  if (Array.isArray(stockData)) {
    stockData.forEach(item => { const g = item.guid || item.menuItem?.guid; if (g) stockMap[g] = item; });
  }
  const allItems = [];

  function collectItems(g, courseName, locations, sortOrder, menuGuid) {
    if (g.menuItems && g.menuItems.length > 0) {
      g.menuItems.forEach(item => {
        const price = item.price || null;
        if (!price || price === 0) return;
        const stockInfo = stockMap[item.guid];
        if (stockInfo && stockInfo.status === 'OUT_OF_STOCK') return;
        if (Array.isArray(item.visibility) && item.visibility.length === 0) return;
        if (allItems.find(i => i.id === item.guid)) return;
        allItems.push({ id: item.guid, name: item.name, price, course: courseName, description: item.description || null, available: true, locations: locations || [], menuSortOrder: sortOrder ?? 0, menuGuid: menuGuid || null });
      });
    }
    if (g.menuGroups && g.menuGroups.length > 0) g.menuGroups.forEach(sub => collectItems(sub, courseName, locations, sortOrder, menuGuid));
  }

  for (const { name: configName, guid, locations, sortOrder } of groups) {
    // Check if GUID matches a top-level menu — pull all subgroups as course sections
    const topLevelMenu = menus.menus.find(m => m.guid === guid);
    if (topLevelMenu) {
      console.log(`Food config "${configName}" matched top-level menu "${topLevelMenu.name}" — locations: ${JSON.stringify(locations)}`);
      if (topLevelMenu.menuGroups && topLevelMenu.menuGroups.length > 0) {
        topLevelMenu.menuGroups.forEach(subgroup => {
          collectItems(subgroup, subgroup.name, locations || [], sortOrder ?? 0);
          console.log(`  Section "${subgroup.name}" — ${allItems.filter(i => i.course === subgroup.name).length} items`);
        });
      }
      continue;
    }

    // Otherwise search as a subgroup
    let group = null;
    for (const menu of menus.menus) {
      group = findGroupByGuid(menu.menuGroups || [], guid);
      if (group) break;
    }
    if (!group) { console.log(`Food group "${configName}" (${guid}) not found`); continue; }
    collectItems(group, configName, locations || [], sortOrder ?? 0, guid);
    console.log(`Food group "${configName}" — found ${allItems.filter(i => i.course === configName).length} items`);
  }
  return allItems;
}

// ─── Food Menu Sync ───────────────────────────────────────────────────────────
exports.syncFoodMenu = functions
  .runWith({ timeoutSeconds: 120, memory: '256MB' })
  .pubsub.schedule('18 17 * * *')
  .onRun(async (context) => {
    try {
      console.log('Starting Food menu sync...');
      const settings = await getAppSettings();
      const foodMenuConfigs = getMenusOfType(settings, 'food');

      // Build FOOD_GROUPS from settings, falling back to hardcoded if not configured
      let dynamicFoodGroups = foodMenuConfigs.map((m, i) => ({ name: m.label, guid: m.guid, locations: m.locations || [], sortOrder: m.sortOrder ?? i }));
      if (dynamicFoodGroups.length === 0) dynamicFoodGroups = FOOD_GROUPS;

      const token = await getToastToken();
      const menus = await getMenus(token);
      const stockData = await getStockData(token);

      // Temporarily override FOOD_GROUPS for this sync run
      const freshItems = extractFoodItemsFromGroups(menus, stockData, dynamicFoodGroups);

      const db = admin.database();
      // Merge locations when the same item appears in multiple menu configs
      // (e.g. AK Entrees subgroup appears in both AK master menu and standalone Tuque's entry)
      // Log location summary before writing
      const locationSummary = {};
      freshItems.forEach(item => {
        const key = JSON.stringify(item.locations || []);
        locationSummary[key] = (locationSummary[key] || 0) + 1;
      });
      console.log('[syncFoodMenu] Location distribution:', JSON.stringify(locationSummary));
      console.log('[syncFoodMenu] Sample items:', freshItems.slice(0,3).map(i => ({ name: i.name, course: i.course, locations: i.locations })));

      const foodById = {};
      freshItems.forEach(item => {
        if (foodById[item.id]) {
          const existing = foodById[item.id].locations || [];
          const incoming = item.locations || [];
          const merged = [...new Set([...existing, ...incoming])];
          foodById[item.id] = { ...foodById[item.id], locations: merged };
        } else {
          foodById[item.id] = item;
        }
      });
      await db.ref('foodItems').set(foodById);
      await db.ref('foodOrder').set([...new Set(freshItems.map(i => i.id))]);
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
    const [foodSnap, orderSnap, lastUpdatedSnap, exclusionsSnap] = await Promise.all([
      db.ref('foodItems').once('value'),
      db.ref('foodOrder').once('value'),
      db.ref('foodLastUpdated').once('value'),
      db.ref('foodExclusions').once('value'),
    ]);

    const foodById = foodSnap.val() || {};
    const foodOrder = orderSnap.val() || [];
    const lastUpdated = lastUpdatedSnap.val();
    const exclusions = exclusionsSnap.val() || {};

    const requestedLocation = req.query.location || req.body?.location || null;

    // Load availability cache to filter menus by current time
    const settingsSnap = await db.ref('appSettings').once('value');
    const appSettings = settingsSnap.val() || {};
    const toastAvailCache = appSettings.toastAvailability || appSettings.settings?.toastAvailability || {};
    const configuredMenus = appSettings.menus || appSettings.settings?.menus || [];

    // Build set of currently-available menu GUIDs for the requested location
    const availableMenuGuids = new Set();
    configuredMenus.forEach(menu => {
      if (menu.menuType !== 'food') return;
      const locs = menu.locations || [];
      if (requestedLocation && locs.length > 0 && !locs.includes(requestedLocation)) return;
      const avail = isMenuAvailableNow(menu, toastAvailCache);
      const ta = toastAvailCache[menu.guid];
      console.log(`[getFoodItems] menu="${menu.label}" guid=${menu.guid} location=${JSON.stringify(locs)} available=${avail} toastDays=${JSON.stringify(ta?.toastDays)} toastHours=${JSON.stringify(ta?.toastHours)}`);
      if (avail) availableMenuGuids.add(menu.guid);
    });

    console.log(`[getFoodItems] requestedLocation=${requestedLocation} availableGuids=${JSON.stringify([...availableMenuGuids])}`);

    const useAvailabilityFilter = configuredMenus.some(m => m.menuType === 'food');

    const ordered = (foodOrder.length > 0
      ? foodOrder.map(id => foodById[id]).filter(Boolean)
      : Object.values(foodById)
    ).filter(item => {
      // Location filter
      if (requestedLocation) {
        const locs = item.locations || [];
        if (locs.length > 0 && !locs.includes(requestedLocation)) return false;
      }
      // Availability filter — only show items from currently-available menus
      if (useAvailabilityFilter && item.menuGuid) {
        return availableMenuGuids.has(item.menuGuid);
      }
      return true;
    }).map(item => ({ ...item, excluded: exclusions[item.id] === true }));

    console.log(`[getFoodItems] useAvailabilityFilter=${useAvailabilityFilter} total=${ordered.length} sample menuGuids=${JSON.stringify([...new Set(ordered.slice(0,5).map(i => i.menuGuid))])}`);
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
        const pairingLocation = req.body.location || null;
        const allFoodItems = Object.values(foodSnap.val() || {});
        const foodItems = allFoodItems.filter(f => {
          if (!pairingLocation) return true;
          const locs = f.locations || [];
          return locs.length === 0 || locs.includes(pairingLocation);
        });

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
        // Enrich pairings with food item IDs so the frontend can add them to My Menu
        const foodByName = {};
        foodItems.forEach(f => { foodByName[f.name.toLowerCase()] = f; });
        const enrichedPairings = (result.pairings || []).map(p => {
          const match = foodByName[p.name.toLowerCase()];
          return match ? { ...p, id: match.id, price: match.price || null } : p;
        });
        return res.json({ pairings: enrichedPairings });
      }

      // ── Food → Wine ───────────────────────────────────────────────────────
      if (type === 'food_to_wine') {
        // Accept items with courseRole or fall back to legacy itemIds
        const itemsWithRoles = req.body.items ||
          (req.body.itemIds || (itemId ? [itemId] : [])).map(id => ({ id, courseRole: 'main' }));
        if (itemsWithRoles.length === 0) return res.status(400).json({ error: 'items required' });

        const [winesSnap, enrichSnap] = await Promise.all([
          db.ref('wines').once('value'),
          db.ref('wineEnrichment').once('value'),
        ]);
        const uniqueIds = [...new Set(itemsWithRoles.map(i => i.id))];
        const foodSnaps = await Promise.all(uniqueIds.map(id => db.ref(`foodItems/${id}`).once('value')));
        const foodById = {};
        foodSnaps.forEach(s => { if (s.val()) foodById[s.key] = s.val(); });
        if (Object.keys(foodById).length === 0) return res.status(404).json({ error: 'Food items not found' });
        const food = foodById[uniqueIds[0]]; // backward compat alias

        const winesById = winesSnap.val() || {};
        const enrichment = enrichSnap.val() || {};

        // Sort wines by price and split into thirds so tiers reflect actual prices
        const wineObjects = Object.values(winesById)
          .filter(w => (w.bottlePrice || w.glassPrice) && w.available !== false
            && !(enrichment[w.id]?.uncertain && !enrichment[w.id]?.approved))
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

        // Group by guest-selected course role
        const roleLabels = { first: 'First Course', main: 'Main Course', dessert: 'Dessert' };
        const courseGroups = {};
        itemsWithRoles.forEach(({ id, courseRole }) => {
          const food = foodById[id];
          if (!food) return;
          const label = roleLabels[courseRole] || 'Main Course';
          if (!courseGroups[label]) courseGroups[label] = [];
          // Avoid duplicate dishes in same group
          if (!courseGroups[label].find(f => f.id === food.id)) courseGroups[label].push(food);
        });
        // Preserve logical course order
        const courseOrder = ['First Course', 'Main Course', 'Dessert'];
        const courseNames = courseOrder.filter(c => courseGroups[c]);
        const isMultiCourse = courseNames.length > 1;

        function enrichPairings(pairings) {
          return (pairings || []).map(p => {
            const w = wineObjects.find(wo => wo.id === p.id);
            return { ...p, imageUrl: w ? (w.toastImageUrl || null) : null, glassPrice: w ? w.glassPrice : p.glassPrice, bottlePrice: w ? w.bottlePrice : p.bottlePrice };
          });
        }

        let prompt, maxTokens;

        if (isMultiCourse) {
          // Build per-course description
          const courseSections = courseNames.map(course => {
            const dishes = courseGroups[course];
            const dishDesc = dishes.map(d => d.name + (d.description ? ` (${d.description})` : '')).join(', ');
            return `${course.toUpperCase()}: ${dishDesc}`;
          }).join('\n');

          prompt = `You are the sommelier at Appalachia Kitchen, an upscale mountain restaurant at Corduroy Inn & Lodge on Snowshoe Mountain, West Virginia.

This table is ordering multiple courses:
${courseSections}

For EACH course, suggest exactly three wines — one Value, one Mid-Range, one Premium — that pair beautifully with that course's dish(es). Choose wines that also flow well together as a progression through the meal. You MUST pick from the correct section for each tier.
${wineListByTier}${excludeNote}

Respond in JSON only (no other text):
{"courses":[{"course":"course name","pairings":[{"level":"Value","id":"wine-id","name":"wine name","varietal":"varietal","region":"region","glassPrice":null,"bottlePrice":null,"reason":"one evocative sentence"},{"level":"Mid-Range",...},{"level":"Premium",...}]}]}`;
          maxTokens = 2400;
        } else {
          const allFoods = itemsWithRoles.map(({ id }) => foodById[id]).filter(Boolean);
          const dishList = allFoods.map(f => `- ${f.name}${f.description ? `: ${f.description}` : ''}`).join('\n');
          const tableContext = allFoods.length === 1
            ? `A guest is ordering:\n${dishList}`
            : `A table of guests is sharing these dishes:\n${dishList}\n\nSuggest wines that work well across all dishes.`;

          prompt = `You are the sommelier at Appalachia Kitchen, an upscale mountain restaurant at Corduroy Inn & Lodge on Snowshoe Mountain, West Virginia. ${tableContext}

Suggest exactly three wines that pair beautifully with ${allFoods.length === 1 ? 'this dish' : 'these dishes'} — one from each price tier below. You MUST pick from the correct section for each tier.
${wineListByTier}${excludeNote}

Respond in JSON only (no other text):
{"pairings":[{"level":"Value","id":"wine-id","name":"wine name","varietal":"varietal","region":"region","glassPrice":null,"bottlePrice":null,"reason":"one evocative sentence"},{"level":"Mid-Range",...},{"level":"Premium",...}]}`;
          maxTokens = 1600;
        }

        const response = await axios.post(
          'https://api.anthropic.com/v1/messages',
          { model: 'claude-sonnet-4-6', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] },
          { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
        );
        const text = response.data.content[0].text;
        console.log(`food_to_wine response (${isMultiCourse ? 'multi' : 'single'}): ${text.substring(0, 200)}`);

        // Robust JSON extraction — finds the outermost {} even if Claude adds text around it
        function extractJson(raw) {
          const stripped = raw.replace(/```json|```/g, '').trim();
          const start = stripped.indexOf('{');
          const end = stripped.lastIndexOf('}');
          if (start !== -1 && end !== -1 && end > start) {
            return JSON.parse(stripped.substring(start, end + 1));
          }
          return JSON.parse(stripped);
        }

        const result = extractJson(text);

        if (isMultiCourse) {
          // Claude may return courses under different keys — handle both
          const rawCourses = result.courses || result.byCourse || result.course_pairings || [];
          if (rawCourses.length === 0) {
            // Fallback: if Claude returned flat pairings instead of course structure, treat as single course
            console.log('Multi-course fallback: no courses key found, using flat pairings');
            return res.json({ pairings: enrichPairings(result.pairings || []) });
          }
          // Normalize Claude's course names to our standard labels regardless of casing
          function normalizeCourse(name) {
            const l = (name || '').toLowerCase();
            if (l.includes('first') || l.includes('starter') || l.includes('appetizer')) return 'First Course';
            if (l.includes('dessert') || l.includes('sweet')) return 'Dessert';
            return 'Main Course';
          }
          const enrichedCourses = rawCourses.map(c => {
            const normalizedCourse = normalizeCourse(c.course);
            return {
              ...c,
              course: normalizedCourse,
              dishes: (courseGroups[normalizedCourse] || courseGroups[c.course] || []).map(d => d.name),
              pairings: enrichPairings(c.pairings)
            };
          });
          return res.json({ byCourse: enrichedCourses });
        } else {
          return res.json({ pairings: enrichPairings(result.pairings) });
        }
      }


      // ── Drink → Food (Beer & Pours) ──────────────────────────────────────
      if (type === 'drink_to_food') {
        const { itemName, itemDescription, itemStyle, itemCategory, itemABV, excludeDishes = [] } = req.body;
        const [foodSnap, exclusionsSnap] = await Promise.all([
          db.ref('foodItems').once('value'),
          db.ref('foodExclusions').once('value'),
        ]);
        const exclusions = exclusionsSnap.val() || {};
        const foodItems = Object.values(foodSnap.val() || {}).filter(f => !exclusions[f.id]);
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
        // Enrich pairings with food item IDs so the frontend can add them to My Menu
        const drinkFoodByName = {};
        foodItems.forEach(f => { drinkFoodByName[f.name.toLowerCase()] = f; });
        const enrichedDrinkPairings = (result.pairings || []).map(p => {
          const match = drinkFoodByName[p.name.toLowerCase()];
          return match ? { ...p, id: match.id, price: match.price || null } : p;
        });
        return res.json({ pairings: enrichedDrinkPairings });
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
    // Store in separate node so syncFoodMenu never overwrites it
    await db.ref(`foodExclusions/${itemId}`).set(excluded === true ? true : null);
    res.json({ ok: true, itemId, excluded });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Specialty Cocktails Sync ─────────────────────────────────────────────────

const COCKTAILS_MENU_GUID = '618dd517-3de7-456c-b38e-0cd0739947a6';
const NAB_MENU_GUID = 'fa091def-5bc2-434e-a436-64b29ce7932f';

exports.syncCocktailsMenu = functions
  .runWith({ timeoutSeconds: 120, memory: '256MB' })
  .pubsub.schedule('19 17 * * *')
  .onRun(async (context) => {
    try {
      console.log('Starting Specialty Cocktails sync...');
      const settings = await getAppSettings();
      const cnMenus = getMenusOfType(settings, 'cocktails_na');
      const cocktailMenus = cnMenus.filter(m => /cocktail/i.test(m.label));
      const toSync = cocktailMenus.length > 0 ? cocktailMenus : (cnMenus.length > 0 ? [cnMenus[0]] : [{ guid: COCKTAILS_MENU_GUID }]);

      const token = await getToastToken();
      const menus = await getMenus(token);
      const stockData = await getStockData(token);
      let freshItems = [];
      for (const cm of toSync) freshItems = [...freshItems, ...extractItemsFromMenu(menus, cm.guid, stockData)];

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
  .pubsub.schedule('20 17 * * *')
  .onRun(async (context) => {
    try {
      console.log('Starting Non-Alcoholic Beverages sync...');
      const settings = await getAppSettings();
      const cnMenus = getMenusOfType(settings, 'cocktails_na');
      const nabMenus = cnMenus.filter(m => /non.?alc|nab|beverage|juice|soda|water/i.test(m.label));
      const toSync = nabMenus.length > 0 ? nabMenus : (cnMenus.length > 1 ? [cnMenus[1]] : [{ guid: NAB_MENU_GUID }]);

      const token = await getToastToken();
      const menus = await getMenus(token);
      const stockData = await getStockData(token);
      let freshItems = [];
      for (const nm of toSync) freshItems = [...freshItems, ...extractItemsFromMenu(menus, nm.guid, stockData)];

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
      const { excluded, ...otherUpdates } = updates;
      // excluded flag lives in foodExclusions/ so it survives syncs
      if (excluded !== undefined) {
        await db.ref(`foodExclusions/${itemId}`).set(excluded === true ? true : null);
      }
      if (Object.keys(otherUpdates).length > 0) {
        await db.ref(`foodItems/${itemId}`).set({ ...existing, ...otherUpdates, lastEditedAt: Date.now() });
      }
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


// ─── Stock-Only Sync ──────────────────────────────────────────────────────────
// Runs every 5 minutes. Only updates available/out-of-stock status on existing
// Firebase records. Two API calls total (token + stock). No menu traversal.
exports.syncStockOnly = functions
  .runWith({ timeoutSeconds: 60, memory: '256MB' })
  .pubsub.schedule('*/5 * * * *')
  .onRun(async () => {
    try {
      const db = admin.database();
      const token = await getToastToken();
      const stockData = await getStockData(token);

      if (!Array.isArray(stockData) || stockData.length === 0) {
        console.log('[stockSync] No stock data returned');
        return null;
      }

      // Build map of guid → available boolean
      const stockMap = {};
      stockData.forEach(item => {
        const guid = item.guid || item.menuItem?.guid;
        if (guid) {
          const outOfStock = item.status === 'OUT_OF_STOCK' ||
            (Array.isArray(item.menuItem?.visibility) && item.menuItem.visibility.length === 0);
          stockMap[guid] = !outOfStock;
        }
      });

      // Update all Firebase item nodes — only write records that changed
      const nodes = ['wines', 'beers', 'pours', 'foodItems', 'cocktails', 'nab'];
      let totalUpdated = 0;

      for (const node of nodes) {
        const snap = await db.ref(node).once('value');
        const items = snap.val();
        if (!items) continue;

        const updates = {};
        Object.entries(items).forEach(([id, item]) => {
          const newAvailable = stockMap[id];
          if (newAvailable === undefined) return; // not in stock data — leave as-is
          const currentAvailable = item.available !== false;
          if (newAvailable !== currentAvailable) {
            updates[`${node}/${id}/available`] = newAvailable;
            totalUpdated++;
          }
        });

        if (Object.keys(updates).length > 0) {
          await db.ref('/').update(updates);
        }
      }

      console.log(`[stockSync] Updated ${totalUpdated} item availability changes`);
      await db.ref('stockLastChecked').set(Date.now());
      return null;
    } catch (e) {
      console.error('[stockSync] Error:', e.message);
      return null;
    }
  });

// ─── Force Sync Endpoint ──────────────────────────────────────────────────────

exports.forceSync = functions
  .runWith({ timeoutSeconds: 60, memory: '256MB' })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).send('');

    try {
      const { categories } = req.body;
      const toRun = Array.isArray(categories) ? categories : ['wine', 'beer', 'pours', 'food', 'cocktails', 'nab'];

      const funcMap = {
        wine:      'syncWineMenu',
        beer:      'syncBeerMenu',
        pours:     'syncPoursMenu',
        food:      'syncFoodMenu',
        cocktails: 'syncCocktailsMenu',
        nab:       'syncNABMenu',
      };

      // Get GCP access token from metadata server (available in all Cloud Functions)
      const tokenRes = await axios.get(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        { headers: { 'Metadata-Flavor': 'Google' } }
      );
      const accessToken = tokenRes.data.access_token;
      const projectId = 'corduroy-wine-list';

      const triggered = [];
      for (const cat of toRun) {
        const funcName = funcMap[cat];
        if (!funcName) continue;
        const topicName = `firebase-schedule-${funcName}-us-central1`;
        await axios.post(
          `https://pubsub.googleapis.com/v1/projects/${projectId}/topics/${topicName}:publish`,
          { messages: [{ data: Buffer.from('{}').toString('base64') }] },
          { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
        );
        triggered.push(cat);
      }

      res.json({ ok: true, triggered, message: `Triggered: ${triggered.join(', ')}. Syncs run in background — check again in ~60 seconds.` });
    } catch (error) {
      console.error('forceSync error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });


// ─── Manual Cleanup Endpoint ──────────────────────────────────────────────────
// Purges orphaned enrichment/data records across all categories in one shot.
// Called from the manager dashboard after fixing a miscategorised menu.
exports.cleanupOrphanedData = functions
  .runWith({ timeoutSeconds: 120, memory: '256MB' })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).send('');

    try {
      const db = admin.database();
      const settings = await getAppSettings();
      const token = await getToastToken();
      const menus = await getMenus(token);
      const stockData = await getStockData(token);

      const results = {};

      // Wine
      const wineMenus = getMenusOfType(settings, 'wine');
      let allWineIds = new Set();
      for (const wm of wineMenus) {
        const raw = extractWinesFromGuid(menus, wm.guid, stockData);
        mergeGlassBottle(raw).forEach(w => allWineIds.add(w.id));
      }
      await purgeOrphanedEnrichment(db, 'wines', 'wineEnrichment', [...allWineIds], 'wine-cleanup');
      results.wine = allWineIds.size;

      // Beer
      const beerPourMenus = getMenusOfType(settings, 'beer_pours');
      const beerMenus = beerPourMenus.filter(m => /beer/i.test(m.label));
      const beerToSync = beerMenus.length > 0 ? beerMenus : (beerPourMenus.length > 0 ? [beerPourMenus[0]] : []);
      let allBeerIds = new Set();
      for (const bm of beerToSync) {
        extractItemsFromMenu(menus, bm.guid, stockData).forEach(b => allBeerIds.add(b.id));
      }
      await purgeOrphanedEnrichment(db, 'beers', 'beerEnrichment', [...allBeerIds], 'beer-cleanup');
      results.beer = allBeerIds.size;

      // Pours
      const pourMenus = beerPourMenus.filter(m => /pour|spirit|whiskey|bourbon|tequila|premium/i.test(m.label));
      const poursToSync = pourMenus.length > 0 ? pourMenus : (beerPourMenus.length > 1 ? [beerPourMenus[1]] : []);
      let allPourIds = new Set();
      for (const pm of poursToSync) {
        extractItemsFromMenu(menus, pm.guid, stockData).forEach(p => allPourIds.add(p.id));
      }
      await purgeOrphanedEnrichment(db, 'pours', 'poursEnrichment', [...allPourIds], 'pours-cleanup');
      results.pours = allPourIds.size;

      return res.json({ ok: true, validCounts: results, message: 'Orphaned records purged across all categories.' });
    } catch (e) {
      console.error('cleanupOrphanedData error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  });

// ─── Save Menu ────────────────────────────────────────────────────────────────
exports.saveMenu = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { favorites } = req.body;
    if (!favorites || !Array.isArray(favorites)) return res.status(400).json({ error: 'Invalid data' });
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let menuId = '';
    for (let i = 0; i < 6; i++) menuId += chars[Math.floor(Math.random() * chars.length)];
    const createdAt = Date.now();
    await admin.database().ref(`savedMenus/${menuId}`).set({ favorites, createdAt });
    res.json({ ok: true, menuId, createdAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Get Menu ─────────────────────────────────────────────────────────────────
exports.getMenu = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'No menu ID' });
  try {
    const snapshot = await admin.database().ref(`savedMenus/${id}`).once('value');
    const data = snapshot.val();
    if (!data) return res.status(404).json({ error: 'not_found' });
    // Only check expiry for old records that have an expiresAt field
    if (data.expiresAt && Date.now() > data.expiresAt) {
      await admin.database().ref(`savedMenus/${id}`).remove();
      return res.status(410).json({ error: 'expired' });
    }
    // Convert compact keys back to full field names for GuestMenuScreen
    const fullFavorites = (data.favorites || []).map((f, i) => ({
      id: `shared-${i}`,
      favoriteType: f.t,
      name: f.n,
      courseRole: f.cr,
      price: f.p,
      description: f.d,
      varietal: f.v,
      region: f.r,
      glassPrice: f.gp,
      bottlePrice: f.bp,
      reason: f.rs,
      courseLabel: f.cl,
      fromPairing: f.fp,
      imageUrl: f.img || null,
    }));
    res.json({ ok: true, favorites: fullFavorites, expiresAt: data.expiresAt, createdAt: data.createdAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Send Menu Email ──────────────────────────────────────────────────────────
exports.sendMenuEmail = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { email, menuId } = req.body;
    if (!email || !menuId) return res.status(400).json({ error: 'Missing email or menu ID' });
    const snapshot = await admin.database().ref(`savedMenus/${menuId}`).once('value');
    const data = snapshot.val();
    if (!data || Date.now() > data.expiresAt) return res.status(410).json({ error: 'expired' });
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) return res.status(503).json({ error: 'not_configured' });
    const menuUrl = `https://corduroy-wine-list.vercel.app/?m=${menuId}`;
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Appalachia Kitchen <menu@corduroy-inn.com>',
        to: email,
        subject: 'Your Menu from Appalachia Kitchen',
        html: `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#1e1100;color:#f0e8d8;"><div style="text-align:center;margin-bottom:24px;"><div style="color:#c9a96e;font-size:11px;letter-spacing:3px;text-transform:uppercase;margin-bottom:8px;">Your Evening at</div><div style="font-size:22px;margin-bottom:4px;">Appalachia Kitchen</div><div style="color:#5a4030;font-size:12px;">Corduroy Inn &amp; Lodge &middot; Snowshoe Mountain, WV</div></div><p style="color:#9a8060;font-size:14px;line-height:1.6;">Thank you for dining with us. Here is a link to your menu from this evening:</p><div style="text-align:center;margin:24px 0;"><a href="${menuUrl}" style="background:#c9a96e;color:#0d0800;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:600;">View My Menu</a></div><p style="color:#5a4030;font-size:11px;text-align:center;">We hope to see you again soon.</p></div>`
      })
    });
    if (emailRes.ok) res.json({ ok: true });
    else res.status(500).json({ error: 'send_failed' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Sommelier Chat Endpoint ──────────────────────────────────────────────────
// Hard-boxed to F&B at Appalachia Kitchen only. No price comparisons to retail
// or other restaurants. No off-topic conversation. Polite redirects for anything
// outside food and beverage.

exports.sommelierChat = functions
  .runWith({ timeoutSeconds: 30, memory: '256MB' })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).send('');

    try {
      const { messages, contextItem, selectedFoods } = req.body;
      if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'messages array required' });
      }

      // Load live menu data from Firebase (including settings for availability filtering)
      const db = admin.database();
      const [
        winesSnap, wineEnrichSnap, wineOrderSnap,
        beersSnap, beerEnrichSnap, beerOrderSnap,
        poursSnap, poursEnrichSnap, poursOrderSnap,
        foodSnap, foodOrderSnap, exclusionsSnap,
        cocktailsSnap, cocktailsOrderSnap,
        nabSnap, nabOrderSnap,
        appSettingsSnap,
      ] = await Promise.all([
        db.ref('wines').once('value'),
        db.ref('wineEnrichment').once('value'),
        db.ref('wineOrder').once('value'),
        db.ref('beers').once('value'),
        db.ref('beerEnrichment').once('value'),
        db.ref('beerOrder').once('value'),
        db.ref('pours').once('value'),
        db.ref('poursEnrichment').once('value'),
        db.ref('poursOrder').once('value'),
        db.ref('foodItems').once('value'),
        db.ref('foodOrder').once('value'),
        db.ref('foodExclusions').once('value'),
        db.ref('cocktails').once('value'),
        db.ref('cocktailsOrder').once('value'),
        db.ref('nab').once('value'),
        db.ref('nabOrder').once('value'),
        db.ref('appSettings').once('value'),
      ]);

      // Check which menu types are currently available per Toast-sourced schedule
      const appSettings = appSettingsSnap.val() || {};
      const configuredMenus = appSettings.menus || [];
      const toastAvailCache = appSettings.toastAvailability || appSettings.settings?.toastAvailability || {};
      function isTypeAvailableNow(menuType) {
        const menusOfType = configuredMenus.filter(m => m.menuType === menuType);
        if (menusOfType.length === 0) return true; // not configured — assume available
        return menusOfType.some(m => isMenuAvailableNow(m, toastAvailCache));
      }
      const wineAvailable     = isTypeAvailableNow('wine');
      const beerPoursAvailable = isTypeAvailableNow('beer_pours');
      const cocktailsNAAvailable = isTypeAvailableNow('cocktails_na');
      const foodAvailable     = isTypeAvailableNow('food');

      // Build wine list
      const winesById = winesSnap.val() || {};
      const wineEnrich = wineEnrichSnap.val() || {};
      const wineOrder = wineOrderSnap.val() || [];
      const orderedWines = (wineOrder.length > 0
        ? wineOrder.map(id => winesById[id]).filter(Boolean)
        : Object.values(winesById)
      ).filter(w => w.available !== false && !(wineEnrich[w.id] && wineEnrich[w.id].uncertain && !wineEnrich[w.id].approved));

      const wineLines = orderedWines.map(w => {
        const e = wineEnrich[w.id] || {};
        const name = e.correctedName || w.name;
        const prices = [];
        if (w.glassPrice) prices.push(`$${Math.round(w.glassPrice)} glass`);
        if (w.bottlePrice) prices.push(`$${Math.round(w.bottlePrice)} bottle`);
        const meta = [e.varietal, e.region].filter(Boolean).join(', ');
        return `  - [id:${w.id}] ${name}${meta ? ` (${meta})` : ''}${prices.length ? ' -- ' + prices.join(', ') : ''}${e.description ? ' | ' + e.description : ''}`;
      });

      // Build beer list
      const beersById = beersSnap.val() || {};
      const beerEnrich = beerEnrichSnap.val() || {};
      const beerOrder = beerOrderSnap.val() || [];
      const orderedBeers = (beerOrder.length > 0
        ? beerOrder.map(id => beersById[id]).filter(Boolean)
        : Object.values(beersById)
      ).filter(b => b.available !== false);

      const beerLines = orderedBeers.map(b => {
        const e = beerEnrich[b.id] || {};
        const price = b.price || b.groupPrice;
        return `  - ${e.correctedName || b.name}${e.style ? ` (${e.style})` : ''}${e.brewery ? ` -- ${e.brewery}` : ''}${price ? ` -- $${Math.round(price)}` : ''}`;
      });

      // Build premium pours list
      const poursById = poursSnap.val() || {};
      const poursEnrich = poursEnrichSnap.val() || {};
      const poursOrder = poursOrderSnap.val() || [];
      const orderedPours = (poursOrder.length > 0
        ? poursOrder.map(id => poursById[id]).filter(Boolean)
        : Object.values(poursById)
      ).filter(p => p.available !== false);

      const pourLines = orderedPours.map(p => {
        const e = poursEnrich[p.id] || {};
        const price = p.price || p.groupPrice;
        return `  - ${e.correctedName || p.name}${e.category ? ` (${e.category})` : ''}${e.producer ? ` -- ${e.producer}` : ''}${price ? ` -- $${Math.round(price)}` : ''}`;
      });

      // Build cocktails list
      const cocktailsById = cocktailsSnap.val() || {};
      const cocktailsOrder = cocktailsOrderSnap.val() || [];
      const orderedCocktails = (cocktailsOrder.length > 0
        ? cocktailsOrder.map(id => cocktailsById[id]).filter(Boolean)
        : Object.values(cocktailsById)
      ).filter(c => c.available !== false);

      const cocktailLines = orderedCocktails.map(c => {
        const price = c.price || c.groupPrice;
        return `  - ${c.name}${price ? ` -- $${Math.round(price)}` : ''}${c.description ? ' | ' + c.description : ''}`;
      });

      // Build NAB list
      const nabById = nabSnap.val() || {};
      const nabOrder = nabOrderSnap.val() || [];
      const orderedNAB = (nabOrder.length > 0
        ? nabOrder.map(id => nabById[id]).filter(Boolean)
        : Object.values(nabById)
      ).filter(n => n.available !== false);

      const nabLines = orderedNAB.map(n => {
        const price = n.price || n.groupPrice;
        return `  - ${n.name}${n.subgroup ? ` (${n.subgroup})` : ''}${price ? ` -- $${Math.round(price)}` : ''}`;
      });

      // Build food menu grouped by course
      const foodById = foodSnap.val() || {};
      const foodOrder = foodOrderSnap.val() || [];
      const exclusions = exclusionsSnap.val() || {};
      const orderedFood = (foodOrder.length > 0
        ? foodOrder.map(id => foodById[id]).filter(Boolean)
        : Object.values(foodById)
      ).filter(f => !exclusions[f.id]);

      const foodByCourse = {};
      orderedFood.forEach(f => {
        if (!foodByCourse[f.course]) foodByCourse[f.course] = [];
        foodByCourse[f.course].push(f);
      });
      const foodSection = Object.entries(foodByCourse).map(([course, items]) =>
        `  ${course}:\n` + items.map(f =>
          `    - [id:${f.id}] ${f.name}${f.price ? ` ($${Math.round(f.price)})` : ''}${f.description ? ': ' + f.description : ''}`
        ).join('\n')
      ).join('\n');

      // Assemble the full menu block — only include sections whose menu type is currently available
      const menuBlock = [
        (wineAvailable && wineLines.length)          ? `WINES:\n${wineLines.join('\n')}` : null,
        (beerPoursAvailable && beerLines.length)      ? `BEERS:\n${beerLines.join('\n')}` : null,
        (beerPoursAvailable && pourLines.length)      ? `PREMIUM POURS:\n${pourLines.join('\n')}` : null,
        (cocktailsNAAvailable && cocktailLines.length) ? `SPECIALTY COCKTAILS:\n${cocktailLines.join('\n')}` : null,
        (cocktailsNAAvailable && nabLines.length)     ? `NON-ALCOHOLIC BEVERAGES:\n${nabLines.join('\n')}` : null,
        (foodAvailable && foodSection)                ? `FOOD MENU:\n${foodSection}` : null,
      ].filter(Boolean).join('\n\n');

      let contextLine;
      if (selectedFoods && selectedFoods.length > 0) {
        const foodNames = selectedFoods.map(f => f.name).join(', ');
        contextLine = `The guest has selected the following dishes and wants wine pairing recommendations: ${foodNames}. Use these as your starting point and recommend wines from the menu that pair well with this specific selection.`;
      } else if (contextItem) {
        contextLine = `The guest opened this chat from the ${contextItem.name} (${contextItem.type}) detail page. Use that as your starting point.`;
      } else {
        contextLine = 'The guest opened this chat from the main menu.';
      }

      // Build lookup maps keyed by Firebase ID -- names are display-only
      const wineById = {};
      orderedWines.forEach(w => {
        const e = wineEnrich[w.id] || {};
        wineById[w.id] = { id: w.id, name: e.correctedName || w.name, varietal: e.varietal || null, region: e.region || null, glassPrice: w.glassPrice || null, bottlePrice: w.bottlePrice || null, imageUrl: w.toastImageUrl || null };
      });
      const foodById2 = {};
      orderedFood.forEach(f => {
        foodById2[f.id] = { id: f.id, name: f.name, course: f.course, price: f.price || null, description: f.description || null };
      });

      // System prompt instructs Claude to return structured JSON so we can
      // surface every recommendation as an actionable chip -- no fuzzy matching needed
      const systemPrompt = `You are the virtual sommelier and food & beverage guide at Appalachia Kitchen at Corduroy Inn & Lodge on Snowshoe Mountain, West Virginia. You are knowledgeable, warm, and concise -- you are talking to a guest at the table, not writing an essay.

${contextLine}

You have full access to tonight's complete menu below. Use it to give specific, confident recommendations by name. When a guest asks about food pairings, dietary needs, or what's available, answer directly from the menu -- do not tell guests to ask their server for information you already have here.

TONIGHT'S COMPLETE MENU:
${menuBlock}

STRICT RULES -- never break these under any circumstances:
1. NEVER compare our prices to retail wine shop prices, grocery store prices, or prices at other restaurants. If asked, say: "I'm not able to make that comparison, but I'm happy to help you find something you'll love tonight."
2. NEVER discuss topics outside food and beverage -- sports, news, weather, travel, politics, entertainment, or anything else unrelated to tonight's dining. Politely redirect: "I'm best at helping you find something delicious tonight -- what can I help you with?"
3. ONLY recommend items that appear in the menu above. Do not invent dishes or beverages.
4. Keep responses concise and conversational -- 2-4 sentences is right. Guests are at the table.
5. When asked about dietary needs (gluten-free, vegetarian, etc.), use your knowledge of ingredients to give a helpful answer, and note that the server should confirm for serious allergy concerns.

RESPONSE FORMAT -- you MUST always respond with valid JSON in this exact shape and nothing else:
{
  "reply": "Your warm conversational response to the guest here",
  "recommended": ["id:wine-abc123", "id:food-xyz456"]
}
The "recommended" array must contain the [id:...] values of every food dish or wine you mention as a recommendation in this turn, taken exactly from the menu above (e.g. if the menu shows "[id:wine-abc123] Opus One 2021", put "wine-abc123" in the array). If you are not recommending specific items this turn (e.g. asking a clarifying question), use an empty array.`;

      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-6',
          max_tokens: 600,
          system: systemPrompt,
          messages: messages.map(m => ({ role: m.role, content: m.content })),
        },
        {
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
        }
      );

      // Parse the structured JSON response
      let reply = '';
      let suggestions = [];
      try {
        const raw = response.data.content[0].text;
        const jsonStart = raw.indexOf('{');
        const jsonEnd = raw.lastIndexOf('}');
        const parsed = JSON.parse(jsonStart !== -1 && jsonEnd !== -1 ? raw.slice(jsonStart, jsonEnd + 1) : raw);
        reply = parsed.reply || '';
        // Resolve each recommended ID to its full menu item object
        const recommended = parsed.recommended || [];
        for (const id of recommended) {
          if (wineById[id]) {
            suggestions.push({ type: 'wine', ...wineById[id] });
          } else if (foodById2[id]) {
            suggestions.push({ type: 'food', ...foodById2[id] });
          }
        }
      } catch (e) {
        // If JSON parse fails, fall back to plain text with no chips
        reply = response.data.content[0].text;
        suggestions = [];
      }

      return res.json({ reply, suggestions });
    } catch (error) {
      console.error('sommelierChat error:', error.message);
      return res.status(500).json({ error: error.message });
    }
  });

// ─── Re-enrich Single Item ────────────────────────────────────────────────────
// Clears existing enrichment for one item and re-runs it through Claude fresh.
// This catches items enriched before the uncertain/review system was added.

exports.reenrichItem = functions
  .runWith({ timeoutSeconds: 60, memory: '256MB' })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).send('');

    try {
      const { itemId, itemType, itemName, hints = {} } = req.body;
      if (!itemId || !itemType || !itemName) {
        return res.status(400).json({ error: 'itemId, itemType, and itemName required' });
      }

      const db = admin.database();
      let enrichment = null;
      let enrichPath = null;
      let enrichData = null;

      if (itemType === 'wine') {
        enrichPath = `wineEnrichment/${itemId}`;
        const vintage = parseVintage(itemName);
        enrichment = await enrichWineWithClaude(itemName, vintage, hints);
        if (!enrichment) return res.status(500).json({ error: 'Claude enrichment returned nothing' });
        enrichData = {
          sourceName: itemName,
          correctedName: hints.correctedName || enrichment.correctedName || itemName,
          uncertain: enrichment.uncertain || false,
          uncertainReason: enrichment.uncertainReason || null,
          varietal: hints.varietal || enrichment.varietal || null,
          region: hints.region || enrichment.region || null,
          description: enrichment.description || null,
          reviews: enrichment.reviews || null,
          labelImageQuery: enrichment.labelImageQuery || null,
          vintage,
          enrichedAt: Date.now(),
          reEnrichedAt: Date.now(),
          manuallyEdited: Object.keys(hints).length > 0,
          approved: false,
        };

      } else if (itemType === 'beer') {
        enrichPath = `beerEnrichment/${itemId}`;
        enrichment = await enrichBeerWithClaude(itemName, hints);
        if (!enrichment) return res.status(500).json({ error: 'Claude enrichment returned nothing' });
        enrichData = {
          sourceName: itemName,
          correctedName: hints.correctedName || enrichment.correctedName || itemName,
          uncertain: enrichment.uncertain || false,
          uncertainReason: enrichment.uncertainReason || null,
          style: hints.style || enrichment.style || null,
          brewery: hints.brewery || enrichment.brewery || null,
          abv: hints.abv || enrichment.abv || null,
          description: enrichment.description || null,
          imageQuery: enrichment.imageQuery || null,
          enrichedAt: Date.now(),
          reEnrichedAt: Date.now(),
          manuallyEdited: Object.keys(hints).length > 0,
          approved: false,
        };

      } else if (itemType === 'pour') {
        enrichPath = `poursEnrichment/${itemId}`;
        enrichment = await enrichPourWithClaude(itemName, hints);
        if (!enrichment) return res.status(500).json({ error: 'Claude enrichment returned nothing' });
        enrichData = {
          sourceName: itemName,
          correctedName: hints.correctedName || enrichment.correctedName || itemName,
          uncertain: enrichment.uncertain || false,
          uncertainReason: enrichment.uncertainReason || null,
          category: hints.category || enrichment.category || null,
          producer: hints.producer || enrichment.producer || null,
          abv: hints.abv || enrichment.abv || null,
          age: hints.age || enrichment.age || null,
          description: enrichment.description || null,
          imageQuery: enrichment.imageQuery || null,
          enrichedAt: Date.now(),
          reEnrichedAt: Date.now(),
          manuallyEdited: Object.keys(hints).length > 0,
          approved: false,
        };

      } else {
        return res.status(400).json({ error: `itemType "${itemType}" does not support enrichment` });
      }

      await db.ref(enrichPath).set(enrichData);
      console.log(`Re-enriched ${itemType} "${itemName}" (${itemId}) — uncertain: ${enrichData.uncertain}`);

      res.json({
        ok: true,
        uncertain: enrichData.uncertain,
        uncertainReason: enrichData.uncertainReason || null,
        enrichment: enrichData,
      });

    } catch (error) {
      console.error('reenrichItem error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

// ─── Get App Settings ─────────────────────────────────────────────────────────

exports.getSettings = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  try {
    const db = admin.database();
    const snap = await db.ref('appSettings').once('value');
    res.json({ settings: snap.val() || { menus: [] } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Save App Settings ────────────────────────────────────────────────────────

exports.saveSettings = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');

  try {
    const { action, settings, guid } = req.body;

    // ── Fetch Toast availability for a single GUID (used by Settings "Check" button) ──
    if (action === 'fetchAvailability') {
      if (!guid) return res.status(400).json({ error: 'guid required' });
      try {
        const token = await getToastToken();
        const menus = await getMenus(token);
        // Find menu or group matching this GUID
        let found = menus.menus.find(m => m.guid === guid);
        let itemCount = 0;
        let menuName = null;
        let availSchedule = null;

        if (found) {
          menuName = found.name;
          // Handle both Toast field name variants for top-level menus
          if (found.availabilitySchedules && found.availabilitySchedules.length > 0) {
            availSchedule = found.availabilitySchedules;
          } else if (found.availability && found.availability.schedule && found.availability.schedule.length > 0) {
            availSchedule = found.availability.schedule.map(s => ({
              availableDays: s.days || null,
              timeRanges: (s.timeRanges || []).map(tr => ({ startTime: tr.start, endTime: tr.end }))
            }));
          } else {
            availSchedule = null;
          }
          // Count all items recursively
          function countItems(group) {
            let c = (group.menuItems || []).length;
            (group.menuGroups || []).forEach(sg => { c += countItems(sg); });
            return c;
          }
          (found.menuGroups || []).forEach(g => { itemCount += countItems(g); });
        } else {
          // Search as a group — inherit availability from parent menu since
          // Toast does not set availabilitySchedules at the group level
          for (const m of menus.menus) {
            const group = findGroupByGuid(m.menuGroups || [], guid);
            if (group) {
              found = group;
              menuName = group.name;
              // Groups never have their own schedule in Toast — always inherit from parent menu
              availSchedule = (m.availabilitySchedules && m.availabilitySchedules.length > 0)
                ? m.availabilitySchedules
                : null;
              function countGrpItems(g) {
                let c = (g.menuItems || []).length;
                (g.menuGroups || []).forEach(sg => { c += countGrpItems(sg); });
                return c;
              }
              itemCount = countGrpItems(group);
              break;
            }
          }
        }

        if (!found) return res.json({ availability: null, error: 'GUID not found in Toast' });

        // Parse Toast availability schedule if present
        let toastDays = null;
        let toastHours = null;
        if (availSchedule && Array.isArray(availSchedule) && availSchedule.length > 0) {
          const sched = availSchedule[0];
          toastDays = sched.availableDays || null;
          if (sched.timeRanges && sched.timeRanges.length > 0) {
            toastHours = { open: sched.timeRanges[0].startTime, close: sched.timeRanges[0].endTime };
          }
        }

        return res.json({
          availability: {
            name: menuName,
            itemCount,
            toastDays,
            toastHours,
            guid,
            checkedAt: Date.now()
          }
        });
      } catch (e) {
        return res.json({ availability: null, error: e.message });
      }
    }

    // ── Save full settings ──
    if (!settings) return res.status(400).json({ error: 'settings required' });
    const db = admin.database();
    await db.ref('appSettings').set({ ...settings, updatedAt: Date.now() });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Cleanup Expired Menus (runs daily at 3 AM) ───────────────────────────────
exports.cleanupExpiredMenus = functions
  .pubsub.schedule('0 3 * * *')
  .onRun(async (context) => {
    const snapshot = await admin.database().ref('savedMenus').once('value');
    const menus = snapshot.val();
    if (!menus) return null;
    const now = Date.now();
    const updates = {};
    Object.entries(menus).forEach(([id, data]) => { if (data.expiresAt < now) updates[id] = null; });
    if (Object.keys(updates).length > 0) await admin.database().ref('savedMenus').update(updates);
    return null;
  });

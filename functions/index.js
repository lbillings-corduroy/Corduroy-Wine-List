const functions = require('firebase-functions');
const admin = require('firebase-admin');
const axios = require('axios');

admin.initializeApp();

const TOAST_API_URL = process.env.TOAST_API_URL || 'https://ws-api.toasttab.com';
const TOAST_CLIENT_ID = process.env.TOAST_CLIENT_ID;
const TOAST_CLIENT_SECRET = process.env.TOAST_CLIENT_SECRET;
const TOAST_RESTAURANT_GUID = process.env.TOAST_RESTAURANT_GUID;

const WINE_MENU_GUID = '2d490bef-759b-447f-9af4-5bf0971948ba';

async function getToastToken() {
  const response = await axios.post(
    `${TOAST_API_URL}/authentication/v1/authentication/login`,
    {
      clientId: TOAST_CLIENT_ID,
      clientSecret: TOAST_CLIENT_SECRET,
      userAccessType: 'TOAST_MACHINE_CLIENT'
    },
    {
      headers: { 'Content-Type': 'application/json' }
    }
  );
  return response.data.token.accessToken;
}

async function getMenus(token) {
  const response = await axios.get(`${TOAST_API_URL}/menus/v2/menus`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Toast-Restaurant-External-ID': TOAST_RESTAURANT_GUID
    }
  });
  return response.data;
}

async function getStockData(token) {
  try {
    const response = await axios.get(`${TOAST_API_URL}/stock/v1/inventory`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Toast-Restaurant-External-ID': TOAST_RESTAURANT_GUID
      }
    });
    return response.data;
  } catch (error) {
    console.log('Stock data unavailable:', error.message);
    return [];
  }
}

function extractWines(menus, stockData) {
  const wines = [];

  // Find the wine menu by GUID
  const wineMenu = menus.menus.find(m => m.guid === WINE_MENU_GUID);
  if (!wineMenu) {
    console.log('Wine menu not found! Available menus:', menus.menus.map(m => `${m.name} (${m.guid})`));
    return wines;
  }

  console.log(`Found wine menu: ${wineMenu.name}`);

  // Build stock lookup map
  const stockMap = {};
  if (Array.isArray(stockData)) {
    stockData.forEach(item => {
      if (item.menuItem && item.menuItem.guid) {
        stockMap[item.menuItem.guid] = item;
      }
    });
  }

  // Extract wines from each menu group (HOUSE, CELLAR, etc.)
  wineMenu.menuGroups.forEach(group => {
    console.log(`Processing group: ${group.name}`);
    
    if (group.menuItems) {
      group.menuItems.forEach(item => {
        // Check stock status
        const stockInfo = stockMap[item.guid];
        const isAvailable = !stockInfo || stockInfo.status !== 'OUT_OF_STOCK';

        wines.push({
          id: item.guid,
          name: item.name,
          description: item.description || '',
          price: item.price,
          tier: group.name, // HOUSE, CELLAR, etc.
          available: isAvailable,
          imageUrl: item.imageUrl || null,
          masterId: item.masterId
        });
      });
    }
  });

  console.log(`Extracted ${wines.length} wines`);
  return wines;
}

exports.syncWineMenu = functions.pubsub
  .schedule('every 30 minutes')
  .onRun(async (context) => {
    try {
      console.log('Starting Toast API sync...');

      const token = await getToastToken();
      console.log('Got Toast token successfully');

      const menus = await getMenus(token);
      const stockData = await getStockData(token);

      const wines = extractWines(menus, stockData);

      const db = admin.database();
      await db.ref('wines').set(wines);
      await db.ref('lastUpdated').set(Date.now());

      console.log(`Saved ${wines.length} wines to Firebase`);
      return null;

    } catch (error) {
      console.error('Sync error:', error.message);
      if (error.response) {
        console.error('API response:', JSON.stringify(error.response.data));
      }
      return null;
    }
  });

exports.getWines = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const db = admin.database();
    const winesSnapshot = await db.ref('wines').once('value');
    const lastUpdatedSnapshot = await db.ref('lastUpdated').once('value');
    
    const wines = winesSnapshot.val();
    const lastUpdated = lastUpdatedSnapshot.val();
    
    res.json({
      wines: wines || [],
      lastUpdated: lastUpdated || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

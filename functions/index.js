const functions = require('firebase-functions');
const admin = require('firebase-admin');
const axios = require('axios');
 
admin.initializeApp();
 
const TOAST_API_URL = process.env.TOAST_API_URL || 'https://ws-api.toasttab.com';
const TOAST_CLIENT_ID = process.env.TOAST_CLIENT_ID;
const TOAST_CLIENT_SECRET = process.env.TOAST_CLIENT_SECRET;
const TOAST_RESTAURANT_GUID = process.env.TOAST_RESTAURANT_GUID;
 
async function getToastToken() {
  const response = await axios.post(
    `${TOAST_API_URL}/authentication/v1/authentication/login`,
    {
      clientId: TOAST_CLIENT_ID,
      clientSecret: TOAST_CLIENT_SECRET,
      userAccessType: 'TOAST_MACHINE_CLIENT'
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Toast-Restaurant-External-ID': TOAST_RESTAURANT_GUID
      }
    }
  );
  return response.data.token.accessToken;
}
 
async function getWineMenu(token) {
  const response = await axios.get(`${TOAST_API_URL}/menus/v2/menus`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Toast-Restaurant-External-ID': TOAST_RESTAURANT_GUID
    }
  });
  return response.data;
}
 
async function getStockData(token) {
  const response = await axios.get(`${TOAST_API_URL}/stock/v1/inventory`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Toast-Restaurant-External-ID': TOAST_RESTAURANT_GUID
    }
  });
  return response.data;
}
 
exports.syncWineMenu = functions.pubsub
  .schedule('every 30 minutes')
  .onRun(async (context) => {
    try {
      console.log('Starting Toast API sync...');
 
      const token = await getToastToken();
      console.log('Got Toast token successfully');
 
      const menus = await getWineMenu(token);
      const stock = await getStockData(token);
 
      console.log('Got menu data:', JSON.stringify(menus).substring(0, 500));
 
      const db = admin.database();
      await db.ref('wineData').set({
        menus: menus,
        stock: stock,
        lastUpdated: Date.now()
      });
 
      console.log('Wine data saved to Firebase successfully');
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
    const snapshot = await db.ref('wineData').once('value');
    const data = snapshot.val();
    res.json(data || { error: 'No data yet' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

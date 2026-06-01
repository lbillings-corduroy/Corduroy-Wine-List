import { useState, useEffect, useRef } from "react";

const FIREBASE_URL = "https://us-central1-corduroy-wine-list.cloudfunctions.net/getWines";
const BEER_URL = "https://us-central1-corduroy-wine-list.cloudfunctions.net/getBeers";
const POURS_URL = "https://us-central1-corduroy-wine-list.cloudfunctions.net/getPours";
const MANAGER_PIN = process.env.REACT_APP_MANAGER_PIN || "0000";
const FOOD_URL = "https://us-central1-corduroy-wine-list.cloudfunctions.net/getFoodItems";
const COCKTAILS_URL = "https://us-central1-corduroy-wine-list.cloudfunctions.net/getCocktails";
const NAB_URL = "https://us-central1-corduroy-wine-list.cloudfunctions.net/getNAB";
const PAIRING_URL = "https://us-central1-corduroy-wine-list.cloudfunctions.net/getPairing";
const MANAGER_UPDATE_URL = "https://us-central1-corduroy-wine-list.cloudfunctions.net/managerUpdateEnrichment";
const FORCE_SYNC_URL = "https://us-central1-corduroy-wine-list.cloudfunctions.net/forceSync";
const SAVE_MENU_URL = "https://us-central1-corduroy-wine-list.cloudfunctions.net/saveMenu";
const GET_MENU_URL  = "https://us-central1-corduroy-wine-list.cloudfunctions.net/getMenu";
const SEND_EMAIL_URL = "https://us-central1-corduroy-wine-list.cloudfunctions.net/sendMenuEmail";
const RESERVATION_URL = "https://www.appalachiakitchen.com/";
const CHAT_URL = "https://us-central1-corduroy-wine-list.cloudfunctions.net/sommelierChat";

// Tiers and subgroups are derived dynamically from Toast data in arrival order.
// TIER_LABELS just controls the short display name in the filter buttons — add entries as needed.
const TIER_LABELS = { "House Wines": "House", "Cellar Wines": "Cellar", "London's List": "London's List" };

const VARIETAL_GROUPS = {
  "Sparkling": ["Prosecco", "Champagne", "Sparkling", "Cava"],
  "Rosé": ["Rosé"],
  "Port": ["Port"],
};

function consolidateVarietal(v) {
  if (!v) return null;
  for (const [group, members] of Object.entries(VARIETAL_GROUPS)) {
    if (members.includes(v)) return group;
  }
  return v;
}

function formatPrice(p) { return p ? `$${Math.round(p)}` : null; }
function timeAgo(ts) {
  if (!ts) return "";
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)}hr ago`;
}

function FilterBtn({ label, active, onClick, small }) {
  return (
    <button onClick={onClick} style={{
      background: active ? "#c9a96e" : "rgba(255,255,255,0.07)",
      border: `0.5px solid ${active ? "#c9a96e" : "rgba(201,169,110,0.25)"}`,
      color: active ? "#0f0800" : "#c8a878",
      fontSize: small ? 10 : 11,
      padding: small ? "4px 11px" : "6px 15px",
      borderRadius: 20, cursor: "pointer",
      letterSpacing: "0.5px", fontFamily: "Georgia, serif",
      fontWeight: active ? 600 : 400, transition: "all 0.15s",
      whiteSpace: "nowrap"
    }}>{label}</button>
  );
}

// ─── Copy Button ─────────────────────────────────────────────────────────────

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <button onClick={handleCopy} style={{
      background: copied ? "rgba(76,175,125,0.2)" : "rgba(201,169,110,0.2)",
      border: `0.5px solid ${copied ? "#4caf7d" : "#c9a96e"}`,
      color: copied ? "#4caf7d" : "#c9a96e",
      fontSize: 11, padding: "4px 12px", borderRadius: 5,
      cursor: "pointer", fontFamily: "Georgia, serif",
      transition: "all 0.2s", whiteSpace: "nowrap"
    }}>
      {copied ? "✓ Copied" : "Copy Name"}
    </button>
  );
}

// ─── Manager Screen ───────────────────────────────────────────────────────────

function normalizeName(name) {
  return (name || "")
    .toLowerCase()
    .replace(/\b(glass|bottle|btl|gls)\b/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findDuplicates(wines) {
  const groups = {};
  wines.forEach(w => {
    const key = normalizeName(w.name);
    if (!groups[key]) groups[key] = [];
    groups[key].push(w);
  });
  // Return groups with more than one wine, excluding valid glass/bottle pairs
  return Object.values(groups).filter(group => {
    if (group.length < 2) return false;
    // If exactly 2 wines and one has glassPrice and the other has bottlePrice — valid pair, not a duplicate
    if (group.length === 2) {
      const hasGlass = group.some(w => w.glassPrice && !w.bottlePrice);
      const hasBottle = group.some(w => w.bottlePrice && !w.glassPrice);
      if (hasGlass && hasBottle) return false;
    }
    return true;
  });
}

// ─── Smart Polling Schedule ───────────────────────────────────────────────────
// Returns the appropriate polling interval in ms based on Snowshoe season & time
function getPollingInterval() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1; // 1–12
  const day   = now.getDate();
  const dow   = now.getDay();        // 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
  const hour  = now.getHours();

  const ACTIVE = 2  * 60 * 1000;    // 2 min  — active service hours
  const SLOW   = 60 * 60 * 1000;    // 60 min — off-hours on an open day
  const CLOSED = 6  * 60 * 60 * 1000; // 6 hrs  — fully closed season

  function nthWeekday(y, m, n, wd) { // nth occurrence of weekday wd in month m
    let count = 0;
    for (let d = 1; d <= 31; d++) {
      const dt = new Date(y, m - 1, d);
      if (dt.getMonth() !== m - 1) break;
      if (dt.getDay() === wd) { count++; if (count === n) return dt; }
    }
  }
  function lastWeekday(y, m, wd) { // last occurrence of weekday wd in month m
    let last = null;
    for (let d = 1; d <= 31; d++) {
      const dt = new Date(y, m - 1, d);
      if (dt.getMonth() !== m - 1) break;
      if (dt.getDay() === wd) last = dt;
    }
    return last;
  }

  const thanksgiving    = nthWeekday(year, 11, 4, 4);         // 4th Thu of Nov
  const dayBeforeThanks = new Date(thanksgiving.getTime() - 86400000);   // Wed before
  const tueBeforeThanks = new Date(thanksgiving.getTime() - 172800000);  // Tue before
  const memorialDay     = lastWeekday(year, 5, 1);             // last Mon of May
  const thurBeforeMD    = new Date(memorialDay.getTime() - 345600000);   // Thu before MD

  const today = new Date(year, month - 1, day);

  // ── Spring closure: April 1 → Thursday before Memorial Day ─────────────────
  if (today >= new Date(year, 3, 1) && today <= thurBeforeMD) return CLOSED;

  // ── Fall closure: Nov 1 → Tuesday before Thanksgiving ──────────────────────
  if (today >= new Date(year, 10, 1) && today <= tueBeforeThanks) return CLOSED;

  // ── Summer season: Memorial Day → Oct 31 ───────────────────────────────────
  if (today >= memorialDay && today <= new Date(year, 9, 31)) {
    if (dow === 1 || dow === 2) return CLOSED; // Mon/Tue fully closed
    const openHour = (dow === 3 || dow === 4) ? 16 : 11; // Wed/Thu open 4 PM; Fri/Sat/Sun 11 AM
    if (hour >= openHour || hour < 1) return ACTIVE; // active until 1 AM
    return SLOW;
  }

  // ── Winter season: day before Thanksgiving → March 31 ──────────────────────
  // (Catches Jan–Mar automatically, and day-before-Thanksgiving through Dec 31)
  if (hour >= 11 || hour < 1) return ACTIVE; // 11 AM – 1 AM
  return SLOW;
}

// ─── Pairing Loading Messages ─────────────────────────────────────────────────

const SOMMELIER_MESSAGES = [
  "Your Virtual Sommelier is consulting the cellar…",
  "Swirling, sniffing, and considering your options…",
  "Evaluating every bottle on the list…",
  "Checking tannins, acidity, and flavor bridges…",
  "Conferring with the cellar master…",
  "Nose: promising. Palate: almost there…",
  "Decanting the perfect recommendation…",
];

const KITCHEN_MESSAGES = [
  "Stepping into the kitchen…",
  "Consulting with Chef on the perfect match…",
  "Weighing flavors, textures, and bridges…",
  "Almost plated and ready…",
  "Matching the terroir to your table…",
];

function LoadingMessages({ messages, onAllShown }) {
  const [displayIdx, setDisplayIdx] = useState(0);
  const [visible, setVisible] = useState(true);
  const idxRef = useRef(0);
  const shownRef = useRef(0);
  const callbackRef = useRef(onAllShown);
  useEffect(() => { callbackRef.current = onAllShown; }, [onAllShown]);

  useEffect(() => {
    const timer = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        idxRef.current = (idxRef.current + 1) % messages.length;
        shownRef.current++;
        setDisplayIdx(idxRef.current);
        setVisible(true);
        if (shownRef.current >= messages.length) {
          shownRef.current = 0; // reset so it loops if needed
          callbackRef.current?.();
        }
      }, 450);
    }, 2500);
    return () => clearInterval(timer);
  }, [messages.length]);

  return (
    <div style={{ textAlign: "center", padding: "32px 16px" }}>
      <div style={{ fontSize: 28, marginBottom: 16 }}>✦</div>
      <div style={{ opacity: visible ? 1 : 0, transition: "opacity 0.45s ease", color: "#c9a96e", fontSize: 15, fontStyle: "italic", fontFamily: "Georgia, serif", letterSpacing: "0.5px", lineHeight: 1.6 }}>
        {messages[displayIdx]}
      </div>
    </div>
  );
}

// ─── Sync Tab ─────────────────────────────────────────────────────────────────

function SyncTab() {
  const categories = [
    { id: "wine", label: "Wine List" },
    { id: "beer", label: "Beer List" },
    { id: "pours", label: "Premium Pours" },
    { id: "food", label: "Food Menu" },
    { id: "cocktails", label: "Specialty Cocktails" },
    { id: "nab", label: "Non-Alcoholic Beverages" },
  ];
  const [selected, setSelected] = useState(categories.map(c => c.id));
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState(null);

  function toggleCat(id) {
    setSelected(prev => prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]);
  }

  async function handleSync() {
    if (selected.length === 0) return;
    setSyncing(true);
    setResult(null);
    try {
      const res = await fetch(FORCE_SYNC_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categories: selected })
      });
      const data = await res.json();
      setResult({ ok: data.ok, message: data.message || data.error });
    } catch (e) {
      setResult({ ok: false, message: e.message });
    }
    setSyncing(false);
  }

  return (
    <div>
      <div style={{ color: "#6a5040", fontSize: 12, marginBottom: 16, lineHeight: 1.6 }}>
        Select the menus to sync from Toast, then tap Run Sync. Syncs run in the background — allow ~60 seconds for changes to appear in the app.
      </div>

      <div style={{ marginBottom: 16 }}>
        {categories.map(c => (
          <div key={c.id} onClick={() => toggleCat(c.id)}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", marginBottom: 6, background: selected.includes(c.id) ? "rgba(201,169,110,0.1)" : "rgba(255,255,255,0.03)", border: `0.5px solid ${selected.includes(c.id) ? "rgba(201,169,110,0.4)" : "#3c2200"}`, borderRadius: 8, cursor: "pointer" }}>
            <div style={{ width: 18, height: 18, borderRadius: 4, background: selected.includes(c.id) ? "#c9a96e" : "transparent", border: `1.5px solid ${selected.includes(c.id) ? "#c9a96e" : "#6a5040"}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              {selected.includes(c.id) && <span style={{ color: "#0d0800", fontSize: 13, fontWeight: 700, lineHeight: 1 }}>✓</span>}
            </div>
            <span style={{ color: selected.includes(c.id) ? "#f0e8d8" : "#6a5040", fontSize: 13, fontFamily: "Georgia, serif" }}>{c.label}</span>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button onClick={() => setSelected(categories.map(c => c.id))} style={{ background: "none", border: "0.5px solid #3c2200", color: "#6a5040", padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 11 }}>Select All</button>
        <button onClick={() => setSelected([])} style={{ background: "none", border: "0.5px solid #3c2200", color: "#6a5040", padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 11 }}>Clear</button>
      </div>

      <button onClick={handleSync} disabled={syncing || selected.length === 0}
        style={{ width: "100%", background: syncing || selected.length === 0 ? "rgba(201,169,110,0.1)" : "#c9a96e", color: syncing || selected.length === 0 ? "#6a5040" : "#0d0800", border: "none", padding: "13px", borderRadius: 8, cursor: syncing || selected.length === 0 ? "default" : "pointer", fontFamily: "Georgia, serif", fontSize: 14, fontWeight: 600, letterSpacing: "0.5px" }}>
        {syncing ? "Triggering sync…" : `⟳ Sync ${selected.length} Menu${selected.length !== 1 ? "s" : ""} Now`}
      </button>

      {result && (
        <div style={{ marginTop: 14, background: result.ok ? "rgba(76,175,125,0.1)" : "rgba(232,80,80,0.1)", border: `0.5px solid ${result.ok ? "#4caf7d" : "#e85050"}`, borderRadius: 8, padding: "12px 14px" }}>
          <div style={{ color: result.ok ? "#4caf7d" : "#e85050", fontSize: 12, fontFamily: "Georgia, serif", lineHeight: 1.6 }}>{result.message}</div>
        </div>
      )}
    </div>
  );
}

// ─── All Items Tab ────────────────────────────────────────────────────────────

function AllItemsTab({ wines, onWineUpdate, managerSearch }) {
  const [beers, setBeers] = useState([]);
  const [pours, setPours] = useState([]);
  const [food, setFood] = useState([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState("wines");
  const [editingItem, setEditingItem] = useState(null);
  const [editFields, setEditFields] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch(BEER_URL).then(r => r.json()),
      fetch(POURS_URL).then(r => r.json()),
      fetch(FOOD_URL).then(r => r.json()),
    ]).then(([bData, pData, fData]) => {
      setBeers(bData.beers || []);
      setPours(pData.pours || []);
      setFood(fData.foodItems || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  function openEdit(item, type) {
    setEditingItem({ ...item, _type: type });
    if (type === "wine") setEditFields({ correctedName: item.name || "", varietal: item.varietal || "", region: item.region || "", description: item.description || "", reviews: item.reviews || "" });
    else if (type === "beer") setEditFields({ correctedName: item.name || "", style: item.style || "", brewery: item.brewery || "", abv: item.abv || "", description: item.description || "" });
    else if (type === "pour") setEditFields({ correctedName: item.name || "", category: item.category || "", producer: item.producer || "", abv: item.abv || "", description: item.description || "" });
    else if (type === "food") setEditFields({ description: item.description || "", excluded: item.excluded || false });
  }

  async function handleSave() {
    if (!editingItem) return;
    setSaving(true);
    try {
      await fetch(MANAGER_UPDATE_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: editingItem.id, itemType: editingItem._type, updates: editFields })
      });
      const t = editingItem._type;
      if (t === "wine") onWineUpdate(editingItem.id, { ...editFields, name: editFields.correctedName });
      else if (t === "beer") setBeers(prev => prev.map(b => b.id === editingItem.id ? { ...b, ...editFields, name: editFields.correctedName } : b));
      else if (t === "pour") setPours(prev => prev.map(p => p.id === editingItem.id ? { ...p, ...editFields, name: editFields.correctedName } : p));
      else if (t === "food") setFood(prev => prev.map(f => f.id === editingItem.id ? { ...f, ...editFields } : f));
      setEditingItem(null);
    } catch (e) { console.error(e); }
    setSaving(false);
  }

  const q = managerSearch.toLowerCase();
  const filterList = list => q ? list.filter(i => (i.name || "").toLowerCase().includes(q)) : list;

  const categories = [
    { id: "wines", label: "Wines", list: filterList(wines) },
    { id: "beer", label: "Beer", list: filterList(beers) },
    { id: "pours", label: "Pours", list: filterList(pours) },
    { id: "food", label: "Food", list: filterList(food) },
  ];
  const activeList = categories.find(c => c.id === category)?.list || [];

  const inputStyle = { width: "100%", boxSizing: "border-box", background: "rgba(255,255,255,0.06)", border: "0.5px solid #3c2200", color: "#f0e8d8", padding: "8px 10px", borderRadius: 6, fontFamily: "Georgia, serif", fontSize: 12, outline: "none", marginBottom: 8 };
  const labelStyle = { color: "#6a5040", fontSize: 10, letterSpacing: "1px", textTransform: "uppercase", marginBottom: 3, display: "block" };

  if (loading) return <div style={{ color: "#6a5040", textAlign: "center", padding: 40 }}>Loading…</div>;

  return (
    <div style={{ position: "relative", height: "100%" }}>
      {/* Category pills */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {categories.map(c => (
          <button key={c.id} onClick={() => { setCategory(c.id); setEditingItem(null); }} style={{
            background: category === c.id ? "rgba(201,169,110,0.2)" : "rgba(255,255,255,0.04)",
            border: `0.5px solid ${category === c.id ? "#c9a96e" : "#3c2200"}`,
            color: category === c.id ? "#c9a96e" : "#6a5040",
            padding: "5px 14px", borderRadius: 20, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 11
          }}>{c.label} <span style={{ opacity: 0.7 }}>({c.list.length})</span></button>
        ))}
      </div>

      {/* Item list */}
      {activeList.length === 0 ? (
        <div style={{ color: "#5a4030", textAlign: "center", padding: 32 }}>{q ? `No results for "${managerSearch}"` : "No items"}</div>
      ) : activeList.map(item => (
        <div key={item.id} onClick={() => openEdit(item, category === "beer" ? "beer" : category === "pours" ? "pour" : category === "food" ? "food" : "wine")}
          style={{ background: editingItem?.id === item.id ? "rgba(201,169,110,0.08)" : "rgba(255,255,255,0.03)", border: `0.5px solid ${editingItem?.id === item.id ? "rgba(201,169,110,0.4)" : "#3c2200"}`, borderRadius: 8, padding: "10px 12px", marginBottom: 6, cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
          {item.imageUrl && <div style={{ width: 32, height: 44, borderRadius: 3, overflow: "hidden", flexShrink: 0 }}><img src={item.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: "#f0e8d8", fontSize: 13, marginBottom: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.name}</div>
            <div style={{ color: "#6a5040", fontSize: 10 }}>
              {category === "wines" && [item.varietal, item.region].filter(Boolean).join(" · ")}
              {category === "beer" && [item.style, item.brewery].filter(Boolean).join(" · ")}
              {category === "pours" && [item.category, item.producer].filter(Boolean).join(" · ")}
              {category === "food" && item.course}
              {item.manuallyEdited && <span style={{ color: "#4caf7d", marginLeft: 6 }}>✎ edited</span>}
              {item.excluded && <span style={{ color: "#e85050", marginLeft: 6 }}>hidden</span>}
            </div>
          </div>
          <div style={{ color: "#4a3020", fontSize: 18 }}>›</div>
        </div>
      ))}

      {/* Edit panel */}
      {editingItem && (
        <div style={{ position: "sticky", bottom: 0, background: "#4d2e00", border: "0.5px solid #3c2200", borderRadius: "12px 12px 0 0", padding: "16px 16px 20px", marginTop: 8, boxShadow: "0 -8px 32px rgba(0,0,0,0.4)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ color: "#c9a96e", fontSize: 12, letterSpacing: "1px", textTransform: "uppercase" }}>Edit · {editingItem.name}</div>
            <button onClick={() => setEditingItem(null)} style={{ background: "none", border: "none", color: "#6a5040", fontSize: 20, cursor: "pointer", padding: 0 }}>×</button>
          </div>

          {editingItem._type !== "food" && (
            <>
              <label style={labelStyle}>Name</label>
              <input style={inputStyle} value={editFields.correctedName || ""} onChange={e => setEditFields(p => ({ ...p, correctedName: e.target.value }))} />
            </>
          )}
          {editingItem._type === "wine" && (
            <>
              <label style={labelStyle}>Varietal</label>
              <input style={inputStyle} value={editFields.varietal || ""} onChange={e => setEditFields(p => ({ ...p, varietal: e.target.value }))} />
              <label style={labelStyle}>Region</label>
              <input style={inputStyle} value={editFields.region || ""} onChange={e => setEditFields(p => ({ ...p, region: e.target.value }))} />
              <label style={labelStyle}>Reviews & Ratings</label>
              <input style={inputStyle} value={editFields.reviews || ""} onChange={e => setEditFields(p => ({ ...p, reviews: e.target.value }))} />
            </>
          )}
          {editingItem._type === "beer" && (
            <>
              <label style={labelStyle}>Style</label>
              <input style={inputStyle} value={editFields.style || ""} onChange={e => setEditFields(p => ({ ...p, style: e.target.value }))} />
              <label style={labelStyle}>Brewery</label>
              <input style={inputStyle} value={editFields.brewery || ""} onChange={e => setEditFields(p => ({ ...p, brewery: e.target.value }))} />
              <label style={labelStyle}>ABV</label>
              <input style={inputStyle} value={editFields.abv || ""} onChange={e => setEditFields(p => ({ ...p, abv: e.target.value }))} />
            </>
          )}
          {editingItem._type === "pour" && (
            <>
              <label style={labelStyle}>Category</label>
              <input style={inputStyle} value={editFields.category || ""} onChange={e => setEditFields(p => ({ ...p, category: e.target.value }))} />
              <label style={labelStyle}>Producer</label>
              <input style={inputStyle} value={editFields.producer || ""} onChange={e => setEditFields(p => ({ ...p, producer: e.target.value }))} />
              <label style={labelStyle}>ABV</label>
              <input style={inputStyle} value={editFields.abv || ""} onChange={e => setEditFields(p => ({ ...p, abv: e.target.value }))} />
            </>
          )}
          {editingItem._type !== "food" && (
            <>
              <label style={labelStyle}>Tasting Notes</label>
              <textarea style={{ ...inputStyle, height: 72, resize: "vertical" }} value={editFields.description || ""} onChange={e => setEditFields(p => ({ ...p, description: e.target.value }))} />
            </>
          )}
          {editingItem._type === "food" && (
            <>
              <label style={labelStyle}>Description</label>
              <textarea style={{ ...inputStyle, height: 72, resize: "vertical" }} value={editFields.description || ""} onChange={e => setEditFields(p => ({ ...p, description: e.target.value }))} />
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <button onClick={() => setEditFields(p => ({ ...p, excluded: !p.excluded }))}
                  style={{ background: editFields.excluded ? "rgba(232,80,80,0.15)" : "rgba(76,175,125,0.15)", border: `0.5px solid ${editFields.excluded ? "rgba(232,80,80,0.5)" : "#4caf7d"}`, color: editFields.excluded ? "#e85050" : "#4caf7d", padding: "5px 14px", borderRadius: 6, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 11 }}>
                  {editFields.excluded ? "Hidden from guests" : "Visible to guests"}
                </button>
                <span style={{ color: "#5a4030", fontSize: 11 }}>Toggle to hide/show in pairings</span>
              </div>
            </>
          )}
          {editingItem._type !== "food" && (
            <div style={{ color: "#4a3020", fontSize: 11, marginBottom: 12, fontStyle: "italic" }}>Price and availability must be updated in Toast.</div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleSave} disabled={saving} style={{ flex: 1, background: saving ? "rgba(201,169,110,0.1)" : "#c9a96e", color: saving ? "#6a5040" : "#0d0800", border: "none", padding: "10px", borderRadius: 6, cursor: saving ? "default" : "pointer", fontFamily: "Georgia, serif", fontSize: 13, fontWeight: 600 }}>
              {saving ? "Saving…" : "Save Changes"}
            </button>
            <button onClick={() => setEditingItem(null)} style={{ background: "none", border: "0.5px solid #3c2200", color: "#6a5040", padding: "10px 16px", borderRadius: 6, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 13 }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Food Manager Tab ─────────────────────────────────────────────────────────

function FoodManagerTab() {
  const [foodItems, setFoodItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState({});

  useEffect(() => {
    fetch(FOOD_URL).then(r => r.json())
      .then(data => { setFoodItems(data.foodItems || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  async function toggleExclusion(item) {
    setSaving(prev => ({ ...prev, [item.id]: true }));
    const newExcluded = !item.excluded;
    try {
      await fetch("https://us-central1-corduroy-wine-list.cloudfunctions.net/setFoodExclusion", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.id, excluded: newExcluded })
      });
      setFoodItems(prev => prev.map(f => f.id === item.id ? { ...f, excluded: newExcluded } : f));
    } catch (e) { console.error(e); }
    setSaving(prev => ({ ...prev, [item.id]: false }));
  }

  if (loading) return <div style={{ color: "#6a5040", textAlign: "center", padding: 40 }}>Loading food menu…</div>;

  const courseOrder = [...new Map(foodItems.map(f => [f.course, true])).keys()];
  const byCourse = {};
  foodItems.forEach(f => { if (!byCourse[f.course]) byCourse[f.course] = []; byCourse[f.course].push(f); });

  return (
    <div>
      <div style={{ color: "#6a5040", fontSize: 11, marginBottom: 12, lineHeight: 1.5 }}>
        Toggle items off to exclude them from guest food pairings. Items shown to guests are pulled from Toast — use this to hide course markers, add-ons, or anything that shouldn't appear in pairings.
      </div>
      {courseOrder.map(course => (
        <div key={course} style={{ marginBottom: 16 }}>
          <div style={{ color: "#c9a96e", fontSize: 9, letterSpacing: "3px", textTransform: "uppercase", marginBottom: 8, paddingBottom: 6, borderBottom: "0.5px solid #2a1400" }}>{course}</div>
          {byCourse[course].map(item => (
            <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 12, background: "rgba(255,255,255,0.04)", border: `0.5px solid ${item.excluded ? "rgba(232,80,80,0.3)" : "#3c2200"}`, borderRadius: 8, padding: "10px 12px", marginBottom: 6, opacity: item.excluded ? 0.6 : 1 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: item.excluded ? "#6a5040" : "#f0e8d8", fontSize: 13, marginBottom: 1 }}>{item.name}</div>
                {item.description && <div style={{ color: "#5a4030", fontSize: 11, fontStyle: "italic" }}>{item.description}</div>}
                <div style={{ color: "#4a3020", fontSize: 10, marginTop: 2 }}>{formatPrice(item.price)}</div>
              </div>
              <button
                onClick={() => toggleExclusion(item)}
                disabled={saving[item.id]}
                style={{ background: item.excluded ? "rgba(232,80,80,0.15)" : "rgba(76,175,125,0.15)", border: `0.5px solid ${item.excluded ? "rgba(232,80,80,0.5)" : "#4caf7d"}`, color: item.excluded ? "#e85050" : "#4caf7d", padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 11, whiteSpace: "nowrap", flexShrink: 0 }}>
                {saving[item.id] ? "…" : item.excluded ? "Excluded" : "Included"}
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function ManagerScreen({ wines, onClose }) {
  const [activeTab, setActiveTab] = useState("uncertain");
  const [search, setSearch] = useState("");
  const [localWines, setLocalWines] = useState(wines);
  const [allItems, setAllItems] = useState([]); // beers + pours for no-image tab

  useEffect(() => {
    // Fetch all wines including uncertain ones (admin bypass) + beers + pours
    Promise.all([
      fetch(FIREBASE_URL + "?admin=1").then(r => r.json()),
      fetch(BEER_URL + "?admin=1").then(r => r.json()),
      fetch(POURS_URL + "?admin=1").then(r => r.json()),
    ]).then(([wData, bData, pData]) => {
      if (wData.wines) setLocalWines(Array.isArray(wData.wines) ? wData.wines : Object.values(wData.wines));
      const beers = (bData.beers || []).map(i => ({ ...i, _type: "beer" }));
      const pours = (pData.pours || []).map(i => ({ ...i, _type: "pour" }));
      setAllItems([...beers, ...pours]);
    }).catch(() => {});
  }, []);

  function handleWineUpdate(id, fields) {
    setLocalWines(prev => prev.map(w => w.id === id ? { ...w, ...fields } : w));
  }

  async function handleApprove(item) {
    const itemType = item._type || "wine";
    try {
      await fetch(MANAGER_UPDATE_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.id, itemType, updates: { uncertain: false, approved: true } })
      });
      if (itemType === "wine") {
        setLocalWines(prev => prev.map(w => w.id === item.id ? { ...w, uncertain: false, approved: true } : w));
      } else {
        // For beer/pours in allItems — just remove from uncertain list on approval
        setAllItems(prev => prev.map(i => i.id === item.id ? { ...i, uncertain: false, approved: true } : i));
      }
    } catch (e) { console.error(e); }
  }

  const q = search.toLowerCase();
  const filterBySearch = list => q ? list.filter(w => (w.name || "").toLowerCase().includes(q)) : list;

  const [reviewSubTab, setReviewSubTab] = useState("pending");

  const uncertainWines = filterBySearch(localWines.filter(w => w.uncertain && !w.approved));
  const uncertainOther = q ? allItems.filter(i => i.uncertain && !i.approved && (i.name || "").toLowerCase().includes(q)) : allItems.filter(i => i.uncertain && !i.approved);
  const uncertain = [...uncertainWines, ...uncertainOther];

  const reviewedWines = filterBySearch(localWines.filter(w => w.approved || w.manuallyEdited));
  const reviewedOther = q ? allItems.filter(i => (i.approved || i.manuallyEdited) && (i.name || "").toLowerCase().includes(q)) : allItems.filter(i => i.approved || i.manuallyEdited);
  const reviewed = [...reviewedWines, ...reviewedOther];
  const noImageWines = filterBySearch(localWines.filter(w => !w.imageUrl));
  const noImageOther = q ? allItems.filter(i => !i.imageUrl && (i.name || "").toLowerCase().includes(q)) : allItems.filter(i => !i.imageUrl);
  const noImage = [...noImageWines, ...noImageOther];
  const noPrice = filterBySearch(localWines.filter(w => !w.glassPrice && !w.bottlePrice));
  const unenriched = filterBySearch(localWines.filter(w => !w.description && !w.varietal));
  const duplicateGroups = findDuplicates(q ? localWines.filter(w => (w.name || "").toLowerCase().includes(q)) : localWines);

  const tabs = [
    { id: "uncertain", label: "⚠️ Review", count: uncertain.length + reviewed.length },
    { id: "noimage", label: "🖼 No Image", count: noImage.length },
    { id: "noprice", label: "$ No Price", count: noPrice.length },
    { id: "unenriched", label: "✍️ No Data", count: unenriched.length },
    { id: "duplicates", label: "♊ Dupes", count: duplicateGroups.length },
    { id: "food", label: "🍽 Food Menu", count: null },
    { id: "all", label: "✎ All Items", count: null },
    { id: "sync", label: "⟳ Sync", count: null },
  ];

  const lists = { uncertain, noimage: noImage, noprice: noPrice, unenriched };
  const current = lists[activeTab] || [];

  return (
    <div style={{ position: "fixed", inset: 0, background: "#3d2200", zIndex: 1000, display: "flex", flexDirection: "column", fontFamily: "Georgia, serif" }}>
      {/* Header */}
      <div style={{ background: "#4d2e00", borderBottom: "1px solid #2a1400", padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ color: "#c9a96e", fontSize: 10, letterSpacing: "3px", textTransform: "uppercase", marginBottom: 2 }}>Manager</div>
            <div style={{ color: "#f0e8d8", fontSize: 18 }}>Wine List Dashboard</div>
          </div>
          <button onClick={onClose} style={{ background: "rgba(201,169,110,0.15)", border: "0.5px solid #c9a96e", color: "#c9a96e", padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 12 }}>
            Close
          </button>
        </div>

        {/* Summary row */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
              width: "calc(25% - 6px)", boxSizing: "border-box", flexShrink: 0,
              background: activeTab === t.id ? (t.id === "sync" ? "rgba(76,175,125,0.2)" : "rgba(201,169,110,0.15)") : t.id === "sync" ? "rgba(76,175,125,0.06)" : "rgba(255,255,255,0.04)",
              border: `0.5px solid ${activeTab === t.id ? (t.id === "sync" ? "#4caf7d" : "#c9a96e") : t.id === "sync" ? "rgba(76,175,125,0.3)" : "#3c2200"}`,
              borderRadius: 8, padding: "10px 4px", cursor: "pointer", textAlign: "center"
            }}>
              <div style={{ color: t.id === "sync" ? "#4caf7d" : t.count === null ? "#c9a96e" : t.count > 0 ? "#e8a050" : "#4caf7d", fontSize: t.id === "sync" ? 16 : t.count === null ? 14 : 20, fontWeight: 600, marginBottom: 2 }}>{t.id === "sync" ? "⟳" : t.count === null ? "" : t.count}</div>
              <div style={{ color: t.id === "sync" ? "#4caf7d" : "#8a7060", fontSize: 9, letterSpacing: "1px", textTransform: "uppercase" }}>{t.label}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Search */}
      <div style={{ padding: "8px 20px 4px", background: "#4d2e00" }}>
        <div style={{ position: "relative" }}>
          <input type="text" placeholder="Search by wine name…" value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: "100%", boxSizing: "border-box", background: "rgba(255,255,255,0.06)", border: "0.5px solid #3c2200", color: "#f0e8d8", padding: "7px 30px 7px 12px", borderRadius: 20, fontFamily: "Georgia, serif", fontSize: 12, outline: "none" }}
          />
          {search && <button onClick={() => setSearch("")} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#6a5040", cursor: "pointer", fontSize: 16, padding: 0 }}>×</button>}
        </div>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
        {/* Review sub-tab switcher — rendered outside ternary to avoid chain break */}
        {activeTab === "uncertain" && (
          <div style={{ display: "flex", background: "rgba(255,255,255,0.04)", borderRadius: 8, padding: 4, marginBottom: 16 }}>
            <button onClick={() => setReviewSubTab("pending")} style={{ flex: 1, padding: "8px", borderRadius: 6, border: "none", cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 12, background: reviewSubTab === "pending" ? "rgba(232,160,80,0.2)" : "transparent", color: reviewSubTab === "pending" ? "#e8a050" : "#6a5040", fontWeight: reviewSubTab === "pending" ? 600 : 400 }}>
              ⚠️ Needs Review ({uncertain.length})
            </button>
            <button onClick={() => setReviewSubTab("reviewed")} style={{ flex: 1, padding: "8px", borderRadius: 6, border: "none", cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 12, background: reviewSubTab === "reviewed" ? "rgba(76,175,125,0.15)" : "transparent", color: reviewSubTab === "reviewed" ? "#4caf7d" : "#6a5040", fontWeight: reviewSubTab === "reviewed" ? 600 : 400 }}>
              ✓ Reviewed ({reviewed.length})
            </button>
          </div>
        )}
        {activeTab === "sync" ? (
          <SyncTab />
        ) : activeTab === "all" ? (
          <AllItemsTab wines={localWines} onWineUpdate={handleWineUpdate} managerSearch={search} />
        ) : activeTab === "food" ? (
          <FoodManagerTab />
        ) : activeTab === "duplicates" ? (
          duplicateGroups.length === 0 ? (
            <div style={{ textAlign: "center", color: "#4caf7d", padding: 40 }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>✓</div>
              <div style={{ fontSize: 14 }}>No duplicates found</div>
            </div>
          ) : duplicateGroups.map((group, gi) => {
            const hasPriceDiff = group.some(w => {
              const price = w.glassPrice || w.bottlePrice;
              return group.some(w2 => (w2.glassPrice || w2.bottlePrice) !== price);
            });
            return (
              <div key={gi} style={{ background: "rgba(255,255,255,0.04)", border: `0.5px solid ${hasPriceDiff ? "rgba(232,80,80,0.4)" : "#3c2200"}`, borderRadius: 8, padding: "12px 14px", marginBottom: 10 }}>
                <div style={{ color: hasPriceDiff ? "#e85050" : "#e8a050", fontSize: 10, letterSpacing: "1px", textTransform: "uppercase", marginBottom: 8 }}>
                  {hasPriceDiff ? "⚠️ Price conflict" : "Duplicate entry"} · {group.length} entries in Toast
                </div>
                {group.map((wine, i) => (
                  <div key={wine.id} style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: i > 0 ? 8 : 0, borderTop: i > 0 ? "0.5px solid #1a0f00" : "none" }}>
                    <div style={{ width: 30, height: 42, borderRadius: 3, background: "#502e00", border: "0.5px solid #2a1400", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, overflow: "hidden" }}>
                      {wine.imageUrl ? <img src={wine.imageUrl} alt={wine.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : "🍷"}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: "#f0e8d8", fontSize: 13 }}>{wine.name}</div>
                      <div style={{ color: "#6a5040", fontSize: 10 }}>
                        {wine._type === "beer" ? ["Beer", wine.style, wine.brewery].filter(Boolean).join(" · ")
                          : wine._type === "pour" ? ["Pour", wine.category, wine.producer].filter(Boolean).join(" · ")
                          : [wine.subgroup, wine.tier].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      {wine.glassPrice && <div style={{ color: "#c9a96e", fontSize: 12 }}>{formatPrice(wine.glassPrice)} glass</div>}
                      {wine.bottlePrice && <div style={{ color: "#c9a96e", fontSize: 12 }}>{formatPrice(wine.bottlePrice)} btl</div>}
                      {!wine.glassPrice && !wine.bottlePrice && <div style={{ color: "#6a5040", fontSize: 11, fontStyle: "italic" }}>No price</div>}
                    </div>
                  </div>
                ))}
                <div style={{ marginTop: 10, color: "#6a5040", fontSize: 11, fontStyle: "italic", borderTop: "0.5px solid #1a0f00", paddingTop: 8 }}>
                  Remove the duplicate{hasPriceDiff ? " and correct the price" : ""} in Toast — it will update on next sync
                </div>
              </div>
            );
          })
        ) : (activeTab === "uncertain" && reviewSubTab === "pending" && uncertain.length === 0) ? (
          <div style={{ textAlign: "center", color: "#4caf7d", padding: 40 }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>✓</div>
            <div style={{ fontSize: 14 }}>Nothing needs review</div>
          </div>
        ) : (activeTab === "uncertain" && reviewSubTab === "reviewed" && reviewed.length === 0) ? (
          <div style={{ textAlign: "center", color: "#6a5040", padding: 40 }}>
            <div style={{ fontSize: 14 }}>No reviewed items yet</div>
          </div>
        ) : (activeTab !== "uncertain" && current.length === 0) ? (
          <div style={{ textAlign: "center", color: "#4caf7d", padding: 40 }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>✓</div>
            <div style={{ fontSize: 14 }}>All clear</div>
          </div>
        ) : (
          (activeTab === "uncertain" ? (reviewSubTab === "pending" ? uncertain : reviewed) : current).map(wine => (
            <div key={wine.id} style={{ background: "rgba(255,255,255,0.04)", border: "0.5px solid #2a1400", borderRadius: 8, padding: "12px 14px", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                {/* Image or placeholder */}
                <div style={{ width: 36, height: 50, borderRadius: 3, background: "#502e00", border: "0.5px solid #2a1400", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, overflow: "hidden" }}>
                  {wine.imageUrl ? <img src={wine.imageUrl} alt={wine.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : "🍷"}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: "#f0e8d8", fontSize: 13, marginBottom: 2 }}>{wine.name}</div>
                  <div style={{ color: "#6a5040", fontSize: 10, letterSpacing: "0.5px" }}>
                    {wine.subgroup} · {wine.tier}
                  </div>
                  {activeTab === "uncertain" && reviewSubTab === "reviewed" && (
                    <div style={{ marginTop: 6 }}>
                      <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(76,175,125,0.1)", border: "0.5px solid #4caf7d", borderRadius: 6, padding: "4px 10px" }}>
                        <span style={{ color: "#4caf7d", fontSize: 11 }}>✓ {wine.manuallyEdited ? "Manually edited" : "Approved by manager"}</span>
                      </div>
                    </div>
                  )}
                  {activeTab === "uncertain" && reviewSubTab === "pending" && (
                    <div style={{ marginTop: 6 }}>
                      {(wine.uncertainReason || wine.uncertain_reason) && (
                        <div style={{ color: "#e8a050", fontSize: 11, marginBottom: 6, fontStyle: "italic" }}>
                          {wine.uncertainReason || wine.uncertain_reason}
                        </div>
                      )}
                      {wine.correctedName && wine.correctedName !== wine.name ? (
                        <div style={{ background: "rgba(201,169,110,0.1)", border: "0.5px solid rgba(201,169,110,0.3)", borderRadius: 6, padding: "8px 10px", marginBottom: 8 }}>
                          <div style={{ color: "#9a8060", fontSize: 10, letterSpacing: "1px", textTransform: "uppercase", marginBottom: 4 }}>Suggested name</div>
                          <div style={{ color: "#f0e8d8", fontSize: 13, marginBottom: 8 }}>{wine.correctedName}</div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <CopyButton text={wine.correctedName} />
                            <span style={{ color: "#6a5040", fontSize: 10 }}>Copy, then paste into Toast to fix</span>
                          </div>
                        </div>
                      ) : (
                        <div style={{ color: "#6a5040", fontSize: 11, fontStyle: "italic", marginBottom: 8 }}>
                          Fix the name in Toast — it will update on next sync
                        </div>
                      )}
                      <button onClick={e => { e.stopPropagation(); handleApprove(wine); }}
                        style={{ background: "rgba(76,175,125,0.15)", border: "0.5px solid #4caf7d", color: "#4caf7d", padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 11 }}>
                        Looks Good ✓ — Mark as Reviewed
                      </button>
                    </div>
                  )}
                  {activeTab === "noprice" && (
                    <div style={{ color: "#e8a050", fontSize: 11, marginTop: 4 }}>
                      No price in Toast — update menu item
                    </div>
                  )}
                  {activeTab === "noimage" && (
                    <div style={{ color: "#8a7060", fontSize: 11, marginTop: 4 }}>
                      {wine._type === "beer" || wine._type === "pour"
                        ? "Upload image in Toast → item → Image to display here"
                        : "Upload label image in Toast to display here"}
                    </div>
                  )}
                  {activeTab === "unenriched" && (
                    <div style={{ color: "#8a7060", fontSize: 11, marginTop: 4 }}>
                      Pending AI enrichment — will auto-populate next sync
                    </div>
                  )}
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  {wine.glassPrice && <div style={{ color: "#c9a96e", fontSize: 12 }}>{formatPrice(wine.glassPrice)} glass</div>}
                  {wine.bottlePrice && <div style={{ color: "#c9a96e", fontSize: 12 }}>{formatPrice(wine.bottlePrice)} btl</div>}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div style={{ background: "#4d2e00", borderTop: "1px solid #2a1400", padding: "12px 20px", textAlign: "center" }}>
        <div style={{ color: "#4e3020", fontSize: 10, letterSpacing: "1px" }}>
          {wines.length} total wines · Tap AK logo 5× to access this screen
        </div>
      </div>
    </div>
  );
}

// ─── PIN Screen ───────────────────────────────────────────────────────────────

function PinScreen({ onSuccess, onCancel }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);

  function handleDigit(d) {
    if (pin.length >= 4) return;
    const next = pin + d;
    setPin(next);
    setError(false);
    if (next.length === 4) {
      if (next === MANAGER_PIN) {
        onSuccess();
      } else {
        setTimeout(() => { setPin(""); setError(true); }, 300);
      }
    }
  }

  function handleDelete() { setPin(p => p.slice(0, -1)); setError(false); }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 999, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Georgia, serif" }}>
      <div style={{ background: "#4d2e00", border: "1px solid #2a1400", borderRadius: 16, padding: "32px 28px", width: 280, textAlign: "center" }}>
        <div style={{ color: "#c9a96e", fontSize: 10, letterSpacing: "3px", textTransform: "uppercase", marginBottom: 8 }}>Manager Access</div>
        <div style={{ color: "#f0e8d8", fontSize: 16, marginBottom: 24 }}>Enter PIN</div>

        {/* PIN dots */}
        <div style={{ display: "flex", justifyContent: "center", gap: 12, marginBottom: 24 }}>
          {[0,1,2,3].map(i => (
            <div key={i} style={{
              width: 14, height: 14, borderRadius: "50%",
              background: i < pin.length ? (error ? "#e85050" : "#c9a96e") : "transparent",
              border: `2px solid ${error ? "#e85050" : i < pin.length ? "#c9a96e" : "#4e3020"}`,
              transition: "all 0.15s"
            }} />
          ))}
        </div>

        {error && <div style={{ color: "#e85050", fontSize: 12, marginBottom: 16 }}>Incorrect PIN</div>}

        {/* Keypad */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 12 }}>
          {[1,2,3,4,5,6,7,8,9].map(d => (
            <button key={d} onClick={() => handleDigit(String(d))} style={{
              background: "rgba(255,255,255,0.06)", border: "0.5px solid #2a1400",
              color: "#f0e8d8", fontSize: 20, padding: "14px", borderRadius: 10,
              cursor: "pointer", fontFamily: "Georgia, serif"
            }}>{d}</button>
          ))}
          <button onClick={onCancel} style={{ background: "transparent", border: "0.5px solid #2a1400", color: "#6a5040", fontSize: 12, padding: "14px", borderRadius: 10, cursor: "pointer", fontFamily: "Georgia, serif" }}>Cancel</button>
          <button onClick={() => handleDigit("0")} style={{ background: "rgba(255,255,255,0.06)", border: "0.5px solid #2a1400", color: "#f0e8d8", fontSize: 20, padding: "14px", borderRadius: 10, cursor: "pointer", fontFamily: "Georgia, serif" }}>0</button>
          <button onClick={handleDelete} style={{ background: "transparent", border: "0.5px solid #2a1400", color: "#6a5040", fontSize: 18, padding: "14px", borderRadius: 10, cursor: "pointer" }}>⌫</button>
        </div>
      </div>
    </div>
  );
}

// ─── Shared List Sub-Components ──────────────────────────────────────────────
// Edit these once and changes apply to Wine, Beer, Cocktails, Pours, NAB

function ListScreenHeader({ title, onBack, favorites, onShowShortlist, children }) {
  return (
    <div style={{ background: "#432800", padding: "0 20px" }}>
      <div style={{ padding: "10px 0 6px", display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: "#f0e8d8", cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 12, letterSpacing: "1px", display: "flex", alignItems: "center", gap: 4, padding: 0 }}>
          ‹ <span style={{ textTransform: "uppercase", letterSpacing: "2px" }}>Main Menu</span>
        </button>
        <div style={{ flex: 1, textAlign: "center" }}>
          <div style={{ color: "#e8d5a0", fontSize: 14, letterSpacing: "4px", textTransform: "uppercase" }}>{title}</div>
        </div>
        <div style={{ width: 80, textAlign: "right" }}>
          {favorites.length > 0 && (
            <button onClick={onShowShortlist} style={{ background: "rgba(201,169,110,0.15)", border: "0.5px solid rgba(201,169,110,0.4)", color: "#c9a96e", padding: "4px 10px", borderRadius: 12, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 11 }}>
              ★ {favorites.length}
            </button>
          )}
        </div>
      </div>
      <div style={{ height: "0.5px", background: "linear-gradient(90deg, transparent, #c9a96e44, transparent)", marginBottom: 10 }} />
      {children}
    </div>
  );
}

function ListSectionHeading({ label, borderTop }) {
  return (
    <div style={{ padding: "18px 20px 6px", borderTop: borderTop ? "0.5px solid #e8e0d0" : "none" }}>
      <div style={{ color: "#c9a96e", fontSize: 9, letterSpacing: "3px", textTransform: "uppercase" }}>{label}</div>
    </div>
  );
}

function ListCountBar({ left, right }) {
  return (
    <div style={{ background: "#472a00", padding: "5px 20px 8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ color: "#6a5040", fontSize: 11, letterSpacing: "1px" }}>{left}</span>
      {right && <span style={{ color: "#6a5040", fontSize: 10, fontStyle: "italic" }}>{right}</span>}
    </div>
  );
}

// ─── Generic Item List Screen (Beer, Pours, Cocktails, NAB) ──────────────────

function ItemListScreen({ title, allLabel, endpoint, dataKey, accentColor, onBack, favorites = [], onToggleFavorite = () => {}, onShowShortlist = () => {} }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeGroup, setActiveGroup] = useState("All");
  const [selectedItem, setSelectedItem] = useState(null);
  const [visible, setVisible] = useState(false);
  const [itemSearch, setItemSearch] = useState("");
  const [zoomedLabel, setZoomedLabel] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatContext, setChatContext] = useState(null);

  function handleOpenChat(ctx) { setChatContext(ctx); setChatOpen(true); }

  useEffect(() => {
    fetch(endpoint)
      .then(r => r.json())
      .then(data => {
        setItems(data[dataKey] || []);
        setLoading(false);
        setTimeout(() => setVisible(true), 50);
      })
      .catch(e => { setError(e.message || "Unable to load menu"); setLoading(false); });

    // Silent background poll — interval adjusts to season/time
    let pollTimer;
    function scheduleNext() {
      pollTimer = setTimeout(() => {
        fetch(endpoint).then(r => r.json())
          .then(data => { setItems(data[dataKey] || []); })
          .catch(() => {});
        scheduleNext();
      }, getPollingInterval());
    }
    scheduleNext();
    return () => clearTimeout(pollTimer);
  }, [endpoint, dataKey]);

  const available = items.filter(i => i.available !== false);
  const groupOrder = [...new Map(available.map(i => [i.subgroup || i.tier || "Menu", true])).keys()];
  const groups = ["All", ...groupOrder];
  const filtered = activeGroup === "All" ? available : available.filter(i => i.subgroup === activeGroup || i.tier === activeGroup);

  const searchFiltered = itemSearch.trim() === ""
    ? filtered
    : filtered.filter(i => {
        const q = itemSearch.toLowerCase();
        return (i.name || "").toLowerCase().includes(q)
          || (i.description || "").toLowerCase().includes(q)
          || (i.style || "").toLowerCase().includes(q)
          || (i.category || "").toLowerCase().includes(q);
      });

  const grouped = {};
  searchFiltered.forEach(item => {
    const key = item.subgroup || item.tier || "Menu";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(item);
  });
  const filteredGroupOrder = [...new Map(searchFiltered.map(i => [i.subgroup || i.tier || "Menu", true])).keys()];

  if (loading) return (
    <div style={{ background: "#432800", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16 }}>
      <div style={{ color: accentColor, fontSize: 13, letterSpacing: "3px", textTransform: "uppercase", fontFamily: "Georgia, serif" }}>Loading {title}...</div>
    </div>
  );

  if (error) return (
    <div style={{ background: "#432800", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "Georgia, serif" }}>
      <div style={{ textAlign: "center", maxWidth: 400 }}>
        <div style={{ color: accentColor, fontSize: 13, letterSpacing: "2px", textTransform: "uppercase", marginBottom: 12 }}>Unable to load {title}</div>
        <div style={{ color: "#6a5040", fontSize: 12, marginBottom: 8 }}>Endpoint: {endpoint}</div>
        <div style={{ background: "rgba(255,255,255,0.04)", border: "0.5px solid #2a1400", borderRadius: 6, padding: "10px 14px", marginBottom: 16, textAlign: "left" }}>
          <div style={{ color: "#9a5040", fontSize: 11, letterSpacing: "1px", textTransform: "uppercase", marginBottom: 4 }}>Error</div>
          <div style={{ color: "#c0a090", fontSize: 12, fontFamily: "monospace", wordBreak: "break-all" }}>{error}</div>
        </div>
        <button onClick={() => window.location.reload()} style={{ background: accentColor, color: "#432800", border: "none", padding: "8px 20px", borderRadius: 6, fontFamily: "Georgia, serif", cursor: "pointer" }}>Try Again</button>
      </div>
    </div>
  );

  return (
    <div style={{ background: "#432800", minHeight: "100vh", fontFamily: "Georgia, serif", maxWidth: 680, margin: "0 auto", opacity: visible ? 1 : 0, transition: "opacity 0.5s ease" }}>
      {/* Shared header — edit ListScreenHeader to change all list screens */}
      <div style={{ position: "sticky", top: 0, zIndex: 10 }}>
        <ListScreenHeader title={title} onBack={onBack} favorites={favorites} onShowShortlist={onShowShortlist}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            {groups.map(g => (
              <button key={g} onClick={() => { setActiveGroup(g); setSelectedItem(null); }} style={{
                background: activeGroup === g ? accentColor : "rgba(255,255,255,0.07)",
                border: `0.5px solid ${activeGroup === g ? accentColor : "rgba(255,255,255,0.15)"}`,
                color: activeGroup === g ? "#432800" : "#c8a878",
                fontSize: 11, padding: "5px 13px", borderRadius: 20, cursor: "pointer",
                fontFamily: "Georgia, serif", whiteSpace: "nowrap",
                fontWeight: activeGroup === g ? 600 : 400
              }}>{g === "All" ? (allLabel || `All ${title}`) : g}</button>
            ))}
          </div>
          <div style={{ padding: "4px 0 10px", position: "relative" }}>
            <input type="text" placeholder={`Search ${title.toLowerCase()}…`} value={itemSearch}
              onChange={e => setItemSearch(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box", background: "rgba(255,255,255,0.07)", border: "0.5px solid rgba(201,169,110,0.25)", color: "#f0e8d8", padding: "8px 32px 8px 12px", borderRadius: 20, fontFamily: "Georgia, serif", fontSize: 12, outline: "none", letterSpacing: "0.3px" }}
            />
            {itemSearch && <button onClick={() => setItemSearch("")} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#6a5040", cursor: "pointer", fontSize: 18, padding: 0 }}>×</button>}
          </div>
        </ListScreenHeader>
      </div>

      <ListCountBar
        left={`${searchFiltered.length} ${searchFiltered.length === 1 ? "item" : "items"}${itemSearch ? ` · "${itemSearch}"` : ""}`}
        right="☆ Star to save to My Menu"
      />

      <div style={{ background: "#faf8f4" }}>
        {filteredGroupOrder.map((group, gi) => (
          <div key={group}>
            <ListSectionHeading label={group} borderTop={gi > 0} />
            <div style={{ padding: "0 14px 8px", display: "flex", flexDirection: "column", gap: 1 }}>
              {grouped[group].map(item => (
                <div key={item.id} onClick={() => setSelectedItem(selectedItem === item.id ? null : item.id)}
                  style={{
                    display: "flex", alignItems: "center", gap: 12,
                    background: selectedItem === item.id ? "#f0ebe0" : "transparent",
                    borderLeft: selectedItem === item.id ? `2px solid ${accentColor}` : "2px solid transparent",
                    borderRadius: 8, padding: "11px 8px", cursor: "pointer", transition: "all 0.15s"
                  }}>
                  <div
                    onClick={item.imageUrl ? e => { e.stopPropagation(); setZoomedLabel({ name: item.name, varietal: item.style || item.category, region: item.brewery || item.producer, imageUrl: item.imageUrl }); } : undefined}
                    style={{ width: 40, height: 56, borderRadius: 3, background: "#f0ebe0", border: `0.5px solid ${item.imageUrl ? "#c9a96e" : "#e0d8c8"}`, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, overflow: "hidden", cursor: item.imageUrl ? "zoom-in" : "default" }}>
                    {item.imageUrl ? <img src={item.imageUrl} alt={item.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : (dataKey === "beers" ? "🍺" : dataKey === "cocktails" ? "🍹" : dataKey === "nab" ? ((item.subgroup || "").toLowerCase() === "mocktails" ? "🍹" : "🥤") : "🥃")}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: "#502e00", fontSize: 16, marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.name}</div>
                    {(item.style || item.category) && (
                      <div style={{ color: accentColor, fontSize: 12, letterSpacing: "0.3px", marginBottom: 2 }}>
                        {item.style || item.category}{(item.brewery || item.producer) ? ` · ${item.brewery || item.producer}` : ""}{item.abv ? ` · ${item.abv}` : ""}
                      </div>
                    )}
                    {item.description ? (
                      <div style={{ color: "#8a7060", fontSize: 13, lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 1, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{item.description} <span style={{ color: accentColor, fontSize: 11 }}>Details ›</span></div>
                    ) : (
                      <div style={{ color: accentColor, fontSize: 11, fontStyle: "italic" }}>Tap for details ›</div>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    <button onClick={e => { e.stopPropagation(); onToggleFavorite(item); }} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: favorites.some(f => f.id === item.id) ? accentColor : "#d0c0b0", padding: "2px 0", lineHeight: 1 }}>
                      {favorites.some(f => f.id === item.id) ? "★" : "☆"}
                    </button>
                    <div style={{ textAlign: "right", flexShrink: 0, minWidth: 44 }}>
                    {item.price ? (
                      <>
                        <div style={{ color: "#502e00", fontSize: 14, fontWeight: 500 }}>${Math.round(item.price)}</div>
                        <div style={{ color: "#b0a090", fontSize: 10, marginTop: 1 }}>each</div>
                      </>
                    ) : (
                      <span style={{ color: "#c0b0a0", fontSize: 11, fontStyle: "italic" }}>Ask</span>
                    )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div style={{ color: "#b0a090", textAlign: "center", padding: 40, fontSize: 14 }}>
            {items.length === 0 ? "Menu coming soon" : "No items in this selection"}
          </div>
        )}
      </div>

      {/* Expanded detail panel */}
      {selectedItem && (() => {
        const item = items.find(i => i.id === selectedItem);
        if (!item) return null;
        return (
          <div style={{ position: "sticky", bottom: 0, background: "#fff", borderTop: "1px solid #e8e0d0", padding: "18px 20px", boxShadow: "0 -8px 32px rgba(0,0,0,0.10)" }}>
            <div style={{ display: "flex", gap: 14, marginBottom: 12 }}>
              <div
                onClick={item.imageUrl ? () => setZoomedLabel({ name: item.name, varietal: item.style || item.category, region: item.brewery || item.producer, imageUrl: item.imageUrl }) : undefined}
                style={{ width: 52, height: 72, borderRadius: 4, background: "#f0ebe0", border: `0.5px solid ${item.imageUrl ? "#c9a96e" : "#e0d8c8"}`, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, overflow: "hidden", cursor: item.imageUrl ? "zoom-in" : "default" }}>
                {item.imageUrl ? <img src={item.imageUrl} alt={item.name} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 4 }} /> : (dataKey === "beers" ? "🍺" : dataKey === "cocktails" ? "🍹" : dataKey === "nab" ? ((item.subgroup || "").toLowerCase() === "mocktails" ? "🍹" : "🥤") : "🥃")}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: "#502e00", fontSize: 16, fontWeight: 500, marginBottom: 3 }}>{item.name}</div>
                {(item.style || item.category) && <div style={{ color: accentColor, fontSize: 11, marginBottom: 2 }}>{item.style || item.category}</div>}
                {(item.brewery || item.producer) && <div style={{ color: "#8a7060", fontSize: 11 }}>{item.brewery || item.producer}</div>}
                <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
                  {item.abv && <span style={{ color: "#8a7060", fontSize: 11 }}>{item.abv} ABV</span>}
                  {item.age && <span style={{ color: "#8a7060", fontSize: 11 }}>{item.age}</span>}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                {item.price && <div style={{ color: "#502e00", fontSize: 18, fontWeight: 500 }}>${Math.round(item.price)}</div>}
              </div>
            </div>
            {item.description && (
              <div style={{ color: "#5a4030", fontSize: 13, lineHeight: 1.6, fontStyle: "italic", borderTop: "0.5px solid #e8e0d0", paddingTop: 10, marginBottom: 12 }}>
                {item.description}
              </div>
            )}
            <ItemPairingButton item={item} onOpenChat={handleOpenChat} favorites={favorites} onToggleFavorite={onToggleFavorite} />
          </div>
        );
      })()}

      <LabelModal wine={zoomedLabel} onClose={() => setZoomedLabel(null)} />
      <SommelierChat isOpen={chatOpen} onClose={() => setChatOpen(false)} contextItem={chatContext} favorites={favorites} onToggleFavorite={onToggleFavorite} />
      <div style={{ height: 32 }} />
    </div>
  );
}

// ─── My Menu QR Code Helpers ─────────────────────────────────────────────────

function encodeFavorites(favorites) {
  const compact = favorites.map(f => {
    if (f.favoriteType === 'food') return { t: 'food', n: f.name, cr: f.courseRole, p: f.price, d: (f.description || '').slice(0, 80) };
    if (f.favoriteType === 'wine') return { t: 'wine', n: f.name, v: f.varietal, r: f.region, gp: f.glassPrice, bp: f.bottlePrice, rs: (f.reason || '').slice(0, 140), cl: f.courseLabel, fp: f.fromPairing, img: f.imageUrl || null };
    return { t: f.favoriteType, n: f.name, p: f.price };
  });
  try { return btoa(unescape(encodeURIComponent(JSON.stringify({ v: 1, dt: Date.now(), items: compact })))); } catch(e) { return null; }
}

function decodeFavorites(encoded) {
  const parsed = JSON.parse(decodeURIComponent(escape(atob(encoded))));
  // Handle both new format { v, dt, items } and old format (plain array)
  const compact = Array.isArray(parsed) ? parsed : (parsed.items || []);
  const savedAt = Array.isArray(parsed) ? null : (parsed.dt || null);
  const favorites = compact.map((f, i) => ({
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
  }));
  return Object.assign(favorites, { _savedAt: savedAt });
}

// ─── Guest Menu Loader (fetches saved menu from DB by short code) ─────────────

function GuestMenuLoader({ menuCode }) {
  const [state, setState] = useState("loading"); // loading | ready | expired | error
  const [favorites, setFavorites] = useState([]);
  const [savedAt, setSavedAt] = useState(null);

  useEffect(() => {
    fetch(`${GET_MENU_URL}?id=${menuCode}`)
      .then(r => r.json())
      .then(data => {
        if (data.ok && data.favorites) { setFavorites(data.favorites); setSavedAt(data.createdAt || null); setState("ready"); }
        else if (data.error === "expired") setState("expired");
        else setState("error");
      })
      .catch(() => setState("error"));
  }, [menuCode]);

  if (state === "loading") return (
    <div style={{ background: "#3d2200", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Georgia, serif" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ color: "#c9a96e", fontSize: 22, marginBottom: 12 }}>✦</div>
        <div style={{ color: "#c9a96e", fontSize: 12, letterSpacing: "3px", textTransform: "uppercase" }}>Loading your menu…</div>
      </div>
    </div>
  );

  if (state === "expired") return (
    <div style={{ background: "#3d2200", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 32, fontFamily: "Georgia, serif" }}>
      <div style={{ textAlign: "center", maxWidth: 360 }}>
        <div style={{ color: "#c9a96e", fontSize: 28, marginBottom: 16 }}>✦</div>
        <div style={{ color: "#c9a96e", fontSize: 12, letterSpacing: "3px", textTransform: "uppercase", marginBottom: 12 }}>Appalachia Kitchen</div>
        <div style={{ color: "#f0e8d8", fontSize: 18, marginBottom: 12 }}>This menu link has expired</div>
        <div style={{ color: "#6a5040", fontSize: 13, lineHeight: 1.6 }}>Menu QR codes are valid for 24 hours. We hope your evening was wonderful — we'd love to welcome you back soon.</div>
        <div style={{ color: "#4a3020", fontSize: 11, marginTop: 24, letterSpacing: "1px" }}>CORDUROY INN & LODGE · SNOWSHOE MOUNTAIN, WV</div>
      </div>
    </div>
  );

  if (state === "error") return (
    <div style={{ background: "#3d2200", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 32, fontFamily: "Georgia, serif" }}>
      <div style={{ textAlign: "center", color: "#6a5040", fontSize: 14 }}>Menu not found. Please ask your server for assistance.</div>
    </div>
  );

  return <GuestMenuScreen favorites={favorites} savedAt={savedAt} />;
}

// ─── Guest Menu Screen (read-only, opened via QR code on guest's phone) ───────

function GuestMenuScreen({ favorites, savedAt }) {
  const courseOrder  = ["first", "main", "dessert"];
  const courseLabels = { first: "First Course", main: "Main Course", dessert: "Dessert" };

  const foodItems  = favorites.filter(f => f.favoriteType === "food");
  const wineItems  = favorites.filter(f => f.favoriteType === "wine");
  const drinkItems = favorites.filter(f => f.favoriteType !== "food" && f.favoriteType !== "wine");

  const foodByCourse = {};
  foodItems.forEach(f => { const r = f.courseRole || "main"; if (!foodByCourse[r]) foodByCourse[r] = []; foodByCourse[r].push(f); });
  const foodCourses = courseOrder.filter(r => foodByCourse[r]);

  const winesByCourseLabel = {};
  const standaloneWines = [];
  wineItems.forEach(w => {
    if (w.fromPairing && w.courseLabel) {
      if (!winesByCourseLabel[w.courseLabel]) winesByCourseLabel[w.courseLabel] = [];
      winesByCourseLabel[w.courseLabel].push(w);
    } else { standaloneWines.push(w); }
  });

  const SectionHeader = ({ label }) => (
    <div style={{ background: "#5e3600", padding: "8px 16px", marginBottom: 10, marginTop: 6, borderRadius: 6 }}>
      <div style={{ color: "#c9a96e", fontSize: 10, letterSpacing: "2px", textTransform: "uppercase", fontWeight: 600 }}>✦ {label}</div>
    </div>
  );

  const WineCard = ({ item }) => (
    <div style={{ background: "rgba(255,255,255,0.04)", border: "0.5px solid #2a1400", borderRadius: 8, padding: "12px 14px", marginBottom: 8 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        {item.imageUrl
          ? <div onClick={() => setZoomedLabel(item)} style={{ width: 36, height: 50, borderRadius: 3, overflow: "hidden", flexShrink: 0, cursor: "zoom-in", border: "0.5px solid #c9a96e" }}><img src={item.imageUrl} alt={item.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>
          : <div style={{ fontSize: 22, flexShrink: 0 }}>🍷</div>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: "#f0e8d8", fontSize: 14, marginBottom: 2 }}>{item.name}</div>
          {(item.varietal || item.region) && <div style={{ color: "#c9a96e", fontSize: 10, letterSpacing: "1px", textTransform: "uppercase", marginBottom: 4 }}>{[item.varietal, item.region].filter(Boolean).join(" · ")}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            {item.glassPrice && <div style={{ color: "#9a8060", fontSize: 11 }}>{formatPrice(item.glassPrice)} <span style={{ color: "#9a8060" }}>glass</span></div>}
            {item.bottlePrice && <div style={{ color: "#9a8060", fontSize: 11 }}>{formatPrice(item.bottlePrice)} <span style={{ color: "#9a8060" }}>bottle</span></div>}
          </div>
        </div>
      </div>
      {item.reason && <div style={{ color: "#c8b49a", fontSize: 12, fontStyle: "italic", lineHeight: 1.6, marginTop: 10, paddingTop: 10, borderTop: "0.5px solid rgba(201,169,110,0.2)" }}>"{item.reason}"</div>}
    </div>
  );

  return (
    <div style={{ background: "#3d2200", minHeight: "100vh", fontFamily: "Georgia, serif", maxWidth: 480, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ background: "#4d2e00", borderBottom: "1px solid #2a1400", padding: "24px 20px 20px", textAlign: "center" }}>
        <div style={{ color: "#c9a96e", fontSize: 10, letterSpacing: "3px", textTransform: "uppercase", marginBottom: 6 }}>My Menu</div>
        <div style={{ color: "#f0e8d8", fontSize: 20, marginBottom: 4 }}>Appalachia Kitchen</div>
        <div style={{ color: "#9a8060", fontSize: 11, letterSpacing: "1px" }}>Corduroy Inn & Lodge · Snowshoe Mountain, WV</div>
        {savedAt && (
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: "0.5px solid rgba(201,169,110,0.2)" }}>
            <div style={{ color: "#c9a96e", fontSize: 12, letterSpacing: "0.5px" }}>
              {new Date(savedAt).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
            </div>
          </div>
        )}
      </div>

      <div style={{ padding: "16px 16px 48px" }}>
        {foodCourses.map(role => {
          const label = courseLabels[role];
          const courseWines = winesByCourseLabel[label] || [];
          return (
            <div key={role}>
              <SectionHeader label={label} />
              {foodByCourse[role].map(item => (
                <div key={item.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", background: "rgba(255,255,255,0.03)", border: "0.5px solid #2a1400", borderRadius: 8, marginBottom: 8 }}>
                  <div style={{ fontSize: 18, flexShrink: 0, marginTop: 2 }}>🍽️</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: "#f0e8d8", fontSize: 14 }}>{item.name}</div>
                    {item.description && <div style={{ color: "#c8b49a", fontSize: 11, fontStyle: "italic", marginTop: 2 }}>{item.description}</div>}
                    {item.price && <div style={{ color: "#b8a080", fontSize: 11, marginTop: 3 }}>{formatPrice(item.price)}</div>}
                  </div>
                </div>
              ))}
              {courseWines.map(item => <WineCard key={item.id} item={item} />)}
            </div>
          );
        })}

        {standaloneWines.length > 0 && (
          <div>
            <SectionHeader label="Wines" />
            {standaloneWines.map(item => <WineCard key={item.id} item={item} />)}
          </div>
        )}

        {drinkItems.length > 0 && (
          <div>
            <SectionHeader label="Drinks" />
            {drinkItems.map(item => (
              <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "rgba(255,255,255,0.03)", border: "0.5px solid #2a1400", borderRadius: 8, marginBottom: 8 }}>
                <div style={{ fontSize: 20, flexShrink: 0 }}>
                  {item.favoriteType === "beer" ? "🍺" : item.favoriteType === "cocktail" ? "🍹" : item.favoriteType === "nab" ? "🥤" : "🥃"}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ color: "#f0e8d8", fontSize: 14 }}>{item.name}</div>
                </div>
                {item.price && <div style={{ color: "#9a8060", fontSize: 12 }}>{formatPrice(item.price)}</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ textAlign: "center", padding: "24px 20px 40px", margin: "8px 16px 0", borderTop: "0.5px solid rgba(201,169,110,0.15)" }}>
        <div style={{ color: "#c9a96e", fontSize: 13, marginBottom: 12 }}>Enjoyed your evening?</div>
        <a href={RESERVATION_URL} target="_blank" rel="noopener noreferrer"
          style={{ display: "inline-block", background: "#c9a96e", color: "#0d0800", textDecoration: "none", padding: "10px 24px", borderRadius: 8, fontFamily: "Georgia, serif", fontSize: 13, fontWeight: 600, letterSpacing: "0.5px", marginBottom: 16 }}>
          Book Your Next Visit
        </a>
        <div style={{ color: "#5a4030", fontSize: 10, letterSpacing: "1px", textTransform: "uppercase" }}>
          Corduroy Inn & Lodge · Snowshoe Mountain, WV
        </div>
      </div>
    </div>
  );
}

// ─── Shortlist Screen ─────────────────────────────────────────────────────────

function ShortlistScreen({ favorites, onRemove, onClose }) {
  const courseOrder  = ["first", "main", "dessert"];
  const courseLabels = { first: "First Course", main: "Main Course", dessert: "Dessert" };

  const foodItems  = favorites.filter(f => f.favoriteType === "food");
  const wineItems  = favorites.filter(f => f.favoriteType === "wine");
  const drinkItems = favorites.filter(f => f.favoriteType !== "food" && f.favoriteType !== "wine");

  const foodByCourse = {};
  foodItems.forEach(f => {
    const r = f.courseRole || "main";
    if (!foodByCourse[r]) foodByCourse[r] = [];
    foodByCourse[r].push(f);
  });
  const foodCourses = courseOrder.filter(r => foodByCourse[r]);

  // Wines from AI pairing embed in their course; wines from wine list sit standalone
  const winesByCourseLabel = {};
  const standaloneWines = [];
  wineItems.forEach(w => {
    if (w.fromPairing && w.courseLabel) {
      if (!winesByCourseLabel[w.courseLabel]) winesByCourseLabel[w.courseLabel] = [];
      winesByCourseLabel[w.courseLabel].push(w);
    } else {
      standaloneWines.push(w);
    }
  });

  const hasCourses = foodCourses.length > 0;

  const [showQR, setShowQR]     = useState(false);
  const [qrSaving, setQrSaving] = useState(false);
  const [zoomedLabel, setZoomedLabel] = useState(null);
  const [menuCode, setMenuCode] = useState(null);
  const [emailInput, setEmailInput] = useState("");
  const [emailState, setEmailState] = useState("idle"); // idle | sending | sent | error

  async function handleOpenQR() {
    setShowQR(true);
    if (menuCode) return; // already saved this session
    setQrSaving(true);
    try {
      const compact = favorites.map(f => ({
        t: f.favoriteType, n: f.name, cr: f.courseRole, p: f.price,
        d: (f.description || "").slice(0, 80), v: f.varietal, r: f.region,
        gp: f.glassPrice, bp: f.bottlePrice, rs: (f.reason || "").slice(0, 140),
        cl: f.courseLabel, fp: f.fromPairing, img: f.imageUrl || null,
      }));
      const res = await fetch(SAVE_MENU_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ favorites: compact })
      });
      const data = await res.json();
      if (data.ok) setMenuCode(data.menuId);
    } catch(e) { /* fail silently — QR just won't show */ }
    setQrSaving(false);
  }

  async function handleSendEmail() {
    if (!emailInput || !menuCode) return;
    setEmailState("sending");
    try {
      const res = await fetch(SEND_EMAIL_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailInput, menuId: menuCode })
      });
      const data = await res.json();
      setEmailState(data.ok ? "sent" : "error");
    } catch(e) { setEmailState("error"); }
  }

  const SectionHeader = ({ label }) => (
    <div style={{ background: "#5e3600", padding: "8px 16px", marginBottom: 10, marginTop: 6, borderRadius: 6 }}>
      <div style={{ color: "#c9a96e", fontSize: 10, letterSpacing: "2px", textTransform: "uppercase", fontWeight: 600 }}>✦ {label}</div>
    </div>
  );

  const RemoveBtn = ({ item }) => (
    <button onClick={() => onRemove(item.id)} style={{ background: "none", border: "none", color: "#4a3020", cursor: "pointer", fontSize: 20, padding: "2px 4px", lineHeight: 1, flexShrink: 0 }}>×</button>
  );

  const WineCard = ({ item }) => (
    <div style={{ background: "rgba(255,255,255,0.04)", border: "0.5px solid #2a1400", borderRadius: 8, padding: "12px 14px", marginBottom: 8 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        {item.imageUrl
          ? <div onClick={() => setZoomedLabel(item)} style={{ width: 36, height: 50, borderRadius: 3, overflow: "hidden", flexShrink: 0, cursor: "zoom-in", border: "0.5px solid #c9a96e" }}><img src={item.imageUrl} alt={item.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>
          : <div style={{ fontSize: 22, flexShrink: 0 }}>🍷</div>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: "#f0e8d8", fontSize: 14, marginBottom: 2 }}>{item.name}</div>
          {(item.varietal || item.region) && <div style={{ color: "#c9a96e", fontSize: 10, letterSpacing: "1px", textTransform: "uppercase", marginBottom: 4 }}>{[item.varietal, item.region].filter(Boolean).join(" · ")}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            {item.glassPrice && <div style={{ color: "#9a8060", fontSize: 11 }}>{formatPrice(item.glassPrice)} <span style={{ color: "#9a8060" }}>glass</span></div>}
            {item.bottlePrice && <div style={{ color: "#9a8060", fontSize: 11 }}>{formatPrice(item.bottlePrice)} <span style={{ color: "#9a8060" }}>bottle</span></div>}
          </div>
        </div>
        <RemoveBtn item={item} />
      </div>
      {item.reason && <div style={{ color: "#c8b49a", fontSize: 12, fontStyle: "italic", lineHeight: 1.6, marginTop: 10, paddingTop: 10, borderTop: "0.5px solid rgba(201,169,110,0.2)" }}>"{item.reason}"</div>}
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 500, display: "flex", justifyContent: "center" }}>
    <div style={{ width: "100%", maxWidth: 680, background: "#3d2200", display: "flex", flexDirection: "column", fontFamily: "Georgia, serif", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ background: "#4d2e00", borderBottom: "1px solid #2a1400", padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ color: "#c9a96e", fontSize: 12, letterSpacing: "3px", textTransform: "uppercase" }}>My Menu</div>
            <div style={{ color: "#c8b49a", fontSize: 11, marginTop: 2 }}>Your evening's selections</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {favorites.length > 0 && (
            <button onClick={handleOpenQR} style={{ background: "rgba(201,169,110,0.15)", border: "0.5px solid #c9a96e", color: "#c9a96e", padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 11 }}>
              Save ↗
            </button>
          )}
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#c9a96e", cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 13, letterSpacing: "1px", padding: "4px 0" }}>‹ Back</button>
          </div>
        </div>
        <div style={{ borderTop: "0.5px solid rgba(201,169,110,0.2)", paddingTop: 8, color: "#c9a96e", fontSize: 11, fontStyle: "italic", textAlign: "center" }}>
          Ready to order? Your server will be happy to help.
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "16px 16px 32px" }}>
        {favorites.length === 0 ? (
          <div style={{ color: "#5a4030", textAlign: "center", padding: "60px 20px" }}>
            <div style={{ fontSize: 36, marginBottom: 16 }}>☆</div>
            <div style={{ fontSize: 14 }}>Star wines, dishes, and drinks to build your menu for the evening</div>
          </div>
        ) : (
          <>
            {/* Food by course, with paired wines embedded */}
            {hasCourses && foodCourses.map(role => {
              const label = courseLabels[role];
              const courseWines = winesByCourseLabel[label] || [];
              return (
                <div key={role}>
                  <SectionHeader label={label} />
                  {foodByCourse[role].map(item => (
                    <div key={item.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", background: "rgba(255,255,255,0.03)", border: "0.5px solid #2a1400", borderRadius: 8, marginBottom: 8 }}>
                      <div style={{ fontSize: 18, flexShrink: 0, marginTop: 2 }}>🍽️</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ color: "#f0e8d8", fontSize: 14 }}>{item.name}</div>
                        {item.description && <div style={{ color: "#c8b49a", fontSize: 11, fontStyle: "italic", marginTop: 2, lineHeight: 1.4 }}>{item.description}</div>}
                        {item.price && <div style={{ color: "#b8a080", fontSize: 11, marginTop: 3 }}>{formatPrice(item.price)}</div>}
                      </div>
                      <RemoveBtn item={item} />
                    </div>
                  ))}
                  {courseWines.map(item => <WineCard key={item.id} item={item} />)}
                </div>
              );
            })}

            {/* Standalone wines — added from wine list, not from a course pairing */}
            {standaloneWines.length > 0 && (
              <div>
                <SectionHeader label="Wines" />
                {standaloneWines.map(item => <WineCard key={item.id} item={item} />)}
              </div>
            )}

            {/* Other drinks */}
            {drinkItems.length > 0 && (
              <div>
                <SectionHeader label="Drinks" />
                {drinkItems.map(item => (
                  <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "rgba(255,255,255,0.03)", border: "0.5px solid #2a1400", borderRadius: 8, marginBottom: 8 }}>
                    <div style={{ fontSize: 20, flexShrink: 0 }}>
                      {item.favoriteType === "beer" ? "🍺" : item.favoriteType === "cocktail" ? "🍹" : item.favoriteType === "nab" ? "🥤" : "🥃"}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: "#f0e8d8", fontSize: 14 }}>{item.name}</div>
                      <div style={{ color: "#c9a96e", fontSize: 10, letterSpacing: "1px", textTransform: "uppercase", marginTop: 2 }}>
                        {item.favoriteType === "beer" ? (item.style || "Beer") : item.favoriteType === "cocktail" ? "Cocktail" : item.favoriteType === "nab" ? "Non-Alcoholic" : "Premium Pour"}
                      </div>
                    </div>
                    {item.price && <div style={{ color: "#9a8060", fontSize: 12, flexShrink: 0 }}>{formatPrice(item.price)}</div>}
                    <RemoveBtn item={item} />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <LabelModal wine={zoomedLabel} onClose={() => setZoomedLabel(null)} />
      {showQR && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.88)", zIndex: 600, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ background: "#4d2e00", border: "1px solid #3c2200", borderRadius: 16, padding: "28px 24px", maxWidth: 340, width: "100%", textAlign: "center" }}>
            <div style={{ color: "#c9a96e", fontSize: 10, letterSpacing: "3px", textTransform: "uppercase", marginBottom: 8 }}>Your Menu is Ready</div>

            {qrSaving ? (
              <div style={{ padding: "40px 0", color: "#c9a96e", fontSize: 12, letterSpacing: "2px" }}>Saving your menu…</div>
            ) : menuCode ? (
              <>
                <div style={{ color: "#f0e8d8", fontSize: 13, marginBottom: 8, lineHeight: 1.5 }}>Scan to view your menu while you dine</div>
                <div style={{ color: "#b8a080", fontSize: 11, fontStyle: "italic", marginBottom: 16, lineHeight: 1.5 }}>No cell service? Connect to <span style={{ color: "#c9a96e" }}>Corduroy Guest</span> WiFi first</div>
                <div style={{ background: "#ffffff", borderRadius: 12, padding: 14, display: "inline-block", marginBottom: 10 }}>
                  <img src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&ecc=M&data=${encodeURIComponent(`${window.location.origin}/?m=${menuCode}`)}`} alt="QR Code" style={{ width: 200, height: 200, display: "block" }} />
                </div>
                <div style={{ color: "#b8a080", fontSize: 11, fontStyle: "italic", marginBottom: 8 }}>Scan anytime — this code does not expire</div>
                <div style={{ background: "rgba(0,0,0,0.3)", borderRadius: 6, padding: "6px 10px", marginBottom: 20, wordBreak: "break-all" }}>
                  <span style={{ color: "#9a8060", fontSize: 9 }}>{`${window.location.origin}/?m=${menuCode}`}</span>
                </div>

                {/* Email section — coming soon, code preserved for when Resend is configured */}
              </>
            ) : (
              <div style={{ color: "#6a5040", padding: "24px 0", fontSize: 13 }}>Unable to save menu. Please ask your server.</div>
            )}

            <button onClick={() => setShowQR(false)} style={{ marginTop: 20, background: "#c9a96e", color: "#0d0800", border: "none", padding: "10px 32px", borderRadius: 8, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 13, fontWeight: 600 }}>Done</button>
          </div>
        </div>
      )}
    </div>
    </div>
  );
}

// ─── Sommelier Chat ───────────────────────────────────────────────────────────
// A slide-up chat drawer that opens from any pairing entry point.
// The backend system prompt hard-boxes the AI to F&B at Appalachia Kitchen only.
//
// Props:
//   isOpen       — controls visibility
//   onClose      — called when user taps X or backdrop
//   contextItem  — { name, type } of the wine/beer/pour/food that opened the chat
//                  used to personalise the opening message; null for generic open

function SommelierChat({ isOpen, onClose, contextItem, favorites = [], onToggleFavorite }) {
  const OPENER = contextItem
    ? `I see you're looking at the ${contextItem.name}. Before I start searching, is there anything I should know about your preferences — dietary restrictions, flavor dislikes, or anything else?`
    : "Before I start my search, is there anything I should know about your preferences — dietary restrictions, flavor dislikes, or budget?";

  // Each message: { role, text, suggestions? }
  const [messages, setMessages]   = useState([]);
  const [input, setInput]         = useState("");
  const [sending, setSending]     = useState(false);
  const bottomRef                 = useRef(null);
  const inputRef                  = useRef(null);

  useEffect(() => {
    if (isOpen) {
      setMessages([{ role: "assistant", text: OPENER, suggestions: [] }]);
      setInput("");
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [isOpen, contextItem?.name]); // intentional: only re-seed when item or open state changes

  useEffect(() => {
    if (isOpen) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isOpen]);

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;

    const newMessages = [...messages, { role: "user", text, suggestions: [] }];
    setMessages(newMessages);
    setInput("");
    setSending(true);

    try {
      const res = await fetch(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: newMessages.map(m => ({ role: m.role, content: m.text })),
          contextItem: contextItem || null,
        }),
      });
      const data = await res.json();
      setMessages(prev => [...prev, {
        role: "assistant",
        text: data.reply || "I'm not sure — please ask your server.",
        suggestions: data.suggestions || [],
      }]);
    } catch {
      setMessages(prev => [...prev, { role: "assistant", text: "Something went wrong. Please ask your server for help.", suggestions: [] }]);
    }
    setSending(false);
  }

  function handleKey(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  function handleAddToMenu(suggestion) {
    if (!onToggleFavorite) return;
    if (suggestion.type === "wine") {
      onToggleFavorite({
        id: suggestion.id,
        name: suggestion.name,
        varietal: suggestion.varietal || null,
        region: suggestion.region || null,
        glassPrice: suggestion.glassPrice || null,
        bottlePrice: suggestion.bottlePrice || null,
        imageUrl: suggestion.imageUrl || null,
        fromPairing: false,
      }, "wine");
    } else if (suggestion.type === "food") {
      onToggleFavorite({
        id: suggestion.id,
        name: suggestion.name,
        price: suggestion.price || null,
        course: suggestion.course || null,
        description: suggestion.description || null,
        courseRole: "main",
      }, "food");
    }
  }

  if (!isOpen) return null;

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 900, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 680, background: "#fff", borderRadius: "16px 16px 0 0", boxShadow: "0 -8px 40px rgba(0,0,0,0.25)", display: "flex", flexDirection: "column", maxHeight: "80vh", fontFamily: "Georgia, serif" }}
      >
        {/* Header */}
        <div style={{ background: "#472a00", borderRadius: "16px 16px 0 0", padding: "14px 18px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <div style={{ flex: 1 }}>
            <div style={{ color: "#c9a96e", fontSize: 10, letterSpacing: "3px", textTransform: "uppercase", marginBottom: 2 }}>Virtual Sommelier</div>
            <div style={{ color: "#f0e8d8", fontSize: 13 }}>Appalachia Kitchen</div>
          </div>
          <button
            onClick={onClose}
            style={{ background: "rgba(201,169,110,0.15)", border: "0.5px solid rgba(201,169,110,0.4)", color: "#c9a96e", width: 32, height: 32, borderRadius: "50%", cursor: "pointer", fontSize: 18, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
          >×</button>
        </div>

        {/* Message list */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 16px 8px" }}>
          {messages.map((m, i) => (
            <div key={i} style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                <div style={{
                  maxWidth: "85%",
                  background: m.role === "user" ? "#472a00" : "#faf5ec",
                  color: m.role === "user" ? "#f0e8d8" : "#3d2000",
                  border: m.role === "user" ? "none" : "0.5px solid #e8dcc8",
                  borderRadius: m.role === "user" ? "14px 14px 2px 14px" : "14px 14px 14px 2px",
                  padding: "10px 14px",
                  fontSize: 13,
                  lineHeight: 1.6,
                }}>
                  {m.text}
                </div>
              </div>

              {/* Suggestion chips — shown below assistant messages that mention menu items */}
              {m.role === "assistant" && m.suggestions && m.suggestions.length > 0 && (
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6, paddingLeft: 4 }}>
                  {m.suggestions.map((s, si) => {
                    const isAdded = favorites.some(f => f.id === s.id);
                    const icon = s.type === "wine" ? "🍷" : "🍽";
                    const sub = s.type === "wine"
                      ? [s.varietal, s.region].filter(Boolean).join(" · ")
                      : s.course;
                    return (
                      <div key={si} style={{ display: "flex", alignItems: "center", gap: 10, background: isAdded ? "rgba(76,175,125,0.08)" : "rgba(201,169,110,0.07)", border: `0.5px solid ${isAdded ? "#4caf7d" : "rgba(201,169,110,0.4)"}`, borderRadius: 10, padding: "8px 12px" }}>
                        <span style={{ fontSize: 16, flexShrink: 0 }}>{icon}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ color: "#3d2000", fontSize: 12, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</div>
                          {sub && <div style={{ color: "#9a7855", fontSize: 10, letterSpacing: "0.5px" }}>{sub}</div>}
                        </div>
                        <button
                          onClick={() => handleAddToMenu(s)}
                          style={{ background: isAdded ? "rgba(76,175,125,0.15)" : "#472a00", border: isAdded ? "0.5px solid #4caf7d" : "none", color: isAdded ? "#4caf7d" : "#c9a96e", fontSize: 11, padding: "5px 10px", borderRadius: 6, cursor: "pointer", fontFamily: "Georgia, serif", whiteSpace: "nowrap", flexShrink: 0 }}
                        >
                          {isAdded ? "★ Added" : "☆ Add to My Menu"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
          {sending && (
            <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 10 }}>
              <div style={{ background: "#faf5ec", border: "0.5px solid #e8dcc8", borderRadius: "14px 14px 14px 2px", padding: "10px 16px" }}>
                <span style={{ color: "#c9a96e", fontSize: 18, letterSpacing: 4 }}>• • •</span>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input bar */}
        <div style={{ padding: "8px 12px 16px", borderTop: "0.5px solid #e8e0d0", flexShrink: 0, display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Type your reply…"
            rows={1}
            style={{ flex: 1, background: "#faf8f4", border: "0.5px solid #d8cfc0", borderRadius: 20, padding: "10px 14px", fontFamily: "Georgia, serif", fontSize: 13, color: "#3d2000", outline: "none", resize: "none", lineHeight: 1.5, maxHeight: 90, overflowY: "auto" }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || sending}
            style={{ background: input.trim() && !sending ? "#c9a96e" : "rgba(201,169,110,0.2)", border: "none", borderRadius: "50%", width: 40, height: 40, cursor: input.trim() && !sending ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "background 0.15s" }}
          >
            <span style={{ color: input.trim() && !sending ? "#0d0800" : "#c9a96e", fontSize: 16, lineHeight: 1 }}>›</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Item Pairing Button (Beer & Pours) ──────────────────────────────────────

function ItemPairingButton({ item, onOpenChat, favorites = [], onToggleFavorite }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [shownDishes, setShownDishes] = useState([]);
  const pendingResult = useRef(null);
  const [msgReady, setMsgReady] = useState(false);

  function handleMsgComplete() {
    if (pendingResult.current !== null) {
      setResult(pendingResult.current);
      setLoading(false);
      pendingResult.current = null;
    }
    setMsgReady(true);
  }

  async function handlePairing() {
    pendingResult.current = null;
    setMsgReady(false);
    setLoading(true);
    try {
      const res = await fetch(PAIRING_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "drink_to_food",
          itemId: item.id,
          itemName: item.name,
          itemDescription: item.description || null,
          itemStyle: item.style || null,
          itemCategory: item.category || null,
          itemABV: item.abv || null,
          excludeDishes: shownDishes
        })
      });
      const data = await res.json();
      const pairings = data.pairings || [];
      setShownDishes(prev => [...new Set([...prev, ...pairings.map(p => p.name)])]);
      pendingResult.current = pairings;
      if (msgReady) { setResult(pairings); setLoading(false); pendingResult.current = null; }
    } catch (e) {
      pendingResult.current = [];
      if (msgReady) { setResult([]); setLoading(false); pendingResult.current = null; }
    }
  }

  return (
    <div>
      {!loading && (
        <div style={{ display: "flex", gap: 8, marginBottom: result ? 12 : 0 }}>
          <button onClick={handlePairing}
            style={{ flex: 1, background: "#472a00", color: "#c9a96e", border: "0.5px solid #c9a96e", padding: "12px", borderRadius: 8, fontSize: 13, cursor: "pointer", fontFamily: "Georgia, serif", letterSpacing: "0.5px" }}>
            {result ? "Give Me Different Options" : "Suggested Food Pairing"}
          </button>
          <button onClick={() => onOpenChat && onOpenChat({ name: item.name, type: item.style || item.category || "beverage" })}
            style={{ background: "rgba(201,169,110,0.12)", border: "0.5px solid #c9a96e", color: "#c9a96e", padding: "12px 14px", borderRadius: 8, fontSize: 13, cursor: "pointer", fontFamily: "Georgia, serif", whiteSpace: "nowrap" }}
            title="Ask the Sommelier">
            ✦ Ask
          </button>
        </div>
      )}
      {loading && <LoadingMessages messages={KITCHEN_MESSAGES} onAllShown={handleMsgComplete} />}
      {result && result.length > 0 && (
        <div style={{ marginTop: 2 }}>
          <div style={{ color: "#9a7855", fontSize: 9, letterSpacing: "2px", textTransform: "uppercase", marginBottom: 8 }}>Pairs beautifully with</div>
          {result.map((p, i) => {
            const isStarred = favorites.some(f => f.id === p.id);
            return (
              <div key={i} style={{ display: "flex", gap: 10, marginBottom: 8, paddingBottom: 8, borderBottom: i < result.length - 1 ? "0.5px solid #f0e8e0" : "none" }}>
                <div style={{ fontSize: 16, flexShrink: 0 }}>🍽</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: "#502e00", fontSize: 13, fontWeight: 500, marginBottom: 1 }}>{p.name}</div>
                  <div style={{ color: "#9a7855", fontSize: 10, textTransform: "uppercase", letterSpacing: "1px", marginBottom: 2 }}>{p.course}</div>
                  <div style={{ color: "#6a5040", fontSize: 12, fontStyle: "italic", lineHeight: 1.5, marginBottom: p.id ? 6 : 0 }}>{p.reason}</div>
                  {p.id && onToggleFavorite && (
                    <button onClick={() => onToggleFavorite({ id: p.id, name: p.name, course: p.course, description: p.reason, courseRole: "main" }, "food")}
                      style={{ background: isStarred ? "rgba(201,169,110,0.15)" : "rgba(201,169,110,0.08)", border: `0.5px solid ${isStarred ? "#c9a96e" : "rgba(201,169,110,0.4)"}`, color: "#c9a96e", fontSize: 11, padding: "4px 10px", borderRadius: 6, cursor: "pointer", fontFamily: "Georgia, serif" }}>
                      {isStarred ? "★ Added to My Menu" : "☆ Add to My Menu"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {result && result.length === 0 && (
        <div style={{ color: "#b0a090", fontSize: 12, textAlign: "center", padding: "8px 0" }}>Unable to find pairings — please ask your server.</div>
      )}
    </div>
  );
}

// ─── Label Zoom Modal ─────────────────────────────────────────────────────────

function LabelModal({ wine, onClose }) {
  if (!wine) return null;
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 800,
      background: "rgba(0,0,0,0.92)",
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      padding: 32, cursor: "pointer"
    }}>
      <img
        src={wine.imageUrl}
        alt={wine.name}
        style={{
          maxHeight: "72vh", maxWidth: "80vw",
          objectFit: "contain", borderRadius: 8,
          boxShadow: "0 8px 48px rgba(0,0,0,0.7)"
        }}
        onClick={e => e.stopPropagation()}
      />
      <div style={{ marginTop: 20, textAlign: "center" }}>
        <div style={{ color: "#f0e8d8", fontSize: 16, fontFamily: "Georgia, serif", marginBottom: 4 }}>{wine.name}</div>
        {(wine.varietal || wine.region) && (
          <div style={{ color: "#c9a96e", fontSize: 11, letterSpacing: "1px", textTransform: "uppercase", fontFamily: "Georgia, serif" }}>
            {[wine.varietal, wine.region].filter(Boolean).join(" · ")}
          </div>
        )}
      </div>
      <div style={{ marginTop: 24, color: "#5a4030", fontSize: 11, fontFamily: "Georgia, serif", letterSpacing: "1px" }}>
        TAP ANYWHERE TO CLOSE
      </div>
    </div>
  );
}

// ─── Wine Detail Panel ────────────────────────────────────────────────────────

function WineDetailPanel({ wine, onClose, onOpenChat, favorites = [], onToggleFavorite }) {
  const [pairingLoading, setPairingLoading] = useState(false);
  const [pairingResult, setPairingResult] = useState(null);

  const [shownDishes, setShownDishes] = useState([]);
  const pendingDishes = useRef(null);
  const [dishMessagesReady, setDishMessagesReady] = useState(false);

  function handleDishMessagesComplete() {
    if (pendingDishes.current !== null) {
      setPairingResult(pendingDishes.current);
      setPairingLoading(false);
      pendingDishes.current = null;
    }
    setDishMessagesReady(true);
  }

  async function handlePairing() {
    pendingDishes.current = null;
    setDishMessagesReady(false);
    setPairingLoading(true);
    try {
      const res = await fetch(PAIRING_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "wine_to_food", itemId: wine.id, excludeDishes: shownDishes })
      });
      const data = await res.json();
      const pairings = data.pairings || [];
      setShownDishes(prev => [...new Set([...prev, ...pairings.map(p => p.name)])]);
      pendingDishes.current = pairings;
      if (dishMessagesReady) { setPairingResult(pairings); setPairingLoading(false); pendingDishes.current = null; }
    } catch (e) {
      pendingDishes.current = [];
      if (dishMessagesReady) { setPairingResult([]); setPairingLoading(false); pendingDishes.current = null; }
    }
  }

  return (
    <div style={{ position: "sticky", bottom: 0, background: "#fff", borderTop: "1px solid #e8e0d0", padding: "18px 20px", boxShadow: "0 -8px 32px rgba(0,0,0,0.10)", maxHeight: "70vh", overflowY: "auto" }}>
      <div style={{ display: "flex", gap: 14, marginBottom: 12 }}>
        <div style={{ width: 52, height: 72, borderRadius: 4, background: "#f0ebe0", border: "0.5px solid #e0d8c8", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, overflow: "hidden" }}>
          {wine.imageUrl ? <img src={wine.imageUrl} alt={wine.name} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 4 }} /> : "🍷"}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: "#502e00", fontSize: 16, marginBottom: 3, lineHeight: 1.3 }}>{wine.name}</div>
          <div style={{ color: "#c9a96e", fontSize: 10, letterSpacing: "1px", textTransform: "uppercase" }}>
            {[wine.varietal, wine.region, wine.vintage ? `${wine.vintage}` : null].filter(Boolean).join(" · ")}
          </div>
        </div>
        <button onClick={onClose} style={{ background: "transparent", border: "none", color: "#b0a090", fontSize: 22, cursor: "pointer", padding: "0 4px", alignSelf: "flex-start", lineHeight: 1 }}>×</button>
      </div>

      {wine.description ? (
        <div style={{ color: "#5a4a3a", fontSize: 13, lineHeight: 1.8, marginBottom: 12 }}>{wine.description}</div>
      ) : (
        <div style={{ color: "#c0b0a0", fontSize: 12, fontStyle: "italic", marginBottom: 12 }}>Ask your server for tasting notes</div>
      )}

      {wine.reviews && wine.reviews !== "null" && (
        <div style={{ background: "#faf8f4", border: "0.5px solid #e8e0d0", borderRadius: 6, padding: "8px 12px", marginBottom: 12 }}>
          <div style={{ color: "#c9a96e", fontSize: 9, letterSpacing: "2px", textTransform: "uppercase", marginBottom: 3 }}>Reviews &amp; Ratings</div>
          <div style={{ color: "#5a4a3a", fontSize: 12, lineHeight: 1.6 }}>{wine.reviews}</div>
        </div>
      )}

      <div style={{ display: "flex", gap: 24, marginBottom: 14, paddingBottom: 14, borderBottom: "0.5px solid #e8e0d0" }}>
        {wine.glassPrice && (
          <div>
            <div style={{ color: "#b0a090", fontSize: 10, letterSpacing: "2px", textTransform: "uppercase", marginBottom: 2 }}>Glass</div>
            <div style={{ color: "#502e00", fontSize: 22 }}>{formatPrice(wine.glassPrice)}</div>
          </div>
        )}
        {wine.bottlePrice && (
          <div>
            <div style={{ color: "#b0a090", fontSize: 10, letterSpacing: "2px", textTransform: "uppercase", marginBottom: 2 }}>Bottle</div>
            <div style={{ color: "#502e00", fontSize: 22 }}>{formatPrice(wine.bottlePrice)}</div>
          </div>
        )}
        {!wine.glassPrice && !wine.bottlePrice && (
          <div style={{ color: "#c0b0a0", fontSize: 13, fontStyle: "italic", alignSelf: "center" }}>Ask your server for pricing</div>
        )}
      </div>

      {!pairingLoading && (
        <div style={{ display: "flex", gap: 8, marginBottom: pairingResult ? 14 : 0 }}>
          <button onClick={handlePairing}
            style={{ flex: 1, background: "#472a00", color: "#c9a96e", border: "0.5px solid #c9a96e", padding: "12px", borderRadius: 8, fontSize: 13, cursor: "pointer", fontFamily: "Georgia, serif", letterSpacing: "0.5px" }}>
            Suggested Food Pairing
          </button>
          <button onClick={() => onOpenChat && onOpenChat({ name: wine.name, type: wine.varietal || "wine" })}
            style={{ background: "rgba(201,169,110,0.12)", border: "0.5px solid #c9a96e", color: "#c9a96e", padding: "12px 14px", borderRadius: 8, fontSize: 13, cursor: "pointer", fontFamily: "Georgia, serif", whiteSpace: "nowrap" }}
            title="Ask the Sommelier">
            ✦ Ask
          </button>
        </div>
      )}
      {pairingLoading && <LoadingMessages messages={KITCHEN_MESSAGES} onAllShown={handleDishMessagesComplete} />}

      {pairingResult && pairingResult.length > 0 && (
        <div>
          <div style={{ color: "#9a7855", fontSize: 9, letterSpacing: "2px", textTransform: "uppercase", marginBottom: 10 }}>Pairs beautifully with</div>
          {pairingResult.map((p, i) => {
            const isStarred = favorites.some(f => f.id === p.id);
            return (
              <div key={i} style={{ display: "flex", gap: 10, marginBottom: 10, paddingBottom: 10, borderBottom: i < pairingResult.length - 1 ? "0.5px solid #f0e8e0" : "none" }}>
                <div style={{ fontSize: 18, flexShrink: 0 }}>🍽</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: "#502e00", fontSize: 13, fontWeight: 500, marginBottom: 2 }}>{p.name}</div>
                  <div style={{ color: "#9a7855", fontSize: 10, letterSpacing: "1px", textTransform: "uppercase", marginBottom: 3 }}>{p.course}</div>
                  <div style={{ color: "#6a5040", fontSize: 12, fontStyle: "italic", lineHeight: 1.5, marginBottom: p.id ? 6 : 0 }}>{p.reason}</div>
                  {p.id && onToggleFavorite && (
                    <button onClick={() => onToggleFavorite({ id: p.id, name: p.name, course: p.course, description: p.reason, courseRole: "main" }, "food")}
                      style={{ background: isStarred ? "rgba(201,169,110,0.15)" : "rgba(201,169,110,0.08)", border: `0.5px solid ${isStarred ? "#c9a96e" : "rgba(201,169,110,0.4)"}`, color: "#c9a96e", fontSize: 11, padding: "4px 10px", borderRadius: 6, cursor: "pointer", fontFamily: "Georgia, serif" }}>
                      {isStarred ? "★ Added to My Menu" : "☆ Add to My Menu"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {pairingResult && pairingResult.length === 0 && (
        <div style={{ color: "#b0a090", fontSize: 12, textAlign: "center", padding: "8px 0" }}>Unable to find pairings — please ask your server.</div>
      )}
    </div>
  );
}

// ─── Sommelier Screen ─────────────────────────────────────────────────────────

function SommelierScreen({ onBack, favorites = [], onToggleFavorite = () => {}, onShowShortlist = () => {} }) {
  const [foodItems, setFoodItems] = useState([]);
  const [loadingFood, setLoadingFood] = useState(true);
  const [activeCourse, setActiveCourse] = useState("All");
  const [selectedFoods, setSelectedFoods] = useState([]);
  const [pairingResult, setPairingResult] = useState(null);
  const [pairingLoading, setPairingLoading] = useState(false);
  const [view, setView] = useState("pick");
  const [chatOpen, setChatOpen] = useState(false);

  useEffect(() => {
    fetch(FOOD_URL).then(r => r.json())
      .then(data => { setFoodItems(data.foodItems || []); setLoadingFood(false); })
      .catch(() => setLoadingFood(false));
  }, []);

  const [lastShownIds, setLastShownIds] = useState({});
  const pendingPairing = useRef(null);
  const [messagesReady, setMessagesReady] = useState(false);
  const [zoomedLabel, setZoomedLabel] = useState(null);

  function handleMessagesComplete() {
    if (pendingPairing.current !== null) {
      setPairingResult(pendingPairing.current);
      setPairingLoading(false);
      pendingPairing.current = null;
    }
    setMessagesReady(true);
  }

  function handleFoodToggle(food, role) {
    const hasRole = selectedFoods.some(f => f.id === food.id && f.courseRole === role);
    let newSelected;
    if (hasRole) {
      newSelected = selectedFoods.filter(f => !(f.id === food.id && f.courseRole === role));
    } else {
      newSelected = [...selectedFoods, { ...food, courseRole: role }];
    }
    setSelectedFoods(newSelected);
    // Add to shortlist when first selection for this dish; remove when all selections cleared
    const hadAny = selectedFoods.some(f => f.id === food.id);
    const hasAny = newSelected.some(f => f.id === food.id);
    const isFav = favorites.some(f => f.id === food.id);
    if (!hadAny && hasAny && !isFav) onToggleFavorite({ id: food.id, name: food.name, price: food.price, course: food.course, courseRole: role, description: food.description }, "food");
    if (hadAny && !hasAny && isFav) onToggleFavorite({ id: food.id, name: food.name, price: food.price, course: food.course, courseRole: role, description: food.description }, "food");
  }

  function storeResult(data) {
    const roleLabels = { first: "First Course", main: "Main Course", dessert: "Dessert" };
    if (data.byCourse) {
      // Embed courseLabel directly on each pairing so it travels with the data
      const taggedCourses = data.byCourse.map(c => ({
        ...c,
        pairings: (c.pairings || []).map(p => ({ ...p, courseLabel: c.course }))
      }));
      const ids = {};
      taggedCourses.forEach(c => c.pairings?.forEach(p => { if (p.id) ids[`${c.course}-${p.level}`] = p.id; }));
      setLastShownIds(ids);
      const result = { byCourse: taggedCourses };
      pendingPairing.current = result;
      if (messagesReady) { setPairingResult(result); setPairingLoading(false); pendingPairing.current = null; }
    } else {
      // Single course — determine course label from selected foods
      const roles = [...new Set(selectedFoods.map(f => f.courseRole || "main"))];
      const singleCourseLabel = roles.length === 1 ? (roleLabels[roles[0]] || null) : null;
      const pairings = (data.pairings || []).map(p => ({ ...p, courseLabel: singleCourseLabel }));
      const ids = {};
      pairings.forEach(p => { if (p.id) ids[p.level] = p.id; });
      setLastShownIds(ids);
      pendingPairing.current = pairings;
      if (messagesReady) { setPairingResult(pairings); setPairingLoading(false); pendingPairing.current = null; }
    }
  }

  async function handleGetPairings() {
    if (selectedFoods.length === 0) return;
    setPairingLoading(true);
    setPairingResult(null);
    pendingPairing.current = null;
    setMessagesReady(false);
    setLastShownIds({});
    setView("result");
    try {
      const res = await fetch(PAIRING_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "food_to_wine", items: selectedFoods.map(f => ({ id: f.id, courseRole: f.courseRole })) })
      });
      storeResult(await res.json());
    } catch (e) {
      pendingPairing.current = [];
      if (messagesReady) { setPairingResult([]); setPairingLoading(false); pendingPairing.current = null; }
    }
  }

  async function handleDifferentOptions() {
    if (selectedFoods.length === 0) return;
    setPairingLoading(true);
    setPairingResult(null);
    pendingPairing.current = null;
    setMessagesReady(false);
    try {
      const res = await fetch(PAIRING_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "food_to_wine", items: selectedFoods.map(f => ({ id: f.id, courseRole: f.courseRole })), excludeWineIds: lastShownIds })
      });
      storeResult(await res.json());
    } catch (e) {
      pendingPairing.current = [];
      if (messagesReady) { setPairingResult([]); setPairingLoading(false); pendingPairing.current = null; }
    }
  }

  const availableFood = foodItems.filter(f => !f.excluded);
  const courses = ["All", ...new Set(availableFood.map(f => f.course))];
  const filtered = activeCourse === "All" ? availableFood : availableFood.filter(f => f.course === activeCourse);

  return (
    <div style={{ background: "#3d2200", minHeight: "100vh", fontFamily: "Georgia, serif", maxWidth: 680, margin: "0 auto" }}>
      <div style={{ background: "#432800", padding: "0 20px", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ padding: "10px 0 10px", display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={view === "result" ? () => { setView("pick"); setPairingResult(null); } : onBack}
            style={{ background: "none", border: "none", color: "#c9a96e", cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 12, letterSpacing: "1px", display: "flex", alignItems: "center", gap: 4, padding: 0 }}>
            ‹ <span style={{ textTransform: "uppercase", letterSpacing: "2px" }}>{view === "result" ? "Back" : "Main Menu"}</span>
          </button>
          <div style={{ flex: 1, textAlign: "center" }}>
            <div style={{ color: "#e8d5a0", fontSize: 14, letterSpacing: "4px", textTransform: "uppercase" }}>Wine Pairing</div>
          </div>
          <div style={{ width: 80, textAlign: "right" }}>
            {favorites.length > 0 && (
              <button onClick={onShowShortlist} style={{ background: "rgba(201,169,110,0.15)", border: "0.5px solid rgba(201,169,110,0.4)", color: "#c9a96e", padding: "4px 10px", borderRadius: 12, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 11 }}>
                ★ {favorites.length}
              </button>
            )}
          </div>
        </div>
        <div style={{ height: "0.5px", background: "linear-gradient(90deg, transparent, #c9a96e44, transparent)", marginBottom: 10 }} />
        {view === "pick" && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            {courses.map(c => (
              <button key={c} onClick={() => setActiveCourse(c)} style={{
                background: activeCourse === c ? "#c9a96e" : "rgba(255,255,255,0.07)",
                border: `0.5px solid ${activeCourse === c ? "#c9a96e" : "rgba(255,255,255,0.15)"}`,
                color: activeCourse === c ? "#432800" : "#c8a878",
                fontSize: 11, padding: "5px 13px", borderRadius: 20, cursor: "pointer",
                fontFamily: "Georgia, serif", whiteSpace: "nowrap", fontWeight: activeCourse === c ? 600 : 400
              }}>{c}</button>
            ))}
          </div>
        )}
      </div>

      {view === "pick" && (
        <>
        <div>
          <div style={{ background: "#472a00", padding: "8px 16px 10px 20px" }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
              <div style={{ flex: 1, color: "#c9a96e", fontSize: 11, letterSpacing: "1px" }}>Select up to 4 dishes per course</div>
            </div>
            <div style={{ color: "#9a7855", fontSize: 10, fontStyle: "italic", lineHeight: 1.5 }}>
              For larger parties, run the sommelier a second time to capture additional guests' selections.
            </div>
          </div>
          <div style={{ background: "#faf8f4" }}>
            {loadingFood ? (
              <div style={{ color: "#b0a090", textAlign: "center", padding: 40 }}>Loading menu…</div>
            ) : (() => {
              const courseOrder = [...new Map(filtered.map(f => [f.course, true])).keys()];
              const byCourse = {};
              filtered.forEach(f => { if (!byCourse[f.course]) byCourse[f.course] = []; byCourse[f.course].push(f); });
              return courseOrder.map(course => (
                <div key={course}>
                  <div style={{ padding: "8px 16px 6px 20px", background: "#5e3600", display: "flex", alignItems: "center" }}>
                    <div style={{ flex: 1, color: "#c9a96e", fontSize: 9, letterSpacing: "3px", textTransform: "uppercase", fontWeight: 600 }}>{course}</div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <div style={{ width: 22, textAlign: "center", color: "#c9a96e", fontSize: 8, letterSpacing: "1px", textTransform: "uppercase", visibility: (course !== "Entrees" && course !== "Dessert") ? "visible" : "hidden" }}>1ST</div>
                      <div style={{ width: 22, textAlign: "center", color: "#c9a96e", fontSize: 8, letterSpacing: "1px", textTransform: "uppercase", visibility: course !== "Dessert" ? "visible" : "hidden" }}>MAIN</div>
                      <div style={{ width: 22, textAlign: "center", color: "#c9a96e", fontSize: 8, letterSpacing: "1px", textTransform: "uppercase", visibility: course === "Dessert" ? "visible" : "hidden" }}>DES</div>
                    </div>
                  </div>
                  {byCourse[course].map(food => {
                    const isEntree = food.course === "Entrees";
                    const isDessert = food.course === "Dessert";
                    const chkFirst   = selectedFoods.some(f => f.id === food.id && f.courseRole === "first");
                    const chkMain    = selectedFoods.some(f => f.id === food.id && f.courseRole === "main");
                    const chkDessert = selectedFoods.some(f => f.id === food.id && f.courseRole === "dessert");
                    const anySelected = chkFirst || chkMain || chkDessert;
                    // Enforce max 4 per course
                    const firstCount   = selectedFoods.filter(f => f.courseRole === "first").length;
                    const mainCount    = selectedFoods.filter(f => f.courseRole === "main").length;
                    const dessertCount = selectedFoods.filter(f => f.courseRole === "dessert").length;

                    const Chk = ({ checked, role, disabled }) => (
                      <div onClick={disabled ? null : () => handleFoodToggle(food, role)}
                        style={{ width: 22, height: 22, borderRadius: 5, border: `1.5px solid ${checked ? "#c9a96e" : disabled ? "transparent" : "#d0c0b0"}`, background: checked ? "#c9a96e" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: disabled ? "default" : "pointer", flexShrink: 0, transition: "all 0.15s" }}>
                        {checked && <span style={{ color: "#0d0800", fontSize: 11, fontWeight: 700, lineHeight: 1 }}>✓</span>}
                      </div>
                    );

                    return (
                          <div key={food.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 16px 11px 20px", borderBottom: "0.5px solid #e8e0d0", background: anySelected ? "#f0ebe4" : "#faf8f4", transition: "background 0.15s" }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ color: "#502e00", fontSize: 13, marginBottom: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{food.name}</div>
                              {food.description && <div style={{ color: "#8a7060", fontSize: 11, lineHeight: 1.3 }}>{food.description}</div>}
                            </div>
                            <div style={{ color: "#8a7060", fontSize: 12, flexShrink: 0, marginRight: 4 }}>{formatPrice(food.price)}</div>
                            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                              <Chk checked={chkFirst}   role="first"   disabled={isEntree || isDessert || (!chkFirst && firstCount >= 4)} />
                              <Chk checked={chkMain}    role="main"    disabled={isDessert || (!chkMain && mainCount >= 4)} />
                              <Chk checked={chkDessert} role="dessert" disabled={!isDessert || (!chkDessert && dessertCount >= 4)} />
                            </div>
                          </div>
                    );
                  })}
                </div>
              ));
            })()}
          </div>
        </div>

        {/* Sticky Find Pairings button */}
        {selectedFoods.length > 0 && (
          <div style={{ position: "sticky", bottom: 0, background: "#3d2200", borderTop: "0.5px solid #3c2200", padding: "12px 20px 16px" }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
              {selectedFoods.map(f => (
                <div key={f.id} style={{ background: "rgba(201,169,110,0.12)", border: "0.5px solid rgba(201,169,110,0.35)", borderRadius: 14, padding: "4px 8px 4px 10px", display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ color: "#f0e8d8", fontSize: 11 }}>{f.name}</span>
                  {f.courseRole !== "main" && <span style={{ color: "#9a7855", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.5px" }}>{f.courseRole === "first" ? "1st" : "Dessert"}</span>}
                  <span onClick={e => { e.stopPropagation(); handleFoodToggle(f, f.courseRole); }} style={{ color: "#6a5040", fontSize: 16, cursor: "pointer", lineHeight: 1 }}>×</span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handleGetPairings}
                style={{ flex: 1, background: "#c9a96e", color: "#0d0800", border: "none", padding: "14px", borderRadius: 8, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 14, fontWeight: 600, letterSpacing: "0.5px" }}>
                Find Wine Pairings for {selectedFoods.length} {selectedFoods.length === 1 ? "Dish" : "Dishes"}{[...new Set(selectedFoods.map(f => f.courseRole))].length > 1 ? ` · ${[...new Set(selectedFoods.map(f => f.courseRole))].length} Courses` : ""} →
              </button>
              <button onClick={() => setChatOpen(true)}
                style={{ background: "rgba(201,169,110,0.12)", border: "0.5px solid #c9a96e", color: "#c9a96e", padding: "14px 16px", borderRadius: 8, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 13, whiteSpace: "nowrap", flexShrink: 0 }}>
                ✦ Ask
              </button>
            </div>
          </div>
        )}
        {selectedFoods.length === 0 && (
          <div style={{ position: "sticky", bottom: 0, background: "#3d2200", borderTop: "0.5px solid #3c2200", padding: "12px 20px 14px", textAlign: "center" }}>
            <button onClick={() => setChatOpen(true)}
              style={{ background: "rgba(201,169,110,0.12)", border: "0.5px solid #c9a96e", color: "#c9a96e", padding: "11px 28px", borderRadius: 8, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 13 }}>
              ✦ Ask the Sommelier Instead
            </button>
          </div>
        )}
        </>
      )}

      {view === "result" && (
        <div style={{ padding: "20px 20px", background: "#3d2200" }}>
          {selectedFoods.length > 0 && pairingLoading && (() => {
            const roleOrder = ["first", "main", "dessert"];
            const roleLabels = { first: "First Course", main: "Main Course", dessert: "Dessert" };
            const grouped = {};
            selectedFoods.forEach(f => {
              const r = f.courseRole || "main";
              if (!grouped[r]) grouped[r] = [];
              grouped[r].push(f);
            });
            const courses = roleOrder.filter(r => grouped[r]);
            return (
              <div style={{ background: "rgba(201,169,110,0.06)", border: "0.5px solid rgba(201,169,110,0.2)", borderRadius: 8, padding: "14px 16px", marginBottom: 20 }}>
                <div style={{ color: "#9a7855", fontSize: 9, letterSpacing: "2px", textTransform: "uppercase", marginBottom: 12 }}>
                  Your table's selections
                </div>
                {courses.map((role, ci) => (
                  <div key={role} style={{ marginBottom: ci < courses.length - 1 ? 14 : 0 }}>
                    <div style={{ color: "#c9a96e", fontSize: 9, letterSpacing: "2px", textTransform: "uppercase", marginBottom: 6 }}>{roleLabels[role]}</div>
                    {grouped[role].map((f, i) => (
                      <div key={`${f.id}-${role}`} style={{ marginBottom: i < grouped[role].length - 1 ? 6 : 0, paddingLeft: 10, borderLeft: "1.5px solid rgba(201,169,110,0.25)" }}>
                        <div style={{ color: "#f0e8d8", fontSize: 13 }}>{f.name}</div>
                        {f.description && <div style={{ color: "#c8b49a", fontSize: 11, fontStyle: "italic" }}>{f.description}</div>}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            );
          })()}

          {pairingLoading && (
            <LoadingMessages messages={SOMMELIER_MESSAGES} onAllShown={handleMessagesComplete} />
          )}

          {(() => {
            const pairings = Array.isArray(pairingResult) ? pairingResult : null;
            const byCourse = pairingResult?.byCourse || null;
            const hasResults = pairings?.length > 0 || byCourse?.length > 0;
            const isEmpty = pairingResult && !pairingLoading && !hasResults;

            const WineCard = (p, i) => (
              <div key={i} style={{ background: "rgba(255,255,255,0.06)", border: "0.5px solid rgba(201,169,110,0.3)", borderRadius: 10, padding: "16px", marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                  <div style={{ background: "rgba(201,169,110,0.15)", border: "0.5px solid rgba(201,169,110,0.3)", borderRadius: 12, padding: "3px 10px" }}>
                    <span style={{ color: "#c9a96e", fontSize: 10, letterSpacing: "1px", textTransform: "uppercase" }}>{p.level}</span>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    {p.glassPrice && <div style={{ color: "#f0e8d8", fontSize: 13 }}>{formatPrice(p.glassPrice)} <span style={{ color: "#c9a96e", fontSize: 10 }}>glass</span></div>}
                    {p.bottlePrice && <div style={{ color: "#f0e8d8", fontSize: 13 }}>{formatPrice(p.bottlePrice)} <span style={{ color: "#c9a96e", fontSize: 10 }}>bottle</span></div>}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
                  {p.imageUrl && <div onClick={() => setZoomedLabel({ name: p.name, varietal: p.varietal, region: p.region, imageUrl: p.imageUrl })} style={{ width: 52, height: 72, borderRadius: 4, flexShrink: 0, overflow: "hidden", border: "0.5px solid #c9a96e", cursor: "zoom-in" }}><img src={p.imageUrl} alt={p.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: "#f5ede0", fontSize: 15, marginBottom: 4 }}>{p.name}</div>
                    {(p.varietal || p.region) && <div style={{ color: "#c9a96e", fontSize: 10, letterSpacing: "1px", textTransform: "uppercase", marginBottom: 8 }}>{[p.varietal, p.region].filter(Boolean).join(" · ")}</div>}
                  </div>
                </div>
                <div style={{ color: "#c8b49a", fontSize: 13, fontStyle: "italic", lineHeight: 1.6 }}>{p.reason}</div>
                {p.id && (() => {
                  const wineObj = { id: p.id, name: p.name, varietal: p.varietal, region: p.region, glassPrice: p.glassPrice, bottlePrice: p.bottlePrice, imageUrl: p.imageUrl || null, reason: p.reason || null, level: p.level || null, courseLabel: p.courseLabel || null, fromPairing: true };
                  const isStarred = favorites.some(f => f.id === p.id);
                  return <button onClick={() => onToggleFavorite(wineObj)} style={{ marginTop: 10, background: isStarred ? "rgba(201,169,110,0.2)" : "rgba(201,169,110,0.1)", border: `1px solid ${isStarred ? "#c9a96e" : "#c9a96e"}`, color: "#c9a96e", padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 12, display: "flex", alignItems: "center", gap: 6, width: "100%", justifyContent: "center" }}>{isStarred ? "★ Added to My Menu" : "☆ Add to My Menu"}</button>;
                })()}
              </div>
            );

            return (
              <>
                {/* Single course */}
                {pairings?.map((p, i) => WineCard(p, i))}

                {/* Multi-course */}
                {byCourse?.map((courseResult, ci) => (
                  <div key={ci} style={{ marginBottom: 24 }}>
                    <div style={{ background: "rgba(201,169,110,0.12)", border: "0.5px solid rgba(201,169,110,0.35)", borderRadius: 8, padding: "12px 14px", marginBottom: 14 }}>
                      <div style={{ color: "#c9a96e", fontSize: 13, letterSpacing: "2px", textTransform: "uppercase", fontWeight: 600, marginBottom: courseResult.dishes?.length > 0 ? 6 : 0 }}>
                        ✦ {courseResult.course}
                      </div>
                      {courseResult.dishes?.length > 0 && (
                        <div style={{ color: "#9a8060", fontSize: 12, fontStyle: "italic" }}>
                          {courseResult.dishes.join(" · ")}
                        </div>
                      )}
                    </div>
                    {courseResult.pairings?.map((p, i) => WineCard(p, `${ci}-${i}`))}
                  </div>
                ))}

                {!pairingLoading && hasResults && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ color: "#9a8060", fontSize: 11, textAlign: "center", fontStyle: "italic", lineHeight: 1.5 }}>
                      If suggestions repeat, it reflects the limits of our current wine selection for this dish.
                    </div>
                  </div>
                )}

                {isEmpty && <div style={{ color: "#9a8060", textAlign: "center", padding: "40px 0", fontSize: 14 }}>Unable to find pairings — please ask your server.</div>}
              </>
            );
          })()}

          {!pairingLoading && pairingResult && (
            <div style={{ position: "sticky", bottom: 0, background: "#3d2200", borderTop: "0.5px solid #3c2200", padding: "12px 20px 16px", marginTop: 8 }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <button onClick={handleDifferentOptions} style={{ flex: 1, background: "rgba(201,169,110,0.08)", border: "0.5px solid rgba(201,169,110,0.3)", color: "#c9a96e", padding: "11px", borderRadius: 8, fontSize: 13, cursor: "pointer", fontFamily: "Georgia, serif", letterSpacing: "0.5px" }}>
                  Different Options
                </button>
                <button onClick={() => setChatOpen(true)} style={{ background: "rgba(201,169,110,0.12)", border: "0.5px solid #c9a96e", color: "#c9a96e", padding: "11px 14px", borderRadius: 8, fontSize: 13, cursor: "pointer", fontFamily: "Georgia, serif", whiteSpace: "nowrap" }}>
                  ✦ Ask
                </button>
              </div>
              <button onClick={onShowShortlist}
                style={{ width: "100%", background: "#c9a96e", color: "#0d0800", border: "none", padding: "13px", borderRadius: 8, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 14, fontWeight: 600, letterSpacing: "0.5px" }}>
                ★ Go to My Menu
              </button>
            </div>
          )}
        </div>
      )}
      <LabelModal wine={zoomedLabel} onClose={() => setZoomedLabel(null)} />
      <SommelierChat isOpen={chatOpen} onClose={() => setChatOpen(false)} contextItem={null} favorites={favorites} onToggleFavorite={onToggleFavorite} />
    </div>
  );
}

function HomeScreen({ onNavigate, favorites = [], onShowShortlist = () => {}, onAdminTap = () => {} }) {
  const [visible, setVisible] = useState(false);
  const [tapCount, setTapCount] = useState(0);
  const tapTimer = useRef(null);

  function handleLogoTap() {
    const next = tapCount + 1;
    setTapCount(next);
    if (tapTimer.current) clearTimeout(tapTimer.current);
    if (next >= 5) { setTapCount(0); onAdminTap(); }
    else { tapTimer.current = setTimeout(() => setTapCount(0), 2000); }
  }

  useEffect(() => {
    setTimeout(() => setVisible(true), 50);
    return () => { if (tapTimer.current) clearTimeout(tapTimer.current); };
  }, []);

  const buttons = [
    { id: "wine", label: "Wine List", icon: "🍷", available: true },
    { id: "beer", label: "Beer List", icon: "🍺", available: true },
    { id: "pours", label: "Premium Pours", icon: "🥃", available: true },
    { id: "cocktails", label: "Specialty Cocktails", icon: "🍸", available: true },
    { id: "nab", label: "Non-Alcoholic Beverages", icon: "🥤", available: true },
    { id: "sommelier", label: "Get a Wine Pairing", icon: "✦", available: true },
  ];

  return (
    <div style={{
      background: "#3d2200", minHeight: "100vh", fontFamily: "Georgia, serif",
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "flex-start", padding: "48px 32px 40px",
      opacity: visible ? 1 : 0, transition: "opacity 0.6s ease",
      maxWidth: 680, margin: "0 auto"
    }}>
      {/* Ambient glow */}
      <div style={{
        position: "fixed", top: 0, left: "50%", transform: "translateX(-50%)",
        width: 600, height: 300, pointerEvents: "none",
        background: "radial-gradient(ellipse at 50% 0%, rgba(201,169,110,0.08) 0%, transparent 70%)"
      }} />

      {/* Logo — tap 5x for manager access */}
      <div onClick={handleLogoTap} style={{ marginBottom: 40, textAlign: "center", cursor: "default", userSelect: "none" }}>
        <img
          src="/Appalachia Kitchen Logo White App.png"
          alt="Appalachia Kitchen"
          style={{ width: "min(340px, 80vw)", opacity: 0.95, filter: "brightness(1.5) contrast(1.05)" }}
        />
      </div>

      {/* Menu buttons */}
      <div style={{ width: "100%", maxWidth: 340, display: "flex", flexDirection: "column", gap: 14 }}>
        {buttons.map(btn => (
          <button
            key={btn.id}
            onClick={() => btn.available && onNavigate(btn.id)}
            style={{
              background: btn.id === "sommelier"
                ? "rgba(180,120,60,0.18)"
                : btn.available ? "rgba(201,169,110,0.08)" : "rgba(255,255,255,0.02)",
              border: btn.id === "sommelier"
                ? "1px solid rgba(201,169,110,0.8)"
                : `0.5px solid ${btn.available ? "rgba(201,169,110,0.5)" : "rgba(255,255,255,0.08)"}`,
              borderRadius: 8, padding: "18px 24px",
              display: "flex", alignItems: "center", justifyContent: "space-between",
              cursor: btn.available ? "pointer" : "default",
              transition: "all 0.2s", width: "100%",
              opacity: btn.available ? 1 : 0.35,
            }}
            onMouseEnter={e => { if (btn.available) e.currentTarget.style.background = btn.id === "sommelier" ? "rgba(180,120,60,0.28)" : "rgba(201,169,110,0.14)"; }}
            onMouseLeave={e => { if (btn.available) e.currentTarget.style.background = btn.id === "sommelier" ? "rgba(180,120,60,0.18)" : "rgba(201,169,110,0.08)"; }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <span style={{ fontSize: 20 }}>{btn.icon}</span>
              <span style={{
                color: btn.id === "sommelier" ? "#c9a96e" : btn.available ? "#e8d9b8" : "#5a4a30",
                fontSize: btn.id === "sommelier" ? 14 : btn.id === "nab" ? 13 : 15,
                letterSpacing: btn.id === "sommelier" ? "1.5px" : btn.id === "nab" ? "1px" : "2px",
                textTransform: "uppercase", fontFamily: "Georgia, serif",
                textAlign: "left", lineHeight: 1.3
              }}>
                {btn.label}
              </span>
            </div>
            {btn.available ? (
              <span style={{ color: "#c9a96e", fontSize: 18, lineHeight: 1 }}>›</span>
            ) : (
              <span style={{ color: "#4e3e24", fontSize: 10, letterSpacing: "1px", textTransform: "uppercase" }}>Soon</span>
            )}
          </button>
        ))}
      </div>

      {/* Shortlist button */}
      {favorites.length > 0 && (
        <button onClick={onShowShortlist} style={{ marginTop: 24, background: "rgba(201,169,110,0.12)", border: "0.5px solid #c9a96e", color: "#c9a96e", padding: "10px 28px", borderRadius: 24, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 13, letterSpacing: "1px", display: "flex", alignItems: "center", gap: 8 }}>
          ★ My Menu <span style={{ background: "rgba(201,169,110,0.25)", borderRadius: 10, padding: "1px 8px", fontSize: 12 }}>{favorites.length}</span>
        </button>
      )}

      {/* Footer */}
      <div style={{ marginTop: 32, color: "#9a7855", fontSize: 10, letterSpacing: "2px", textTransform: "uppercase" }}>
        Corduroy Inn & Lodge · Snowshoe Mountain
      </div>
    </div>
  );
}

// ─── Wine List Screen ─────────────────────────────────────────────────────────

function WineListScreen({ wines, favorites, onToggleFavorite, onBack, onShowShortlist }) {
  const [activeTier, setActiveTier]       = useState("All");
  const [activeSubgroup, setActiveSubgroup] = useState("All");
  const [activeVarietal, setActiveVarietal] = useState("All");
  const [selectedWine, setSelectedWine]   = useState(null);
  const [wineSearch, setWineSearch]       = useState("");
  const [visible, setVisible]             = useState(false);
  const [zoomedLabel, setZoomedLabel]     = useState(null);
  const [chatOpen, setChatOpen]           = useState(false);
  const [chatContext, setChatContext]      = useState(null);
  useEffect(() => { setTimeout(() => setVisible(true), 50); }, []);

  function handleOpenChat(ctx) { setChatContext(ctx); setChatOpen(true); }

  const availableWines = wines.filter(w => w.available !== false);
  const tierOrder   = [...new Map(availableWines.map(w => [w.tier, true])).keys()];
  const tiers       = ["All", ...tierOrder];
  const filteredByTier = activeTier === "All" ? availableWines : availableWines.filter(w => w.tier === activeTier);
  const subgroupOrder  = [...new Map(filteredByTier.map(w => [w.subgroup, true])).keys()].filter(Boolean);
  const subgroups      = ["All", ...subgroupOrder];
  const filteredBySubgroup = activeSubgroup === "All" ? filteredByTier : filteredByTier.filter(w => w.subgroup === activeSubgroup);
  const varietalSet    = new Set(filteredBySubgroup.map(w => consolidateVarietal(w.varietal)).filter(Boolean));
  const varietals      = ["All", ...Array.from(varietalSet).sort()];

  const allMatchingWines = wines.filter(w => {
    if (activeTier !== "All" && w.tier !== activeTier) return false;
    if (activeSubgroup !== "All" && w.subgroup !== activeSubgroup) return false;
    if (activeVarietal !== "All" && consolidateVarietal(w.varietal) !== activeVarietal) return false;
    return true;
  });
  const searchFiltered = wineSearch.trim() === ""
    ? allMatchingWines
    : allMatchingWines.filter(w => {
        const q = wineSearch.toLowerCase();
        return (w.name || "").toLowerCase().includes(q)
          || (w.varietal || "").toLowerCase().includes(q)
          || (w.region || "").toLowerCase().includes(q)
          || (w.description || "").toLowerCase().includes(q);
      });

  const grouped = {};
  const sortedForGrouping = [
    ...searchFiltered.filter(w => w.available !== false),
    ...searchFiltered.filter(w => w.available === false),
  ];
  sortedForGrouping.forEach(wine => {
    const key = wine.subgroup || wine.tier || "Wine";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(wine);
  });
  const groupOrder = [...new Map(sortedForGrouping.map(w => [w.subgroup || w.tier || "Wine", true])).keys()];

  const availCount = searchFiltered.filter(w => w.available !== false).length;
  const oosCount   = searchFiltered.filter(w => w.available === false).length;
  const countLeft  = `${availCount} ${availCount === 1 ? "wine" : "wines"}${oosCount > 0 ? ` · ${oosCount} out of stock` : ""}${wineSearch ? ` · "${wineSearch}"` : activeVarietal !== "All" ? ` · ${activeVarietal}` : activeSubgroup !== "All" ? ` · ${activeSubgroup}` : activeTier !== "All" ? ` · ${TIER_LABELS[activeTier] || activeTier}` : ""}`;

  return (
    <div style={{ background: "#faf8f4", minHeight: "100vh", fontFamily: "Georgia, serif", maxWidth: 680, margin: "0 auto", opacity: visible ? 1 : 0, transition: "opacity 0.5s ease" }}>
      {/* Shared header — edit ListScreenHeader to change all list screens */}
      <div style={{ position: "sticky", top: 0, zIndex: 100 }}>
        <ListScreenHeader title="Wine List" onBack={onBack} favorites={favorites} onShowShortlist={onShowShortlist}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {tiers.map(t => (
              <FilterBtn key={t} label={t === "All" ? "All Wines" : TIER_LABELS[t] || t}
                active={activeTier === t}
                onClick={() => { setActiveTier(t); setActiveSubgroup("All"); setActiveVarietal("All"); setSelectedWine(null); }} />
            ))}
          </div>
          {activeTier !== "All" && subgroups.length > 2 && (
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
              <span style={{ color: "#6a5040", fontSize: 9, letterSpacing: "2px", textTransform: "uppercase", marginRight: 2 }}>Type</span>
              {subgroups.map(s => (
                <FilterBtn key={s} small label={s === "All" ? "All" : s.replace(/^(Cellar |House )/, "")}
                  active={activeSubgroup === s}
                  onClick={() => { setActiveSubgroup(s); setActiveVarietal("All"); setSelectedWine(null); }} />
              ))}
            </div>
          )}
          {varietals.length > 2 && (
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center", marginBottom: 4 }}>
              <span style={{ color: "#6a5040", fontSize: 9, letterSpacing: "2px", textTransform: "uppercase", marginRight: 2 }}>Grape</span>
              {varietals.map(v => (
                <FilterBtn key={v} small label={v === "All" ? "All Grapes" : v}
                  active={activeVarietal === v}
                  onClick={() => { setActiveVarietal(v); setSelectedWine(null); }} />
              ))}
            </div>
          )}
          <div style={{ padding: "4px 0 10px", position: "relative" }}>
            <input type="text" placeholder="Search wines, grapes, regions…" value={wineSearch}
              onChange={e => setWineSearch(e.target.value)}
              style={{ width: "100%", boxSizing: "border-box", background: "rgba(255,255,255,0.07)", border: "0.5px solid rgba(201,169,110,0.25)", color: "#f0e8d8", padding: "8px 32px 8px 12px", borderRadius: 20, fontFamily: "Georgia, serif", fontSize: 12, outline: "none", letterSpacing: "0.3px" }}
            />
            {wineSearch && <button onClick={() => setWineSearch("")} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#6a5040", cursor: "pointer", fontSize: 18, padding: 0 }}>×</button>}
          </div>
        </ListScreenHeader>
      </div>

      <ListCountBar left={countLeft} right="☆ Star to save to My Menu" />

      <div style={{ background: "#faf8f4" }}>
        {groupOrder.map((group, gi) => (
          <div key={group}>
            <ListSectionHeading label={group} borderTop={gi > 0} />
            <div style={{ padding: "0 14px 8px", display: "flex", flexDirection: "column", gap: 1 }}>
              {grouped[group].map(wine => (
                <WineCard key={wine.id} wine={wine} selected={selectedWine === wine.id}
                  onSelect={() => setSelectedWine(selectedWine === wine.id ? null : wine.id)}
                  isFavorited={favorites.some(f => f.id === wine.id)}
                  onToggleFavorite={onToggleFavorite}
                  onZoomLabel={wine.imageUrl ? () => setZoomedLabel(wine) : null} />
              ))}
            </div>
          </div>
        ))}
        {searchFiltered.length === 0 && (
          <div style={{ color: "#b0a090", textAlign: "center", padding: 40, fontSize: 14 }}>
            {wineSearch ? `No wines matching "${wineSearch}"` : "No wines in this selection"}
          </div>
        )}
      </div>

      {selectedWine && (() => { const wine = wines.find(w => w.id === selectedWine); return wine ? <WineDetailPanel wine={wine} onClose={() => setSelectedWine(null)} onOpenChat={handleOpenChat} favorites={favorites} onToggleFavorite={onToggleFavorite} /> : null; })()}
      <LabelModal wine={zoomedLabel} onClose={() => setZoomedLabel(null)} />
      <SommelierChat isOpen={chatOpen} onClose={() => setChatOpen(false)} contextItem={chatContext} favorites={favorites} onToggleFavorite={onToggleFavorite} />
      <div style={{ height: 32 }} />
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

function AppContent() {
  const [screen, setScreen] = useState("home");
  const [wines, setWines] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showPin, setShowPin] = useState(false);
  const [showManager, setShowManager] = useState(false);
  const idleTimer = useRef(null);
  const [favorites, setFavorites] = useState([]);
  const [showShortlist, setShowShortlist] = useState(false);

  useEffect(() => {
    fetchWines();
    let pollTimer;
    function scheduleNext() {
      pollTimer = setTimeout(() => { fetchWines(true); scheduleNext(); }, getPollingInterval());
    }
    scheduleNext();
    return () => clearTimeout(pollTimer);
  }, []);

  useEffect(() => {
    function resetApp() {
      setScreen("home");
      setFavorites([]);
      setShowShortlist(false);
    }
    function resetIdle() {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => window.location.reload(), 15 * 60 * 1000);
    }
    const events = ["touchstart", "touchmove", "click", "scroll"];
    events.forEach(e => document.addEventListener(e, resetIdle, { passive: true }));
    resetIdle();
    return () => {
      events.forEach(e => document.removeEventListener(e, resetIdle));
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, []);

  function toggleFavorite(item, itemType) {
    setFavorites(prev => {
      const exists = prev.find(f => f.id === item.id);
      if (exists) return prev.filter(f => f.id !== item.id);
      return [...prev, { ...item, favoriteType: itemType }];
    });
  }

  async function fetchWines() {
    try {
      const res = await fetch(FIREBASE_URL);
      const data = await res.json();
      if (data.wines) {
        setWines(Array.isArray(data.wines) ? data.wines : Object.values(data.wines));
        setLastUpdated(data.lastUpdated);
      }
      setError(null);
    } catch (e) { setError("Unable to load wine list"); }
    finally { setLoading(false); }
  }

  // Wine filtering is now handled inside WineListScreen
  // Wine filtering moved to WineListScreen

  const shortlistOverlay = (
    <>
      {showShortlist && <ShortlistScreen favorites={favorites} onRemove={(id) => setFavorites(prev => prev.filter(f => f.id !== id))} onClose={() => setShowShortlist(false)} />}
      {showPin && <PinScreen onSuccess={() => { setShowPin(false); setShowManager(true); }} onCancel={() => setShowPin(false)} />}
      {showManager && <ManagerScreen wines={wines} onClose={() => setShowManager(false)} />}
    </>
  );

  if (screen === "home") return <>{shortlistOverlay}<HomeScreen onNavigate={setScreen} favorites={favorites} onShowShortlist={() => setShowShortlist(true)} onAdminTap={() => setShowPin(true)} /></>;
  if (screen === "wine") return <>{shortlistOverlay}<WineListScreen wines={wines} favorites={favorites} onToggleFavorite={(w) => toggleFavorite(w, "wine")} onBack={() => setScreen("home")} onShowShortlist={() => setShowShortlist(true)} /></>;
  if (screen === "sommelier") return <>{shortlistOverlay}<SommelierScreen onBack={() => setScreen("home")} favorites={favorites} onToggleFavorite={(item, type = "wine") => toggleFavorite(item, type)} onShowShortlist={() => setShowShortlist(true)} /></>;
  if (screen === "cocktails") return <>{shortlistOverlay}<ItemListScreen title="Specialty Cocktails" endpoint={COCKTAILS_URL} dataKey="cocktails" accentColor="#b06090" onBack={() => setScreen("home")} favorites={favorites} onToggleFavorite={(item) => toggleFavorite(item, "cocktail")} onShowShortlist={() => setShowShortlist(true)} /></>;
  if (screen === "nab") return <>{shortlistOverlay}<ItemListScreen title="Non-Alcoholic Beverages" allLabel="All Beverages" endpoint={NAB_URL} dataKey="nab" accentColor="#6090a0" onBack={() => setScreen("home")} favorites={favorites} onToggleFavorite={(item) => toggleFavorite(item, "nab")} onShowShortlist={() => setShowShortlist(true)} /></>;
  if (screen === "beer") return <>{shortlistOverlay}<ItemListScreen title="Beer List" allLabel="All Beers" endpoint={BEER_URL} dataKey="beers" accentColor="#c8860a" onBack={() => setScreen("home")} favorites={favorites} onToggleFavorite={(item) => toggleFavorite(item, "beer")} onShowShortlist={() => setShowShortlist(true)} /></>;
  if (screen === "pours") return <>{shortlistOverlay}<ItemListScreen title="Premium Pours" endpoint={POURS_URL} dataKey="pours" accentColor="#9a6e3a" onBack={() => setScreen("home")} favorites={favorites} onToggleFavorite={(item) => toggleFavorite(item, "pour")} onShowShortlist={() => setShowShortlist(true)} /></>;

  // AppContent no longer renders the wine list directly
  // All screens accounted for above — return home as fallback
  return <>{shortlistOverlay}<HomeScreen onNavigate={setScreen} favorites={favorites} onShowShortlist={() => setShowShortlist(true)} onAdminTap={() => setShowPin(true)} /></>;
}

function WineCard({ wine, selected, onSelect, isFavorited, onToggleFavorite, onZoomLabel }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div onClick={onSelect} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} style={{
      display: "flex", alignItems: "center", gap: 12,
      background: selected ? "#f0ebe0" : hovered ? "#f5f0e8" : "transparent",
      borderLeft: selected ? "2px solid #c9a96e" : "2px solid transparent",
      borderRadius: 8, padding: "11px 8px", cursor: "pointer",
      transition: "all 0.15s", opacity: wine.available === false ? 0.4 : 1
    }}>
      <div
        onClick={onZoomLabel ? e => { e.stopPropagation(); onZoomLabel(); } : undefined}
        style={{ width: 40, height: 56, borderRadius: 3, background: "#f0ebe0", border: `0.5px solid ${onZoomLabel ? "#c9a96e" : "#e0d8c8"}`, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, overflow: "hidden", cursor: onZoomLabel ? "zoom-in" : "default" }}>
        {wine.imageUrl ? <img src={wine.imageUrl} alt={wine.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : "🍷"}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: "#502e00", fontSize: 16, marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{wine.name}</div>
        {wine.varietal && (
          <div style={{ color: "#c9a96e", fontSize: 12, letterSpacing: "0.3px", marginBottom: 2 }}>
            {wine.varietal}{wine.region ? ` · ${wine.region}` : ""}
          </div>
        )}
        {wine.description ? (
          <div style={{ color: "#8a7060", fontSize: 13, lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 1, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{wine.description} <span style={{ color: "#c9a96e", fontSize: 11 }}>Details ›</span></div>
        ) : (
          <div style={{ color: "#c9a96e", fontSize: 11, fontStyle: "italic" }}>Tap for details ›</div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <button onClick={e => { e.stopPropagation(); onToggleFavorite && onToggleFavorite(wine); }} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: isFavorited ? "#c9a96e" : "#d0c0b0", padding: "2px 0", lineHeight: 1, flexShrink: 0 }}>
          {isFavorited ? "★" : "☆"}
        </button>
        <div style={{ textAlign: "right", flexShrink: 0, minWidth: 44 }}>
        {wine.available === false ? (
          <div style={{ background: "#f0ebe0", color: "#c0706a", fontSize: 10, padding: "3px 8px", borderRadius: 10, letterSpacing: "1px", textTransform: "uppercase", border: "0.5px solid #e0c8c8" }}>Out of Stock</div>
        ) : wine.glassPrice && wine.bottlePrice ? (
          <div style={{ color: "#502e00", fontSize: 13, fontWeight: 500, textAlign: "right" }}>{formatPrice(wine.glassPrice)}<span style={{ color: "#b0a090" }}>/</span>{Math.round(wine.bottlePrice)}</div>
        ) : wine.glassPrice ? (
          <>
            <div style={{ color: "#502e00", fontSize: 14, fontWeight: 500 }}>{formatPrice(wine.glassPrice)}</div>
            <div style={{ color: "#b0a090", fontSize: 10, marginTop: 1 }}>glass</div>
          </>
        ) : wine.bottlePrice ? (
          <>
            <div style={{ color: "#502e00", fontSize: 14, fontWeight: 500 }}>{formatPrice(wine.bottlePrice)}</div>
            <div style={{ color: "#b0a090", fontSize: 10, marginTop: 1 }}>bottle</div>
          </>
        ) : (
          <span style={{ color: "#c0b0a0", fontSize: 11, fontStyle: "italic" }}>Ask</span>
        )}
        </div>
      </div>
    </div>
  );
}

// ─── Root Export ─────────────────────────────────────────────────────────────
// Checks for shared menu QR link BEFORE rendering AppContent (avoids hook violations)
export default function App() {
  const urlParams = new URLSearchParams(window.location.search);
  // Short DB-backed code: ?m=ABC123
  const menuCode = urlParams.get('m');
  if (menuCode) return <GuestMenuLoader menuCode={menuCode} />;
  // Legacy long-URL code: ?menu=BASE64 (kept for backward compatibility)
  const menuParam = urlParams.get('menu');
  if (menuParam) {
    try {
      const sharedFavorites = decodeFavorites(menuParam);
      if (sharedFavorites && sharedFavorites.length > 0) return <GuestMenuScreen favorites={sharedFavorites} savedAt={sharedFavorites._savedAt} />;
    } catch(e) {}
  }
  return <AppContent />;
}

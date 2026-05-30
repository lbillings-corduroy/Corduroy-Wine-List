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
        <div style={{ position: "sticky", bottom: 0, background: "#2b1800", border: "0.5px solid #3c2200", borderRadius: "12px 12px 0 0", padding: "16px 16px 20px", marginTop: 8, boxShadow: "0 -8px 32px rgba(0,0,0,0.4)" }}>
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
    Promise.all([
      fetch(BEER_URL).then(r => r.json()),
      fetch(POURS_URL).then(r => r.json()),
    ]).then(([bData, pData]) => {
      const beers = (bData.beers || []).map(i => ({ ...i, _type: "beer" }));
      const pours = (pData.pours || []).map(i => ({ ...i, _type: "pour" }));
      setAllItems([...beers, ...pours]);
    }).catch(() => {});
  }, []);

  function handleWineUpdate(id, fields) {
    setLocalWines(prev => prev.map(w => w.id === id ? { ...w, ...fields } : w));
  }

  async function handleApprove(wine) {
    try {
      await fetch(MANAGER_UPDATE_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: wine.id, itemType: "wine", updates: { uncertain: false, approved: true } })
      });
      setLocalWines(prev => prev.map(w => w.id === wine.id ? { ...w, uncertain: false, approved: true } : w));
    } catch (e) { console.error(e); }
  }

  const q = search.toLowerCase();
  const filterBySearch = list => q ? list.filter(w => (w.name || "").toLowerCase().includes(q)) : list;

  const uncertain = filterBySearch(localWines.filter(w => w.uncertain && !w.approved));
  const noImageWines = filterBySearch(localWines.filter(w => !w.imageUrl));
  const noImageOther = q ? allItems.filter(i => !i.imageUrl && (i.name || "").toLowerCase().includes(q)) : allItems.filter(i => !i.imageUrl);
  const noImage = [...noImageWines, ...noImageOther];
  const noPrice = filterBySearch(localWines.filter(w => !w.glassPrice && !w.bottlePrice));
  const unenriched = filterBySearch(localWines.filter(w => !w.description && !w.varietal));
  const duplicateGroups = findDuplicates(q ? localWines.filter(w => (w.name || "").toLowerCase().includes(q)) : localWines);

  const tabs = [
    { id: "uncertain", label: "⚠️ Review", count: uncertain.length },
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
    <div style={{ position: "fixed", inset: 0, background: "#1e1100", zIndex: 1000, display: "flex", flexDirection: "column", fontFamily: "Georgia, serif" }}>
      {/* Header */}
      <div style={{ background: "#2b1800", borderBottom: "1px solid #2a1400", padding: "16px 20px" }}>
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
      <div style={{ padding: "8px 20px 4px", background: "#2b1800" }}>
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
                    <div style={{ width: 30, height: 42, borderRadius: 3, background: "#301700", border: "0.5px solid #2a1400", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, overflow: "hidden" }}>
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
        ) : current.length === 0 ? (
          <div style={{ textAlign: "center", color: "#4caf7d", padding: 40 }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>✓</div>
            <div style={{ fontSize: 14 }}>All clear</div>
          </div>
        ) : (
          current.map(wine => (
            <div key={wine.id} style={{ background: "rgba(255,255,255,0.04)", border: "0.5px solid #2a1400", borderRadius: 8, padding: "12px 14px", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                {/* Image or placeholder */}
                <div style={{ width: 36, height: 50, borderRadius: 3, background: "#301700", border: "0.5px solid #2a1400", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, overflow: "hidden" }}>
                  {wine.imageUrl ? <img src={wine.imageUrl} alt={wine.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : "🍷"}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: "#f0e8d8", fontSize: 13, marginBottom: 2 }}>{wine.name}</div>
                  <div style={{ color: "#6a5040", fontSize: 10, letterSpacing: "0.5px" }}>
                    {wine.subgroup} · {wine.tier}
                  </div>
                  {activeTab === "uncertain" && (
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
                        Looks Good ✓ — Remove from Review
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
      <div style={{ background: "#2b1800", borderTop: "1px solid #2a1400", padding: "12px 20px", textAlign: "center" }}>
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
      <div style={{ background: "#2b1800", border: "1px solid #2a1400", borderRadius: 16, padding: "32px 28px", width: 280, textAlign: "center" }}>
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

// ─── Generic Item List Screen (Beer, Pours, Cocktails) ───────────────────────

function ItemListScreen({ title, allLabel, endpoint, dataKey, accentColor, onBack, favorites = [], onToggleFavorite = () => {}, onShowShortlist = () => {} }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeGroup, setActiveGroup] = useState("All");
  const [selectedItem, setSelectedItem] = useState(null);
  const [visible, setVisible] = useState(false);
  const [itemSearch, setItemSearch] = useState("");

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
    <div style={{ background: "#231500", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16 }}>
      <div style={{ color: accentColor, fontSize: 13, letterSpacing: "3px", textTransform: "uppercase", fontFamily: "Georgia, serif" }}>Loading {title}...</div>
    </div>
  );

  if (error) return (
    <div style={{ background: "#231500", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "Georgia, serif" }}>
      <div style={{ textAlign: "center", maxWidth: 400 }}>
        <div style={{ color: accentColor, fontSize: 13, letterSpacing: "2px", textTransform: "uppercase", marginBottom: 12 }}>Unable to load {title}</div>
        <div style={{ color: "#6a5040", fontSize: 12, marginBottom: 8 }}>Endpoint: {endpoint}</div>
        <div style={{ background: "rgba(255,255,255,0.04)", border: "0.5px solid #2a1400", borderRadius: 6, padding: "10px 14px", marginBottom: 16, textAlign: "left" }}>
          <div style={{ color: "#9a5040", fontSize: 11, letterSpacing: "1px", textTransform: "uppercase", marginBottom: 4 }}>Error</div>
          <div style={{ color: "#c0a090", fontSize: 12, fontFamily: "monospace", wordBreak: "break-all" }}>{error}</div>
        </div>
        <button onClick={() => window.location.reload()} style={{ background: accentColor, color: "#231500", border: "none", padding: "8px 20px", borderRadius: 6, fontFamily: "Georgia, serif", cursor: "pointer" }}>Try Again</button>
      </div>
    </div>
  );

  return (
    <div style={{ background: "#231500", minHeight: "100vh", fontFamily: "Georgia, serif", maxWidth: 680, margin: "0 auto", opacity: visible ? 1 : 0, transition: "opacity 0.5s ease" }}>
      {/* Header */}
      <div style={{ background: "#231500", padding: "0 20px", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ padding: "10px 0 6px", display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={onBack} style={{ background: "none", border: "none", color: accentColor, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 12, letterSpacing: "1px", display: "flex", alignItems: "center", gap: 4, padding: 0 }}>
            ‹ <span style={{ textTransform: "uppercase", letterSpacing: "2px" }}>Main Menu</span>
          </button>
          <div style={{ flex: 1, textAlign: "center" }}>
            <div style={{ color: accentColor, fontSize: 11, letterSpacing: "4px", textTransform: "uppercase" }}>{title}</div>
          </div>
          <div style={{ width: 60, textAlign: "right" }}>
            {favorites.length > 0 && (
              <button onClick={onShowShortlist} style={{ background: "rgba(201,169,110,0.15)", border: "0.5px solid rgba(201,169,110,0.4)", color: "#c9a96e", padding: "4px 10px", borderRadius: 12, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 11 }}>
                ★ {favorites.length}
              </button>
            )}
          </div>
        </div>

        <div style={{ height: "0.5px", background: `linear-gradient(90deg, transparent, ${accentColor}44, transparent)`, marginBottom: 10 }} />

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          {groups.map(g => (
            <button key={g} onClick={() => { setActiveGroup(g); setSelectedItem(null); }} style={{
              background: activeGroup === g ? accentColor : "rgba(255,255,255,0.07)",
              border: `0.5px solid ${activeGroup === g ? accentColor : "rgba(255,255,255,0.15)"}`,
              color: activeGroup === g ? "#231500" : "#c8a878",
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
      </div>

      <div style={{ background: "#271500", padding: "5px 20px 8px", color: "#6a5040", fontSize: 11, letterSpacing: "1px" }}>
        {searchFiltered.length} {searchFiltered.length === 1 ? "item" : "items"}{itemSearch ? ` · "${itemSearch}"` : ""}
      </div>

      <div style={{ background: "#faf8f4" }}>
        {filteredGroupOrder.map((group, gi) => (
          <div key={group}>
            <div style={{ padding: "18px 20px 6px", borderTop: gi > 0 ? "0.5px solid #e8e0d0" : "none" }}>
              <div style={{ color: accentColor, fontSize: 9, letterSpacing: "3px", textTransform: "uppercase" }}>{group}</div>
            </div>
            <div style={{ padding: "0 14px 8px", display: "flex", flexDirection: "column", gap: 1 }}>
              {grouped[group].map(item => (
                <div key={item.id} onClick={() => setSelectedItem(selectedItem === item.id ? null : item.id)}
                  style={{
                    display: "flex", alignItems: "center", gap: 12,
                    background: selectedItem === item.id ? "#f0ebe0" : "transparent",
                    borderLeft: selectedItem === item.id ? `2px solid ${accentColor}` : "2px solid transparent",
                    borderRadius: 8, padding: "11px 8px", cursor: "pointer", transition: "all 0.15s"
                  }}>
                  <div style={{ width: 40, height: 56, borderRadius: 3, background: "#f0ebe0", border: "0.5px solid #e0d8c8", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, overflow: "hidden" }}>
                    {item.imageUrl ? <img src={item.imageUrl} alt={item.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : (dataKey === "beers" ? "🍺" : dataKey === "cocktails" ? "🍹" : dataKey === "nab" ? ((item.subgroup || "").toLowerCase() === "mocktails" ? "🍹" : "🥤") : "🥃")}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: "#301700", fontSize: 14, marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.name}</div>
                    {(item.style || item.category) && (
                      <div style={{ color: accentColor, fontSize: 10, letterSpacing: "0.3px", marginBottom: 2 }}>
                        {item.style || item.category}{(item.brewery || item.producer) ? ` · ${item.brewery || item.producer}` : ""}{item.abv ? ` · ${item.abv}` : ""}
                      </div>
                    )}
                    {item.description ? (
                      <div style={{ color: "#8a7060", fontSize: 12, lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{item.description}</div>
                    ) : (
                      <div style={{ color: "#c0b0a0", fontSize: 11, fontStyle: "italic" }}>Tap for details</div>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    <button onClick={e => { e.stopPropagation(); onToggleFavorite(item); }} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: favorites.some(f => f.id === item.id) ? accentColor : "#d0c0b0", padding: "2px 0", lineHeight: 1 }}>
                      {favorites.some(f => f.id === item.id) ? "★" : "☆"}
                    </button>
                    <div style={{ textAlign: "right", flexShrink: 0, minWidth: 44 }}>
                    {item.price ? (
                      <>
                        <div style={{ color: "#301700", fontSize: 14, fontWeight: 500 }}>${Math.round(item.price)}</div>
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
              <div style={{ width: 52, height: 72, borderRadius: 4, background: "#f0ebe0", border: "0.5px solid #e0d8c8", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, overflow: "hidden" }}>
                {item.imageUrl ? <img src={item.imageUrl} alt={item.name} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 4 }} /> : (dataKey === "beers" ? "🍺" : dataKey === "cocktails" ? "🍹" : dataKey === "nab" ? ((item.subgroup || "").toLowerCase() === "mocktails" ? "🍹" : "🥤") : "🥃")}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: "#301700", fontSize: 16, fontWeight: 500, marginBottom: 3 }}>{item.name}</div>
                {(item.style || item.category) && <div style={{ color: accentColor, fontSize: 11, marginBottom: 2 }}>{item.style || item.category}</div>}
                {(item.brewery || item.producer) && <div style={{ color: "#8a7060", fontSize: 11 }}>{item.brewery || item.producer}</div>}
                <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
                  {item.abv && <span style={{ color: "#8a7060", fontSize: 11 }}>{item.abv} ABV</span>}
                  {item.age && <span style={{ color: "#8a7060", fontSize: 11 }}>{item.age}</span>}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                {item.price && <div style={{ color: "#301700", fontSize: 18, fontWeight: 500 }}>${Math.round(item.price)}</div>}
              </div>
            </div>
            {item.description && (
              <div style={{ color: "#5a4030", fontSize: 13, lineHeight: 1.6, fontStyle: "italic", borderTop: "0.5px solid #e8e0d0", paddingTop: 10, marginBottom: 12 }}>
                {item.description}
              </div>
            )}
            <ItemPairingButton item={item} />
          </div>
        );
      })()}

      <div style={{ height: 32 }} />
    </div>
  );
}

// ─── Shortlist Screen ─────────────────────────────────────────────────────────

function ShortlistScreen({ favorites, onRemove, onClose }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "#1e1100", zIndex: 500, display: "flex", flexDirection: "column", fontFamily: "Georgia, serif" }}>
      <div style={{ background: "#2b1800", borderBottom: "1px solid #2a1400", padding: "16px 20px", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ color: "#c9a96e", fontSize: 11, letterSpacing: "3px", textTransform: "uppercase" }}>My Shortlist</div>
          <div style={{ color: "#5a4030", fontSize: 11, marginTop: 2 }}>{favorites.length} {favorites.length === 1 ? "item" : "items"} starred</div>
        </div>
        <button onClick={onClose} style={{ background: "rgba(201,169,110,0.15)", border: "0.5px solid #c9a96e", color: "#c9a96e", padding: "8px 18px", borderRadius: 6, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 12, letterSpacing: "0.5px" }}>
          Close
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
        {favorites.length === 0 ? (
          <div style={{ color: "#5a4030", textAlign: "center", padding: "60px 20px", fontSize: 14 }}>
            <div style={{ fontSize: 36, marginBottom: 16 }}>☆</div>
            <div>Tap the star on any wine, beer, or pour to add it here</div>
          </div>
        ) : (
          favorites.map(item => (
            <div key={item.id} style={{ background: "rgba(255,255,255,0.04)", border: "0.5px solid #2a1400", borderRadius: 8, padding: "12px 14px", marginBottom: 8, display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ fontSize: 20, flexShrink: 0 }}>
                {item.favoriteType === "wine" ? "🍷" : item.favoriteType === "beer" ? "🍺" : item.favoriteType === "cocktail" ? "🍹" : item.favoriteType === "nab" ? "🥤" : item.favoriteType === "food" ? "🍽️" : "🥃"}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: "#f0e8d8", fontSize: 14, marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.name}</div>
                <div style={{ color: "#c9a96e", fontSize: 10, letterSpacing: "1px", textTransform: "uppercase" }}>
                  {item.favoriteType === "wine"
                    ? (item.varietal || "Wine") + (item.region ? ` · ${item.region}` : "")
                    : item.favoriteType === "beer"
                    ? (item.style || "Beer") + (item.brewery ? ` · ${item.brewery}` : "")
                    : item.favoriteType === "food"
                    ? (item.course || "Food")
                    : (item.category || "Pour") + (item.producer ? ` · ${item.producer}` : "")}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0, marginRight: 4 }}>
                {item.favoriteType === "wine" ? (
                  item.glassPrice
                    ? <><div style={{ color: "#f0e8d8", fontSize: 14 }}>{formatPrice(item.glassPrice)}</div><div style={{ color: "#5a4030", fontSize: 10 }}>glass</div></>
                    : item.bottlePrice
                    ? <><div style={{ color: "#f0e8d8", fontSize: 14 }}>{formatPrice(item.bottlePrice)}</div><div style={{ color: "#5a4030", fontSize: 10 }}>bottle</div></>
                    : null
                ) : item.price ? (
                  <div style={{ color: "#f0e8d8", fontSize: 14 }}>${Math.round(item.price)}</div>
                ) : null}
              </div>
              <button onClick={() => onRemove(item.id)} style={{ background: "none", border: "none", color: "#5a4030", cursor: "pointer", fontSize: 22, padding: "4px", lineHeight: 1, flexShrink: 0 }}>×</button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Item Pairing Button (Beer & Pours) ──────────────────────────────────────

function ItemPairingButton({ item }) {
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
        <button onClick={handlePairing}
          style={{ width: "100%", background: "#271500", color: "#c9a96e", border: "0.5px solid #c9a96e", padding: "12px", borderRadius: 8, fontSize: 13, cursor: "pointer", fontFamily: "Georgia, serif", letterSpacing: "0.5px", marginBottom: result ? 12 : 0 }}>
          {result ? "Give Me Different Options" : "Suggested Food Pairing"}
        </button>
      )}
      {loading && <LoadingMessages messages={KITCHEN_MESSAGES} onAllShown={handleMsgComplete} />}
      {result && result.length > 0 && (
        <div style={{ marginTop: 2 }}>
          <div style={{ color: "#9a7855", fontSize: 9, letterSpacing: "2px", textTransform: "uppercase", marginBottom: 8 }}>Pairs beautifully with</div>
          {result.map((p, i) => {
            return (
              <div key={i} style={{ display: "flex", gap: 10, marginBottom: 8, paddingBottom: 8, borderBottom: i < result.length - 1 ? "0.5px solid #f0e8e0" : "none" }}>
                <div style={{ fontSize: 16, flexShrink: 0 }}>🍽</div>
                <div>
                  <div style={{ color: "#301700", fontSize: 13, fontWeight: 500, marginBottom: 1 }}>{p.name}</div>
                  <div style={{ color: "#9a7855", fontSize: 10, textTransform: "uppercase", letterSpacing: "1px", marginBottom: 2 }}>{p.course}</div>
                  <div style={{ color: "#6a5040", fontSize: 12, fontStyle: "italic", lineHeight: 1.5 }}>{p.reason}</div>

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

// ─── Wine Detail Panel ────────────────────────────────────────────────────────

function WineDetailPanel({ wine, onClose }) {
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
          <div style={{ color: "#301700", fontSize: 16, marginBottom: 3, lineHeight: 1.3 }}>{wine.name}</div>
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
            <div style={{ color: "#301700", fontSize: 22 }}>{formatPrice(wine.glassPrice)}</div>
          </div>
        )}
        {wine.bottlePrice && (
          <div>
            <div style={{ color: "#b0a090", fontSize: 10, letterSpacing: "2px", textTransform: "uppercase", marginBottom: 2 }}>Bottle</div>
            <div style={{ color: "#301700", fontSize: 22 }}>{formatPrice(wine.bottlePrice)}</div>
          </div>
        )}
        {!wine.glassPrice && !wine.bottlePrice && (
          <div style={{ color: "#c0b0a0", fontSize: 13, fontStyle: "italic", alignSelf: "center" }}>Ask your server for pricing</div>
        )}
      </div>

      {!pairingLoading && (
        <button onClick={handlePairing}
          style={{ width: "100%", background: "#271500", color: "#c9a96e", border: "0.5px solid #c9a96e", padding: "12px", borderRadius: 8, fontSize: 13, cursor: "pointer", fontFamily: "Georgia, serif", letterSpacing: "0.5px", marginBottom: pairingResult ? 14 : 0 }}>
          Suggested Food Pairing
        </button>
      )}
      {pairingLoading && <LoadingMessages messages={KITCHEN_MESSAGES} onAllShown={handleDishMessagesComplete} />}

      {pairingResult && pairingResult.length > 0 && (
        <div>
          <div style={{ color: "#9a7855", fontSize: 9, letterSpacing: "2px", textTransform: "uppercase", marginBottom: 10 }}>Pairs beautifully with</div>
          {pairingResult.map((p, i) => (
            <div key={i} style={{ display: "flex", gap: 10, marginBottom: 10, paddingBottom: 10, borderBottom: i < pairingResult.length - 1 ? "0.5px solid #f0e8e0" : "none" }}>
              <div style={{ fontSize: 18, flexShrink: 0 }}>🍽</div>
              <div>
                <div style={{ color: "#301700", fontSize: 13, fontWeight: 500, marginBottom: 2 }}>{p.name}</div>
                <div style={{ color: "#9a7855", fontSize: 10, letterSpacing: "1px", textTransform: "uppercase", marginBottom: 3 }}>{p.course}</div>
                <div style={{ color: "#6a5040", fontSize: 12, fontStyle: "italic", lineHeight: 1.5 }}>{p.reason}</div>

              </div>
            </div>
          ))}
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

  useEffect(() => {
    fetch(FOOD_URL).then(r => r.json())
      .then(data => { setFoodItems(data.foodItems || []); setLoadingFood(false); })
      .catch(() => setLoadingFood(false));
  }, []);

  const [lastShownIds, setLastShownIds] = useState({});
  const pendingPairing = useRef(null);
  const [messagesReady, setMessagesReady] = useState(false);

  function handleMessagesComplete() {
    if (pendingPairing.current !== null) {
      setPairingResult(pendingPairing.current);
      setPairingLoading(false);
      pendingPairing.current = null;
    }
    setMessagesReady(true);
  }

  function handleFoodToggle(food) {
    const isAdding = !selectedFoods.find(f => f.id === food.id);
    setSelectedFoods(prev =>
      isAdding ? [...prev, food] : prev.filter(f => f.id !== food.id)
    );
    // Selecting a dish adds it to the shortlist automatically
    const isFav = favorites.some(f => f.id === food.id);
    if (isAdding && !isFav) onToggleFavorite({ id: food.id, name: food.name, price: food.price, course: food.course }, "food");
    if (!isAdding && isFav) onToggleFavorite({ id: food.id, name: food.name, price: food.price, course: food.course }, "food");
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
        body: JSON.stringify({ type: "food_to_wine", itemIds: selectedFoods.map(f => f.id) })
      });
      const data = await res.json();
      const pairings = data.pairings || [];
      const ids = {};
      pairings.forEach(p => { if (p.id) ids[p.level] = p.id; });
      setLastShownIds(ids);
      pendingPairing.current = pairings;
    } catch (e) { pendingPairing.current = []; }
  }

  async function handleDifferentOptions() {
    if (selectedFoods.length === 0) return;
    setPairingLoading(true);
    setPairingResult(null);
    pendingPairing.current = null;
    try {
      const res = await fetch(PAIRING_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "food_to_wine", itemIds: selectedFoods.map(f => f.id), excludeWineIds: lastShownIds })
      });
      const data = await res.json();
      const pairings = data.pairings || [];
      const ids = {};
      pairings.forEach(p => { if (p.id) ids[p.level] = p.id; });
      setLastShownIds(ids);
      pendingPairing.current = pairings;
    } catch (e) { pendingPairing.current = []; }
  }

  const availableFood = foodItems.filter(f => !f.excluded);
  const courses = ["All", ...new Set(availableFood.map(f => f.course))];
  const filtered = activeCourse === "All" ? availableFood : availableFood.filter(f => f.course === activeCourse);

  return (
    <div style={{ background: "#1e1100", minHeight: "100vh", fontFamily: "Georgia, serif", maxWidth: 680, margin: "0 auto" }}>
      <div style={{ background: "#231500", padding: "0 20px", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ padding: "10px 0 10px", display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={view === "result" ? () => { setView("pick"); setPairingResult(null); } : onBack}
            style={{ background: "none", border: "none", color: "#c9a96e", cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 12, letterSpacing: "1px", display: "flex", alignItems: "center", gap: 4, padding: 0 }}>
            ‹ <span style={{ textTransform: "uppercase", letterSpacing: "2px" }}>{view === "result" ? "Back" : "Main Menu"}</span>
          </button>
          <div style={{ flex: 1, textAlign: "center" }}>
            <div style={{ color: "#c9a96e", fontSize: 11, letterSpacing: "4px", textTransform: "uppercase" }}>Wine Pairing</div>
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
                color: activeCourse === c ? "#231500" : "#c8a878",
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
          <div style={{ background: "#271500", padding: "8px 20px 10px", color: "#6a5040", fontSize: 11, letterSpacing: "1px" }}>
            Tap dishes to add them, then find your perfect wine
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
                  <div style={{ padding: "12px 20px 6px", background: "#f5f0e8", borderBottom: "0.5px solid #e8e0d0", borderTop: "0.5px solid #e8e0d0" }}>
                    <div style={{ color: "#c9a96e", fontSize: 9, letterSpacing: "3px", textTransform: "uppercase" }}>{course}</div>
                  </div>
                  {byCourse[course].map(food => {
                    const isSelected = selectedFoods.some(f => f.id === food.id);
                    return (
                      <div key={food.id}
                        style={{ display: "flex", alignItems: "center", gap: 10, padding: "13px 16px 13px 20px", borderBottom: "0.5px solid #e8e0d0", background: isSelected ? "#f0ebe4" : "#faf8f4", transition: "background 0.15s" }}>
                        <div onClick={() => handleFoodToggle(food)} style={{ width: 22, height: 22, borderRadius: 6, border: `1.5px solid ${isSelected ? "#c9a96e" : "#d0c0b0"}`, background: isSelected ? "#c9a96e" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "all 0.15s", cursor: "pointer" }}>
                          {isSelected && <span style={{ color: "#0d0800", fontSize: 13, fontWeight: 700, lineHeight: 1 }}>✓</span>}
                        </div>
                        <div onClick={() => handleFoodToggle(food)} style={{ flex: 1, cursor: "pointer" }}>
                          <div style={{ color: "#301700", fontSize: 14, marginBottom: 2 }}>{food.name}</div>
                          {food.description && <div style={{ color: "#8a7060", fontSize: 12, lineHeight: 1.4 }}>{food.description}</div>}
                        </div>
                        <div style={{ color: "#301700", fontSize: 13, flexShrink: 0 }}>{formatPrice(food.price)}</div>
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
          <div style={{ position: "sticky", bottom: 0, background: "#1e1100", borderTop: "0.5px solid #3c2200", padding: "12px 20px 16px" }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
              {selectedFoods.map(f => (
                <div key={f.id} style={{ background: "rgba(201,169,110,0.12)", border: "0.5px solid rgba(201,169,110,0.35)", borderRadius: 14, padding: "4px 8px 4px 10px", display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ color: "#f0e8d8", fontSize: 11 }}>{f.name}</span>
                  <span onClick={e => { e.stopPropagation(); handleFoodToggle(f); }} style={{ color: "#6a5040", fontSize: 16, cursor: "pointer", lineHeight: 1 }}>×</span>
                </div>
              ))}
            </div>
            <button onClick={handleGetPairings}
              style={{ width: "100%", background: "#c9a96e", color: "#0d0800", border: "none", padding: "14px", borderRadius: 8, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 14, fontWeight: 600, letterSpacing: "0.5px" }}>
              Find Wine Pairings for {selectedFoods.length} {selectedFoods.length === 1 ? "Dish" : "Dishes"} →
            </button>
          </div>
        )}
        </>
      )}

      {view === "result" && (
        <div style={{ padding: "20px 20px" }}>
          {selectedFoods.length > 0 && (
            <div style={{ background: "rgba(201,169,110,0.08)", border: "0.5px solid rgba(201,169,110,0.25)", borderRadius: 8, padding: "14px 16px", marginBottom: 20 }}>
              <div style={{ color: "#9a7855", fontSize: 9, letterSpacing: "2px", textTransform: "uppercase", marginBottom: 8 }}>
                {selectedFoods.length === 1 ? "Your selection" : `Your table's selections (${selectedFoods.length} dishes)`}
              </div>
              {selectedFoods.map((f, i) => (
                <div key={f.id} style={{ marginBottom: i < selectedFoods.length - 1 ? 8 : 0, paddingBottom: i < selectedFoods.length - 1 ? 8 : 0, borderBottom: i < selectedFoods.length - 1 ? "0.5px solid rgba(201,169,110,0.15)" : "none" }}>
                  <div style={{ color: "#f0e8d8", fontSize: 14 }}>{f.name}</div>
                  {f.description && <div style={{ color: "#6a5040", fontSize: 11, marginTop: 2, fontStyle: "italic" }}>{f.description}</div>}
                </div>
              ))}
            </div>
          )}

          {pairingLoading && (
            <LoadingMessages messages={SOMMELIER_MESSAGES} onAllShown={handleMessagesComplete} />
          )}

          {(() => {
            const pairings = Array.isArray(pairingResult) ? pairingResult : null;
            const byCourse = pairingResult?.byCourse || null;
            const hasResults = pairings?.length > 0 || byCourse?.length > 0;
            const isEmpty = pairingResult && !pairingLoading && !hasResults;

            const WineCard = (p, i) => (
              <div key={i} style={{ background: "rgba(255,255,255,0.04)", border: "0.5px solid #2a1400", borderRadius: 10, padding: "16px", marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                  <div style={{ background: "rgba(201,169,110,0.15)", border: "0.5px solid rgba(201,169,110,0.3)", borderRadius: 12, padding: "3px 10px" }}>
                    <span style={{ color: "#c9a96e", fontSize: 10, letterSpacing: "1px", textTransform: "uppercase" }}>{p.level}</span>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    {p.glassPrice && <div style={{ color: "#f0e8d8", fontSize: 13 }}>{formatPrice(p.glassPrice)} <span style={{ color: "#5a4030", fontSize: 10 }}>glass</span></div>}
                    {p.bottlePrice && <div style={{ color: "#f0e8d8", fontSize: 13 }}>{formatPrice(p.bottlePrice)} <span style={{ color: "#5a4030", fontSize: 10 }}>bottle</span></div>}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
                  {p.imageUrl && <div style={{ width: 52, height: 72, borderRadius: 4, flexShrink: 0, overflow: "hidden", border: "0.5px solid #2a1400" }}><img src={p.imageUrl} alt={p.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: "#f0e8d8", fontSize: 15, marginBottom: 4 }}>{p.name}</div>
                    {(p.varietal || p.region) && <div style={{ color: "#c9a96e", fontSize: 10, letterSpacing: "1px", textTransform: "uppercase", marginBottom: 8 }}>{[p.varietal, p.region].filter(Boolean).join(" · ")}</div>}
                  </div>
                </div>
                <div style={{ color: "#8a7060", fontSize: 13, fontStyle: "italic", lineHeight: 1.6 }}>{p.reason}</div>
                {p.id && (() => {
                  const wineObj = { id: p.id, name: p.name, varietal: p.varietal, region: p.region, glassPrice: p.glassPrice, bottlePrice: p.bottlePrice };
                  const isStarred = favorites.some(f => f.id === p.id);
                  return <button onClick={() => onToggleFavorite(wineObj)} style={{ marginTop: 10, background: isStarred ? "rgba(201,169,110,0.15)" : "none", border: `0.5px solid ${isStarred ? "#c9a96e" : "rgba(201,169,110,0.3)"}`, color: isStarred ? "#c9a96e" : "#6a5040", padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>{isStarred ? "★ Added to Shortlist" : "☆ Add to Shortlist"}</button>;
                })()}
              </div>
            );

            return (
              <>
                {!pairingLoading && hasResults && (
                  <div style={{ marginBottom: 16 }}>
                    <button onClick={handleDifferentOptions} style={{ width: "100%", background: "rgba(201,169,110,0.08)", border: "0.5px solid rgba(201,169,110,0.3)", color: "#c9a96e", padding: "11px", borderRadius: 8, fontSize: 13, cursor: "pointer", fontFamily: "Georgia, serif", letterSpacing: "0.5px", marginBottom: 8 }}>
                      Give Me Different Options
                    </button>
                    <div style={{ color: "#6a5545", fontSize: 11, textAlign: "center", fontStyle: "italic", lineHeight: 1.5 }}>
                      If suggestions repeat, it reflects the limits of our current wine selection for this dish.
                    </div>
                  </div>
                )}

                {/* Single course */}
                {pairings?.map((p, i) => WineCard(p, i))}

                {/* Multi-course */}
                {byCourse?.map((courseResult, ci) => (
                  <div key={ci} style={{ marginBottom: 20 }}>
                    <div style={{ borderBottom: "0.5px solid rgba(201,169,110,0.25)", paddingBottom: 8, marginBottom: 14 }}>
                      <div style={{ color: "#c9a96e", fontSize: 10, letterSpacing: "2px", textTransform: "uppercase", marginBottom: 4 }}>
                        {courseResult.course} Pairing
                      </div>
                      {courseResult.dishes?.length > 0 && (
                        <div style={{ color: "#6a5040", fontSize: 11, fontStyle: "italic" }}>
                          For: {courseResult.dishes.join(", ")}
                        </div>
                      )}
                    </div>
                    {courseResult.pairings?.map((p, i) => WineCard(p, `${ci}-${i}`))}
                  </div>
                ))}

                {isEmpty && <div style={{ color: "#6a5040", textAlign: "center", padding: "40px 0", fontSize: 14 }}>Unable to find pairings — please ask your server.</div>}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// ─── Home Screen ─────────────────────────────────────────────────────────────

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
      background: "#1e1100", minHeight: "100vh", fontFamily: "Georgia, serif",
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
          src="/Appalachia Kitchen Logo colour (1).png"
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
          ★ My Shortlist <span style={{ background: "rgba(201,169,110,0.25)", borderRadius: 10, padding: "1px 8px", fontSize: 12 }}>{favorites.length}</span>
        </button>
      )}

      {/* Footer */}
      <div style={{ marginTop: 32, color: "#4e3e24", fontSize: 10, letterSpacing: "2px", textTransform: "uppercase" }}>
        Corduroy Inn & Lodge · Snowshoe Mountain
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [screen, setScreen] = useState("home");
  const [wines, setWines] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTier, setActiveTier] = useState("All");
  const [activeSubgroup, setActiveSubgroup] = useState("All");
  const [activeVarietal, setActiveVarietal] = useState("All");
  const [selectedWine, setSelectedWine] = useState(null);
  const [visible, setVisible] = useState(false);
  const [logoTaps, setLogoTaps] = useState(0);
  const [showPin, setShowPin] = useState(false);
  const [showManager, setShowManager] = useState(false);
  const logoTapTimer = useRef(null);
  const idleTimer = useRef(null);
  const [wineSearch, setWineSearch] = useState("");
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

  useEffect(() => { if (!loading) setTimeout(() => setVisible(true), 50); }, [loading]);

  useEffect(() => {
    function resetApp() {
      setScreen("home");
      setFavorites([]);
      setShowShortlist(false);
      setWineSearch("");
      setActiveTier("All");
      setActiveSubgroup("All");
      setActiveVarietal("All");
      setSelectedWine(null);
    }
    function handleVisibility() { if (!document.hidden) resetApp(); }
    function resetIdle() {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(resetApp, 15 * 60 * 1000);
    }
    const events = ["touchstart", "touchmove", "click", "scroll"];
    document.addEventListener("visibilitychange", handleVisibility);
    events.forEach(e => document.addEventListener(e, resetIdle, { passive: true }));
    resetIdle();
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
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

  function handleLogoTap() {
    const next = logoTaps + 1;
    setLogoTaps(next);
    if (logoTapTimer.current) clearTimeout(logoTapTimer.current);
    if (next >= 5) {
      setLogoTaps(0);
      setShowPin(true);
    } else {
      logoTapTimer.current = setTimeout(() => setLogoTaps(0), 2000);
    }
  }

  // Filter pills use available wines only (don't show OOS-only varietals in filters)
  const availableWines = wines.filter(w => w.available !== false);
  const tierOrder = [...new Map(availableWines.map(w => [w.tier, true])).keys()];
  const tiers = ["All", ...tierOrder];
  const filteredByTier = activeTier === "All" ? availableWines : availableWines.filter(w => w.tier === activeTier);
  const subgroupOrder = [...new Map(filteredByTier.map(w => [w.subgroup, true])).keys()].filter(Boolean);
  const subgroups = ["All", ...subgroupOrder];
  const filteredBySubgroup = activeSubgroup === "All" ? filteredByTier : filteredByTier.filter(w => w.subgroup === activeSubgroup);
  const varietalSet = new Set(filteredBySubgroup.map(w => consolidateVarietal(w.varietal)).filter(Boolean));
  const varietals = ["All", ...Array.from(varietalSet).sort()];
  const filtered = activeVarietal === "All" ? filteredBySubgroup : filteredBySubgroup.filter(w => consolidateVarietal(w.varietal) === activeVarietal);

  // For rendering, include OOS wines that match the same tier/subgroup/varietal filters
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

  // Sort: available wines first, OOS wines at bottom of each group
  const grouped = {};
  const sortedForGrouping = [
    ...searchFiltered.filter(w => w.available !== false),
    ...searchFiltered.filter(w => w.available === false)
  ];
  sortedForGrouping.forEach(wine => {
    const key = wine.subgroup || wine.tier || "Wine";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(wine);
  });
  const groupOrder = [...new Map(sortedForGrouping.map(w => [w.subgroup || w.tier || "Wine", true])).keys()];

  const shortlistOverlay = (
    <>
      {showShortlist && <ShortlistScreen favorites={favorites} onRemove={(id) => setFavorites(prev => prev.filter(f => f.id !== id))} onClose={() => setShowShortlist(false)} />}
      {showPin && <PinScreen onSuccess={() => { setShowPin(false); setShowManager(true); }} onCancel={() => setShowPin(false)} />}
      {showManager && <ManagerScreen wines={wines} onClose={() => setShowManager(false)} />}
    </>
  );

  if (screen === "home") return <>{shortlistOverlay}<HomeScreen onNavigate={setScreen} favorites={favorites} onShowShortlist={() => setShowShortlist(true)} onAdminTap={() => setShowPin(true)} /></>;
  if (screen === "sommelier") return <>{shortlistOverlay}<SommelierScreen onBack={() => setScreen("home")} favorites={favorites} onToggleFavorite={(item, type = "wine") => toggleFavorite(item, type)} onShowShortlist={() => setShowShortlist(true)} /></>;
  if (screen === "cocktails") return <>{shortlistOverlay}<ItemListScreen title="Specialty Cocktails" endpoint={COCKTAILS_URL} dataKey="cocktails" accentColor="#b06090" onBack={() => setScreen("home")} favorites={favorites} onToggleFavorite={(item) => toggleFavorite(item, "cocktail")} onShowShortlist={() => setShowShortlist(true)} /></>;
  if (screen === "nab") return <>{shortlistOverlay}<ItemListScreen title="Non-Alcoholic Beverages" allLabel="All Beverages" endpoint={NAB_URL} dataKey="nab" accentColor="#6090a0" onBack={() => setScreen("home")} favorites={favorites} onToggleFavorite={(item) => toggleFavorite(item, "nab")} onShowShortlist={() => setShowShortlist(true)} /></>;
  if (screen === "beer") return <>{shortlistOverlay}<ItemListScreen title="Beer List" allLabel="All Beers" endpoint={BEER_URL} dataKey="beers" accentColor="#c8860a" onBack={() => setScreen("home")} favorites={favorites} onToggleFavorite={(item) => toggleFavorite(item, "beer")} onShowShortlist={() => setShowShortlist(true)} /></>;
  if (screen === "pours") return <>{shortlistOverlay}<ItemListScreen title="Premium Pours" endpoint={POURS_URL} dataKey="pours" accentColor="#9a6e3a" onBack={() => setScreen("home")} favorites={favorites} onToggleFavorite={(item) => toggleFavorite(item, "pour")} onShowShortlist={() => setShowShortlist(true)} /></>;

  if (loading) return (
    <div style={{ background: "#271500", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16 }}>
      <div style={{ fontSize: 32 }}>🍷</div>
      <div style={{ color: "#c9a96e", fontSize: 13, letterSpacing: "3px", textTransform: "uppercase", fontFamily: "Georgia, serif" }}>Loading Wine List</div>
    </div>
  );

  if (error) return (
    <div style={{ background: "#271500", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ color: "#c9a96e", fontFamily: "Georgia, serif", textAlign: "center" }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>🍷</div>
        <div>{error}</div>
        <button onClick={fetchWines} style={{ marginTop: 16, background: "#c9a96e", color: "#271500", border: "none", padding: "8px 20px", borderRadius: 6, fontFamily: "Georgia, serif", cursor: "pointer" }}>Try Again</button>
      </div>
    </div>
  );

  return (
    <>
    {shortlistOverlay}
    <div style={{ background: "#faf8f4", minHeight: "100vh", fontFamily: "Georgia, serif", maxWidth: 680, margin: "0 auto", opacity: visible ? 1 : 0, transition: "opacity 0.5s ease" }}>


      {/* Sticky wrapper — keeps back button + filter header together */}
      <div style={{ position: "sticky", top: 0, zIndex: 100 }}>
        {/* Back to home */}
        <div style={{ background: "#231500", padding: "8px 16px", display: "flex", alignItems: "center" }}>
          <button onClick={() => setScreen("home")} style={{
            background: "none", border: "none", color: "#c9a96e", cursor: "pointer",
            fontFamily: "Georgia, serif", fontSize: 12, letterSpacing: "1px",
            display: "flex", alignItems: "center", gap: 6, padding: "4px 0"
          }}>
            ‹ <span style={{ textTransform: "uppercase", letterSpacing: "2px" }}>Main Menu</span>
          </button>
        </div>

      {/* Header */}
      <div style={{ background: "#271500", padding: "20px 20px 12px", borderBottom: "1px solid #2a1400" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <div onClick={handleLogoTap} style={{ width: 40, height: 40, borderRadius: "50%", border: "1px solid #c9a96e", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "pointer", userSelect: "none" }}>
            <span style={{ color: "#c9a96e", fontSize: 12, letterSpacing: 1 }}>AK</span>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ color: "#9a7855", fontSize: 10, letterSpacing: "2.5px", textTransform: "uppercase" }}>Corduroy Inn &amp; Lodge · Snowshoe Mountain</div>
            <div style={{ color: "#f0e8d8", fontSize: 19 }}>Appalachia Kitchen</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
              {favorites.length > 0 && (
                <button onClick={() => setShowShortlist(true)} style={{ background: "rgba(201,169,110,0.15)", border: "0.5px solid #c9a96e", color: "#c9a96e", padding: "4px 10px", borderRadius: 12, cursor: "pointer", fontFamily: "Georgia, serif", fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
                  ★ {favorites.length}
                </button>
              )}
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#4caf7d" }} />
                  <span style={{ color: "#4caf7d", fontSize: 10, letterSpacing: "1px", textTransform: "uppercase" }}>Live</span>
                </div>
                <div style={{ color: "#5a4030", fontSize: 10, marginTop: 2 }}>{timeAgo(lastUpdated)}</div>
              </div>
            </div>
          </div>
        </div>

        <div style={{ height: "0.5px", background: "linear-gradient(90deg, transparent, #c9a96e44, transparent)", marginBottom: 12 }} />

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
      </div>
      </div>{/* end sticky wrapper */}

      <div style={{ background: "#271500", padding: "6px 20px 10px", color: "#6a5040", fontSize: 11, letterSpacing: "1px" }}>
        {searchFiltered.filter(w => w.available !== false).length} {searchFiltered.filter(w => w.available !== false).length === 1 ? "wine" : "wines"}
        {searchFiltered.filter(w => w.available === false).length > 0 && <span style={{ color: "#c0706a", marginLeft: 6 }}>· {searchFiltered.filter(w => w.available === false).length} out of stock</span>}
        {wineSearch ? ` · "${wineSearch}"` : activeVarietal !== "All" ? ` · ${activeVarietal}` : activeSubgroup !== "All" ? ` · ${activeSubgroup}` : activeTier !== "All" ? ` · ${TIER_LABELS[activeTier] || activeTier}` : ""}
      </div>

      <div style={{ background: "#faf8f4" }}>
        {groupOrder.map((group, gi) => (
          <div key={group}>
            <div style={{ padding: "18px 20px 6px", borderTop: gi > 0 ? "0.5px solid #e8e0d0" : "none" }}>
              <div style={{ color: "#c9a96e", fontSize: 9, letterSpacing: "3px", textTransform: "uppercase" }}>{group}</div>
            </div>
            <div style={{ padding: "0 14px 8px", display: "flex", flexDirection: "column", gap: 1 }}>
              {grouped[group].map((wine, i) => (
                <WineCard key={wine.id} wine={wine} selected={selectedWine === wine.id}
                  onSelect={() => setSelectedWine(selectedWine === wine.id ? null : wine.id)}
                  isFavorited={favorites.some(f => f.id === wine.id)}
                  onToggleFavorite={(w) => toggleFavorite(w, "wine")} />
              ))}
            </div>
          </div>
        ))}
        {searchFiltered.length === 0 && (
          <div style={{ color: "#b0a090", textAlign: "center", padding: 40, fontSize: 14 }}>{wineSearch ? `No wines matching "${wineSearch}"` : "No wines in this selection"}</div>
        )}
      </div>

      {selectedWine && (() => { const wine = wines.find(w => w.id === selectedWine); return wine ? <WineDetailPanel wine={wine} onClose={() => setSelectedWine(null)} /> : null; })()}

      <div style={{ height: 32 }} />
    </div>
    </>
  );
}

function WineCard({ wine, selected, onSelect, isFavorited, onToggleFavorite }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div onClick={onSelect} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} style={{
      display: "flex", alignItems: "center", gap: 12,
      background: selected ? "#f0ebe0" : hovered ? "#f5f0e8" : "transparent",
      borderLeft: selected ? "2px solid #c9a96e" : "2px solid transparent",
      borderRadius: 8, padding: "11px 8px", cursor: "pointer",
      transition: "all 0.15s", opacity: wine.available === false ? 0.4 : 1
    }}>
      <div style={{ width: 40, height: 56, borderRadius: 3, background: "#f0ebe0", border: "0.5px solid #e0d8c8", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, overflow: "hidden" }}>
        {wine.imageUrl ? <img src={wine.imageUrl} alt={wine.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : "🍷"}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: "#301700", fontSize: 14, marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{wine.name}</div>
        {wine.varietal && (
          <div style={{ color: "#c9a96e", fontSize: 10, letterSpacing: "0.3px", marginBottom: 2 }}>
            {wine.varietal}{wine.region ? ` · ${wine.region}` : ""}
          </div>
        )}
        {wine.description ? (
          <div style={{ color: "#8a7060", fontSize: 12, lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{wine.description}</div>
        ) : (
          <div style={{ color: "#c0b0a0", fontSize: 11, fontStyle: "italic" }}>Tap for details</div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <button onClick={e => { e.stopPropagation(); onToggleFavorite && onToggleFavorite(wine); }} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: isFavorited ? "#c9a96e" : "#d0c0b0", padding: "2px 0", lineHeight: 1, flexShrink: 0 }}>
          {isFavorited ? "★" : "☆"}
        </button>
        <div style={{ textAlign: "right", flexShrink: 0, minWidth: 44 }}>
        {wine.available === false ? (
          <div style={{ background: "#f0ebe0", color: "#c0706a", fontSize: 10, padding: "3px 8px", borderRadius: 10, letterSpacing: "1px", textTransform: "uppercase", border: "0.5px solid #e0c8c8" }}>Out of Stock</div>
        ) : wine.glassPrice ? (
          <>
            <div style={{ color: "#301700", fontSize: 14, fontWeight: 500 }}>{formatPrice(wine.glassPrice)}</div>
            <div style={{ color: "#b0a090", fontSize: 10, marginTop: 1 }}>glass</div>
          </>
        ) : wine.bottlePrice ? (
          <>
            <div style={{ color: "#301700", fontSize: 14, fontWeight: 500 }}>{formatPrice(wine.bottlePrice)}</div>
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

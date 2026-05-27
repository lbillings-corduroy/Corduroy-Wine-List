import { useState, useEffect, useRef } from "react";

const FIREBASE_URL = "https://us-central1-corduroy-wine-list.cloudfunctions.net/getWines";
const MANAGER_PIN = process.env.REACT_APP_MANAGER_PIN || "0000";

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

function ManagerScreen({ wines, onClose }) {
  const [activeTab, setActiveTab] = useState("uncertain");

  const uncertain = wines.filter(w => w.uncertain);
  const noImage = wines.filter(w => !w.imageUrl);
  const noPrice = wines.filter(w => !w.glassPrice && !w.bottlePrice);
  const unenriched = wines.filter(w => !w.description && !w.varietal);
  const duplicateGroups = findDuplicates(wines);

  const tabs = [
    { id: "uncertain", label: "⚠️ Review", count: uncertain.length },
    { id: "noimage", label: "🖼 No Image", count: noImage.length },
    { id: "noprice", label: "$ No Price", count: noPrice.length },
    { id: "unenriched", label: "✍️ No Data", count: unenriched.length },
    { id: "duplicates", label: "♊ Dupes", count: duplicateGroups.length },
  ];

  const lists = { uncertain, noimage: noImage, noprice: noPrice, unenriched };
  const current = lists[activeTab] || [];

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0a0500", zIndex: 1000, display: "flex", flexDirection: "column", fontFamily: "Georgia, serif" }}>
      {/* Header */}
      <div style={{ background: "#150a00", borderBottom: "1px solid #2a1400", padding: "16px 20px" }}>
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
        <div style={{ display: "flex", gap: 12, marginTop: 14 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
              flex: 1, background: activeTab === t.id ? "rgba(201,169,110,0.15)" : "rgba(255,255,255,0.04)",
              border: `0.5px solid ${activeTab === t.id ? "#c9a96e" : "#2a1400"}`,
              borderRadius: 8, padding: "10px 6px", cursor: "pointer", textAlign: "center"
            }}>
              <div style={{ color: t.count > 0 ? "#e8a050" : "#4caf7d", fontSize: 20, fontWeight: 600, marginBottom: 2 }}>{t.count}</div>
              <div style={{ color: "#8a7060", fontSize: 9, letterSpacing: "1px", textTransform: "uppercase" }}>{t.label}</div>
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
        {activeTab === "duplicates" ? (
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
              <div key={gi} style={{ background: "rgba(255,255,255,0.04)", border: `0.5px solid ${hasPriceDiff ? "rgba(232,80,80,0.4)" : "#2a1400"}`, borderRadius: 8, padding: "12px 14px", marginBottom: 10 }}>
                <div style={{ color: hasPriceDiff ? "#e85050" : "#e8a050", fontSize: 10, letterSpacing: "1px", textTransform: "uppercase", marginBottom: 8 }}>
                  {hasPriceDiff ? "⚠️ Price conflict" : "Duplicate entry"} · {group.length} entries in Toast
                </div>
                {group.map((wine, i) => (
                  <div key={wine.id} style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: i > 0 ? 8 : 0, borderTop: i > 0 ? "0.5px solid #1a0f00" : "none" }}>
                    <div style={{ width: 30, height: 42, borderRadius: 3, background: "#1a0a00", border: "0.5px solid #2a1400", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, overflow: "hidden" }}>
                      {wine.imageUrl ? <img src={wine.imageUrl} alt={wine.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : "🍷"}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: "#f0e8d8", fontSize: 13 }}>{wine.name}</div>
                      <div style={{ color: "#6a5040", fontSize: 10 }}>{wine.subgroup} · {wine.tier}</div>
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
                <div style={{ width: 36, height: 50, borderRadius: 3, background: "#1a0a00", border: "0.5px solid #2a1400", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, overflow: "hidden" }}>
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
                        <div style={{ background: "rgba(201,169,110,0.1)", border: "0.5px solid rgba(201,169,110,0.3)", borderRadius: 6, padding: "8px 10px" }}>
                          <div style={{ color: "#9a8060", fontSize: 10, letterSpacing: "1px", textTransform: "uppercase", marginBottom: 4 }}>Suggested name</div>
                          <div style={{ color: "#f0e8d8", fontSize: 13, marginBottom: 8 }}>{wine.correctedName}</div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <CopyButton text={wine.correctedName} />
                            <span style={{ color: "#6a5040", fontSize: 10 }}>Copy, then paste into Toast to fix</span>
                          </div>
                        </div>
                      ) : (
                        <div style={{ color: "#6a5040", fontSize: 11, fontStyle: "italic" }}>
                          Fix the name in Toast — it will update on next sync
                        </div>
                      )}
                    </div>
                  )}
                  {activeTab === "noprice" && (
                    <div style={{ color: "#e8a050", fontSize: 11, marginTop: 4 }}>
                      No price in Toast — update menu item
                    </div>
                  )}
                  {activeTab === "noimage" && (
                    <div style={{ color: "#8a7060", fontSize: 11, marginTop: 4 }}>
                      Upload label image in Toast to display here
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
      <div style={{ background: "#150a00", borderTop: "1px solid #2a1400", padding: "12px 20px", textAlign: "center" }}>
        <div style={{ color: "#3a2010", fontSize: 10, letterSpacing: "1px" }}>
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
      <div style={{ background: "#150a00", border: "1px solid #2a1400", borderRadius: 16, padding: "32px 28px", width: 280, textAlign: "center" }}>
        <div style={{ color: "#c9a96e", fontSize: 10, letterSpacing: "3px", textTransform: "uppercase", marginBottom: 8 }}>Manager Access</div>
        <div style={{ color: "#f0e8d8", fontSize: 16, marginBottom: 24 }}>Enter PIN</div>

        {/* PIN dots */}
        <div style={{ display: "flex", justifyContent: "center", gap: 12, marginBottom: 24 }}>
          {[0,1,2,3].map(i => (
            <div key={i} style={{
              width: 14, height: 14, borderRadius: "50%",
              background: i < pin.length ? (error ? "#e85050" : "#c9a96e") : "transparent",
              border: `2px solid ${error ? "#e85050" : i < pin.length ? "#c9a96e" : "#3a2010"}`,
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

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
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

  useEffect(() => {
    fetchWines();
    const interval = setInterval(fetchWines, 15 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => { if (!loading) setTimeout(() => setVisible(true), 50); }, [loading]);

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

  const availableWines = wines.filter(w => w.available !== false);
  // Build tiers and subgroups in Toast arrival order (no hardcoded lists needed)
  const tierOrder = [...new Map(availableWines.map(w => [w.tier, true])).keys()];
  const tiers = ["All", ...tierOrder];
  const filteredByTier = activeTier === "All" ? availableWines : availableWines.filter(w => w.tier === activeTier);
  const subgroupOrder = [...new Map(filteredByTier.map(w => [w.subgroup, true])).keys()].filter(Boolean);
  const subgroups = ["All", ...subgroupOrder];
  const filteredBySubgroup = activeSubgroup === "All" ? filteredByTier : filteredByTier.filter(w => w.subgroup === activeSubgroup);
  const varietalSet = new Set(filteredBySubgroup.map(w => consolidateVarietal(w.varietal)).filter(Boolean));
  const varietals = ["All", ...Array.from(varietalSet).sort()];
  const filtered = activeVarietal === "All" ? filteredBySubgroup : filteredBySubgroup.filter(w => consolidateVarietal(w.varietal) === activeVarietal);

  const grouped = {};
  filtered.forEach(wine => {
    const key = wine.subgroup || wine.tier || "Wine";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(wine);
  });
  // Preserve Toast order for group headers
  const groupOrder = [...new Map(filtered.map(w => [w.subgroup || w.tier || "Wine", true])).keys()];

  if (loading) return (
    <div style={{ background: "#120800", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16 }}>
      <div style={{ fontSize: 32 }}>🍷</div>
      <div style={{ color: "#c9a96e", fontSize: 13, letterSpacing: "3px", textTransform: "uppercase", fontFamily: "Georgia, serif" }}>Loading Wine List</div>
    </div>
  );

  if (error) return (
    <div style={{ background: "#120800", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ color: "#c9a96e", fontFamily: "Georgia, serif", textAlign: "center" }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>🍷</div>
        <div>{error}</div>
        <button onClick={fetchWines} style={{ marginTop: 16, background: "#c9a96e", color: "#120800", border: "none", padding: "8px 20px", borderRadius: 6, fontFamily: "Georgia, serif", cursor: "pointer" }}>Try Again</button>
      </div>
    </div>
  );

  return (
    <div style={{ background: "#faf8f4", minHeight: "100vh", fontFamily: "Georgia, serif", maxWidth: 680, margin: "0 auto", opacity: visible ? 1 : 0, transition: "opacity 0.5s ease" }}>

      {showPin && <PinScreen onSuccess={() => { setShowPin(false); setShowManager(true); }} onCancel={() => setShowPin(false)} />}
      {showManager && <ManagerScreen wines={wines} onClose={() => setShowManager(false)} />}

      {/* Header */}
      <div style={{ background: "#120800", padding: "20px 20px 12px", position: "sticky", top: 0, zIndex: 100, borderBottom: "1px solid #2a1400" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <div onClick={handleLogoTap} style={{ width: 40, height: 40, borderRadius: "50%", border: "1px solid #c9a96e", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "pointer", userSelect: "none" }}>
            <span style={{ color: "#c9a96e", fontSize: 12, letterSpacing: 1 }}>AK</span>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ color: "#9a7855", fontSize: 10, letterSpacing: "2.5px", textTransform: "uppercase" }}>Corduroy Inn &amp; Lodge · Snowshoe Mountain</div>
            <div style={{ color: "#f0e8d8", fontSize: 19 }}>Appalachia Kitchen</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#4caf7d" }} />
              <span style={{ color: "#4caf7d", fontSize: 10, letterSpacing: "1px", textTransform: "uppercase" }}>Live</span>
            </div>
            <div style={{ color: "#5a4030", fontSize: 10, marginTop: 2 }}>{timeAgo(lastUpdated)}</div>
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
      </div>

      <div style={{ background: "#120800", padding: "6px 20px 10px", color: "#6a5040", fontSize: 11, letterSpacing: "1px" }}>
        {filtered.length} {filtered.length === 1 ? "wine" : "wines"}
        {activeVarietal !== "All" ? ` · ${activeVarietal}` : activeSubgroup !== "All" ? ` · ${activeSubgroup}` : activeTier !== "All" ? ` · ${TIER_LABELS[activeTier] || activeTier}` : ""}
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
                  onSelect={() => setSelectedWine(selectedWine === wine.id ? null : wine.id)} index={i} />
              ))}
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div style={{ color: "#b0a090", textAlign: "center", padding: 40, fontSize: 14 }}>No wines in this selection</div>
        )}
      </div>

      {selectedWine && (() => {
        const wine = wines.find(w => w.id === selectedWine);
        if (!wine) return null;
        return (
          <div style={{ position: "sticky", bottom: 0, background: "#fff", borderTop: "1px solid #e8e0d0", padding: "18px 20px", boxShadow: "0 -8px 32px rgba(0,0,0,0.10)" }}>
            <div style={{ display: "flex", gap: 14, marginBottom: 12 }}>
              <div style={{ width: 52, height: 72, borderRadius: 4, background: "#f0ebe0", border: "0.5px solid #e0d8c8", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, overflow: "hidden" }}>
                {wine.imageUrl ? <img src={wine.imageUrl} alt={wine.name} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 4 }} /> : "🍷"}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: "#1a0a00", fontSize: 16, marginBottom: 3, lineHeight: 1.3 }}>{wine.name}</div>
                <div style={{ color: "#c9a96e", fontSize: 10, letterSpacing: "1px", textTransform: "uppercase" }}>
                  {[wine.varietal, wine.region, wine.vintage ? `${wine.vintage}` : null].filter(Boolean).join(" · ")}
                </div>
              </div>
              <button onClick={() => setSelectedWine(null)} style={{ background: "transparent", border: "none", color: "#b0a090", fontSize: 22, cursor: "pointer", padding: "0 4px", alignSelf: "flex-start", lineHeight: 1 }}>×</button>
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

            <div style={{ display: "flex", gap: 24, marginBottom: 16, paddingBottom: 14, borderBottom: "0.5px solid #e8e0d0" }}>
              {wine.glassPrice && (
                <div>
                  <div style={{ color: "#b0a090", fontSize: 10, letterSpacing: "2px", textTransform: "uppercase", marginBottom: 2 }}>Glass</div>
                  <div style={{ color: "#1a0a00", fontSize: 22 }}>{formatPrice(wine.glassPrice)}</div>
                </div>
              )}
              {wine.bottlePrice && (
                <div>
                  <div style={{ color: "#b0a090", fontSize: 10, letterSpacing: "2px", textTransform: "uppercase", marginBottom: 2 }}>Bottle</div>
                  <div style={{ color: "#1a0a00", fontSize: 22 }}>{formatPrice(wine.bottlePrice)}</div>
                </div>
              )}
              {!wine.glassPrice && !wine.bottlePrice && (
                <div style={{ color: "#c0b0a0", fontSize: 13, fontStyle: "italic", alignSelf: "center" }}>Ask your server for pricing</div>
              )}
            </div>

            <button style={{ background: "#120800", color: "#c9a96e", border: "none", padding: "13px 24px", borderRadius: 8, fontSize: 13, cursor: "pointer", fontFamily: "Georgia, serif", letterSpacing: "0.5px", width: "100%" }}>
              Ask your server about this wine
            </button>
          </div>
        );
      })()}

      <div style={{ height: 32 }} />
    </div>
  );
}

function WineCard({ wine, selected, onSelect }) {
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
        <div style={{ color: "#1a0a00", fontSize: 14, marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{wine.name}</div>
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
      <div style={{ textAlign: "right", flexShrink: 0, minWidth: 52 }}>
        {wine.available === false ? (
          <div style={{ background: "#f0ebe0", color: "#c0b0a0", fontSize: 10, padding: "3px 8px", borderRadius: 10, letterSpacing: "1px", textTransform: "uppercase", border: "0.5px solid #e0d8c8" }}>86'd</div>
        ) : wine.glassPrice ? (
          <>
            <div style={{ color: "#1a0a00", fontSize: 14, fontWeight: 500 }}>{formatPrice(wine.glassPrice)}</div>
            <div style={{ color: "#b0a090", fontSize: 10, marginTop: 1 }}>glass</div>
          </>
        ) : wine.bottlePrice ? (
          <>
            <div style={{ color: "#1a0a00", fontSize: 14, fontWeight: 500 }}>{formatPrice(wine.bottlePrice)}</div>
            <div style={{ color: "#b0a090", fontSize: 10, marginTop: 1 }}>bottle</div>
          </>
        ) : (
          <span style={{ color: "#c0b0a0", fontSize: 11, fontStyle: "italic" }}>Ask</span>
        )}
      </div>
    </div>
  );
}

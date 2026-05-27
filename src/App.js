import { useState, useEffect } from "react";

const FIREBASE_URL = "https://us-central1-corduroy-wine-list.cloudfunctions.net/getWines";

const TIER_ORDER = ["House Wines", "Cellar Wines", "London's List"];
const TIER_LABELS = { "House Wines": "House", "Cellar Wines": "Cellar", "London's List": "London's List" };
const SUBGROUP_ORDER = [
  "House Reds", "House Whites",
  "Cellar Red Bottles", "Cellar White Bottles",
  "Cellar Premium Reds", "Cellar Premium Whites",
  "London's List"
];

function formatPrice(p) { return p ? `$${Math.round(p)}` : null; }
function timeAgo(ts) {
  if (!ts) return "";
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)}hr ago`;
}

// Filter button component for reuse
function FilterBtn({ label, active, onClick, small }) {
  return (
    <button onClick={onClick} style={{
      background: active ? "#c9a96e" : "rgba(255,255,255,0.08)",
      border: `0.5px solid ${active ? "#c9a96e" : "rgba(201,169,110,0.3)"}`,
      color: active ? "#0f0800" : "#d4b896",
      fontSize: small ? 10 : 11,
      padding: small ? "4px 11px" : "5px 14px",
      borderRadius: 20, cursor: "pointer",
      letterSpacing: "0.5px", fontFamily: "Georgia, serif",
      fontWeight: active ? 600 : 400, transition: "all 0.15s",
      whiteSpace: "nowrap"
    }}>{label}</button>
  );
}

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

  const availableWines = wines.filter(w => w.available !== false);
  const tiers = ["All", ...TIER_ORDER.filter(t => availableWines.some(w => w.tier === t))];
  const filteredByTier = activeTier === "All" ? availableWines : availableWines.filter(w => w.tier === activeTier);
  const subgroups = ["All", ...SUBGROUP_ORDER.filter(s => filteredByTier.some(w => w.subgroup === s))];
  const filteredBySubgroup = activeSubgroup === "All" ? filteredByTier : filteredByTier.filter(w => w.subgroup === activeSubgroup);
  const varietals = ["All", ...Array.from(new Set(filteredBySubgroup.map(w => w.varietal).filter(Boolean))).sort()];
  const filtered = activeVarietal === "All" ? filteredBySubgroup : filteredBySubgroup.filter(w => w.varietal === activeVarietal);

  const grouped = {};
  filtered.forEach(wine => {
    const key = wine.subgroup || wine.tier || "Wine";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(wine);
  });
  const groupOrder = SUBGROUP_ORDER.filter(s => grouped[s]);

  if (loading) return (
    <div style={{ background: "#0f0800", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16 }}>
      <div style={{ fontSize: 32 }}>🍷</div>
      <div style={{ color: "#c9a96e", fontSize: 13, letterSpacing: "3px", textTransform: "uppercase", fontFamily: "Georgia, serif" }}>Loading Wine List</div>
    </div>
  );

  if (error) return (
    <div style={{ background: "#0f0800", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ color: "#c9a96e", fontFamily: "Georgia, serif", textAlign: "center" }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>🍷</div>
        <div>{error}</div>
        <button onClick={fetchWines} style={{ marginTop: 16, background: "#c9a96e", color: "#0f0800", border: "none", padding: "8px 20px", borderRadius: 6, fontFamily: "Georgia, serif", cursor: "pointer" }}>Try Again</button>
      </div>
    </div>
  );

  return (
    <div style={{ background: "#faf8f4", minHeight: "100vh", fontFamily: "Georgia, serif", maxWidth: 680, margin: "0 auto", opacity: visible ? 1 : 0, transition: "opacity 0.5s ease" }}>

      {/* Header */}
      <div style={{ background: "#1a0800", padding: "20px 20px 0", position: "sticky", top: 0, zIndex: 100, borderBottom: "1px solid #3a2010" }}>

        {/* Logo row */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <div style={{ width: 40, height: 40, borderRadius: "50%", border: "1px solid #c9a96e", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, background: "rgba(201,169,110,0.1)" }}>
            <span style={{ color: "#c9a96e", fontSize: 12, letterSpacing: 1 }}>AK</span>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ color: "#a08060", fontSize: 10, letterSpacing: "2.5px", textTransform: "uppercase" }}>Corduroy Inn &amp; Lodge · Snowshoe Mountain</div>
            <div style={{ color: "#f0e8d8", fontSize: 19, letterSpacing: "0.3px" }}>Appalachia Kitchen</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#4caf7d" }} />
              <span style={{ color: "#4caf7d", fontSize: 10, letterSpacing: "1px", textTransform: "uppercase" }}>Live</span>
            </div>
            <div style={{ color: "#6a5040", fontSize: 10, marginTop: 2 }}>{timeAgo(lastUpdated)}</div>
          </div>
        </div>

        <div style={{ height: "0.5px", background: "linear-gradient(90deg, transparent, #c9a96e55, transparent)", marginBottom: 12 }} />

        {/* Tier filters */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {tiers.map(t => (
            <FilterBtn key={t} label={t === "All" ? "All Wines" : TIER_LABELS[t] || t}
              active={activeTier === t}
              onClick={() => { setActiveTier(t); setActiveSubgroup("All"); setActiveVarietal("All"); setSelectedWine(null); }} />
          ))}
        </div>

        {/* Subgroup filters */}
        {activeTier !== "All" && subgroups.length > 2 && (
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
            <span style={{ color: "#7a6050", fontSize: 9, letterSpacing: "2px", textTransform: "uppercase", alignSelf: "center", marginRight: 2 }}>Type</span>
            {subgroups.map(s => (
              <FilterBtn key={s} small label={s === "All" ? "All" : s.replace(/^(Cellar |House )/, "")}
                active={activeSubgroup === s}
                onClick={() => { setActiveSubgroup(s); setActiveVarietal("All"); setSelectedWine(null); }} />
            ))}
          </div>
        )}

        {/* Varietal filters */}
        {varietals.length > 2 && (
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
            <span style={{ color: "#7a6050", fontSize: 9, letterSpacing: "2px", textTransform: "uppercase", alignSelf: "center", marginRight: 2 }}>Grape</span>
            {varietals.map(v => (
              <FilterBtn key={v} small label={v === "All" ? "All" : v}
                active={activeVarietal === v}
                onClick={() => { setActiveVarietal(v); setSelectedWine(null); }} />
            ))}
          </div>
        )}

        <div style={{ height: "0.5px", background: "#2a1500", marginTop: 4 }} />
      </div>

      {/* Wine count bar */}
      <div style={{ background: "#1a0800", padding: "7px 20px 10px", color: "#7a6050", fontSize: 11, letterSpacing: "1px" }}>
        {filtered.length} {filtered.length === 1 ? "wine" : "wines"}
        {activeVarietal !== "All" ? ` · ${activeVarietal}` : activeSubgroup !== "All" ? ` · ${activeSubgroup}` : activeTier !== "All" ? ` · ${TIER_LABELS[activeTier] || activeTier}` : ""}
      </div>

      {/* Wine list */}
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

      {/* Detail panel */}
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

            <button style={{ background: "#1a0800", color: "#c9a96e", border: "none", padding: "13px 24px", borderRadius: 8, fontSize: 13, cursor: "pointer", fontFamily: "Georgia, serif", letterSpacing: "0.5px", width: "100%" }}>
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
      <div style={{ textAlign: "right", flexShrink: 0, minWidth: 48 }}>
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

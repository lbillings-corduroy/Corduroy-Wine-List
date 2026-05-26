import { useState, useEffect } from "react";

const FIREBASE_URL = "https://us-central1-corduroy-wine-list.cloudfunctions.net/getWines";

const TIER_ORDER = ["House Wines", "Cellar Wines", "London's List"];

const TIER_LABELS = {
  "House Wines": "House",
  "Cellar Wines": "Cellar",
  "London's List": "London's List"
};

const SUBGROUP_ORDER = [
  "House Reds", "House Whites",
  "Cellar Red Bottles", "Cellar White Bottles",
  "Cellar Premium Reds", "Cellar Premium Whites",
  "London's List"
];

function formatPrice(price) {
  if (!price) return null;
  return `$${Math.round(price)}`;
}

function timeAgo(ts) {
  if (!ts) return "";
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs}hr ago`;
}

export default function App() {
  const [wines, setWines] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTier, setActiveTier] = useState("All");
  const [activeSubgroup, setActiveSubgroup] = useState("All");
  const [selectedWine, setSelectedWine] = useState(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    fetchWines();
    const interval = setInterval(fetchWines, 15 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!loading) setTimeout(() => setVisible(true), 50);
  }, [loading]);

  async function fetchWines() {
    try {
      const res = await fetch(FIREBASE_URL);
      const data = await res.json();
      if (data.wines) {
        setWines(Array.isArray(data.wines) ? data.wines : Object.values(data.wines));
        setLastUpdated(data.lastUpdated);
      }
      setError(null);
    } catch (e) {
      setError("Unable to load wine list");
    } finally {
      setLoading(false);
    }
  }

  const availableWines = wines.filter(w => w.available !== false);

  const tiers = ["All", ...TIER_ORDER.filter(t => availableWines.some(w => w.tier === t))];

  const filteredByTier = activeTier === "All"
    ? availableWines
    : availableWines.filter(w => w.tier === activeTier);

  const subgroups = ["All", ...SUBGROUP_ORDER.filter(s => filteredByTier.some(w => w.subgroup === s))];

  const filtered = activeSubgroup === "All"
    ? filteredByTier
    : filteredByTier.filter(w => w.subgroup === activeSubgroup);

  // Group by subgroup for display
  const grouped = {};
  filtered.forEach(wine => {
    const key = wine.subgroup || wine.tier || "Wine";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(wine);
  });

  const groupOrder = SUBGROUP_ORDER.filter(s => grouped[s]);

  if (loading) {
    return (
      <div style={{
        background: "#0f0800", minHeight: "100vh", display: "flex",
        alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16
      }}>
        <div style={{ fontSize: 32 }}>🍷</div>
        <div style={{ color: "#c9a96e", fontSize: 13, letterSpacing: "3px", textTransform: "uppercase", fontFamily: "Georgia, serif" }}>
          Loading Wine List
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        background: "#0f0800", minHeight: "100vh", display: "flex",
        alignItems: "center", justifyContent: "center"
      }}>
        <div style={{ color: "#c9a96e", fontFamily: "Georgia, serif", textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🍷</div>
          <div>{error}</div>
          <button onClick={fetchWines} style={{
            marginTop: 16, background: "#c9a96e", color: "#0f0800",
            border: "none", padding: "8px 20px", borderRadius: 6,
            fontFamily: "Georgia, serif", cursor: "pointer"
          }}>Try Again</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      background: "#faf8f4", minHeight: "100vh",
      fontFamily: "Georgia, serif", maxWidth: 680, margin: "0 auto",
      opacity: visible ? 1 : 0, transition: "opacity 0.5s ease"
    }}>

      {/* Header */}
      <div style={{
        background: "#0f0800",
        padding: "24px 24px 0",
        position: "sticky", top: 0, zIndex: 100
      }}>
        {/* Logo row */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
          <div style={{
            width: 42, height: 42, borderRadius: "50%",
            border: "1px solid #c9a96e",
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0
          }}>
            <span style={{ color: "#c9a96e", fontSize: 13, letterSpacing: 1 }}>AK</span>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ color: "#6a5040", fontSize: 10, letterSpacing: "3px", textTransform: "uppercase" }}>
              Corduroy Inn &amp; Lodge · Snowshoe Mountain
            </div>
            <div style={{ color: "#f5ede0", fontSize: 20, letterSpacing: "0.5px" }}>
              Appalachia Kitchen
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5, justifyContent: "flex-end" }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#4caf7d" }} />
              <span style={{ color: "#4caf7d", fontSize: 10, letterSpacing: "1px", textTransform: "uppercase" }}>Live</span>
            </div>
            <div style={{ color: "#4a3828", fontSize: 10, marginTop: 2 }}>
              {timeAgo(lastUpdated)}
            </div>
          </div>
        </div>

        {/* Decorative rule */}
        <div style={{ height: "0.5px", background: "linear-gradient(90deg, transparent, #c9a96e, transparent)", marginBottom: 16 }} />

        {/* Tier filters */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          {tiers.map(t => (
            <button key={t} onClick={() => { setActiveTier(t); setActiveSubgroup("All"); setSelectedWine(null); }} style={{
              background: activeTier === t ? "#c9a96e" : "transparent",
              border: `0.5px solid ${activeTier === t ? "#c9a96e" : "#3a2010"}`,
              color: activeTier === t ? "#0f0800" : "#6a5040",
              fontSize: 11, padding: "5px 14px", borderRadius: 20,
              cursor: "pointer", letterSpacing: "0.5px",
              fontFamily: "Georgia, serif", fontWeight: activeTier === t ? 600 : 400,
              transition: "all 0.15s"
            }}>{t === "All" ? "All Wines" : TIER_LABELS[t] || t}</button>
          ))}
        </div>

        {/* Subgroup filters — only show when a tier is selected */}
        {activeTier !== "All" && subgroups.length > 2 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            {subgroups.map(s => (
              <button key={s} onClick={() => { setActiveSubgroup(s); setSelectedWine(null); }} style={{
                background: "transparent",
                border: `0.5px solid ${activeSubgroup === s ? "#6a5040" : "#2a1500"}`,
                color: activeSubgroup === s ? "#c9a96e" : "#4a3828",
                fontSize: 10, padding: "4px 12px", borderRadius: 20,
                cursor: "pointer", letterSpacing: "0.5px",
                fontFamily: "Georgia, serif",
                transition: "all 0.15s"
              }}>{s === "All" ? "All" : s.replace(activeTier === "Cellar Wines" ? "Cellar " : "House ", "")}</button>
            ))}
          </div>
        )}

        <div style={{ height: "0.5px", background: "#1a0a00", marginBottom: 0 }} />
      </div>

      {/* Wine count */}
      <div style={{
        background: "#0f0800",
        padding: "8px 24px 12px",
        color: "#4a3828", fontSize: 11, letterSpacing: "1px"
      }}>
        {filtered.length} {filtered.length === 1 ? "wine" : "wines"}
        {activeSubgroup !== "All" ? ` · ${activeSubgroup}` : activeTier !== "All" ? ` · ${activeTier}` : ""}
      </div>

      {/* Wine list */}
      <div style={{ background: "#faf8f4" }}>
        {groupOrder.map((group, gi) => (
          <div key={group}>
            {/* Section header */}
            <div style={{
              padding: "20px 24px 8px",
              borderTop: gi > 0 ? "0.5px solid #e8e0d0" : "none"
            }}>
              <div style={{ color: "#c9a96e", fontSize: 9, letterSpacing: "3px", textTransform: "uppercase" }}>
                {group}
              </div>
            </div>

            {/* Wine cards */}
            <div style={{ padding: "0 16px 8px", display: "flex", flexDirection: "column", gap: 1 }}>
              {grouped[group].map((wine, i) => (
                <WineCard
                  key={wine.id}
                  wine={wine}
                  selected={selectedWine === wine.id}
                  onSelect={() => setSelectedWine(selectedWine === wine.id ? null : wine.id)}
                  index={i}
                />
              ))}
            </div>
          </div>
        ))}

        {filtered.length === 0 && (
          <div style={{ color: "#b0a090", textAlign: "center", padding: 40, fontSize: 14 }}>
            No wines in this selection
          </div>
        )}
      </div>

      {/* Detail panel */}
      {selectedWine && (() => {
        const wine = wines.find(w => w.id === selectedWine);
        if (!wine) return null;
        return (
          <div style={{
            position: "sticky", bottom: 0,
            background: "#fff",
            borderTop: "0.5px solid #e8e0d0",
            padding: "20px 24px",
            boxShadow: "0 -8px 24px rgba(0,0,0,0.08)"
          }}>
            <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
              <div style={{
                width: 52, height: 72, borderRadius: 4,
                background: "#f0ebe0", border: "0.5px solid #e0d8c8",
                flexShrink: 0, display: "flex", alignItems: "center",
                justifyContent: "center", fontSize: 24
              }}>
                {wine.imageUrl
                  ? <img src={wine.imageUrl} alt={wine.name} style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 4 }} />
                  : "🍷"
                }
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ color: "#1a0a00", fontSize: 17, marginBottom: 4, lineHeight: 1.3 }}>{wine.name}</div>
                <div style={{ color: "#c9a96e", fontSize: 10, letterSpacing: "1.5px", textTransform: "uppercase" }}>
                  {wine.subgroup}
                </div>
              </div>
              <button onClick={() => setSelectedWine(null)} style={{
                background: "transparent", border: "none", color: "#b0a090",
                fontSize: 20, cursor: "pointer", padding: "0 4px", alignSelf: "flex-start"
              }}>×</button>
            </div>

            {wine.description ? (
              <div style={{ color: "#6a5a4a", fontSize: 13, lineHeight: 1.8, marginBottom: 16 }}>
                {wine.description}
              </div>
            ) : (
              <div style={{ color: "#c0b0a0", fontSize: 12, fontStyle: "italic", marginBottom: 16 }}>
                Ask your server for tasting notes
              </div>
            )}

            <div style={{ display: "flex", gap: 28, marginBottom: 18, paddingBottom: 16, borderBottom: "0.5px solid #e8e0d0" }}>
              <div>
                <div style={{ color: "#b0a090", fontSize: 10, letterSpacing: "2px", textTransform: "uppercase", marginBottom: 3 }}>Bottle</div>
                <div style={{ color: "#1a0a00", fontSize: 24 }}>{formatPrice(wine.price) || "—"}</div>
              </div>
            </div>

            <button style={{
              background: "#0f0800", color: "#c9a96e", border: "none",
              padding: "13px 24px", borderRadius: 8, fontSize: 13,
              cursor: "pointer", fontFamily: "Georgia, serif",
              letterSpacing: "0.5px", width: "100%"
            }}>
              Ask your server about this wine
            </button>
          </div>
        );
      })()}

      <div style={{ height: 32 }} />
    </div>
  );
}

function WineCard({ wine, selected, onSelect, index }) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex", alignItems: "center", gap: 14,
        background: selected ? "#f0ebe0" : hovered ? "#f5f0e8" : "transparent",
        borderLeft: selected ? "2px solid #c9a96e" : "2px solid transparent",
        borderRadius: 8, padding: "12px 8px",
        cursor: "pointer",
        transition: "all 0.15s",
        opacity: wine.available === false ? 0.4 : 1,
        animationDelay: `${index * 0.03}s`
      }}
    >
      {/* Label image or placeholder */}
      <div style={{
        width: 40, height: 56, borderRadius: 3,
        background: "#f0ebe0", border: "0.5px solid #e0d8c8",
        flexShrink: 0, display: "flex", alignItems: "center",
        justifyContent: "center", fontSize: 18, overflow: "hidden"
      }}>
        {wine.imageUrl
          ? <img src={wine.imageUrl} alt={wine.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          : "🍷"
        }
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          color: "#1a0a00", fontSize: 14, marginBottom: 2,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
        }}>{wine.name}</div>
        {wine.description ? (
          <div style={{
            color: "#8a7060", fontSize: 12, lineHeight: 1.5,
            display: "-webkit-box", WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical", overflow: "hidden"
          }}>{wine.description}</div>
        ) : (
          <div style={{ color: "#c0b0a0", fontSize: 11, fontStyle: "italic" }}>
            Tap for details
          </div>
        )}
      </div>

      {/* Price */}
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        {wine.available === false ? (
          <div style={{
            background: "#f0ebe0", color: "#c0b0a0", fontSize: 10,
            padding: "3px 8px", borderRadius: 10, letterSpacing: "1px",
            textTransform: "uppercase", border: "0.5px solid #e0d8c8"
          }}>86'd</div>
        ) : (
          <div style={{ color: "#1a0a00", fontSize: 15, fontWeight: 500 }}>
            {formatPrice(wine.price) || <span style={{ color: "#c0b0a0", fontSize: 12 }}>Ask</span>}
          </div>
        )}
      </div>
    </div>
  );
}

import { useState, useEffect } from "react";

const wines = [
  { id:1, name:"Whispering Angel Rosé", tier:"Cellar", color:"Rosé", grape:"Grenache Blend", region:"Provence, France", glass:18, bottle:72, available:true, desc:"The benchmark Provence rosé. Pale salmon with notes of fresh peach, white flowers, and a whisper of cream. Crisp, dry finish." },
  { id:2, name:"Jordan Cabernet Sauvignon", tier:"Cellar", color:"Red", grape:"Cabernet Sauvignon", region:"Alexander Valley, CA", glass:22, bottle:88, available:true, desc:"Structured yet approachable. Black cherry, cedar, and a touch of mocha with elegant tannins. A Sonoma classic." },
  { id:3, name:"Rombauer Chardonnay", tier:"Cellar", color:"White", grape:"Chardonnay", region:"Napa Valley, CA", glass:19, bottle:76, available:true, desc:"Rich and indulgent. Ripe tropical fruit, toasted oak, and a lush buttery finish that Napa Chardonnay is famous for." },
  { id:4, name:"Meiomi Pinot Noir", tier:"House", color:"Red", grape:"Pinot Noir", region:"California", glass:12, bottle:44, available:true, desc:"Silky and fruit-forward. Fresh strawberry, blackberry, and mocha with a smooth, velvety texture. An approachable crowd-pleaser." },
  { id:5, name:"Kim Crawford Sauvignon Blanc", tier:"House", color:"White", grape:"Sauvignon Blanc", region:"Marlborough, NZ", glass:11, bottle:40, available:true, desc:"Vibrant and refreshing. Zesty citrus, passionfruit, and fresh-cut grass. Perfect with lighter fare or on its own." },
  { id:6, name:"La Marca Prosecco", tier:"House", color:"Sparkling", grape:"Glera", region:"Veneto, Italy", glass:11, bottle:40, available:true, desc:"Light and festive. Delicate bubbles with honeysuckle, cream, and a hint of peach. Perfect to start the evening." },
  { id:7, name:"Caymus Cabernet Sauvignon", tier:"Cellar", color:"Red", grape:"Cabernet Sauvignon", region:"Napa Valley, CA", glass:null, bottle:145, available:true, desc:"Legendary Napa Cab. Intense dark fruit, velvety tannins, and remarkable depth. One of California's most celebrated wines." },
  { id:8, name:"Santa Margherita Pinot Grigio", tier:"House", color:"White", grape:"Pinot Grigio", region:"Alto Adige, Italy", glass:13, bottle:48, available:false, desc:"Clean and mineral-driven. Golden apple, citrus zest, and a refreshing dry finish. The wine that defined the category." },
  { id:9, name:"Duckhorn Merlot", tier:"Cellar", color:"Red", grape:"Merlot", region:"Napa Valley, CA", glass:20, bottle:80, available:true, desc:"Plush and generous. Plum, chocolate, and black cherry with a round, velvety mid-palate. Napa Merlot at its finest." },
  { id:10, name:"Kendall-Jackson Chardonnay", tier:"House", color:"White", grape:"Chardonnay", region:"California", glass:11, bottle:40, available:true, desc:"America's best-selling Chardonnay. Tropical fruit and vanilla with just enough oak for richness without heaviness." },
];

const FILTERS = ["All","Red","White","Rosé","Sparkling","House","Cellar"];

const gold = "#c9a96e";
const dark = "#1a0a00";
const cream = "#faf8f4";
const muted = "#b0a090";
const border = "#e8e0d0";
const hover = "#f0ebe0";

export default function WineList() {
  const [activeFilter, setActiveFilter] = useState("All");
  const [selectedWine, setSelectedWine] = useState(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => { setTimeout(() => setVisible(true), 50); }, []);

  const filtered = wines.filter(w =>
    activeFilter === "All" || w.color === activeFilter || w.tier === activeFilter
  );
  const house = filtered.filter(w => w.tier === "House");
  const cellar = filtered.filter(w => w.tier === "Cellar");
  const showSections = ["All","House","Cellar"].includes(activeFilter);

  const handleFilter = (f) => { setActiveFilter(f); setSelectedWine(null); };
  const handleSelect = (w) => { if (!w.available) return; setSelectedWine(w.id === selectedWine ? null : w.id); };

  const selected = wines.find(w => w.id === selectedWine);

  return (
    <div style={{
      background: cream, minHeight:"100vh", fontFamily:"'Georgia', serif",
      opacity: visible ? 1 : 0, transition:"opacity 0.6s ease",
      maxWidth: 600, margin:"0 auto"
    }}>

      {/* Header */}
      <div style={{ background:"#fff", borderBottom:`0.5px solid ${border}`, padding:"20px 24px 0" }}>
        <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:14 }}>
          <div style={{
            width:38, height:38, borderRadius:"50%", background:dark,
            display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0
          }}>
            <span style={{ color:gold, fontSize:12, fontFamily:"'Georgia', serif", letterSpacing:1 }}>AK</span>
          </div>
          <div>
            <div style={{ color:muted, fontSize:10, letterSpacing:"2.5px", textTransform:"uppercase", fontFamily:"'Georgia', serif" }}>
              Corduroy Inn &amp; Lodge
            </div>
            <div style={{ color:dark, fontSize:18, fontWeight:400, letterSpacing:"0.5px" }}>
              Appalachia Kitchen Wine List
            </div>
          </div>
        </div>

        {/* Sync indicator */}
        <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:16 }}>
          <div style={{ width:6, height:6, borderRadius:"50%", background:"#4caf7d", flexShrink:0 }} />
          <span style={{ color:muted, fontSize:11, fontFamily:"'Georgia', serif" }}>
            Prices &amp; availability live from Toast
          </span>
          <span style={{ color:gold, fontSize:11, marginLeft:4 }}>· Updated just now</span>
        </div>

        {/* Filters */}
        <div style={{ display:"flex", gap:6, flexWrap:"wrap", paddingBottom:16 }}>
          {FILTERS.map(f => (
            <button key={f} onClick={() => handleFilter(f)} style={{
              background: activeFilter===f ? dark : "transparent",
              border: `0.5px solid ${activeFilter===f ? dark : border}`,
              color: activeFilter===f ? gold : muted,
              fontSize:11, padding:"5px 14px", borderRadius:20,
              cursor:"pointer", letterSpacing:"0.5px", fontFamily:"'Georgia', serif",
              transition:"all 0.15s"
            }}>{f}</button>
          ))}
        </div>
      </div>

      {/* Wine sections */}
      {showSections ? (
        <>
          {house.length > 0 && <WineSection label="House Selections" wines={house} selectedWine={selectedWine} onSelect={handleSelect} />}
          {house.length > 0 && cellar.length > 0 && <div style={{ height:"0.5px", background:border, margin:"4px 24px" }} />}
          {cellar.length > 0 && <WineSection label="Cellar Selections" wines={cellar} selectedWine={selectedWine} onSelect={handleSelect} />}
        </>
      ) : (
        <WineSection label="" wines={filtered} selectedWine={selectedWine} onSelect={handleSelect} />
      )}

      {/* Detail panel */}
      {selected && (
        <div style={{
          background:"#fff", borderTop:`0.5px solid ${border}`,
          padding:"20px 24px", marginTop:4,
          animation:"fadeIn 0.2s ease"
        }}>
          <style>{`@keyframes fadeIn { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:translateY(0) } }`}</style>
          <div style={{ display:"flex", gap:16, marginBottom:14 }}>
            <div style={{
              width:52, height:72, borderRadius:4, background:hover,
              border:`0.5px solid ${border}`, flexShrink:0,
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:24, color:gold
            }}>🍷</div>
            <div>
              <div style={{ color:dark, fontSize:17, fontWeight:400, marginBottom:4 }}>{selected.name}</div>
              <div style={{ color:gold, fontSize:11, letterSpacing:"1px", textTransform:"uppercase" }}>
                {selected.tier} · {selected.color} · {selected.grape} · {selected.region}
              </div>
            </div>
          </div>
          <div style={{ color:"#6a5a4a", fontSize:13, lineHeight:1.8, marginBottom:16 }}>{selected.desc}</div>
          <div style={{ display:"flex", gap:28, marginBottom:18, paddingBottom:16, borderBottom:`0.5px solid ${border}` }}>
            <div>
              <div style={{ color:muted, fontSize:10, letterSpacing:"2px", textTransform:"uppercase", marginBottom:3 }}>Glass</div>
              <div style={{ color:dark, fontSize:22 }}>{selected.glass ? `$${selected.glass}` : "—"}</div>
            </div>
            <div>
              <div style={{ color:muted, fontSize:10, letterSpacing:"2px", textTransform:"uppercase", marginBottom:3 }}>Bottle</div>
              <div style={{ color:dark, fontSize:22 }}>${selected.bottle}</div>
            </div>
          </div>
          <button style={{
            background:dark, color:gold, border:"none",
            padding:"12px 24px", borderRadius:8, fontSize:13,
            cursor:"pointer", fontFamily:"'Georgia', serif",
            letterSpacing:"0.5px", width:"100%"
          }}>Ask your server about this wine</button>
        </div>
      )}

      <div style={{ height:32 }} />
    </div>
  );
}

function WineSection({ label, wines, selectedWine, onSelect }) {
  return (
    <div>
      {label && (
        <div style={{
          color:gold, fontSize:9, letterSpacing:"3px",
          textTransform:"uppercase", padding:"16px 24px 8px",
          fontFamily:"'Georgia', serif"
        }}>{label}</div>
      )}
      <div style={{ padding:"0 16px 8px", display:"flex", flexDirection:"column", gap:1 }}>
        {wines.map(w => <WineCard key={w.id} wine={w} selected={selectedWine===w.id} onSelect={onSelect} />)}
      </div>
    </div>
  );
}

function WineCard({ wine: w, selected, onSelect }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={() => onSelect(w)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display:"flex", alignItems:"center", gap:14,
        background: selected ? hover : hovered ? hover : "transparent",
        borderLeft: selected ? `2px solid ${gold}` : "2px solid transparent",
        borderRadius:8, padding:"11px 8px",
        cursor: w.available ? "pointer" : "default",
        opacity: w.available ? 1 : 0.4,
        transition:"all 0.15s"
      }}
    >
      <div style={{
        width:40, height:56, borderRadius:3, background:hover,
        border:`0.5px solid ${border}`, flexShrink:0,
        display:"flex", alignItems:"center", justifyContent:"center",
        fontSize:18, color:gold
      }}>🍷</div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{
          color:dark, fontSize:14, fontWeight:400, marginBottom:2,
          whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"
        }}>{w.name}</div>
        <div style={{ color:muted, fontSize:11, letterSpacing:"0.3px", marginBottom:3 }}>
          {w.color} · {w.grape} · {w.region}
        </div>
        <div style={{
          color:"#8a7060", fontSize:12, lineHeight:1.5,
          display:"-webkit-box", WebkitLineClamp:2,
          WebkitBoxOrient:"vertical", overflow:"hidden"
        }}>{w.desc}</div>
      </div>
      <div style={{ textAlign:"right", flexShrink:0 }}>
        {w.available ? (
          <>
            <div style={{ color:dark, fontSize:14, fontWeight:500 }}>
              {w.glass ? `$${w.glass}` : `$${w.bottle}`}
            </div>
            <div style={{ color:muted, fontSize:11, marginTop:1 }}>
              {w.glass ? `$${w.bottle} btl` : "bottle only"}
            </div>
          </>
        ) : (
          <div style={{
            background:hover, color:"#c0b0a0", fontSize:10,
            padding:"3px 8px", borderRadius:10, letterSpacing:"1px",
            textTransform:"uppercase", border:`0.5px solid ${border}`
          }}>86'd</div>
        )}
      </div>
    </div>
  );
}

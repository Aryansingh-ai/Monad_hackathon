import { useEffect, useRef, useState } from "react";
import {
  ShieldCheck, ShieldAlert, RefreshCw, XCircle, Link2, Cpu, Hash, Radar,
  AlertTriangle, ExternalLink,
} from "lucide-react";
import "./App.css";

const API_URL = "http://localhost:3000";

function useCountUp(target, ms = 900) {
  const [val, setVal] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf;
    const tick = (t) => {
      const p = Math.min((t - start) / ms, 1);
      setVal(Math.round(a + (target - a) * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return val;
}

/* ---------- helpers (real data only) ---------- */
const recNo = (r, i) => r.recordNumber ?? r.id ?? i + 1;
const shortHash = (r, i) => {
  const h = r.proofHash || r.originalProofHash || r.hash || r.currentHash || r.sha256 || r.proof || "";
  return h ? `${String(h).slice(0, 6)}…${String(h).slice(-4)}` : `0x${Number(recNo(r, i)).toString(16).padStart(4, "0")}`;
};
const clip = (h) => (h ? `${String(h).slice(0, 10)}…${String(h).slice(-6)}` : null);
const money = (v) => (v == null || v === "" ? "—" : String(v).startsWith("₹") ? v : `₹${v}`);
const when = (r) => {
  const t = r.record?.timestamp ?? r.timestamp;
  const d = t ? new Date(t) : null;
  return d && !isNaN(d) ? d.toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : null;
};
const details = (d) => (!d ? null : Array.isArray(d) ? d.join(" · ") : typeof d === "object" ? JSON.stringify(d) : String(d));

/* ---------- decorative: gopuram silhouette ---------- */
function Gopuram() {
  return (
    <svg className="gopuram" viewBox="0 0 300 380" aria-hidden="true">
      <defs>
        <radialGradient id="halo" cx="50%" cy="38%" r="55%">
          <stop offset="0" stopColor="#f3b24a" stopOpacity="0.55" />
          <stop offset="1" stopColor="#f3b24a" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="150" cy="150" r="150" fill="url(#halo)" className="halo" />
      <g className="body">
        <rect x="30" y="338" width="240" height="30" />
        <rect x="50" y="308" width="200" height="30" />
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <g key={i}>
            <rect x={70 + i * 11} y={282 - i * 38} width={160 - i * 22} height="38" rx="2" />
            <rect x={70 + i * 11} y={282 - i * 38} width={160 - i * 22} height="3" className="gold" />
            <rect x="143" y={292 - i * 38} width="14" height="20" rx="7" className="door" />
          </g>
        ))}
        <path d="M150 -6 L158 22 H142 Z" className="gold" />
        <rect x="140" y="22" width="20" height="10" className="gold" />
      </g>
    </svg>
  );
}

/* ---------- gauge + stats ---------- */
function Insights({ total, verified, tampered, pct }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { const t = setTimeout(() => setArmed(true), 80); return () => clearTimeout(t); }, []);
  const nTotal = useCountUp(armed ? total : 0, 1100);
  const nOk = useCountUp(armed ? verified : 0, 1100);
  const nBad = useCountUp(armed ? tampered : 0, 1100);
  const shown = useCountUp(armed ? Math.round(pct * 10) : 0, 1300) / 10;
  const bad = tampered > 0;
  const r = 86, c = 2 * Math.PI * r;
  return (
    <section className={`panel ${bad ? "is-bad" : "is-ok"}`} aria-label="Integrity">
      <div className="gauge-box">
        <svg className="gauge" viewBox="0 0 240 240" role="img" aria-label={`${pct.toFixed(1)}% intact`}>
          <defs>
            <linearGradient id="gOk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#e08a1e" /><stop offset="1" stopColor="#1f7a5a" /></linearGradient>
            <linearGradient id="gBad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#e08a1e" /><stop offset="1" stopColor="#b3261e" /></linearGradient>
          </defs>
          <circle cx="120" cy="120" r="108" className="g-ticks" />
          <circle cx="120" cy="120" r="70" className="g-inner" />
          <circle cx="120" cy="120" r={r} className="g-track" />
          <g transform="rotate(-90 120 120)">
            <circle cx="120" cy="120" r={r} className="g-fill ok" strokeDasharray={c} strokeDashoffset={c - (c * shown) / 100} />
            <circle cx="120" cy="120" r={r} className="g-fill badarc" strokeDasharray={c} strokeDashoffset={c - (c * shown) / 100} />
          </g>
          <text x="120" y="124" className="g-num">{shown.toFixed(1)}</text>
          <text x="120" y="148" className="g-sub">% intact</text>
        </svg>
      </div>
      <div className="numbers">
        <div className="stat"><strong>{nTotal.toLocaleString()}</strong><span>records registered</span></div>
        <div className="stat g"><strong>{nOk.toLocaleString()}</strong><span>match their proof</span></div>
        <div className={`stat r ${bad ? "dominant" : ""}`}><strong>{nBad.toLocaleString()}</strong><span>failed verification</span></div>
      </div>
    </section>
  );
}

/* ---------- tampered record comparison ---------- */
function TamperCard({ r, i }) {
  const note = details(r.tamperDetails);
  return (
    <article className="tcard">
      <header>
        <b><AlertTriangle size={16} /> Record #{recNo(r, i)}</b>
        <span className="mismatch">Blockchain proof mismatch</span>
      </header>
      <div className="cmp">
        <div className="side">
          <small>Original</small>
          <strong>{money(r.originalDenomination)}</strong>
          <code>{r.originalBin ?? "—"}</code>
        </div>
        <div className="neq" aria-label="does not equal"><i /><b>≠</b><i /></div>
        <div className="side now">
          <small>Current</small>
          <strong>{money(r.currentDenomination)}</strong>
          <code>{r.currentBin ?? "—"}</code>
        </div>
      </div>
      {(r.originalProofHash || r.proofHash) && (
        <div className="hashes">
          <div><small>Original proof</small><code>{clip(r.originalProofHash) ?? "—"}</code></div>
          <span className="hbreak">→</span>
          <div className="now"><small>Current calculated proof</small><code>{clip(r.proofHash) ?? "—"}</code></div>
        </div>
      )}
      {note && <p className="tnote">{note}</p>}
      {r.explorerUrl && (
        <a className="tx" href={r.explorerUrl} target="_blank" rel="noopener noreferrer">
          View blockchain transaction <ExternalLink size={14} />
        </a>
      )}
    </article>
  );
}

/* ---------- envio proof analytics & explorer ---------- */
function ProofAnalytics() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/proof-analytics`);
      if (!res.ok) throw new Error("Unavailable");
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      setData(json);
      setError(null);
    } catch (err) {
      setError("On-chain analytics temporarily unavailable.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  if (loading && !data) return null;
  if (error) return <div className="panel muted" style={{ marginTop: '2rem' }}><AlertTriangle size={14}/> {error}</div>;

  return (
    <section className="analytics panel" style={{ marginTop: '2rem', padding: '2rem' }}>
      <div className="sec-head row">
        <div>
          <h2>On-Chain Analytics</h2>
          <span className="muted">Global HyperIndex Statistics</span>
        </div>
        {data.latestProcessedBlock && (
          <span className="pill" style={{ fontSize: '0.8rem', background: 'var(--bg-sub)' }}>
            <span style={{ color: 'var(--ok)' }}>●</span> Synced to block {data.latestProcessedBlock}
          </span>
        )}
      </div>
      <div className="numbers" style={{ justifyContent: 'flex-start', gap: '3rem', marginTop: '1.5rem', flexWrap: 'wrap' }}>
        <div className="stat">
          <strong>{data.total}{data.isPartial ? '+' : ''}</strong>
          <span>Total Indexed Proofs</span>
        </div>
        {Object.entries(data.byIssuer || {}).map(([issuer, count]) => (
          <div className="stat" key={issuer}>
            <strong>{count}{data.isPartial ? '+' : ''}</strong>
            <span>Proofs by Issuer ({clip(issuer)})</span>
          </div>
        ))}
      </div>
      {data.isPartial && (
        <div className="muted" style={{ marginTop: '1.5rem', fontSize: '0.85rem' }}>
          * Displaying aggregated results for the most recent 10,000 proofs.
        </div>
      )}
    </section>
  );
}

function ProofExplorer() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/proof-history?limit=10`);
      if (!res.ok) throw new Error("Unavailable");
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      setData(json.records || []);
      setError(null);
    } catch (err) {
      setError("On-chain history temporarily unavailable; indexer synchronization may be interrupted.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  if (loading && !data) return <div className="muted" style={{ padding: '2rem' }}>Loading Explorer...</div>;
  
  if (error) {
    return (
      <section className="explorer" style={{ marginTop: '3rem', padding: '2rem', border: '1px solid var(--border)', borderRadius: '8px' }}>
        <div className="sec-head row">
          <div>
            <h2>On-Chain Proof Explorer</h2>
            <span className="muted">Live Envio HyperIndex Feed</span>
          </div>
          <button className="btn" onClick={load}><RefreshCw size={12} /> Retry</button>
        </div>
        <div className="verdict bad" style={{ marginTop: '1rem', padding: '1rem' }}>
          <span className="v-icon"><AlertTriangle size={20} /></span>
          <div>
            <strong>INDEXER OFFLINE</strong>
            <span>{error}</span>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="explorer" style={{ marginTop: '3rem', paddingTop: '2rem' }}>
      <div className="sec-head row">
        <div>
          <h2>On-Chain Proof Explorer</h2>
          <span className="muted">Live Envio HyperIndex Feed</span>
        </div>
        <button className="btn" onClick={load}><RefreshCw size={12} /> Refresh Feed</button>
      </div>
      
      {data.length === 0 ? (
        <p className="muted">No proofs indexed yet.</p>
      ) : (
        <div className="tgrid" style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {data.map((r) => (
            <article key={r.proofHash} className="tcard" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem', alignItems: 'center', padding: '1rem 1.5rem' }}>
              <div>
                <small>Proof Hash</small>
                <code style={{display:'block'}}>{clip(r.proofHash)}</code>
              </div>
              <div>
                <small>Source ID</small>
                <strong>{r.sourceId}</strong>
              </div>
              <div>
                <small>Block</small>
                <strong>#{r.blockNumber}</strong>
                <div className="muted" style={{ fontSize: '0.75rem' }}>{new Date(Number(r.blockTimestamp) * 1000).toLocaleString([], {dateStyle:'short', timeStyle:'short'})}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <a className="tx" href={r.explorerUrl} target="_blank" rel="noopener noreferrer">
                  View Tx <ExternalLink size={14} />
                </a>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

const STEPS = [
  [Cpu, "Model scans", "ML screens each record for anomalies"],
  [Hash, "SHA-256", "The record becomes a fixed fingerprint"],
  [Link2, "Monad", "The fingerprint is anchored on-chain"],
  [Radar, "Re-check", "We recompute it every 3 seconds"],
];

export default function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updated, setUpdated] = useState(null);
  const [fresh, setFresh] = useState(() => new Set());
  const seen = useRef(null);

  const load = async () => {
    try {
      setError("");
      const res = await fetch(`${API_URL}/all-records`);
      if (!res.ok) throw new Error("Failed to load records");
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "API error");
      const keys = (json.records || []).map((r, i) => String(recNo(r, i)));
      if (seen.current) {
        const added = keys.filter((k) => !seen.current.has(k));
        if (added.length) {
          setFresh(new Set(added));
          setTimeout(() => setFresh(new Set()), 2200);
        }
      }
      seen.current = new Set(keys);
      setData(json);
      setUpdated(new Date());
    } catch (e) {
      console.error(e);
      setError("Can't reach the DaanDristi API. Start the backend on port 3000, then retry.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  const records = data?.records || [];
  const total = Number(data?.totalRecords || 0);
  const tampered = records.filter((r) => r.status === "TAMPERED").length;
  const verified = Math.max(total - tampered, 0);
  const pct = total > 0 ? (verified / total) * 100 : 100;

  if (loading || error)
    return (
      <div className="app center">
        <div className={`seal ${error ? "bad" : "spin"}`}>
          {error ? <XCircle size={40} /> : <ShieldCheck size={40} />}
        </div>
        <h2>{error ? "Connection lost" : "Checking the ledger"}</h2>
        <p className="muted">{error || "Comparing every record with its on-chain proof…"}</p>
        {error && <button className="btn" onClick={load}><RefreshCw size={15} /> Retry</button>}
      </div>
    );

  const chain = records.slice(-12);
  const offset = records.length - chain.length;
  const firstBroken = chain.findIndex((r) => r.status === "TAMPERED");
  const badRecords = records.map((r, i) => [r, i]).filter(([r]) => r.status === "TAMPERED").reverse();

  return (
    <div className="app">
      <div className="torana" aria-hidden="true" />

      <header className="nav">
        <div className="brand">
          <ShieldCheck size={24} />
          <div>
            <b>DaanDristi</b>
            <span lang="hi">दानदृष्टि</span>
          </div>
          <em className="muted">donation provenance</em>
        </div>
        <div className="pill"><i className="dot" /> Monad testnet · live</div>
      </header>

      <main>
        <section className="hero">
          <div className="hero-copy">
            <p className="label"><i /> DAANDRISTI / DONATION PROVENANCE</p>
            <h1>
              Every rupee given<br />
              leaves a <em>proof</em><br />
              that can't be edited.
            </h1>
            <p className="lede">
              Each donation record is fingerprinted with SHA-256 and anchored on Monad.
              If a single digit changes later, the fingerprint no longer matches and we flag it here.
            </p>

            <div className={`verdict ${tampered ? "bad" : "ok"}`} role="status" aria-live="polite">
              <span className="v-icon">
                {tampered ? <ShieldAlert size={24} /> : <ShieldCheck size={24} />}
                <i className="v-ping" />
              </span>
              <div>
                <strong>{tampered ? "TAMPERING DETECTED" : "SYSTEM SECURE"}</strong>
                <span>
                  {tampered
                    ? `${tampered} record${tampered === 1 ? "" : "s"} no longer match their proof. Review them now.`
                    : "All records match their on-chain proof."}
                </span>
              </div>
            </div>
          </div>
          <div className="hero-art">
            <Gopuram />
            {Array.from({ length: 9 }).map((_, i) => (
              <i key={i} className="mote" style={{ left: `${10 + i * 10}%`, animationDelay: `${i * -2.1}s`, animationDuration: `${11 + (i % 4) * 3}s` }} />
            ))}
          </div>
        </section>

        <section className="ledger" aria-label="Latest records on the chain">
          <div className="sec-head row">
            <div>
              <h2>Latest blocks</h2>
              <span className="muted">Live provenance chain</span>
            </div>
            <span className="muted refreshed">
              <RefreshCw size={12} /> {updated && `Refreshed ${updated.toLocaleTimeString()} · every 3s`}
            </span>
          </div>
          <div className="chain">
            {chain.length === 0 && <p className="muted">No records yet. New donations appear here as they are registered.</p>}
            {chain.map((r, i) => {
              const bad = r.status === "TAMPERED";
              const idx = offset + i;
              const key = String(recNo(r, idx));
              const ts = when(r);
              return (
                <div className="link-group" key={key}>
                  {i > 0 && (
                    <span className={`wire ${i >= firstBroken && firstBroken > -1 && (bad || chain[i - 1].status === "TAMPERED") ? "cut" : ""}`} />
                  )}
                  <div className={`slip ${bad ? "bad" : "ok"} ${fresh.has(key) ? "fresh" : ""}`} style={{ "--d": `${i * 60}ms` }}>
                    <article className="block">
                      <small>Block</small>
                      <b>#{recNo(r, idx)}</b>
                      <code>{shortHash(r, idx)}</code>
                      {ts && <time>{ts}</time>}
                      <span className="stamp">
                        {bad ? <AlertTriangle size={12} /> : <ShieldCheck size={12} />}
                        {bad ? "Tampered" : "Verified"}
                      </span>
                    </article>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {badRecords.length > 0 && (
          <section className="tamper" aria-label="Tampered records">
            <div className="sec-head">
              <h2>Original record ≠ current record</h2>
              <span className="muted">Each proof was anchored on Monad before the change</span>
            </div>
            <div className="tgrid">
              {badRecords.slice(0, 4).map(([r, i]) => <TamperCard key={recNo(r, i)} r={r} i={i} />)}
            </div>
            {badRecords.length > 4 && <p className="muted more">+ {badRecords.length - 4} more tampered records</p>}
          </section>
        )}

        <Insights total={total} verified={verified} tampered={tampered} pct={pct} />

        <ProofAnalytics />
        <ProofExplorer />

        <section className="flow" aria-label="How verification works">
          <div className="track"><i className="particle" /></div>
          {STEPS.map(([Icon, t, d], i) => (
            <div className="step" key={t} style={{ "--i": i }}>
              <span className="s-icon"><Icon size={22} /></span>
              <div><b>{t}</b><span>{d}</span></div>
            </div>
          ))}
        </section>
      </main>

      <footer className="foot muted">DaanDristi · Records are checked against Monad testnet proofs</footer>
    </div>
  );
}

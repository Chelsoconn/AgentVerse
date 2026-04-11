import { useState, useEffect, useCallback, useRef } from 'react';
import { DndContext, closestCenter, PointerSensor, TouchSensor, KeyboardSensor, useSensor, useSensors, useDraggable, useDroppable } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import './App.css';

// In production the frontend is served by the same Express server, so the API
// is at the same origin. In dev, point at the local Express on :3001.
const API = import.meta.env.PROD ? '/api' : 'http://localhost:3001/api';
async function api(path, method = 'GET', body = null) {
  const opts = { method, credentials: 'include', headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  try { return await (await fetch(API + path, opts)).json(); } catch { return { error: 'Cannot connect to server' }; }
}

const T = {
  crocodile: { bg:'#0a1f0e',bg2:'#143d1a',card:'#1a4d22',cardH:'#22612c',accent:'#4caf50',accent2:'#81c784',text:'#e8f5e9',dim:'#8bc34a',header:'🐊 Croc Academy',emoji:'🐊',correct:'🐊 Snappy!',wrong:'💦 Splash!',done:'🐊 Swamp conquered!',glow:'rgba(76,175,80,0.3)',
    traveler:'🛶', pathName:'Amazon River', journeyTitle:'Sail the Amazon!', deco:['🐊','🌴','🦜','🐍','🌿','🐊','🪵','🌴','🐸','🦎','🦋','🌺'], pathBg:'linear-gradient(180deg,#0a1f0e 0%,#143d1a 50%,#1a4d22 100%)', pathColor:'#4a7c2a' },
  greek: { bg:'#080820',bg2:'#121240',card:'#1e1e5a',cardH:'#28287a',accent:'#ffd54f',accent2:'#fff176',text:'#e8eaf6',dim:'#9fa8da',header:'⚡ Olympus Academy',emoji:'⚡',correct:'⚡ By Zeus!',wrong:'🌊 Poseidon says no!',done:'🏛️ Gods are pleased!',glow:'rgba(255,213,79,0.3)',
    traveler:'☁️', pathName:'Mount Olympus', journeyTitle:'Climb Olympus!', deco:['⚡','🏛️','🌩️','🏺','👑','⚡','🦉','🌟','🌙','🔱','🏛️','✨'], pathBg:'linear-gradient(180deg,#080820 0%,#121240 50%,#1e1e5a 100%)', pathColor:'#6464a8' },
};

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { api('/me').then(u => { if (u?.id) setUser(u); }).finally(() => setLoading(false)); }, []);
  if (loading) return <div className="ld"><div className="spin"/>Loading...</div>;
  if (!user) return <Auth onLogin={setUser}/>;
  if (user.is_admin) return <AdminDashboard user={user} setUser={setUser}/>;
  return <Main user={user} setUser={setUser}/>;
}

// ===================== ADMIN DASHBOARD =====================
function AdminDashboard({ user, setUser }) {
  const [tab, setTab] = useState('users');
  const [users, setUsers] = useState([]);
  const [requests, setRequests] = useState([]);
  const [msg, setMsg] = useState('');

  async function loadUsers() {
    const u = await api('/admin/users');
    if (Array.isArray(u)) setUsers(u);
  }
  async function loadRequests() {
    const r = await api('/admin/feature-requests');
    if (Array.isArray(r)) setRequests(r);
  }

  useEffect(() => { loadUsers(); loadRequests(); }, []);

  async function approve(id) {
    await api('/admin/users/' + id + '/approve', 'POST');
    setMsg('✅ Approved!');
    loadUsers();
    setTimeout(() => setMsg(''), 2000);
  }
  async function deny(id) {
    await api('/admin/users/' + id + '/deny', 'POST');
    setMsg('❌ Denied');
    loadUsers();
    setTimeout(() => setMsg(''), 2000);
  }
  async function del(id, username) {
    if (!confirm(`Permanently delete user "${username}" and all their data?`)) return;
    await api('/admin/users/' + id, 'DELETE');
    loadUsers();
  }
  async function setReqStatus(id, status) {
    await api('/admin/feature-requests/' + id, 'PUT', { status });
    loadRequests();
  }
  async function logout() { await api('/logout', 'POST'); setUser(null); }

  const pending = users.filter(u => u.status === 'pending');
  const approved = users.filter(u => u.status === 'approved' && !u.is_admin);
  const denied = users.filter(u => u.status === 'denied');

  return (
    <div className="admin-app">
      <header className="admin-header">
        <h1>🛡️ AgentVerse Admin</h1>
        <div>
          <span className="admin-hi">Hi, {user.display_name}</span>
          <button className="hb" onClick={logout}>Logout</button>
        </div>
      </header>
      <nav className="admin-nav">
        <button className={tab==='users'?'on':''} onClick={()=>setTab('users')}>👥 Users ({users.length})</button>
        <button className={tab==='pending'?'on':''} onClick={()=>setTab('pending')}>⏳ Pending ({pending.length})</button>
        <button className={tab==='requests'?'on':''} onClick={()=>setTab('requests')}>💡 Feature Requests ({requests.filter(r=>r.status==='open').length})</button>
      </nav>
      {msg && <div className="admin-msg">{msg}</div>}
      <main className="admin-main">
        {tab === 'users' && (
          <div>
            <h2>All Users</h2>
            <div className="admin-stats">
              <div className="stat-box"><div className="stat-num">{approved.length}</div><div className="stat-lbl">Approved</div></div>
              <div className="stat-box"><div className="stat-num">{pending.length}</div><div className="stat-lbl">Pending</div></div>
              <div className="stat-box"><div className="stat-num">{denied.length}</div><div className="stat-lbl">Denied</div></div>
            </div>
            <table className="admin-table">
              <thead><tr><th>Status</th><th>Username</th><th>Name</th><th>Age</th><th>Level</th><th>XP</th><th>🪙</th><th>Actions</th></tr></thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} className={`row-${u.status}`}>
                    <td><span className={`status-pill status-${u.status}`}>{u.status}</span>{u.is_admin && <span className="admin-pill">admin</span>}</td>
                    <td>{u.username}</td>
                    <td>{u.display_name}</td>
                    <td>{u.age}</td>
                    <td>{u.level}</td>
                    <td>{u.xp}</td>
                    <td>{u.tokens}</td>
                    <td>
                      {u.status === 'pending' && <>
                        <button className="admin-btn approve" onClick={()=>approve(u.id)}>Approve</button>
                        <button className="admin-btn deny" onClick={()=>deny(u.id)}>Deny</button>
                      </>}
                      {u.status !== 'pending' && !u.is_admin && (
                        <button className="admin-btn del" onClick={()=>del(u.id, u.username)}>Delete</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {tab === 'pending' && (
          <div>
            <h2>Pending Approvals</h2>
            {pending.length === 0 && <p className="admin-empty">No one is waiting for approval right now.</p>}
            {pending.map(u => (
              <div key={u.id} className="pending-card">
                <div>
                  <h3>{u.display_name} <span className="pending-username">(@{u.username})</span></h3>
                  <p>Age {u.age} · Signed up {new Date(u.created_at).toLocaleString()}</p>
                </div>
                <div className="pending-actions">
                  <button className="admin-btn approve big" onClick={()=>approve(u.id)}>✅ Approve</button>
                  <button className="admin-btn deny big" onClick={()=>deny(u.id)}>❌ Deny</button>
                </div>
              </div>
            ))}
          </div>
        )}
        {tab === 'requests' && (
          <div>
            <h2>Feature Requests from Users</h2>
            {requests.length === 0 && <p className="admin-empty">No feature requests yet.</p>}
            {requests.map(r => (
              <div key={r.id} className={`req-card req-${r.status}`}>
                <div className="req-meta">
                  <strong>{r.display_name}</strong> <span className="req-user">@{r.username}</span>
                  <span className="req-time">{new Date(r.created_at).toLocaleString()}</span>
                </div>
                <p className="req-body">{r.body}</p>
                <div className="req-actions">
                  <span className={`req-status req-s-${r.status}`}>{r.status}</span>
                  <button className="admin-btn" onClick={()=>setReqStatus(r.id, 'seen')}>Mark Seen</button>
                  <button className="admin-btn approve" onClick={()=>setReqStatus(r.id, 'done')}>Done</button>
                  <button className="admin-btn deny" onClick={()=>setReqStatus(r.id, 'rejected')}>Reject</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

// ===================== AUTH =====================
function Auth({ onLogin }) {
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ username:'', password:'', displayName:'', age:'10', theme:'crocodile' });
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k,v) => setF({...f,[k]:v});

  async function go() {
    setErr(''); setOk('');
    if (!f.username || !f.password) return setErr('Fill in all fields!');
    if (mode === 'register' && !f.displayName) return setErr('Enter your name!');
    setBusy(true);
    if (mode === 'register') {
      const r = await api('/register','POST',{ username:f.username, password:f.password, displayName:f.displayName, age:+f.age, theme:f.theme });
      setBusy(false);
      if (r.error) return setErr(r.error);
      setOk('🎉 Account created! An admin needs to approve you before you can log in. Check back soon!');
      setMode('login');
      set('password','');
    } else {
      const r = await api('/login','POST',{ username:f.username, password:f.password });
      setBusy(false);
      if (r.error) return setErr(r.error);
      onLogin(r);
    }
  }

  return (
    <div className="auth-bg">
      <div className="auth-card">
        <div className="auth-top"><span className="big-icon">🧠</span><h1>AI Learning Lab</h1><p>Learn AI + Code with fun games!</p></div>
        <div className="auth-form">
          <input placeholder="Username" value={f.username} onChange={e=>set('username',e.target.value)}/>
          <input placeholder="Password" type="password" value={f.password} onChange={e=>set('password',e.target.value)}/>
          {mode==='register' && <>
            <input placeholder="Your Name" value={f.displayName} onChange={e=>set('displayName',e.target.value)}/>
            <select value={f.age} onChange={e=>set('age',e.target.value)}>{[8,9,10,11,12].map(a=><option key={a} value={a}>Age {a}</option>)}</select>
            <div className="tpick"><div className={`tp ${f.theme==='crocodile'?'s':''}`} onClick={()=>set('theme','crocodile')}>🐊 Crocodile</div><div className={`tp ${f.theme==='greek'?'s':''}`} onClick={()=>set('theme','greek')}>⚡ Greek Myths</div></div>
          </>}
          {err && <div className="msg bad">{err}</div>}
          {ok && <div className="msg good">{ok}</div>}
          <button className="btn-go" disabled={busy} onClick={go}>{busy ? '...' : mode==='login' ? 'Log In' : 'Create Account'}</button>
          <button className="btn-switch" onClick={()=>{setMode(mode==='login'?'register':'login');setErr('');setOk('');}}>
            {mode==='login' ? "New? Create account" : "Have account? Log in"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ===================== MAIN =====================
function Main({ user, setUser }) {
  const [view, setView] = useState('home');
  const [universe, setUniverse] = useState(null); // selected universe object
  const [world, setWorld] = useState(null);
  const [lesson, setLesson] = useState(null);
  const [portal, setPortal] = useState(null);
  const [celebrate, setCelebrate] = useState(null);
  const [xpPop, setXpPop] = useState(null);
  const [confetti, setConfetti] = useState(false);
  const [inventory, setInventory] = useState({ purchases: [], activeBackground: '' });
  const t = T[user.theme] || T.crocodile;

  const loadInventory = useCallback(async () => {
    const inv = await api('/shop/inventory');
    if (inv && !inv.error) setInventory(inv);
  }, []);
  useEffect(() => { loadInventory(); }, [loadInventory]);

  const cosmetics = new Set((inventory.purchases || []).filter(p => p.kind === 'cosmetic').map(p => p.code));
  const hasBonusGame = (inventory.purchases || []).some(p => p.kind === 'bonus_game');

  // Pick the most vibrant hex color from a CSS gradient string for use as accent
  function pickAccentFromCss(css) {
    if (!css) return null;
    const hexes = css.match(/#[0-9a-fA-F]{6}/g) || [];
    if (hexes.length === 0) return null;
    // Score each color by saturation + brightness, pick the highest
    function score(hex) {
      const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
      const max = Math.max(r,g,b), min = Math.min(r,g,b);
      const sat = max === 0 ? 0 : (max - min) / max;
      const lum = (max + min) / 2 / 255;
      // Prefer high saturation and mid-bright lumination
      return sat * 0.7 + (1 - Math.abs(lum - 0.55)) * 0.3;
    }
    return hexes.slice().sort((a,b) => score(b) - score(a))[0];
  }
  function hexToRgba(hex, a) {
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  // Generic neutral fallback when a custom background has no emojis (e.g. old purchases)
  const DEFAULT_BG_DECO = ['✨','🌈','⭐','💫','🌟','🪄','💎','🎀','🎉','🎨'];

  // If the user has an active custom background, override the theme's bg + pathBg + decorations + accent colors
  const effectiveT = (() => {
    if (!user.active_background) return { ...t, animation: user.theme === 'crocodile' ? 'sway' : 'twinkle' };
    const customAccent = pickAccentFromCss(user.active_background) || t.accent;
    const customGlow = customAccent.startsWith('#') ? hexToRgba(customAccent, 0.35) : t.glow;
    const parsedEmojis = (user.active_background_emojis || '').split(/\s+/).filter(Boolean);
    return {
      ...t,
      bg: user.active_background,
      bg2: user.active_background,
      pathBg: user.active_background,
      accent: customAccent,
      accent2: customAccent,
      glow: customGlow,
      pathColor: customAccent,
      animation: user.active_background_animation || 'drift',
      // Critical: when on a custom background, NEVER fall back to the original theme's deco
      deco: parsedEmojis.length > 0 ? parsedEmojis : DEFAULT_BG_DECO,
    };
  })();

  function enterWorld(w) { setPortal(w); }
  function portalDone() { setWorld(portal); setPortal(null); }

  // Called when returning from a lesson — checks if a world was just completed
  async function onLessonExit() {
    setLesson(null);
    const u = await api('/me'); if (u?.id) setUser(u);
    if (!world) return;
    const cats = await api('/categories');
    if (!Array.isArray(cats)) return;
    const finished = cats.find(c => c.id === world.id);
    if (finished && finished.isComplete) {
      const nextWorld = cats.find(c => c.sort_order === finished.sort_order + 1);
      setCelebrate({ finishedWorld: finished, nextWorld });
      boom();
    }
  }

  function continueToNextWorld() {
    const next = celebrate?.nextWorld;
    setCelebrate(null);
    setWorld(null);
    if (next && next.isUnlocked) {
      setPortal(next);
    }
  }

  const refresh = useCallback(async () => { const u = await api('/me'); if (u?.id) setUser(u); }, [setUser]);

  function showXp(n) { setXpPop(n); setTimeout(()=>setXpPop(null), 1500); }
  function boom() { setConfetti(true); setTimeout(()=>setConfetti(false), 2000); }
  const [tokenPop, setTokenPop] = useState(null);
  function showTokens(n) { setTokenPop(n); setTimeout(()=>setTokenPop(null), 1500); }

  return (
    <div className="app" style={{'--bg':effectiveT.bg,'--bg2':effectiveT.bg2,'--card':t.card,'--cardH':t.cardH,'--accent':effectiveT.accent,'--accent2':effectiveT.accent2,'--text':t.text,'--dim':t.dim,'--glow':effectiveT.glow, backgroundAttachment:'fixed'}}>
      <LiveBackground emojis={effectiveT.deco} animation={effectiveT.animation}/>
      {confetti && <Confetti/>}
      {xpPop && <div className="xp-pop">+{xpPop} XP!</div>}
      {tokenPop && <div className="token-pop">+{tokenPop} 🪙</div>}
      {portal && <Portal t={effectiveT} world={portal} onDone={portalDone}/>}
      {celebrate && <WorldCompleteOverlay t={effectiveT} celebrate={celebrate} onNext={continueToNextWorld}/>}
      {cosmetics.has('sparkles') && <SparkleCursor/>}
      <header>
        <h1 className={'logo' + (cosmetics.has('rainbow') ? ' rainbow-logo' : '')}>{t.header}</h1>
        <div className="hdr-r">
          <div className="token-badge"><span className="tb-icon">🪙</span><span className="tb-num">{user.tokens||0}</span></div>
          <div className="xp-mini"><span>Lvl {user.level||1}</span><div className="xp-t"><div className="xp-f" style={{width:`${(user.xp||0)%100}%`}}/></div><span>{user.xp||0} XP</span></div>
          <span className="hi">{cosmetics.has('crown') && <span className="crown-badge">👑</span>}Hi, {user.display_name||user.displayName}!</span>
          <button className="hb" onClick={()=>setView('theme')} title="Pick a theme">🎨</button>
          <button className="hb" onClick={async()=>{await api('/logout','POST');setUser(null);}}>👋</button>
        </div>
      </header>
      <nav>
        <button className={view==='home'?'on':''} onClick={()=>{setView('home');setUniverse(null);setWorld(null);setLesson(null);}}>🌌 Universes</button>
        <button className={view==='shop'?'on':''} onClick={()=>setView('shop')}>🛒 Shop</button>
        <button className={view==='progress'?'on':''} onClick={()=>setView('progress')}>📊 Progress</button>
        <button className={view==='feature'?'on':''} onClick={()=>setView('feature')}>💡 Ideas</button>
      </nav>
      <main>
        {view==='theme' && <ThemePicker t={effectiveT} user={user} refreshUser={refresh} reloadInventory={loadInventory} back={()=>setView('home')}/>}
        {view==='progress' && <Progress t={effectiveT}/>}
        {view==='feature' && <FeatureRequest t={effectiveT}/>}
        {view==='shop' && <Shop t={effectiveT} user={user} refreshUser={refresh} reloadInventory={loadInventory} hasBonusGame={hasBonusGame}/>}
        {view==='studio' && <GameStudio t={effectiveT} back={()=>setView('home')}/>}
        {view==='home' && !universe && <UniverseMap t={effectiveT} pick={setUniverse}/>}
        {view==='home' && universe && !world && <WorldMap t={effectiveT} universe={universe} pick={enterWorld} openStudio={()=>setView('studio')} back={()=>setUniverse(null)}/>}
        {view==='home' && universe && world && !lesson && <Lessons catId={world.id} t={effectiveT} pick={setLesson} back={()=>setWorld(null)}/>}
        {view==='home' && lesson && <LessonView lesson={lesson} t={effectiveT} back={onLessonExit} showXp={showXp} showTokens={showTokens} boom={boom} refreshUser={refresh}/>}
      </main>
    </div>
  );
}

function Confetti() {
  return <div className="confetti-wrap">{Array.from({length:40}).map((_,i)=><div key={i} className="confetti-bit" style={{left:`${Math.random()*100}%`,animationDelay:`${Math.random()*0.5}s`,backgroundColor:`hsl(${Math.random()*360},80%,60%)`}}/>)}</div>;
}

// ===================== LIVE BACKGROUND LAYER =====================
// Renders 25 drifting decoration emojis across the whole app, animated by style
function LiveBackground({ emojis, animation }) {
  if (!emojis || emojis.length === 0) return null;
  const COUNT = 25;
  const items = Array.from({ length: COUNT }).map((_, i) => ({
    id: i,
    emoji: emojis[i % emojis.length],
    left: (i * 37 + 7) % 100,
    top: (i * 53 + 13) % 100,
    delay: (i * 0.3) % 6,
    duration: 8 + ((i * 7) % 12),
    size: 1.4 + ((i * 11) % 5) * 0.4,
  }));
  return (
    <div className={`live-bg anim-${animation || 'drift'}`}>
      {items.map(item => (
        <span
          key={item.id}
          className="live-deco"
          style={{
            left: item.left + '%',
            top: item.top + '%',
            animationDelay: item.delay + 's',
            animationDuration: item.duration + 's',
            fontSize: item.size + 'rem',
          }}
        >{item.emoji}</span>
      ))}
      {/* Soft glow overlays for depth */}
      <div className="bg-glow bg-glow-1"/>
      <div className="bg-glow bg-glow-2"/>
      <div className="bg-glow bg-glow-3"/>
    </div>
  );
}

// ===================== UNIVERSE MAP (HOME) =====================
function UniverseMap({ t, pick }) {
  const [unis, setUnis] = useState([]);
  useEffect(() => { api('/universes').then(u => Array.isArray(u) && setUnis(u)); }, []);

  return (
    <div className="content">
      <h2 className="universe-title">🌌 Choose Your Universe</h2>
      <p className="universe-sub">Each universe is a big adventure. Finish one to unlock the next!</p>
      <div className="universe-list">
        {unis.map((u, i) => {
          const pct = u.totalLessons ? Math.round((u.completedLessons / u.totalLessons) * 100) : 0;
          const canEnter = u.isUnlocked;
          return (
            <div
              key={u.id}
              className={'universe-card' + (canEnter ? ' open' : ' locked') + (u.isComplete ? ' done' : '')}
              onClick={() => canEnter && pick(u)}
            >
              <div className="universe-num">Universe {i + 1}</div>
              <div className="universe-icon">{canEnter ? u.icon : '🔒'}</div>
              <h3>{u.name}</h3>
              <p className="universe-desc">{u.description}</p>
              <div className="universe-progress">
                <div className="up-bar"><div className="up-fill" style={{width: pct + '%'}}/></div>
                <span>{u.completedLessons}/{u.totalLessons} lessons</span>
              </div>
              {u.totalLessons > 0 && (
                <div className="universe-extra">🎮 Game Studio: {u.gameStudioDone ? '✅ Done' : '⏳ Not yet'}</div>
              )}
              <div className="universe-status">
                {u.isComplete ? '🏆 Complete!' : canEnter ? '▶️ Enter' : '🔒 Locked'}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ===================== ADVENTURE MAP (inside a universe) =====================
function WorldMap({ t, universe, pick, openStudio, back }) {
  const [cats, setCats] = useState([]);
  const [gsStatus, setGsStatus] = useState(null);
  useEffect(() => {
    api('/universes/' + universe.id + '/categories').then(c => Array.isArray(c) && setCats(c));
    api('/universes').then(u => {
      if (Array.isArray(u)) {
        const cur = u.find(x => x.id === universe.id);
        if (cur) setGsStatus(cur);
      }
    });
  }, [universe.id]);

  const allDone = cats.length > 0 && cats.every(c => c.isComplete);
  const totalStops = cats.length + 1; // worlds + game studio stop

  return (
    <div className="content journey">
      <button className="back" onClick={back}>← All Universes</button>
      <h2 className="journey-title">{universe.icon} {universe.name}</h2>
      <p className="journey-sub">Complete all worlds + the Game Studio to unlock the next universe!</p>
      <div className="journey-path big-path" style={{background:t.pathBg}}>
        {Array.from({length:18}).map((_,i)=><span key={'d'+i} className="float-deco" style={{left:`${(i*7)%95}%`,top:`${(i*11)%100}%`,animationDelay:`${i*0.4}s`,fontSize:`${1.4+(i%3)*0.5}rem`}}>{t.deco[i%t.deco.length]}</span>)}
        <svg className="path-svg" preserveAspectRatio="none" viewBox="0 0 100 100">
          <path d={Array.from({length:totalStops}).map((_,i)=>{const x=i%2===0?25:75;const y=(i+0.5)/(totalStops||1)*100;return (i===0?'M':'L')+' '+x+' '+y;}).join(' ')} stroke={t.pathColor} strokeWidth="2.5" strokeDasharray="3 3" fill="none" strokeLinecap="round"/>
        </svg>
        <div className="path-stops">
          {cats.map((c,i)=>{
            const isCurrent = c.isUnlocked && !c.isComplete;
            const side = i%2===0 ? 'left' : 'right';
            return (
              <div key={c.id} className={`stop world-stop stop-${side} ${c.isComplete?'done':''} ${c.isUnlocked?'open':'locked'} ${isCurrent?'current':''}`} onClick={()=>c.isUnlocked && pick(c)}>
                <div className="stop-marker world-marker">
                  {c.isComplete ? '🏆' : !c.isUnlocked ? '🔒' : c.icon}
                </div>
                <div className="stop-card world-card">
                  <div className="stop-num">World {i+1}</div>
                  <h3>{c.name}</h3>
                  <p className="world-desc">{c.description}</p>
                  <div className="world-progress">
                    <div className="wp-bar"><div className="wp-fill" style={{width:`${c.totalLessons?c.completedLessons/c.totalLessons*100:0}%`}}/></div>
                    <span>{c.completedLessons}/{c.totalLessons}</span>
                  </div>
                  <span className="stop-badge">{c.isComplete?'🏆 Complete!':isCurrent?'⭐ Adventure here!':c.isUnlocked?'Ready':'🔒 Locked'}</span>
                </div>
              </div>
            );
          })}
          {cats.length > 0 && (
            <div className={`stop world-stop stop-${cats.length%2===0?'left':'right'} studio-stop ${allDone?'open current':'locked'}`} onClick={()=>allDone && openStudio()}>
              <div className="stop-marker world-marker studio-marker">
                {allDone ? (gsStatus?.gameStudioDone ? '🏆' : '🎮') : '🔒'}
              </div>
              <div className="stop-card world-card">
                <div className="stop-num">Final Stop</div>
                <h3>🎮 Game Studio</h3>
                <p className="world-desc">Build your own game with AI!</p>
                <span className="stop-badge">
                  {allDone ? (gsStatus?.gameStudioDone ? '🏆 Complete!' : '✨ Unlocked!') : '🔒 Finish all worlds first'}
                </span>
              </div>
            </div>
          )}
        </div>
        {allDone && gsStatus?.gameStudioDone && <div className="path-flag">🎉 Universe Complete! Head back to unlock the next one!</div>}
      </div>
    </div>
  );
}

// ===================== WORLD COMPLETE CELEBRATION =====================
function WorldCompleteOverlay({ t, celebrate, onNext }) {
  const { finishedWorld, nextWorld } = celebrate;
  return (
    <div className="celebrate-overlay">
      {Array.from({length:60}).map((_,i)=><div key={i} className="confetti-bit" style={{left:`${Math.random()*100}%`,animationDelay:`${Math.random()*0.8}s`,backgroundColor:`hsl(${Math.random()*360},80%,60%)`}}/>)}
      <div className="celebrate-card">
        <div className="celebrate-trophy">🏆</div>
        <h1 className="celebrate-title">Great Job!</h1>
        <p className="celebrate-sub">You finished <strong>{finishedWorld.name}</strong>!</p>
        <div className="celebrate-stars">⭐⭐⭐⭐⭐</div>
        {nextWorld ? (
          <>
            <p className="celebrate-next">Up next: <strong>{nextWorld.icon} {nextWorld.name}</strong></p>
            <button className="btn-go big-btn" onClick={onNext}>Travel to next world →</button>
          </>
        ) : (
          <>
            <p className="celebrate-next">🎉 You finished every world! You're a true {t.emoji} master!</p>
            <button className="btn-go big-btn" onClick={onNext}>Back to Map</button>
          </>
        )}
      </div>
    </div>
  );
}

// ===================== GAME STUDIO =====================
function GameStudio({ t, back }) {
  const [status, setStatus] = useState(null);
  const [session, setSession] = useState(null);
  const [iterations, setIterations] = useState([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [title, setTitle] = useState('');

  useEffect(() => { api('/game-studio/status').then(setStatus); }, []);

  const MAX_REFINEMENTS = 3;
  const remaining = MAX_REFINEMENTS - iterations.length;
  const latest = iterations.length > 0 ? iterations[iterations.length - 1] : null;
  const currentHtml = latest ? latest.html_response : null;
  const currentInstructions = latest ? latest.instructions : '';

  async function startNew() {
    setErr('');
    if (!title.trim()) return setErr('Give your game a name!');
    const s = await api('/game-studio/start', 'POST', { title });
    if (s.error) return setErr(s.error);
    setSession(s);
    setIterations([]);
  }

  async function loadSession(id) {
    const s = await api('/game-studio/session/' + id);
    if (s.error) return setErr(s.error);
    setSession(s);
    setIterations(s.iterations || []);
  }

  async function send() {
    if (!prompt.trim() || busy) return;
    setErr(''); setBusy(true);
    const r = await api('/game-studio/iterate', 'POST', { sessionId: session.id, prompt });
    setBusy(false);
    if (r.error) return setErr(r.error);
    setIterations(its => [...its, r.iteration]);
    setPrompt('');
  }

  if (!status) return <div className="content"><div className="ld">Loading...</div></div>;
  if (!status.unlocked) {
    return (
      <div className="content">
        <button className="back" onClick={back}>← Back</button>
        <div className="locked-studio">
          <div className="big-lock">🔒</div>
          <h2>Game Studio is locked!</h2>
          <p>Finish all the worlds first to unlock the Game Studio. Once you do, you can build your own games using AI!</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="content">
        <button className="back" onClick={back}>← Back</button>
        <div className="studio-intro">
          <h2>🎮 Game Studio</h2>
          <p className="studio-sub">You unlocked the Game Studio! Describe a game in plain English and Claude will build it for you. You can refine it up to <strong>3 times</strong>.</p>
          <div className="studio-new">
            <h3>Create a new game</h3>
            <input placeholder="Game name (e.g., Snake Adventure)" value={title} onChange={e=>setTitle(e.target.value)}/>
            {err && <div className="msg bad">{err}</div>}
            <button className="btn-go" onClick={startNew}>Start Building 🚀</button>
          </div>
          {status.sessions.length > 0 && (
            <div className="studio-saved">
              <h3>Your Games</h3>
              {status.sessions.map(s => (
                <div key={s.id} className="saved-game" onClick={() => loadSession(s.id)}>
                  <span className="sg-title">🎮 {s.title}</span>
                  <span className="sg-meta">{s.iteration_count}/3 refinements</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="content">
      <button className="back" onClick={() => setSession(null)}>← My games</button>
      <div className="studio-active">
        <div className="studio-header">
          <h2>🎮 {session.title}</h2>
          <span className="studio-counter">{remaining}/3 refinements left</span>
        </div>

        {currentInstructions && (
          <div className="game-instructions">
            <div className="gi-icon">📖</div>
            <div className="gi-body">
              <div className="gi-label">How to play</div>
              <div className="gi-text">{currentInstructions}</div>
            </div>
          </div>
        )}

        <div className="game-frame-wrap">
          {currentHtml ? (
            <iframe
              className="game-frame"
              sandbox="allow-scripts"
              srcDoc={currentHtml}
              title={session.title}
            />
          ) : (
            <div className="game-empty">
              <div className="empty-icon">🎨</div>
              <p>Describe your game below to start building!</p>
              <p className="empty-examples">
                Try: "A snake game where the snake is a crocodile and the food is fish"<br/>
                Or: "A clicker game where I tap clouds to collect lightning bolts"
              </p>
            </div>
          )}
        </div>

        {iterations.length > 0 && (
          <div className="studio-history">
            <h4>Your refinements:</h4>
            {iterations.map((it, i) => (
              <div key={it.id} className="hist-item">
                <span className="hist-num">{i+1}</span>
                <span className="hist-prompt">{it.prompt}</span>
              </div>
            ))}
          </div>
        )}

        {remaining > 0 ? (
          <div className="studio-input">
            <textarea
              placeholder={iterations.length === 0 ? "Describe your game..." : "How should we change it?"}
              value={prompt}
              onChange={e=>setPrompt(e.target.value)}
              maxLength={500}
              disabled={busy}
              rows={3}
            />
            <div className="studio-actions">
              <span className="char-count">{prompt.length}/500</span>
              <button className="btn-go" onClick={send} disabled={busy || !prompt.trim()}>
                {busy ? '🤖 Building...' : iterations.length === 0 ? '✨ Build it!' : '🔄 Refine'}
              </button>
            </div>
            {err && <div className="msg bad">{err}</div>}
          </div>
        ) : (
          <div className="studio-done">
            <p>🎉 You've used all 3 refinements! Your game is complete.</p>
            <button className="btn-go" onClick={() => setSession(null)}>Make another game →</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ===================== PORTAL TRANSITION =====================
function Portal({ t, world, onDone }) {
  useEffect(() => { const timer = setTimeout(onDone, 1800); return () => clearTimeout(timer); }, [onDone]);
  return (
    <div className="portal-overlay" style={{background:t.bg}}>
      <div className="portal-rings">
        <div className="ring r1" style={{borderColor:t.accent}}/>
        <div className="ring r2" style={{borderColor:t.accent}}/>
        <div className="ring r3" style={{borderColor:t.accent}}/>
      </div>
      {Array.from({length:30}).map((_,i)=><span key={i} className="portal-deco" style={{left:`${Math.random()*100}%`,top:`${Math.random()*100}%`,animationDelay:`${Math.random()*0.5}s`,fontSize:`${1+Math.random()*2}rem`}}>{t.deco[i%t.deco.length]}</span>)}
      <div className="portal-content">
        <div className="portal-icon">{world.icon}</div>
        <h1 className="portal-title">{world.name}</h1>
        <p className="portal-sub">Entering the world...</p>
      </div>
    </div>
  );
}

// ===================== LESSONS =====================
function Lessons({ catId, t, pick, back }) {
  const [ls, setLs] = useState([]);
  useEffect(() => { api('/categories/'+catId+'/lessons').then(l => Array.isArray(l) && setLs(l)); }, [catId]);

  // Find current position: first incomplete lesson
  const currentIdx = ls.findIndex(l => !l.completed);
  const currentLesson = currentIdx === -1 ? ls.length - 1 : currentIdx;

  function isUnlocked(i) {
    if (i === 0) return true;
    return ls[i-1] && ls[i-1].completed;
  }

  return (
    <div className="content journey">
      <button className="back" onClick={back}>← Pick another world</button>
      <h2 className="journey-title">{t.journeyTitle}</h2>
      <div className="journey-path" style={{background:t.pathBg}}>
        {/* Floating background decorations */}
        {Array.from({length:14}).map((_,i)=><span key={'d'+i} className="float-deco" style={{left:`${(i*7)%95}%`,top:`${(i*11)%100}%`,animationDelay:`${i*0.4}s`,fontSize:`${1.2+(i%3)*0.4}rem`}}>{t.deco[i%t.deco.length]}</span>)}
        {/* Winding path SVG */}
        <svg className="path-svg" preserveAspectRatio="none" viewBox="0 0 100 100">
          <path d={ls.map((_,i)=>{const x=i%2===0?25:75;const y=(i+0.5)/(ls.length||1)*100;return (i===0?'M':'L')+' '+x+' '+y;}).join(' ')} stroke={t.pathColor} strokeWidth="2" strokeDasharray="2 2" fill="none" strokeLinecap="round"/>
        </svg>
        {/* Lesson stops */}
        <div className="path-stops">
          {ls.map((l,i)=>{
            const unlocked = isUnlocked(i);
            const isCurrent = i === currentLesson && !l.completed;
            const side = i%2===0 ? 'left' : 'right';
            return (
              <div key={l.id} className={`stop stop-${side} ${l.completed?'done':''} ${unlocked?'open':'locked'} ${isCurrent?'current':''}`} onClick={()=>unlocked && pick(l)}>
                <div className="stop-marker">
                  {l.completed ? '✅' : isCurrent ? t.traveler : unlocked ? '⭕' : '🔒'}
                </div>
                <div className="stop-card">
                  <div className="stop-num">Lesson {i+1}</div>
                  <h3>{l.title}</h3>
                  <span className="stop-badge">{l.completed?'Conquered!':isCurrent?'You are here!':unlocked?'Ready':'Locked'}</span>
                </div>
              </div>
            );
          })}
        </div>
        {/* End flag */}
        {ls.length > 0 && <div className="path-flag">{ls.every(l=>l.completed) ? '🏆 World Complete!' : '🏁 Finish'}</div>}
      </div>
    </div>
  );
}

// ===================== LESSON VIEW =====================
function LessonView({ lesson, t, back, showXp, showTokens, boom, refreshUser }) {
  const [acts, setActs] = useState([]);
  const [quizzes, setQuizzes] = useState([]);
  const [step, setStep] = useState(0);
  const [fb, setFb] = useState({});
  const [done, setDone] = useState(false);
  const [allQAnswered, setAllQAnswered] = useState(false);

  useEffect(() => {
    Promise.all([api('/lessons/'+lesson.id+'/activities'), api('/lessons/'+lesson.id+'/quizzes')]).then(([a,q])=>{
      if (Array.isArray(a)) setActs(a);
      if (Array.isArray(q)) setQuizzes(q);
    });
  }, [lesson.id]);

  const total = 1 + acts.length + (quizzes.length > 0 ? 1 : 0);

  async function answerQ(qid, cid) {
    const r = await api('/quizzes/'+qid+'/answer','POST',{choiceId:cid});
    setFb(f=>({...f,[qid]:r.correct?t.correct:t.wrong+' Try again!'}));
    if (r.correct) {
      showXp(15);
      if (r.tokensEarned > 0) showTokens(r.tokensEarned);
      refreshUser();
    }
    if (r.lessonCompleted) { setDone(true); boom(); }
    const q = await api('/lessons/'+lesson.id+'/quizzes');
    if (Array.isArray(q)) {
      setQuizzes(q);
      setAllQAnswered(q.every(qq => qq.userAnswer && qq.userAnswer.is_correct));
    }
  }

  return (
    <div className="content lv">
      <button className="back" onClick={back}>← Back to trail</button>
      <div className="stepper"><div className="sbar"><div className="sfill" style={{width:`${Math.round(step/(total-1)*100)}%`}}/></div><span>{step+1}/{total}</span></div>

      {step===0 && <div className="intro"><h2>{t.emoji} {lesson.title}</h2><div className="intro-box">{lesson.content.split('\n').map((l,i)=><p key={i}>{l||'\u00A0'}</p>)}</div><button className="btn-go" onClick={()=>setStep(1)}>Let's Go! 🚀</button></div>}

      {step>0 && step<=acts.length && <Activity a={acts[step-1]} t={t} showXp={showXp} boom={boom} next={()=>{
        // If this is the last activity and there's no quiz, go straight back to the trail
        if (step === acts.length && quizzes.length === 0) { back(); return; }
        setStep(step+1);
      }}/>}

      {step>acts.length && quizzes.length>0 && <div className="quiz-sec">
        <h2>{t.emoji} Final Quiz!</h2>
        <p className="quiz-hint">Get every answer right to finish this lesson!</p>
        {quizzes.map(q=><div key={q.id} className="qcard"><p className="qtxt">{q.question}</p><div className="qchoices">{q.choices.map(c=>{
          const a=q.userAnswer, sel=a&&a.selected_choice_id===c.id;
          return <button key={c.id} className={'qbtn'+(sel?(a.is_correct?' right':' nope'):'')} onClick={()=>answerQ(q.id,c.id)}>{c.choice_text}</button>;
        })}</div>{fb[q.id]&&<p className={'qfb'+(q.userAnswer&&q.userAnswer.is_correct?' qfb-good':' qfb-bad')}>{fb[q.id]}</p>}</div>)}
        {done && <div className="complete-banner">
          {t.done}
          <button className="btn-go big-btn" onClick={back}>Continue Your Adventure →</button>
        </div>}
      </div>}

      {step > 0 && (
        <div className="snav">
          <button className="nbtn" onClick={()=>setStep(step-1)}>← Previous</button>
        </div>
      )}
    </div>
  );
}

// ===================== ACTIVITY ROUTER =====================
function Activity({ a, t, showXp, boom, next }) {
  switch(a.activity_type) {
    case 'video': return <Video a={a} next={next}/>;
    case 'match': return <MatchGame a={a} t={t} showXp={showXp} boom={boom} next={next}/>;
    case 'sort': case 'codebuilder': return <SortGame a={a} t={t} showXp={showXp} boom={boom} next={next}/>;
    case 'truefalse': return <TFGame a={a} t={t} showXp={showXp} boom={boom} next={next}/>;
    case 'fillinblank': return <BlankGame a={a} t={t} showXp={showXp} boom={boom} next={next}/>;
    case 'codechallenge': return <CodeChallenge a={a} t={t} showXp={showXp} boom={boom} next={next}/>;
    case 'minigame': return <MiniGame a={a} t={t} showXp={showXp} boom={boom} next={next}/>;
    case 'promptpractice': return <PromptPracticeGame a={a} t={t} showXp={showXp} boom={boom} next={next}/>;
    default: return <div>Unknown</div>;
  }
}

// ===================== VIDEO =====================
function Video({ a, next }) {
  return <div className="acard"><h3>🎬 {a.title}</h3><p className="adesc">{a.description}</p><div className="vid-wrap"><iframe src={a.video_url} title={a.title} allowFullScreen/></div><button className="btn-go" onClick={next}>Done Watching →</button></div>;
}

// ===================== MATCH GAME =====================
function DraggableTerm({ pair, matched, wrong }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: 'term-' + pair.id,
    data: { pairId: pair.id },
    disabled: matched,
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: isDragging ? 100 : 1 }
    : {};
  let cls = 'mi term';
  if (matched) cls += ' got';
  if (isDragging) cls += ' dragging';
  if (wrong) cls += ' bad';
  return (
    <div ref={setNodeRef} style={style} className={cls} {...listeners} {...attributes}>
      {pair.term}
    </div>
  );
}

function DroppableDef({ pair, matched, wrong, isOver }) {
  const { isOver: hover, setNodeRef } = useDroppable({
    id: 'def-' + pair.id,
    data: { pairId: pair.id },
    disabled: matched,
  });
  let cls = 'mi def droppable';
  if (matched) cls += ' got';
  if (hover) cls += ' hover';
  if (wrong) cls += ' bad';
  return (
    <div ref={setNodeRef} className={cls}>
      {pair.definition}
    </div>
  );
}

function MatchGame({ a, t, showXp, boom, next }) {
  const [matched, setMatched] = useState(new Set());
  const [wrongTerm, setWrongTerm] = useState(null);
  const [wrongDef, setWrongDef] = useState(null);
  const [shuffled, setShuffled] = useState([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setShuffled([...a.pairs].sort(() => Math.random() - 0.5));
    setMatched(new Set());
    setDone(false);
  }, [a.id]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 100, tolerance: 8 } }),
  );

  function handleDragEnd(event) {
    const { active, over } = event;
    if (!over) return;
    const termId = active.data.current?.pairId;
    const defId = over.data.current?.pairId;
    if (termId == null || defId == null) return;

    if (termId === defId) {
      const nm = new Set(matched);
      nm.add(termId);
      setMatched(nm);
      if (nm.size === a.pairs.length) {
        setDone(true);
        api('/activities/' + a.id + '/score', 'POST', { score: a.pairs.length, maxScore: a.pairs.length });
        showXp(a.pairs.length * 10);
        boom();
      }
    } else {
      // Wrong drop — flash both red briefly, then snap back
      setWrongTerm(termId);
      setWrongDef(defId);
      setTimeout(() => { setWrongTerm(null); setWrongDef(null); }, 700);
    }
  }

  return (
    <div className="acard">
      <div className="acard-head"><h3>🔗 {a.title}</h3></div>
      <p className="adesc">{a.description} <span className="drag-hint">↔️ Drag each word to its match!</span></p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <div className="match-board">
          <div className="match-col">
            <div className="match-label">Words</div>
            {a.pairs.map(p => (
              <DraggableTerm key={'t'+p.id} pair={p} matched={matched.has(p.id)} wrong={wrongTerm === p.id}/>
            ))}
          </div>
          <div className="match-col">
            <div className="match-label">Drop here</div>
            {shuffled.map(p => (
              <DroppableDef key={'d'+p.id} pair={p} matched={matched.has(p.id)} wrong={wrongDef === p.id}/>
            ))}
          </div>
        </div>
      </DndContext>
      {done && <div className="gdone">{t.correct} <button className="btn-go" onClick={next}>Next →</button></div>}
    </div>
  );
}

// ===================== SORT GAME =====================
function SortableRow({ item, index, isCode, checked }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled: checked });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : 1,
  };
  const cls = ['si','draggable-item'];
  if (checked) cls.push(item.correct_position === index + 1 ? 'sr' : 'sw');
  if (isDragging) cls.push('dragging');
  return (
    <div ref={setNodeRef} style={style} className={cls.join(' ')} {...attributes} {...listeners}>
      <span className="grip">⋮⋮</span>
      <span className="snum">{index + 1}</span>
      <span className={isCode ? 'codetxt' : ''}>{item.content}</span>
    </div>
  );
}

function SortGame({ a, t, showXp, boom, next }) {
  const [items, setItems] = useState([]);
  const [checked, setChecked] = useState(false);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    setItems([...a.items].sort(() => Math.random() - 0.5));
    setChecked(false); setOk(false);
  }, [a.id]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setItems((cur) => {
      const oldIdx = cur.findIndex(i => i.id === active.id);
      const newIdx = cur.findIndex(i => i.id === over.id);
      return arrayMove(cur, oldIdx, newIdx);
    });
  }

  function check() {
    const c = items.every((it, i) => it.correct_position === i + 1);
    setChecked(true); setOk(c);
    if (c) {
      api('/activities/' + a.id + '/score', 'POST', { score: items.length, maxScore: items.length });
      showXp(items.length * 10);
      boom();
    }
  }

  function retry() {
    setItems([...a.items].sort(() => Math.random() - 0.5));
    setChecked(false); setOk(false);
  }

  const isCode = a.activity_type === 'codebuilder';

  return (
    <div className="acard">
      <h3>{isCode ? '🧱' : '📋'} {a.title}</h3>
      <p className="adesc">{a.description} <span className="drag-hint">↕️ Drag to reorder!</span></p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items.map(i => i.id)} strategy={verticalListSortingStrategy}>
          <div className={`sort-list${isCode ? ' code' : ''}`}>
            {items.map((it, i) => (
              <SortableRow key={it.id} item={it} index={i} isCode={isCode} checked={checked} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {!checked && <button className="btn-check" onClick={check}>Check! ✓</button>}
      {checked && !ok && <div className="gretry">{t.wrong}<button className="btn-check" onClick={retry}>Try Again 🔄</button></div>}
      {checked && ok && <div className="gdone">{t.correct}<button className="btn-go" onClick={next}>Next →</button></div>}
    </div>
  );
}

// ===================== TRUE/FALSE =====================
function TFGame({ a, t, showXp, boom, next }) {
  const [cur, setCur] = useState(0);
  const [answers, setAnswers] = useState([]);
  const [showRes, setShowRes] = useState(false);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [answered, setAnswered] = useState(false);
  const total = a.items.length;
  const item = a.items[cur];

  useEffect(() => {
    setAnswered(false);
  }, [cur]);

  function doAnswer(choice) {
    if (answered) return;
    setAnswered(true);
    const currentItem = a.items[cur];
    const isRight = (choice === 'true') === !!currentItem.is_true;
    const newAnswers = [...answers, { correct: isRight, explanation: currentItem.explanation }];
    setAnswers(newAnswers);
    setStreak(isRight ? streak + 1 : 0);
    if (isRight) setScore(s => s + 1);

    setTimeout(() => {
      if (cur < total - 1) {
        setCur(cur + 1);
      } else {
        setShowRes(true);
        const finalScore = score + (isRight ? 1 : 0);
        api('/activities/' + a.id + '/score', 'POST', { score: finalScore, maxScore: total });
        showXp(finalScore * 10);
        if (finalScore === total) boom();
      }
    }, 1200);
  }

  const last = answers[answers.length - 1];
  const justAns = answered && !showRes;

  return (
    <div className="acard">
      <div className="acard-head"><h3>⚡ {a.title}</h3></div>
      <p className="adesc">{a.description}</p>
      {!showRes && <div className="tf-game">
        <div className="tf-top"><span className="tf-prog">{cur+1}/{total}</span>{streak>=2 && <span className="tf-streak">🔥 {streak} streak!</span>}</div>
        <div className="tf-stmt">{item.statement}</div>
        {!justAns ? <div className="tf-btns"><button className="tfb true" onClick={()=>doAnswer('true')}>👍 TRUE</button><button className="tfb false" onClick={()=>doAnswer('false')}>👎 FALSE</button></div>
        : <div className={`tf-res ${last.correct?'tf-y':'tf-n'}`}><p>{last.correct?'✅ Correct!':'❌ Nope!'}</p><p className="tf-exp">{last.explanation}</p></div>}
      </div>}
      {showRes && <div className="tf-final"><h3>Score: {score}/{total}</h3><div className="stars">{'⭐'.repeat(Math.max(1,Math.round(score/total*5)))}</div><button className="btn-go" onClick={next}>Next →</button></div>}
    </div>
  );
}

// ===================== FILL IN BLANK =====================
function BlankGame({ a, t, showXp, boom, next }) {
  const [picks, setPicks] = useState(a.blanks.map(()=>null));
  const [res, setRes] = useState(a.blanks.map(()=>null));
  const [done, setDone] = useState(false);
  const [shuffled, setShuffled] = useState([]);

  useEffect(() => {
    setShuffled(a.blanks.map(b => [...(b.options || [])].sort(()=>Math.random()-0.5)));
    setPicks(a.blanks.map(()=>null));
    setRes(a.blanks.map(()=>null));
    setDone(false);
  }, [a.id]);

  function pickOption(blankIdx, opt) {
    if (done) return;
    const np = [...picks]; np[blankIdx] = opt; setPicks(np);
    const nr = [...res]; nr[blankIdx] = null; setRes(nr);
  }

  function check() {
    let s = 0;
    const r = a.blanks.map((b,i) => {
      const c = picks[i] && picks[i].toLowerCase() === b.correct_answer.toLowerCase();
      if (c) s++;
      return c;
    });
    setRes(r);
    if (r.every(Boolean)) {
      setDone(true);
      api('/activities/'+a.id+'/score','POST',{score:s,maxScore:a.blanks.length});
      showXp(s*10);
      boom();
    }
  }

  function retry() {
    setPicks(a.blanks.map(()=>null));
    setRes(a.blanks.map(()=>null));
  }

  const allPicked = picks.every(p => p !== null);
  const someWrong = res.some(r => r === false);

  return (
    <div className="acard">
      <h3>✏️ {a.title}</h3>
      <p className="adesc">{a.description}</p>
      <div className="blanks">
        {a.blanks.map((b,i) => (
          <div key={b.id} className="bitem">
            <p className="bsent">
              {b.sentence_before}
              <span className={`bslot${res[i]===true?' br':res[i]===false?' bw':''}${picks[i]?' filled':''}`}>{picks[i] || '???'}</span>
              {b.sentence_after}
            </p>
            <div className="boptions">
              {(shuffled[i] || []).map((opt, oi) => (
                <button
                  key={oi}
                  className={`bopt${picks[i]===opt?' selected':''}${res[i]===true && picks[i]===opt?' right':''}${res[i]===false && picks[i]===opt?' nope':''}`}
                  disabled={done}
                  onClick={() => pickOption(i, opt)}
                >{opt}</button>
              ))}
            </div>
            {res[i]===false && <p className="bhint">💡 {b.hint}</p>}
          </div>
        ))}
      </div>
      {!done && !someWrong && <button className="btn-check" onClick={check} disabled={!allPicked}>Check! ✓</button>}
      {!done && someWrong && <button className="btn-check" onClick={retry}>Try Again 🔄</button>}
      {done && <div className="gdone">{t.correct}<button className="btn-go" onClick={next}>Next →</button></div>}
    </div>
  );
}

// ===================== CODE CHALLENGE (PYTHON IDE) =====================
function CodeChallenge({ a, t, showXp, boom, next }) {
  const [curIdx, setCurIdx] = useState(0);
  const [codes, setCodes] = useState(a.challenges.map(c=>c.starter_code));
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [passed, setPassed] = useState(a.challenges.map(()=>false));
  const [showHint, setShowHint] = useState(false);
  const ch = a.challenges[curIdx];
  const allDone = passed.every(Boolean);

  async function runCode() {
    setRunning(true); setOutput(''); setError(''); setShowHint(false);
    const r = await api('/run-python','POST',{code:codes[curIdx]});
    setRunning(false);
    if (r.error) { setError(r.error); setOutput(r.output||''); return; }
    setOutput(r.output);
    // Check if output matches expected (if expected is set)
    if (ch.expected_output && r.output.trim() === ch.expected_output.trim()) {
      const np = [...passed]; np[curIdx] = true; setPassed(np);
      showXp(10);
      if (np.every(Boolean)) { api('/activities/'+a.id+'/score','POST',{score:a.challenges.length,maxScore:a.challenges.length}); boom(); }
    } else if (!ch.expected_output && r.output.trim().length > 0) {
      // For open-ended challenges (no expected output), any output = pass
      const np = [...passed]; np[curIdx] = true; setPassed(np);
      showXp(10);
      if (np.every(Boolean)) { api('/activities/'+a.id+'/score','POST',{score:a.challenges.length,maxScore:a.challenges.length}); boom(); }
    }
  }

  function updateCode(val) { const n=[...codes]; n[curIdx]=val; setCodes(n); }

  return (
    <div className="acard ide-card">
      <div className="acard-head">
        <h3>🐍 {a.title}</h3>
        <div className="challenge-nav">
          <span className="cnav-label">Challenge {curIdx+1} of {a.challenges.length}</span>
          <div className="challenge-dots">
            {a.challenges.map((_,i)=>(
              <span
                key={i}
                className={`cdot${passed[i]?' cdone':''}${i===curIdx?' cactive':''}`}
                title={`Jump to challenge ${i+1}`}
                onClick={()=>{setCurIdx(i);setOutput('');setError('');setShowHint(false);}}
              >{passed[i] ? '✓' : i+1}</span>
            ))}
          </div>
        </div>
      </div>

      <div className="ide-instructions">
        <p>{ch.instructions}</p>
        {!showHint && <button className="hint-btn" onClick={()=>setShowHint(true)}>💡 Show Hint</button>}
        {showHint && <p className="hint-text">💡 {ch.hint}</p>}
      </div>

      <div className="ide-editor">
        <div className="ide-header"><span className="ide-dot red"/><span className="ide-dot yellow"/><span className="ide-dot green"/><span className="ide-title">Python Editor</span></div>
        <textarea className="ide-code" value={codes[curIdx]} onChange={e=>updateCode(e.target.value)} spellCheck={false} rows={Math.max(4, codes[curIdx].split('\n').length+1)}/>
      </div>

      <div className="ide-controls">
        <button className={`run-btn${running?' running':''}`} onClick={runCode} disabled={running}>{running ? '⏳ Running...' : '▶️ Run Code!'}</button>
        <button className="reset-btn" onClick={()=>{updateCode(ch.starter_code);setOutput('');setError('');}}>🔄 Reset</button>
      </div>

      <div className="ide-output">
        <div className="out-header">Output:</div>
        <pre className="out-text">
          {output && <span className="out-ok">{output}</span>}
          {error && <span className="out-err">{error}</span>}
          {!output && !error && <span className="out-dim">Press Run to see what happens!</span>}
        </pre>
        {passed[curIdx] && <div className="out-pass">✅ Challenge {curIdx+1} complete!</div>}
        {output && !passed[curIdx] && ch.expected_output && <div className="out-try">Not quite! Expected: <code>{ch.expected_output.trim()}</code></div>}
      </div>

      {passed[curIdx] && curIdx < a.challenges.length - 1 && (
        <div className="next-challenge">
          <p>🎉 Nice! Ready for the next one?</p>
          <button className="btn-go big-btn" onClick={()=>{setCurIdx(curIdx+1);setOutput('');setError('');setShowHint(false);}}>
            Next Challenge →
          </button>
        </div>
      )}

      {allDone && <div className="gdone">{t.correct} All challenges done!<button className="btn-go" onClick={next}>Continue →</button></div>}
    </div>
  );
}

// ===================== PROMPT PRACTICE =====================
function PromptPracticeGame({ a, t, showXp, boom, next }) {
  const [idx, setIdx] = useState(0);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [err, setErr] = useState('');
  const [passed, setPassed] = useState(a.tasks.map(() => false));
  const task = a.tasks[idx];
  const allDone = passed.every(Boolean);

  async function submit() {
    if (!prompt.trim() || busy) return;
    setErr(''); setBusy(true); setFeedback(null);
    const r = await api('/prompt-practice/grade', 'POST', { task: task.task_description, userPrompt: prompt });
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    setFeedback(r);
    if (r.score >= 7) {
      const np = [...passed]; np[idx] = true; setPassed(np);
      showXp(r.score * 5);
      if (np.every(Boolean)) {
        api('/activities/' + a.id + '/score', 'POST', { score: a.tasks.length, maxScore: a.tasks.length });
        boom();
      }
    }
  }

  function goNext() {
    if (idx < a.tasks.length - 1) {
      setIdx(idx + 1);
      setPrompt('');
      setFeedback(null);
      setErr('');
    }
  }

  function tryAgain() {
    setFeedback(null);
    setErr('');
  }

  return (
    <div className="acard pp-card">
      <div className="acard-head">
        <h3>💬 {a.title}</h3>
        <div className="pp-dots">
          {a.tasks.map((_, i) => (
            <span key={i} className={'pp-dot' + (passed[i] ? ' done' : '') + (i === idx ? ' active' : '')}>{i+1}</span>
          ))}
        </div>
      </div>
      <p className="adesc">{a.description}</p>

      <div className="pp-task">
        <div className="pp-label">Your Task:</div>
        <div className="pp-task-text">{task.task_description}</div>
        {task.hint && <div className="pp-hint">💡 {task.hint}</div>}
      </div>

      <div className="pp-input">
        <textarea
          placeholder="Type your prompt here..."
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          disabled={busy || (feedback && feedback.score >= 7)}
          rows={4}
          maxLength={500}
        />
        <div className="pp-input-foot">
          <span className="char-count">{prompt.length}/500</span>
          {!feedback && <button className="btn-go" disabled={busy || !prompt.trim()} onClick={submit}>
            {busy ? '✨ Checking...' : 'Submit Prompt ✨'}
          </button>}
          {feedback && feedback.score < 7 && <button className="btn-go" onClick={tryAgain}>Try Again 🔄</button>}
        </div>
      </div>

      {err && <div className="msg bad">{err}</div>}

      {feedback && (
        <div className={'pp-feedback score-' + (feedback.score >= 9 ? 'great' : feedback.score >= 7 ? 'good' : 'tryagain')}>
          <div className="pp-score">
            <div className="pp-score-num">{feedback.score}<span>/10</span></div>
            <div className="pp-score-stars">{'⭐'.repeat(Math.max(1, Math.round(feedback.score / 2)))}</div>
          </div>
          <div className="pp-fb-body">
            <div className="pp-fb-row"><strong>👍 Great:</strong> {feedback.good}</div>
            <div className="pp-fb-row"><strong>💡 Tip:</strong> {feedback.tip}</div>
          </div>
          {feedback.score >= 7 && idx < a.tasks.length - 1 && (
            <button className="btn-go" onClick={goNext}>Next Task →</button>
          )}
          {allDone && <div className="pp-final">🏆 You finished all the practice prompts!<button className="btn-go" onClick={next}>Continue →</button></div>}
        </div>
      )}
    </div>
  );
}

// ===================== MINI GAMES =====================
function MiniGame({ a, t, showXp, boom, next }) {
  switch (a.game_kind) {
    case 'catch_ai': return <CatchAIGame a={a} t={t} showXp={showXp} boom={boom} next={next}/>;
    case 'pick_tool': return <PickToolGame a={a} t={t} showXp={showXp} boom={boom} next={next}/>;
    case 'bug_squash': return <BugSquashGame a={a} t={t} showXp={showXp} boom={boom} next={next}/>;
    case 'train_ai': return <TrainAIGame a={a} t={t} showXp={showXp} boom={boom} next={next}/>;
    default: return <div>Unknown minigame</div>;
  }
}

// ----- CATCH THE AI -----
function CatchAIGame({ a, t, showXp, boom, next }) {
  const AI_THINGS = ['🤖','📱','🎮','🚗','🛰️','🎯','💡','🦾'];
  const NOT_AI = ['📕','🪑','🥄','✏️','🥕','🪨','🧦','🎂'];
  const TARGET = 10;
  const TIME = 30;
  const [items, setItems] = useState([]);
  const [score, setScore] = useState(0);
  const [time, setTime] = useState(TIME);
  const [phase, setPhase] = useState('intro');
  const idCounter = useRef(0);

  useEffect(() => {
    if (phase !== 'play') return;
    const tick = setInterval(() => {
      setTime(t => {
        if (t <= 1) { clearInterval(tick); setPhase('done'); return 0; }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'play') return;
    const spawn = setInterval(() => {
      const isAI = Math.random() < 0.6;
      const pool = isAI ? AI_THINGS : NOT_AI;
      const emoji = pool[Math.floor(Math.random() * pool.length)];
      const id = ++idCounter.current;
      setItems(it => [...it, { id, emoji, isAI, left: 5 + Math.random() * 85, top: -10 }]);
      setTimeout(() => setItems(it => it.filter(x => x.id !== id)), 4000);
    }, 700);
    return () => clearInterval(spawn);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'play') return;
    const fall = setInterval(() => {
      setItems(it => it.map(x => ({ ...x, top: x.top + 2 })));
    }, 80);
    return () => clearInterval(fall);
  }, [phase]);

  useEffect(() => {
    if (phase === 'done' || (phase === 'play' && score >= TARGET)) {
      if (score >= TARGET || phase === 'done') {
        setPhase('done');
        api('/activities/' + a.id + '/score', 'POST', { score: Math.min(score, TARGET), maxScore: TARGET });
        showXp(score * 10);
        if (score >= TARGET) boom();
      }
    }
  }, [phase, score]);

  function tap(item) {
    setItems(it => it.filter(x => x.id !== item.id));
    if (item.isAI) setScore(s => s + 1);
    else setScore(s => Math.max(0, s - 1));
  }

  return (
    <div className="acard mg-card">
      <h3>🤖 {a.title}</h3>
      <p className="adesc">{a.description}</p>
      {phase === 'intro' && (
        <div className="mg-intro">
          <p>Catch <strong>{TARGET}</strong> AI things in <strong>{TIME} seconds</strong>!</p>
          <p className="mg-hint">Tap things that USE AI (🤖 phones, robots, voice assistants...)<br/>Avoid things that DON'T (📕 books, 🥄 spoons...)</p>
          <button className="btn-go" onClick={() => { setScore(0); setTime(TIME); setItems([]); setPhase('play'); }}>Start! ▶️</button>
        </div>
      )}
      {phase === 'play' && (
        <>
          <div className="mg-stats"><span>⏱️ {time}s</span><span>🤖 {score}/{TARGET}</span></div>
          <div className="mg-arena">
            {items.map(it => (
              <div key={it.id} className="falling-emoji" style={{ left: it.left + '%', top: it.top + '%' }} onClick={() => tap(it)}>{it.emoji}</div>
            ))}
          </div>
        </>
      )}
      {phase === 'done' && (
        <div className="mg-done">
          <h3>{score >= TARGET ? '🏆 You won!' : '⏰ Time up!'}</h3>
          <p>You caught <strong>{score}</strong> AI things!</p>
          <button className="btn-go" onClick={() => { setScore(0); setTime(TIME); setItems([]); setPhase('play'); }}>Play Again 🔄</button>
          <button className="btn-go" onClick={next}>Next →</button>
        </div>
      )}
    </div>
  );
}

// ----- PICK THE TOOL -----
function PickToolGame({ a, t, showXp, boom, next }) {
  const ROUNDS = [
    { task: '🍕 Find a pizza recipe', correct: '🌐', tools: ['🌐','🧮','📅','✏️'], labels: { '🌐':'Web Browser','🧮':'Calculator','📅':'Calendar','✏️':'Editor' } },
    { task: '➕ Add 247 + 583', correct: '🧮', tools: ['🌐','🧮','📅','✏️'], labels: { '🌐':'Web Browser','🧮':'Calculator','📅':'Calendar','✏️':'Editor' } },
    { task: "📅 Schedule mom's birthday", correct: '📅', tools: ['🌐','🧮','📅','✏️'], labels: { '🌐':'Web Browser','🧮':'Calculator','📅':'Calendar','✏️':'Editor' } },
    { task: '✏️ Write a story', correct: '✏️', tools: ['🌐','🧮','📅','✏️'], labels: { '🌐':'Web Browser','🧮':'Calculator','📅':'Calendar','✏️':'Editor' } },
    { task: '🌍 Translate French to English', correct: '🌐', tools: ['🌐','🧮','📅','✏️'], labels: { '🌐':'Web Browser','🧮':'Calculator','📅':'Calendar','✏️':'Editor' } },
  ];
  const [round, setRound] = useState(0);
  const [score, setScore] = useState(0);
  const [feedback, setFeedback] = useState(null);
  const [phase, setPhase] = useState('intro');

  function pick(tool) {
    if (feedback) return;
    const correct = tool === ROUNDS[round].correct;
    setFeedback(correct ? 'right' : 'wrong');
    if (correct) setScore(s => s + 1);
    setTimeout(() => {
      setFeedback(null);
      if (round < ROUNDS.length - 1) {
        setRound(r => r + 1);
      } else {
        const final = score + (correct ? 1 : 0);
        setPhase('done');
        api('/activities/' + a.id + '/score', 'POST', { score: final, maxScore: ROUNDS.length });
        showXp(final * 10);
        if (final === ROUNDS.length) boom();
      }
    }, 900);
  }

  function reset() { setRound(0); setScore(0); setPhase('play'); setFeedback(null); }

  return (
    <div className="acard mg-card">
      <h3>🧰 {a.title}</h3>
      <p className="adesc">{a.description}</p>
      {phase === 'intro' && (
        <div className="mg-intro">
          <p>The agent has <strong>{ROUNDS.length}</strong> tasks. Pick the right tool for each one!</p>
          <button className="btn-go" onClick={reset}>Start! ▶️</button>
        </div>
      )}
      {phase === 'play' && (
        <div className="pt-game">
          <div className="pt-progress">Task {round + 1} / {ROUNDS.length} · Score: {score}</div>
          <div className="pt-task">{ROUNDS[round].task}</div>
          <div className="pt-tools">
            {ROUNDS[round].tools.map(tool => (
              <button
                key={tool}
                className={`pt-tool${feedback && tool === ROUNDS[round].correct ? ' pt-right' : ''}${feedback === 'wrong' && tool !== ROUNDS[round].correct ? '' : ''}`}
                onClick={() => pick(tool)}
              >
                <span className="pt-emoji">{tool}</span>
                <span className="pt-label">{ROUNDS[round].labels[tool]}</span>
              </button>
            ))}
          </div>
          {feedback === 'right' && <p className="pt-fb pt-fb-good">✅ Right tool!</p>}
          {feedback === 'wrong' && <p className="pt-fb pt-fb-bad">❌ Wrong tool — the right one was {ROUNDS[round].correct}</p>}
        </div>
      )}
      {phase === 'done' && (
        <div className="mg-done">
          <h3>{score === ROUNDS.length ? '🏆 Perfect!' : '👍 Done!'}</h3>
          <p>You picked <strong>{score}/{ROUNDS.length}</strong> tools right!</p>
          <button className="btn-go" onClick={reset}>Play Again 🔄</button>
          <button className="btn-go" onClick={next}>Next →</button>
        </div>
      )}
    </div>
  );
}

// ----- BUG SQUASH -----
function BugSquashGame({ a, t, showXp, boom, next }) {
  const TIME = 30;
  const GRID = 12;
  const [bugs, setBugs] = useState({});
  const [score, setScore] = useState(0);
  const [time, setTime] = useState(TIME);
  const [phase, setPhase] = useState('intro');

  useEffect(() => {
    if (phase !== 'play') return;
    const tick = setInterval(() => {
      setTime(t => {
        if (t <= 1) { clearInterval(tick); setPhase('done'); return 0; }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'play') return;
    const spawn = setInterval(() => {
      const cell = Math.floor(Math.random() * GRID);
      const bid = Date.now() + Math.random();
      setBugs(b => ({ ...b, [cell]: bid }));
      setTimeout(() => {
        setBugs(b => {
          if (b[cell] === bid) { const n = { ...b }; delete n[cell]; return n; }
          return b;
        });
      }, 1300);
    }, 600);
    return () => clearInterval(spawn);
  }, [phase]);

  useEffect(() => {
    if (phase === 'done') {
      api('/activities/' + a.id + '/score', 'POST', { score, maxScore: 20 });
      showXp(score * 5);
      if (score >= 15) boom();
    }
  }, [phase]);

  function squash(cell) {
    if (bugs[cell]) {
      setScore(s => s + 1);
      setBugs(b => { const n = { ...b }; delete n[cell]; return n; });
    }
  }

  function reset() { setBugs({}); setScore(0); setTime(TIME); setPhase('play'); }

  return (
    <div className="acard mg-card">
      <h3>🐛 {a.title}</h3>
      <p className="adesc">{a.description}</p>
      {phase === 'intro' && (
        <div className="mg-intro">
          <p>Bugs in the code! Squash as many as you can in <strong>{TIME} seconds</strong>!</p>
          <p className="mg-hint">Tap a bug 🐛 the moment it pops up!</p>
          <button className="btn-go" onClick={reset}>Start! ▶️</button>
        </div>
      )}
      {phase === 'play' && (
        <>
          <div className="mg-stats"><span>⏱️ {time}s</span><span>🐛 Squashed: {score}</span></div>
          <div className="bug-grid">
            {Array.from({ length: GRID }).map((_, i) => (
              <div key={i} className={'bug-cell' + (bugs[i] ? ' has-bug' : '')} onClick={() => squash(i)}>
                {bugs[i] && <span className="bug">🐛</span>}
              </div>
            ))}
          </div>
        </>
      )}
      {phase === 'done' && (
        <div className="mg-done">
          <h3>{score >= 15 ? '🏆 Bug Master!' : '👍 Time up!'}</h3>
          <p>You squashed <strong>{score}</strong> bugs!</p>
          <button className="btn-go" onClick={reset}>Play Again 🔄</button>
          <button className="btn-go" onClick={next}>Next →</button>
        </div>
      )}
    </div>
  );
}

// ----- TRAIN THE AI -----
function TrainAIGame({ a, t, showXp, boom, next }) {
  const ITEMS = [
    { e: '🐱', cat: 'Animal' }, { e: '🚗', cat: 'Object' }, { e: '🐶', cat: 'Animal' },
    { e: '⚽', cat: 'Object' }, { e: '🐢', cat: 'Animal' }, { e: '🪑', cat: 'Object' },
    { e: '🐰', cat: 'Animal' }, { e: '📱', cat: 'Object' }, { e: '🦊', cat: 'Animal' },
    { e: '🍎', cat: 'Object' },
  ];
  const [shuffled, setShuffled] = useState([]);
  const [idx, setIdx] = useState(0);
  const [score, setScore] = useState(0);
  const [feedback, setFeedback] = useState(null);
  const [phase, setPhase] = useState('intro');

  useEffect(() => { setShuffled([...ITEMS].sort(() => Math.random() - 0.5)); }, []);

  function pick(category) {
    if (feedback) return;
    const correct = shuffled[idx].cat === category;
    setFeedback(correct ? 'right' : 'wrong');
    if (correct) setScore(s => s + 1);
    setTimeout(() => {
      setFeedback(null);
      if (idx < shuffled.length - 1) {
        setIdx(i => i + 1);
      } else {
        const final = score + (correct ? 1 : 0);
        setPhase('done');
        api('/activities/' + a.id + '/score', 'POST', { score: final, maxScore: shuffled.length });
        showXp(final * 10);
        if (final === shuffled.length) boom();
      }
    }, 700);
  }

  function reset() {
    setShuffled([...ITEMS].sort(() => Math.random() - 0.5));
    setIdx(0); setScore(0); setFeedback(null); setPhase('play');
  }

  const item = shuffled[idx];
  return (
    <div className="acard mg-card">
      <h3>🧠 {a.title}</h3>
      <p className="adesc">{a.description}</p>
      {phase === 'intro' && (
        <div className="mg-intro">
          <p>Help train an AI by sorting <strong>{ITEMS.length}</strong> things into the right group!</p>
          <p className="mg-hint">Tap "Animal" or "Object" for each item that pops up.</p>
          <button className="btn-go" onClick={reset}>Start! ▶️</button>
        </div>
      )}
      {phase === 'play' && item && (
        <div className="train-game">
          <div className="train-progress">{idx + 1} / {shuffled.length} · Score: {score}</div>
          <div className={`train-item${feedback === 'right' ? ' tr-right' : ''}${feedback === 'wrong' ? ' tr-wrong' : ''}`}>{item.e}</div>
          <div className="train-buttons">
            <button className="train-btn animal" disabled={!!feedback} onClick={() => pick('Animal')}>🐾 Animal</button>
            <button className="train-btn object" disabled={!!feedback} onClick={() => pick('Object')}>📦 Object</button>
          </div>
          {feedback === 'right' && <p className="pt-fb pt-fb-good">✅ Yes!</p>}
          {feedback === 'wrong' && <p className="pt-fb pt-fb-bad">❌ Nope, it was a {item.cat}</p>}
        </div>
      )}
      {phase === 'done' && (
        <div className="mg-done">
          <h3>{score === shuffled.length ? '🏆 AI Trained Perfectly!' : '👍 AI Trained!'}</h3>
          <p>You sorted <strong>{score}/{shuffled.length}</strong> right!</p>
          <button className="btn-go" onClick={reset}>Play Again 🔄</button>
          <button className="btn-go" onClick={next}>Next →</button>
        </div>
      )}
    </div>
  );
}

// ===================== SPARKLE CURSOR =====================
function SparkleCursor() {
  const [sparkles, setSparkles] = useState([]);
  useEffect(() => {
    let id = 0;
    function move(e) {
      const sid = ++id;
      setSparkles(s => [...s, { id: sid, x: e.clientX, y: e.clientY }]);
      setTimeout(() => setSparkles(s => s.filter(p => p.id !== sid)), 800);
    }
    window.addEventListener('mousemove', move);
    return () => window.removeEventListener('mousemove', move);
  }, []);
  return (
    <div className="sparkle-layer">
      {sparkles.map(s => <span key={s.id} className="sparkle" style={{ left: s.x, top: s.y }}>✨</span>)}
    </div>
  );
}

// ===================== THEME PICKER =====================
function ThemePicker({ t, user, refreshUser, reloadInventory, back }) {
  const [themes, setThemes] = useState([]);
  const [inventory, setInventory] = useState({ purchases: [], activeBackground: '', activeBackgroundEmojis: '' });
  const [busy, setBusy] = useState(false);

  async function load() {
    const [thRes, invRes] = await Promise.all([api('/themes'), api('/shop/inventory')]);
    if (Array.isArray(thRes)) setThemes(thRes);
    if (invRes && !invRes.error) setInventory(invRes);
  }
  useEffect(() => { load(); }, []);

  async function pickBuiltIn(themeCode) {
    setBusy(true);
    await api('/shop/use-theme', 'POST', { themeCode });
    await refreshUser();
    await reloadInventory();
    setBusy(false);
  }

  async function pickCustomBg(purchaseId) {
    setBusy(true);
    await api('/shop/use-background', 'POST', { purchaseId });
    await refreshUser();
    await reloadInventory();
    setBusy(false);
  }

  const customBgs = (inventory.purchases || []).filter(p => p.kind === 'background');
  const isUsingCustom = !!user.active_background;

  return (
    <div className="content">
      <button className="back" onClick={back}>← Back</button>
      <h2>🎨 Pick a Theme</h2>
      <p className="adesc">Tap any theme to switch instantly. Your whole world changes!</p>

      <h3 className="theme-section">Built-in Worlds</h3>
      <div className="theme-grid">
        {themes.map(th => {
          const isActive = !isUsingCustom && user.theme === th.code;
          const decoArr = (th.decorations || []).slice(0, 8);
          return (
            <div
              key={th.id}
              className={'theme-tile' + (isActive ? ' active-theme' : '')}
              style={{ background: th.code === 'crocodile'
                ? 'linear-gradient(135deg, #0a1f0e 0%, #143d1a 50%, #1a4d22 100%)'
                : 'linear-gradient(135deg, #080820 0%, #121240 50%, #1e1e5a 100%)' }}
              onClick={() => !busy && pickBuiltIn(th.code)}
            >
              <div className="theme-tile-name">{th.header_label}</div>
              <div className="theme-tile-emojis">
                {decoArr.map((e, i) => <span key={i}>{e}</span>)}
              </div>
              <div className="theme-tile-swatches">
                <span style={{ background: th.bg_color }}></span>
                <span style={{ background: th.accent_color }}></span>
                <span style={{ background: th.text_color }}></span>
              </div>
              {isActive && <div className="theme-tile-active">✓ In use</div>}
            </div>
          );
        })}
      </div>

      {customBgs.length > 0 && (
        <>
          <h3 className="theme-section">Your Custom Backgrounds</h3>
          <div className="theme-grid">
            {customBgs.map(bg => {
              const isActive = isUsingCustom && bg.payload === inventory.activeBackground;
              const decoArr = (bg.decoration_emojis || '').split(/\s+/).filter(Boolean).slice(0, 8);
              return (
                <div
                  key={bg.id}
                  className={'theme-tile' + (isActive ? ' active-theme' : '')}
                  style={{ background: bg.payload }}
                  onClick={() => !busy && pickCustomBg(bg.id)}
                >
                  <div className="theme-tile-name">🎨 {bg.purchase_name || 'Custom'}</div>
                  <div className="theme-tile-emojis">
                    {decoArr.length > 0 ? decoArr.map((e, i) => <span key={i}>{e}</span>) : <span style={{opacity:.5}}>✨</span>}
                  </div>
                  {isActive && <div className="theme-tile-active">✓ In use</div>}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ===================== SHOP =====================
function Shop({ t, user, refreshUser, reloadInventory, hasBonusGame }) {
  const [items, setItems] = useState([]);
  const [inventory, setInventory] = useState({ purchases: [], activeBackground: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [bgPrompt, setBgPrompt] = useState('');
  const [bgPromptOpen, setBgPromptOpen] = useState(false);
  const [playingBonus, setPlayingBonus] = useState(false);

  async function loadAll() {
    const [shopRes, invRes] = await Promise.all([api('/shop'), api('/shop/inventory')]);
    if (Array.isArray(shopRes)) setItems(shopRes);
    if (invRes && !invRes.error) setInventory(invRes);
  }
  useEffect(() => { loadAll(); }, []);

  async function buyCosmetic(item) {
    setErr(''); setOk(''); setBusy(true);
    const r = await api('/shop/buy', 'POST', { itemId: item.id });
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    setOk(`Bought ${item.name}!`);
    await loadAll();
    await refreshUser();
    await reloadInventory();
  }

  async function buyBackground() {
    if (!bgPrompt.trim()) { setErr('Describe the background you want!'); return; }
    setErr(''); setOk(''); setBusy(true);
    const item = items.find(i => i.kind === 'background');
    const r = await api('/shop/buy', 'POST', { itemId: item.id, prompt: bgPrompt });
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    setOk('🎨 Background created and applied!');
    setBgPrompt('');
    setBgPromptOpen(false);
    await loadAll();
    await refreshUser();
    await reloadInventory();
  }

  async function useBackground(purchaseId) {
    const r = await api('/shop/use-background', 'POST', { purchaseId });
    if (r.error) return;
    await refreshUser();
    await reloadInventory();
    await loadAll();
  }

  if (playingBonus) return <MemoryMatchGame t={t} onExit={() => setPlayingBonus(false)}/>;

  const myBackgrounds = (inventory.purchases || []).filter(p => p.kind === 'background');

  return (
    <div className="content shop">
      <div className="shop-head">
        <h2>🛒 Token Shop</h2>
        <div className="shop-balance">🪙 <strong>{user.tokens || 0}</strong> tokens</div>
      </div>

      {err && <div className="msg bad">{err}</div>}
      {ok && <div className="msg good">{ok}</div>}

      {hasBonusGame && (
        <div className="shop-bonus-banner">
          <span>🧠 You own the Memory Match game!</span>
          <button className="btn-go" onClick={() => setPlayingBonus(true)}>Play Now ▶️</button>
        </div>
      )}

      <div className="shop-grid">
        {items.map(item => {
          const canAfford = (user.tokens || 0) >= item.cost;
          const owned = item.owned && item.kind !== 'background';
          return (
            <div key={item.id} className={'shop-card' + (owned ? ' owned' : '') + (!canAfford && !owned ? ' poor' : '')}>
              <div className="shop-icon">{item.icon}</div>
              <h3>{item.name}</h3>
              <p className="shop-desc">{item.description}</p>
              <div className="shop-cost">🪙 {item.cost}</div>
              {owned ? (
                <button className="shop-btn owned-btn" disabled>✅ Owned</button>
              ) : item.kind === 'background' ? (
                <button className="shop-btn" disabled={busy || !canAfford} onClick={() => setBgPromptOpen(true)}>
                  {canAfford ? 'Create' : 'Need more 🪙'}
                </button>
              ) : (
                <button className="shop-btn" disabled={busy || !canAfford} onClick={() => buyCosmetic(item)}>
                  {canAfford ? 'Buy' : 'Need more 🪙'}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {myBackgrounds.length > 0 && (
        <div className="my-bgs">
          <h3>🎨 Your Backgrounds</h3>
          <div className="bg-list">
            {myBackgrounds.map(b => {
              const isActive = b.payload === inventory.activeBackground;
              return (
                <div key={b.id} className={'bg-thumb' + (isActive ? ' active-bg' : '')} style={{ background: b.payload }} onClick={() => useBackground(b.id)}>
                  <span className="bg-thumb-label">{b.purchase_name || 'Custom'}</span>
                  {isActive && <span className="bg-active-label">In use ✓</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {bgPromptOpen && (
        <div className="bg-modal-overlay" onClick={() => !busy && setBgPromptOpen(false)}>
          <div className="bg-modal" onClick={e => e.stopPropagation()}>
            <h3>🎨 Describe Your Background</h3>
            <p className="bg-modal-sub">You get <strong>one shot</strong>! Describe the colors or scene you want.</p>
            <p className="bg-modal-examples">Try: "sunset over the ocean", "magical forest", "outer space with stars", "candy land", "rainbow"</p>
            <input
              type="text"
              placeholder="e.g., sunset over the ocean"
              value={bgPrompt}
              onChange={e => setBgPrompt(e.target.value)}
              maxLength={200}
              autoFocus
            />
            <div className="bg-modal-btns">
              <button className="nbtn" onClick={() => setBgPromptOpen(false)} disabled={busy}>Cancel</button>
              <button className="btn-go" onClick={buyBackground} disabled={busy || !bgPrompt.trim()}>
                {busy ? '🎨 Creating...' : 'Create (40 🪙)'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ===================== MEMORY MATCH BONUS GAME =====================
function MemoryMatchGame({ t, onExit }) {
  const EMOJIS = ['🐊','🦁','🐘','🦒','🦋','🐢','🦜','🦊'];
  const [cards, setCards] = useState([]);
  const [flipped, setFlipped] = useState([]);
  const [matched, setMatched] = useState(new Set());
  const [moves, setMoves] = useState(0);
  const [won, setWon] = useState(false);

  function reset() {
    const deck = [...EMOJIS, ...EMOJIS]
      .map((emoji, i) => ({ id: i, emoji }))
      .sort(() => Math.random() - 0.5);
    setCards(deck);
    setFlipped([]);
    setMatched(new Set());
    setMoves(0);
    setWon(false);
  }
  useEffect(() => { reset(); }, []);

  function flip(idx) {
    if (flipped.length >= 2 || flipped.includes(idx) || matched.has(cards[idx].emoji)) return;
    const newFlipped = [...flipped, idx];
    setFlipped(newFlipped);
    if (newFlipped.length === 2) {
      setMoves(m => m + 1);
      const [a, b] = newFlipped;
      if (cards[a].emoji === cards[b].emoji) {
        setTimeout(() => {
          const nm = new Set(matched);
          nm.add(cards[a].emoji);
          setMatched(nm);
          setFlipped([]);
          if (nm.size === EMOJIS.length) setWon(true);
        }, 500);
      } else {
        setTimeout(() => setFlipped([]), 800);
      }
    }
  }

  return (
    <div className="content">
      <button className="back" onClick={onExit}>← Back to Shop</button>
      <h2>🧠 Memory Match!</h2>
      <p className="adesc">Flip cards to find matching pairs. Try to win in as few moves as possible!</p>
      <div className="mm-stats">
        <span>🎯 Moves: {moves}</span>
        <span>✅ Matches: {matched.size}/{EMOJIS.length}</span>
      </div>
      <div className="mm-grid">
        {cards.map((c, i) => {
          const isFlipped = flipped.includes(i) || matched.has(c.emoji);
          return (
            <div key={c.id} className={'mm-card' + (isFlipped ? ' flipped' : '')} onClick={() => flip(i)}>
              <div className="mm-inner">
                <div className="mm-front">?</div>
                <div className="mm-back">{c.emoji}</div>
              </div>
            </div>
          );
        })}
      </div>
      {won && (
        <div className="mg-done">
          <h3>🏆 You won in {moves} moves!</h3>
          <button className="btn-go" onClick={reset}>Play Again 🔄</button>
          <button className="btn-go" onClick={onExit}>Done</button>
        </div>
      )}
    </div>
  );
}

// ===================== FEATURE REQUEST FORM =====================
function FeatureRequest({ t }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState('');
  const [err, setErr] = useState('');

  async function submit() {
    setErr(''); setOk('');
    if (!text.trim() || text.trim().length < 5) { setErr('Write at least 5 characters'); return; }
    setBusy(true);
    const r = await api('/feature-requests', 'POST', { body: text });
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    setOk('🎉 Thanks! The admin will see your idea.');
    setText('');
  }

  return (
    <div className="content">
      <h2>💡 Got an Idea?</h2>
      <p className="adesc">Tell the admin what you'd like to see next! Maybe a new game, a new world, or a cool feature?</p>
      <div className="feature-form">
        <textarea
          placeholder="I wish AgentVerse had..."
          value={text}
          onChange={e => setText(e.target.value)}
          maxLength={500}
          rows={5}
        />
        <div className="feature-actions">
          <span className="char-count">{text.length}/500</span>
          <button className="btn-go" disabled={busy || !text.trim()} onClick={submit}>
            {busy ? 'Sending...' : 'Send Idea ✨'}
          </button>
        </div>
        {err && <div className="msg bad">{err}</div>}
        {ok && <div className="msg good">{ok}</div>}
      </div>
    </div>
  );
}

// ===================== PROGRESS =====================
function Progress({ t }) {
  const [p, setP] = useState(null);
  useEffect(()=>{api('/progress').then(d=>{if(d&&!d.error)setP(d);});},[]);
  if (!p) return <div className="ld">Loading...</div>;
  const bars = [
    {l:'Lessons',v:p.completedLessons,m:p.totalLessons,i:'📖'},
    {l:'Quizzes Right',v:p.correctQuizzes,m:p.totalQuizzes,i:'❓'},
    {l:'Games Played',v:p.completedActivities,m:p.totalActivities,i:'🎮'},
    {l:'Perfect Games',v:p.perfectActivities||0,m:p.totalActivities,i:'⭐'},
  ];
  return (
    <div className="content">
      <h2>{t.emoji} My Progress</h2>
      <div className="xp-big">
        <div className="xp-lvl">Level {p.level}</div>
        <div className="xp-amt">{p.xp} XP</div>
        <div className="xp-t big"><div className="xp-f" style={{width:`${p.xp%100}%`}}/></div>
        <p className="xp-nxt">{100-p.xp%100} XP to next level</p>
        <div className="token-big">🪙 <strong>{p.tokens||0}</strong> tokens earned</div>
        {p.streak>=2&&<p className="xp-streak">🔥 {p.streak} in a row!</p>}
      </div>
      {bars.map(b=>{const pct=b.m?Math.round(b.v/b.m*100):0;return <div key={b.l} className="pr"><span className="pri">{b.i}</span><span className="prl">{b.l}</span><div className="prb"><div className="prf" style={{width:pct+'%'}}/></div><span className="prn">{b.v}/{b.m}</span></div>;})}
    </div>
  );
}

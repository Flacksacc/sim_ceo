import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './boardroom-template.css';

type Topic = 'Launch timing' | 'Pricing' | 'Hiring';
type Message = { id: number; topic: Topic; name: string; role: string; initials: string; tone: string; time: string; summary: string; detail?: string; reply?: string; evidence?: string; kind?: 'lead' | 'advisor' };
const topics: Topic[] = ['Launch timing', 'Pricing', 'Hiring'];
const advisors = [
  { initials: 'MC', name: 'Mara Chen', role: 'Finance', tone: 'sage', state: 'Finished' },
  { initials: 'JR', name: 'Jonas Reed', role: 'Operations', tone: 'blue', state: 'Finished' },
  { initials: 'AK', name: 'Amara Kline', role: 'Customer', tone: 'rose', state: 'Reviewing' },
  { initials: 'VL', name: 'Vera Lin', role: 'Strategy', tone: 'gold', state: 'Queued' },
];
const startingMessages: Message[] = [
  { id: 1, topic: 'Launch timing', name: 'You', role: 'CEO', initials: 'SW', tone: 'lead', time: '10:42', kind: 'lead', summary: 'Should we move the public launch from June to May? What would have to be true for that to work?' },
  { id: 2, topic: 'Launch timing', name: 'Mara Chen', role: 'Finance advisor', initials: 'MC', tone: 'sage', time: '10:43', kind: 'advisor', summary: 'Keep June as the public date. A May launch is viable only if the support and acquisition budgets are approved this week.', detail: 'The earlier date moves spend forward before the retention signal is clear. I would set a May readiness gate: support coverage, a capped acquisition budget, and a measured pilot conversion rate.', evidence: 'Q2 forecast · approved board source' },
  { id: 3, topic: 'Launch timing', name: 'Jonas Reed', role: 'Operations advisor', initials: 'JR', tone: 'blue', time: '10:44', kind: 'advisor', summary: 'I would run a limited May pilot, then decide on the public date after the first two weeks of support data.', detail: 'A pilot lets us exercise onboarding and escalation paths without a full launch commitment. Define exit criteria now and hold the team to them.', reply: 'Responding to Mara’s budget concern', evidence: 'Launch readiness checklist · approved meeting source' },
];

function Glyph({ name, size = 18 }: { name: string; size?: number }) {
  const shared = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  const paths: Record<string, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    chat: <><path d="M20 11.5a8 8 0 0 1-8 8 8.7 8.7 0 0 1-3.5-.7L4 20l1.2-4.5A8 8 0 1 1 20 11.5Z"/></>,
    inbox: <><path d="M4 4h16l2 12v4H2v-4L4 4Z"/><path d="M2 15h6l2 3h4l2-3h6"/></>,
    file: <><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h4M9 12h6M9 16h6"/></>,
    users: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M19 20v-2a5 5 0 0 0-3-4.6"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9 7 7m10 10 2.1 2.1m0-14.2L17 7M7 17l-2.1 2.1"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    down: <path d="m6 9 6 6 6-6"/>,
    send: <><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></>,
    mic: <><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5m-4 0h8"/></>,
    more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
    menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
    close: <path d="M5 5 19 19M19 5 5 19"/>,
    link: <><path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1"/></>,
  };
  return <svg {...shared}>{paths[name]}</svg>;
}

function Avatar({ initials, tone }: { initials: string; tone: string }) { return <span className={`bt-avatar ${tone}`} aria-hidden="true">{initials}</span>; }

function Template() {
  const [topic, setTopic] = useState<Topic>('Launch timing');
  const [messages, setMessages] = useState(startingMessages);
  const [draft, setDraft] = useState('');
  const [recipient, setRecipient] = useState('Entire board');
  const [contextTab, setContextTab] = useState<'Agenda' | 'Sources' | 'Record'>('Agenda');
  const [contextOpen, setContextOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');
  const [expanded, setExpanded] = useState<number[]>([]);
  const [proposed, setProposed] = useState(false);
  const [notice, setNotice] = useState('');
  const [discussion, setDiscussion] = useState<'active' | 'paused'>('active');
  useEffect(() => { document.documentElement.dataset.templateTheme = theme; document.documentElement.dataset.templateDensity = density; }, [theme, density]);
  const show = (value: string) => { setNotice(value); window.setTimeout(() => setNotice(''), 4500); };
  const send = () => {
    if (!draft.trim()) return;
    setMessages(current => [...current, { id: Date.now(), topic, name: 'You', role: 'CEO', initials: 'SW', tone: 'lead', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), kind: 'lead', summary: draft.trim() }]);
    setDraft('');
    show(`Preview only: your message to ${recipient.toLowerCase()} was added locally.`);
  };
  const toggleDetail = (id: number) => setExpanded(current => current.includes(id) ? current.filter(x => x !== id) : [...current, id]);
  return <div className="bt-shell">
    <a className="bt-skip" href="#conversation">Skip to conversation</a>
    <aside className={`bt-nav ${navOpen ? 'open' : ''}`} aria-label="Board navigation">
      <div className="bt-brand"><span className="bt-mark">S</span><span>SIM CEO<small>BOARDROOM</small></span><button className="bt-mobile-close" onClick={() => setNavOpen(false)} aria-label="Close navigation"><Glyph name="close"/></button></div>
      <div className="bt-board-switch"><span className="bt-board-monogram">N</span><span><strong>Northstar Studio</strong><small>Strategy board</small></span><Glyph name="down" size={15}/></div>
      <div className="bt-nav-label">WORKSPACE</div>
      <button onClick={() => show('Board overview is outside this design preview.')}><Glyph name="grid"/> Overview</button>
      <button className="selected" onClick={() => setNavOpen(false)}><Glyph name="chat"/> Meetings <span className="bt-nav-count">3</span></button>
      <button onClick={() => show('Decision inbox is represented in the context panel.')}><Glyph name="inbox"/> Decision inbox <span className="bt-dot"/></button>
      <button onClick={() => show('Records are part of the full Sim CEO app.')}><Glyph name="file"/> Records</button>
      <button onClick={() => show('Advisor management is part of the full Sim CEO app.')}><Glyph name="users"/> Advisors</button>
      <div className="bt-nav-label meetings-label">RECENT MEETINGS</div>
      <button className="bt-meeting selected-meeting" onClick={() => setNavOpen(false)}><span className="bt-meeting-indicator"/> Launch readiness <small>Today</small></button>
      <button className="bt-meeting" onClick={() => show('This template shows the Launch readiness meeting.')}><span className="bt-meeting-indicator off"/> Q2 priorities <small>Oct 24</small></button>
      <button className="bt-meeting" onClick={() => show('This template shows the Launch readiness meeting.')}><span className="bt-meeting-indicator off"/> Pricing review <small>Oct 19</small></button>
      <div className="bt-nav-bottom"><span>DESIGN PREVIEW</span><button onClick={() => show('Settings are available in the full app.')}><Glyph name="settings"/> Settings</button></div>
    </aside>

    <main className="bt-main" id="conversation">
      <header className="bt-topbar"><button className="bt-menu" onClick={() => setNavOpen(true)} aria-label="Open navigation"><Glyph name="menu"/></button><div className="bt-crumb">Northstar Studio <Glyph name="chevron" size={13}/> Meetings <Glyph name="chevron" size={13}/> <strong>Launch readiness</strong></div><div className="bt-top-actions"><span className="bt-live"><span/> {discussion === 'active' ? 'In progress' : 'Paused'}</span><button onClick={() => setDiscussion(current => current === 'active' ? 'paused' : 'active')}>{discussion === 'active' ? 'Pause meeting' : 'Resume meeting'}</button><button className="bt-context-toggle" onClick={() => setContextOpen(true)}>Context</button></div></header>
      <section className="bt-heading"><div className="bt-eyebrow">STRATEGY BOARD <span>·</span> MEETING 03</div><div className="bt-heading-row"><div><h1>Launch readiness</h1><p>Decide whether the public launch should move from June to May.</p></div><button className="bt-icon-button" aria-label="Meeting options" onClick={() => show('Meeting actions are in the full Sim CEO app.')}><Glyph name="more"/></button></div></section>
      <nav className="bt-topics" aria-label="Agenda topics">{topics.map((item,i) => <button key={item} className={topic === item ? 'current' : ''} onClick={() => setTopic(item)}><span>{String(i+1).padStart(2,'0')}</span>{item}{item === 'Launch timing' && <span className="bt-topic-count">4</span>}</button>)}</nav>
      <div className="bt-thread">
        <div className="bt-day"><span>WEDNESDAY, OCTOBER 28</span></div>
        <div className="bt-round-label"><span>ROUND 01</span><span className="bt-round-rule"/><span>{topic}</span></div>
        {messages.some(message => message.topic === topic) ? messages.filter(message => message.topic === topic).map(message => <article className={`bt-message ${message.kind === 'lead' ? 'from-lead' : ''}`} key={message.id}>
          <Avatar initials={message.initials} tone={message.tone}/><div className="bt-message-content"><div className="bt-message-meta"><strong>{message.name}</strong><span className="bt-role">{message.role}</span><time>{message.time}</time></div>{message.reply && <div className="bt-reply">↳ {message.reply}</div>}<p>{message.summary}</p>{message.detail && <><div className="bt-message-actions"><button onClick={() => toggleDetail(message.id)} aria-expanded={expanded.includes(message.id)}>{expanded.includes(message.id) ? 'Hide reasoning' : 'Reasoning & source'} <Glyph name="down" size={14}/></button><button onClick={() => show('Detailed reply threads are shown here in the integrated design.')} >Reply in thread</button></div>{expanded.includes(message.id) && <div className="bt-detail"><p>{message.detail}</p><div><Glyph name="link" size={14}/> {message.evidence}</div></div>}</>}</div>
        </article>) : <div className="bt-topic-empty"><span className="bt-empty-number">0{topics.indexOf(topic)+1}</span><h2>{topic}</h2><p>This agenda topic is ready for its first question. Your draft stays available as you switch topics.</p><button onClick={() => document.getElementById('bt-draft')?.focus()}>Start this topic</button></div>}
        {topic === 'Launch timing' && <div className="bt-progress"><div className="bt-progress-stack"><Avatar initials="AK" tone="rose"/><Avatar initials="VL" tone="gold"/></div><span><strong>2 advisors in this round</strong><small>Amara reviewing context · Vera queued</small></span></div>}
      </div>
      <div className="bt-composer-wrap"><div className="bt-composer"><div className="bt-compose-top"><span>Message to</span><select value={recipient} onChange={e => setRecipient(e.target.value)} aria-label="Message recipient"><option>Entire board</option>{advisors.map(a => <option key={a.name}>{a.name}</option>)}<option>Secretary</option></select><span className="bt-compose-scope">Northstar Studio / Launch readiness / {topic}</span></div><textarea id="bt-draft" aria-label="Message draft" rows={2} placeholder="Ask the board a question, challenge a recommendation, or add context…" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }}/><div className="bt-compose-bottom"><button className="bt-icon-button" aria-label="Voice input preview" title="Voice input is available in the full app" onClick={() => show('Voice transcription is available in the full app; edit the transcript before sending.')}><Glyph name="mic"/></button><span>⌘ / Ctrl + Enter to send</span><button className="bt-send" disabled={!draft.trim()} onClick={send}>Send message <Glyph name="send" size={15}/></button></div></div></div>
    </main>

    <aside className={`bt-context ${contextOpen ? 'open' : ''}`} aria-label="Meeting context"><div className="bt-context-head"><div><span>MEETING CONTEXT</span><h2>On the table</h2></div><button className="bt-context-close" onClick={() => setContextOpen(false)} aria-label="Close context"><Glyph name="close"/></button></div><div className="bt-context-tabs" role="tablist" aria-label="Context sections">{(['Agenda','Sources','Record'] as const).map(item => <button role="tab" aria-selected={contextTab === item} className={contextTab === item ? 'active' : ''} key={item} onClick={() => setContextTab(item)}>{item}</button>)}</div>
      {contextTab === 'Agenda' && <div className="bt-context-body"><div className="bt-context-section"><h3>Current agenda</h3><ol className="bt-agenda"><li className="active"><span>01</span><div><strong>Launch timing</strong><small>Compare May and June paths</small></div></li><li><span>02</span><div><strong>Pricing</strong><small>Validate offer and margin</small></div></li><li><span>03</span><div><strong>Hiring</strong><small>Support coverage plan</small></div></li></ol></div><div className="bt-context-section"><div className="bt-section-heading"><h3>At the table</h3><span>4 / 10</span></div><div className="bt-roster">{advisors.map(a => <div key={a.name}><Avatar initials={a.initials} tone={a.tone}/><span><strong>{a.name}</strong><small>{a.role}</small></span><em className={a.state.toLowerCase()}>{a.state}</em></div>)}</div></div><div className="bt-context-section"><h3>Decision to make</h3><p className="bt-context-copy">Public launch date and the evidence required to commit.</p><button className="bt-text-action" onClick={() => setContextTab('Record')}>View proposed record →</button></div></div>}
      {contextTab === 'Sources' && <div className="bt-context-body"><div className="bt-context-section"><h3>Approved sources</h3><p className="bt-context-copy">Only approved material in scope for this board or meeting should inform advisor replies.</p><div className="bt-source"><Glyph name="file"/><span><strong>Q2 forecast</strong><small>Board-wide · version 3</small></span><b>Approved</b></div><div className="bt-source"><Glyph name="file"/><span><strong>Launch readiness checklist</strong><small>This meeting · version 1</small></span><b>Approved</b></div></div></div>}
      {contextTab === 'Record' && <div className="bt-context-body"><div className="bt-context-section"><h3>Decision record</h3><div className="bt-record-status">{proposed ? 'PROPOSED · REVIEW REQUIRED' : 'NO PROPOSAL YET'}</div><p className="bt-context-copy">{proposed ? 'Keep June as the public launch date; run a limited May pilot with explicit readiness gates.' : 'A decision draft can be prepared from this discussion. It remains provisional until the owner reviews and approves it in Records.'}</p><button className="bt-record-button" onClick={() => { setProposed(true); show('Preview only: a local decision proposal was drafted. No record was published.'); }}>{proposed ? 'Refresh local proposal' : 'Draft proposal'}</button><p className="bt-record-note">Drafting here does not approve a decision.</p></div></div>}
      <div className="bt-context-foot"><span>Preview controls</span><div><button onClick={() => setTheme(current => current === 'light' ? 'dark' : 'light')} aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}>{theme === 'light' ? 'Dark' : 'Light'}</button><button onClick={() => setDensity(current => current === 'comfortable' ? 'compact' : 'comfortable')} aria-label={`Switch to ${density === 'comfortable' ? 'compact' : 'comfortable'} density`}>{density === 'comfortable' ? 'Compact' : 'Comfortable'}</button></div></div>
    </aside>
    {(navOpen || contextOpen) && <button className="bt-backdrop" aria-label="Close open panel" onClick={() => { setNavOpen(false); setContextOpen(false); }}/>}<div className="bt-demo-label">INTERACTIVE DESIGN TEMPLATE · MOCK DATA</div>{notice && <div role="status" className="bt-notice">{notice}</div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<Template/>);

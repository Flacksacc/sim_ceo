import { useId, useRef, useState, type ReactNode, type KeyboardEvent } from 'react';
import { humanNoteBody } from './human-format';
import './advisor-sections.css';

const sections = ['Profile', 'Chat', 'References'] as const;
export function AdvisorSections(props: { profile: ReactNode; chat: ReactNode; references: ReactNode }) {
  const [selected, setSelected] = useState(0);
  const id = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const contents = [props.profile, props.chat, props.references];
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % sections.length;
    else if (event.key === 'ArrowLeft') next = (index + sections.length - 1) % sections.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = sections.length - 1;
    else return;
    event.preventDefault();
    setSelected(next);
    buttons.current[next]?.focus();
  };
  return <div className="advisor-sections">
    <div className="advisor-section-tabs" role="tablist" aria-label="Advisor sections">
      {sections.map((label, index) => <button key={label} type="button" role="tab"
        id={id + '-tab-' + index} aria-controls={id + '-panel-' + index}
        aria-selected={selected === index} tabIndex={selected === index ? 0 : -1}
        ref={el => { buttons.current[index] = el; }}
        onClick={() => setSelected(index)} onKeyDown={event => navigate(event, index)}>{label}</button>)}
    </div>
    {sections.map((label, index) => <div key={label} className="advisor-section-panel" role="tabpanel"
      id={id + '-panel-' + index} aria-labelledby={id + '-tab-' + index} hidden={selected !== index}>
      {contents[index]}
    </div>)}
  </div>;
}

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as RecordValue : {};
  } catch { return {}; }
}
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export function referenceUrl(value: unknown): string | null {
  try {
    const url = new URL(text(value));
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
type ReadingSource = { url: string; title: string; excerpts: string[]; fetched: boolean; supplied: boolean };
export function advisorReferences(entry: { profileJson: string; researchInputsJson?: string; researchJson?: string }, latest?: unknown) {
  const profile = object(entry.profileJson), inputs = object(entry.researchInputsJson);
  const saved = object(latest ?? entry.researchJson);
  const research = Object.keys(object(saved.partial)).length ? object(saved.partial) : saved;
  const sources = new Map<string, ReadingSource>();
  const add = (candidate: unknown, supplied = false) => {
    const value = typeof candidate === 'string' ? { url: candidate } : object(candidate);
    const url = referenceUrl(value.url) ?? referenceUrl(value.ref);
    if (!url) return;
    const existing = sources.get(url);
    const excerpt = typeof value.excerpt === 'string' ? value.excerpt : '';
    sources.set(url, { url, title: text(value.title) || existing?.title || new URL(url).hostname,
      excerpts: [...new Set([...(existing?.excerpts ?? []), ...(excerpt.trim() ? [excerpt] : [])])],
      fetched: value.fetched === true || existing?.fetched === true,
      supplied: supplied || value.ownerSupplied === true || existing?.supplied === true });
  };
  for (const link of [...array(inputs.sourceUrls), ...array(profile.sourceUrls), ...array(saved.pendingSourceUrls)]) add(link, true);
  for (const source of array(research.evidenceRefs)) add(source);
  const claims = array(research.claims).map(object);
  for (const claim of claims) for (const source of [...array(claim.refs), ...array(claim.sources)]) add(source);
  const queries = [...new Set(array(research.searchQueries).map(text).filter(Boolean))];
  return { background: text(inputs.background) || text(profile.background) || text(saved.pendingBackground),
    sources: [...sources.values()], claims: claims.filter(c => text(c.text) && text(c.kind) !== 'citation'), queries };
}

export function AdvisorReferences(props: {
  entry: { name: string; description: string; profileJson: string; researchInputsJson?: string; researchJson?: string };
  researchJson?: unknown; running?: boolean; loading?: boolean; error?: boolean; onRefresh: () => void;
}) {
  const data = advisorReferences(props.entry, props.researchJson);
  return <section className="advisor-references" aria-label="Advisor references">
    <h3>Behind {props.entry.name}</h3>
    <p>Explore the background, sources, and research used to create this advisor.</p>
    {props.running && <p role="status">Research is running. New references will appear when it finishes.</p>}
    {props.loading && <p role="status">Loading research…</p>}
    {props.error && <p role="alert">We could not refresh the research. Saved references are shown below. <button type="button" onClick={props.onRefresh}>Try again</button></p>}
    <div className="card"><h4>Your starting description</h4><p>{humanNoteBody(props.entry.description)}</p>
      {data.background && <><h4>Background you provided</h4><p>{humanNoteBody(data.background)}</p></>}
    </div>
    {data.queries.length > 0 && <div className="card"><h4>Web searches</h4><ul>{data.queries.map(query => <li key={query}>{query}</li>)}</ul></div>}
    <div className="card"><h4>Sources and reading</h4>
      {data.sources.length === 0 ? <p>No references have been saved for this advisor yet. Run research from Profile to gather some.</p> :
        <ul className="advisor-reading-list">{data.sources.map(source => <li key={source.url}>
          <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a>
          {source.supplied && <span className="badge">Your link</span>}
          <p className="muted">{source.fetched ? 'Page read during research' : source.excerpts.length ? 'Excerpt from a search result' : 'Link found; page text was not retrieved'}</p>
          {source.excerpts.length > 0 && <details><summary>Read saved excerpts</summary>
            {source.excerpts.map((excerpt, index) => <blockquote key={index}>{humanNoteBody(excerpt)}</blockquote>)}
          </details>}
        </li>)}</ul>}
    </div>
    {data.claims.length > 0 && <div className="card"><h4>Research notes</h4>
      <p>These notes helped shape the advisor. A matching passage identifies the source; it does not settle whether every claim is true.</p>
      <ul className="advisor-research-notes">{data.claims.map((claim, index) => <li key={index}>
        <span className="badge">{claim.verified === true ? 'Matched to a source' : text(claim.kind) === 'interpretation' ? 'Interpretation' : 'Needs checking'}</span>
        <p>{humanNoteBody(text(claim.text))}</p>
        {array(claim.refs).map((value, refIndex) => {
          const ref = object(value), url = referenceUrl(ref.url) ?? referenceUrl(ref.ref);
          return url ? <a key={refIndex} href={url} target="_blank" rel="noreferrer">{text(ref.title) || new URL(url).hostname}</a> : null;
        })}
      </li>)}</ul>
    </div>}
  </section>;
}

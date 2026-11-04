const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const webRequire = createRequire(path.resolve('web/package.json'));
const { buildSync } = webRequire('esbuild');
const result = buildSync({ entryPoints: ['web/src/advisor-sections.tsx'], bundle: true, platform: 'node', format: 'cjs',
  write: false, jsx: 'automatic', loader: { '.css': 'empty' }, external: ['react', 'react/jsx-runtime'] });
const mod = { exports: {} };
vm.runInNewContext(result.outputFiles[0].text, { module: mod, exports: mod.exports, require: webRequire, URL, console });
const { advisorReferences, referenceUrl, AdvisorReferences } = mod.exports;
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
let pass = 0;
function check(name, condition) { assert.ok(condition, name); pass++; console.log('PASS ' + name); }
const upper = 'https://example.test/Paper', lower = 'https://example.test/paper';
const excerpt = 'The study describes careful comparisons and a practical way to test assumptions. '.repeat(15);
const entry = { name: 'Research advisor', description: 'Help me test my assumptions.',
  profileJson: JSON.stringify({ background: 'Profile background', sourceUrls: [upper, lower, 'javascript:alert(1)', 'https://user:secret@example.test/private'] }),
  researchInputsJson: JSON.stringify({ background: 'Owner background', sourceUrls: [upper] }),
  researchJson: JSON.stringify({ responseIds: ['private-provider-id'], note: 'INTERNAL PUT snapshot metadata',
    searchQueries: ['test query', 'test query', 'second query'],
    evidenceRefs: [{ url: upper, title: 'A useful study', excerpt, fetched: true }, { url: 'https://example.test/search', title: 'Search result', excerpt: 'A search result snippet', fetched: false }],
    claims: [{ text: 'An evidence-linked observation.', kind: 'fact', verified: true, refs: [{ ref: upper, excerpt: 'A shorter supporting passage.' }] },
      { text: 'A tentative interpretation.', kind: 'interpretation', verified: false, refs: [] }] }) };
const data = advisorReferences(entry);
check('uses owner creation background', data.background === 'Owner background');
check('keeps all distinct safe sources', data.sources.length === 3);
check('preserves path case as distinct sources', data.sources.some(s => s.url === upper) && data.sources.some(s => s.url === lower));
check('deduplicates supplied and discovered copies', data.sources.filter(s => s.url === upper).length === 1);
check('preserves source title and supplied marker', data.sources.find(s => s.url === upper).title === 'A useful study' && data.sources.find(s => s.url === upper).supplied);
check('keeps full excerpt and claim-specific passage', data.sources.find(s => s.url === upper).excerpts.includes(excerpt) && data.sources.find(s => s.url === upper).excerpts.length === 2);
check('keeps fetched versus search snippet distinction', data.sources.find(s => s.url === upper).fetched && !data.sources.find(s => s.title === 'Search result').fetched);
check('deduplicates only recorded search queries', data.queries.length === 2);
check('rejects executable links', referenceUrl('javascript:alert(1)') === null && referenceUrl('data:text/html,test') === null);
check('does not expose embedded credentials', referenceUrl('https://user:secret@example.test/private') === null);
const html = renderToStaticMarkup(React.createElement(AdvisorReferences, { entry, onRefresh() {} }));
check('renders study, background and notes', html.includes('A useful study') && html.includes('Owner background') && html.includes('An evidence-linked observation.'));
check('retains full long excerpt', html.includes(excerpt.trim()));
check('labels tentative interpretations honestly', html.includes('Interpretation') && html.includes('Matched to a source'));
check('hides raw backend metadata', !html.includes('private-provider-id') && !html.includes('INTERNAL PUT snapshot metadata'));
check('external links use protected new tabs', html.includes('target="_blank"') && html.includes('rel="noreferrer"'));
check('uses latest same-advisor research', advisorReferences(entry, JSON.stringify({ claims: [], evidenceRefs: [{ url: 'https://example.test/new', title: 'New result' }] })).sources.some(s => s.title === 'New result'));
check('cleared research does not resurrect older claims', advisorReferences(entry, '{}').claims.length === 0);
check('malformed old research remains readable', advisorReferences({ profileJson: '{', researchJson: '{' }).sources.length === 0);
check('empty state does not invent search history', advisorReferences({ profileJson: '{}' }).queries.length === 0);
console.log('ADVISOR REFERENCES QA pass=' + pass + ' fail=0');

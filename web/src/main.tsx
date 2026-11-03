import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './styles.css';

function identityKey(): string {
  try {
    const t = localStorage.getItem("simceo-token") ?? "";
    const u = localStorage.getItem("simceo-user") ?? "";
    const fb = localStorage.getItem("simceo-fb-user-v2") ?? "";
    return t ? ("token:" + t.slice(0, 12) + ":" + u) : ("anon:" + fb);
  } catch { return "anon"; }
}
function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5000 } } });
}
let qc = makeClient();
let appKey = identityKey();
let root: Root | null = null;
try { (window as unknown as { __simceoEpoch?: number }).__simceoEpoch = 0; } catch {}
function epochNow(): number { try { return (window as unknown as { __simceoEpoch?: number }).__simceoEpoch ?? 0; } catch { return 0; } }
function mount(): void {
  const el = document.getElementById('root')!;
  if (!root) root = createRoot(el);
  try { qc.cancelQueries(); } catch {}
  // Do not clear the brand-new client on first mount before render; clear only on identity switch.
  root.render(
    <React.StrictMode>
      <QueryClientProvider client={qc}>
        <App key={appKey} />
      </QueryClientProvider>
    </React.StrictMode>
  );
}
try {
  window.addEventListener("simceo-auth-change", () => {
    const next = identityKey();
    if (next === appKey) return;
    appKey = next;
    try { (window as unknown as { __simceoEpoch?: number }).__simceoEpoch = ((window as unknown as { __simceoEpoch?: number }).__simceoEpoch ?? 0) + 1; } catch {}
    try { qc.cancelQueries(); } catch {}
    try { qc.clear(); } catch {}
    try { qc.unmount?.(); } catch {}
    qc = makeClient();
    mount();
  });
  window.addEventListener("storage", (e) => {
    // key === null covers localStorage.clear() (cross-tab sign-out): identity re-read decides.
    if (e.key === null || e.key === "simceo-token" || e.key === "simceo-user") {
      window.dispatchEvent(new Event("simceo-auth-change"));
    }
  });
} catch {}
mount();

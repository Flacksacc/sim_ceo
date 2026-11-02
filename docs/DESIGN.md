# SimCEO visual system (DESIGN.md)

Derived from `web/src/styles.css` + `web/src/App.tsx`. Tokens are the source
of truth; no new color, radius, or font should appear outside them.

## Tokens (`:root` / `[data-theme="dark"]`)

- `--bg` deep navy rail/topbar-dark; `--content` page background.
- `--panel` cards/dialogs/inputs; `--panel-2` sunken wells (`pre`, pills).
- `--ink` primary text; `--muted` secondary; `--line` hairline borders.
- `--accent` amber: primary actions, active states, lead bubbles, live badges.
- `--accent-ink` text on accent; `--accent-soft` tinted fills.
- `--danger`, `--ok` for destructive/confirmed states only.
- Radius `--radius: 12px` panels, `--radius-s: 8px` controls, pills fully round.
- Shadow: single soft two-layer `--shadow`; never glows.

## Type

System stack (no webfont dependency). Page h1 brand, section h2 1.3rem/700,
card h3 1rem/650. Ledger numerals use `tabular-nums`. Body 15px/1.5,
bubbles 1.6 for long advisor text. No gradient text, no kickers.

## Layout

Shell: 248px navy rail + topbar + centered content (980px, 1440px when a
boardroom grid is present). Boardroom: 248px agenda/members rail, fluid
center, 300px inspector; mid widths stack the inspector; phones stack all.
Density toggle (`data-density="compact"`) tightens bubbles, members, avatars.

## Components

- Buttons: base bordered; `.primary` amber; `.ghost` chromeless; `.danger`
  outline; `.icon` square. One primary action per view.
- Bubbles: advisor = panel card with identity header (initials disc in a
  name-hashed hue, name, time, status); lead = right-offset amber-tinted.
  Never nested cards. `Challenged` badge only when the stored content carries
  a `[challenge:]` marker; citation chips `[source:]/[record:]` jump tabs.
- Toasts replace all popups: neutral vs red-edge errors, 7s, `aria-live`.
- Native `<dialog>` for scope/auth; native `<details>` for setup/search.
- Motion: 120–160ms fades/slides only; `prefers-reduced-motion` disables all.

## Honest omissions (not restyled around)

No stance labels (server stores none), no reply threading (no `ReplyTo`
field), no page refs in excerpts (recall returns scores, not pages), no
photo avatars in thread (initials; portraits stay in Advisors).

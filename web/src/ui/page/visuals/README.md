# Trying a Visual starter by hand

1. Run the server and the UI (`cargo run -p qoop-server`, then `npm run dev` in `web/`); `/visual-frame` must answer, the dev server proxies it.
2. Sign in as a Member, open any Card's Page, press "+ Add block" → "Visual" and pick a starter (`templates/blank.ts`, `bloch.ts`, `plot.ts`).
3. The editor opens with the starter's source: change it and press "Run" (⌘Enter) — the preview below reloads from the draft, nothing is submitted.
4. Check in the preview: sliders and fields work with the keyboard, the drawing follows the panel width (⤢), and it re-colours when you switch the app theme.
5. "Cancel" (Esc) throws the draft away; a thrown error shows as a strip under the frame. Tests: `npx vitest run src/ui/page/visuals`.

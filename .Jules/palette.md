## 2024-05-18 - Keyboard Navigation and ARIA Labels
**Learning:** Found that custom canvas drawing areas and native select elements often miss necessary ARIA labels for accessibility, and pagination benefits significantly from keyboard navigation (Arrow keys). Tooltips (`title`) combined with `aria-keyshortcuts` inform users of functionality.
**Action:** Always verify `aria-label` and `role` attributes on interactive non-text elements (like `<canvas>`) and ensure logical keyboard shortcuts (with indicators) are added to pagination controls.

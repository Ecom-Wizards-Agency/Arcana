export const screenSurfaceStyles = `.wa-support-screen {
  width: 100%; min-width: 0; max-width: 1200px; margin: 0 auto;
  font-family: var(--wa-font); color: var(--wa-text);
  --wa-fw-title: 600; --wa-fw-section: 600;
  --wa-radius: 8px; --wa-radius-lg: 8px;
}
.wa-support-breadcrumb { color: var(--wa-text-muted); font-size: 12px; line-height: 20px; margin-bottom: 16px; }
.wa-support-breadcrumb span { color: var(--wa-text); }
/* Old route-local reading widths must fit the shell's content column. */
.wa-support-screen > main { width: 100%; max-width: none !important; margin: 0 !important; padding: 0 !important; min-width: 0; }
.wa-support-screen h1 { font: 600 24px/32px var(--wa-font) !important; letter-spacing: 0 !important; margin-top: 0; }
.wa-support-screen .tl-accessible-title { position: static; width: auto; height: auto; margin: 0 0 6px; overflow: visible; clip-path: none; white-space: normal; }
.wa-support-screen h2 { font: 600 16px/24px var(--wa-font); }
.wa-support-screen .wa-page-sub,
.wa-support-screen main > p,
.wa-support-screen header > p { font-size: 13px !important; line-height: 20px; color: var(--wa-text-muted); }
.wa-support-screen .wa-card { border: 1px solid var(--wa-border); border-radius: 8px; box-shadow: none; background: var(--wa-surface); }
.wa-support-screen .wa-btn { background: var(--wa-surface-2); border-radius: 8px; padding: 12px 16px; font: 600 14px/20px var(--wa-font); }
.wa-support-screen .wa-btn--ghost { background: transparent; }
.wa-support-screen .wa-btn--danger { background: var(--wa-bad-bg); color: var(--wa-bad-text); }
.wa-support-screen .wa-btn--sm { padding: 8px 12px; }
.wa-support-screen .wa-btn--primary { background: var(--wa-accent); color: var(--wa-on-accent); border-color: var(--wa-accent); }
.wa-support-screen .wa-btn--primary:hover:not(:disabled) { background: var(--wa-accent); }
.wa-support-screen .wa-empty { margin-block: 16px; border: 1px solid var(--wa-border); border-radius: 8px; padding: 24px; background: var(--wa-surface); }
.wa-support-screen .wa-empty[data-state='gated'], .wa-support-screen .wa-empty[data-state='error'] { background: var(--wa-warn-bg); }
.wa-support-screen .wa-empty__title { text-transform: none; letter-spacing: 0; font: 600 14px/20px var(--wa-font); }
.wa-support-screen .wa-empty__body, .wa-support-screen .wa-empty__meta { font: 400 13px/20px var(--wa-font); color: var(--wa-text-muted); }
.wa-support-screen table { background: var(--wa-surface); border: 1px solid var(--wa-border); border-radius: 8px; overflow: hidden; }
.wa-support-screen th { font: 600 12px/20px var(--wa-font); }
.wa-support-screen td { font-size: 13px; line-height: 20px; }
.wa-support-screen .wa-tabs { flex-wrap: wrap; }
.wa-support-panel { border: 1px solid var(--wa-border); border-radius: 8px; background: var(--wa-surface); padding: 24px; }
.wa-support-stack { display: grid; gap: 24px; }
.wa-support-note { color: var(--wa-text-muted); font: 400 13px/20px var(--wa-font); }
`;

/**
 * Escapes a string for safe insertion anywhere in HTML text or an attribute
 * value. Every value that reaches the report and did not originate as a
 * literal we wrote ourselves — an address, a transaction hash, a revert
 * string surfaced as `outcome.detail` — must pass through this before it is
 * concatenated into the page. A contract's revert string is
 * attacker-controlled input; this is the one place that gets neutralised.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Wraps a body fragment into one complete, self-contained HTML document:
 * no `<script>`, no `<link>`, no remote `src`. Every rule lives in an inline
 * `<style>` block so the page renders for a judge who opens the file with no
 * network at all.
 */
export function pageShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 2rem;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #0b0d10;
    color: #e6e6e6;
    line-height: 1.5;
  }
  h1 { font-size: 1.5rem; margin: 0 0 1rem; }
  h2 { font-size: 1.1rem; margin: 2rem 0 0.75rem; border-bottom: 1px solid #2a2e33; padding-bottom: 0.4rem; }
  h3 { font-size: 1rem; margin: 0 0 0.5rem; }
  section.run {
    border: 1px solid #2a2e33;
    border-radius: 8px;
    padding: 1rem 1.25rem;
    margin-bottom: 1.25rem;
    background: #14171b;
  }
  table { border-collapse: collapse; width: 100%; margin: 0.5rem 0 1rem; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.35rem 0.6rem; border-bottom: 1px solid #2a2e33; vertical-align: top; }
  th { color: #9aa3ad; font-weight: 600; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.85em; }
  a { color: #6cb6ff; }
  .muted { color: #9aa3ad; }
  .badge {
    display: inline-block;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 600;
    background: #2a2e33;
  }
  .badge-hold { background: #234a2e; color: #7be08f; }
  .badge-reduce { background: #4a2323; color: #ff8f8f; }
  .badge-restore { background: #23364a; color: #8fbcff; }
  .badge-unknown { background: #4a4423; color: #e0d47b; }
  .badge-breach { background: #4a2323; color: #ff8f8f; }
  .status-landed { color: #7be08f; }
  .status-refused { color: #ff8f8f; }
  .status-unresolved { color: #e0d47b; }
  .summary-grid { display: flex; gap: 2rem; flex-wrap: wrap; margin-bottom: 1rem; }
  .summary-item .label { color: #9aa3ad; font-size: 0.8rem; display: block; }
  .summary-item .value { font-size: 1.3rem; font-weight: 600; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

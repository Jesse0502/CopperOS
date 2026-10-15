// What the emails CopperOS sends have in common (welcome-email.ts, updates-email.ts): the colours of
// the panel, a centered black and copper card, and the pieces they are built from. Laid out in tables
// with inline styles because that is what mail apps render the same.

export const SITE = "https://copper.jassydev.com";

// The panel's own colours (extension/sidepanel.html, dark). White text does not read on the copper,
// so the buttons are copper with black text.
export const C = {
  page: "#0a0a0a",
  card: "#151515",
  line: "#2b2825",
  text: "#ece9e6",
  muted: "#a8a39c",
  faint: "#8e8981",
  copper: "#d97757",
};
export const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const button = (href: string, words: string) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>` +
  `<td align="center" bgcolor="${C.copper}" style="border-radius:10px"><a href="${esc(href)}" style="display:inline-block;padding:13px 26px;font:700 15px/1 ${FONT};color:#151515;text-decoration:none;border-radius:10px">${esc(words)}</a></td>` +
  `</tr></table>`;

export const rule = `<tr><td style="padding:6px 36px"><div style="height:1px;line-height:1px;background:${C.line}">&nbsp;</div></td></tr>`;

/** The logo, centered, at the top of a card. */
export const logoRow = `<tr><td align="center" style="padding:32px 36px 4px">
<img src="${SITE}/assets/logo.png" width="56" height="56" alt="CopperOS" style="display:block;margin:0 auto;border:0">
</td></tr>`;

/** The page around the rows: the dark page, the centered card, its copper edge. */
export function shell(opts: { subject: string; preheader: string; rows: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${esc(opts.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page}">${esc(opts.preheader)}&#8199;&zwnj;&#8199;&zwnj;&#8199;&zwnj;&#8199;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page}">
<tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center" bgcolor="${C.card}" style="width:100%;max-width:600px;background:${C.card};border:1px solid ${C.line};border-radius:16px">
<tr><td height="4" bgcolor="${C.copper}" style="height:4px;line-height:4px;font-size:0;background:${C.copper};border-radius:16px 16px 0 0">&nbsp;</td></tr>
${opts.rows}
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** The links under every email: where to look, and a line saying what this one is. */
export function footer(lines: { first: string; last: string }): string {
  const link = (href: string, words: string) => `<a href="${href}" style="color:${C.faint};text-decoration:underline">${words}</a>`;
  return `<tr><td align="center" style="padding:18px 36px 28px;border-top:1px solid ${C.line}">
<p style="margin:0 0 6px;font:400 13.5px/1.6 ${FONT};color:${C.muted}">${lines.first}</p>
<p style="margin:0;font:400 12.5px/1.6 ${FONT};color:${C.faint}">${link(`${SITE}/`, "Website")} &nbsp;·&nbsp; ${link(`${SITE}/support/`, "Support")} &nbsp;·&nbsp; ${link("https://github.com/Jesse0502/CopperOS", "GitHub")} &nbsp;·&nbsp; ${lines.last}</p>
</td></tr>`;
}

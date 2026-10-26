// The email for what is new in a release or a major feature (updates.ts). An entry in
// website/announcements.json can carry its own email copy (`email`): a few short paragraphs in a left-aligned
// letter, written to be read as a note from a person and not as the panel's dialog. The letter is a dark card
// with a header band (the mark, the name, the version), an optional box for what changed, and a signature, on
// a light page with the links under the card. Without `email` the email is built from the dialog's own fields,
// as a centered card. Every one carries a link to unsubscribe from product updates.

import { button, C, esc, FONT, footer, logoRow, shell, SITE } from "./email-kit.js";

/** An announcement, as announce.py writes it. */
export type WhatsNew = {
  id: string;
  tag?: string;
  title: string;
  lead?: string;
  points?: string[];
  /** A picture on the website. */
  image?: string;
  cta?: { label: string; url: string };
  /**
   * The email's own words. Paragraphs are plain text; the first is usually the greeting. `callout` is the
   * box for what changed: a label (default "What changed in <label>"), a few lines, and optionally a big
   * button at the bottom, placed after the first `after` paragraphs (default 2). `signoff` is lines: a name, then a site, as in "Jasmeet Singh\njassydev.com".
   */
  email?: {
    subject?: string;
    paragraphs?: string[];
    signoff?: string;
    label?: string;
    callout?: { label?: string; lines?: string[]; after?: number; button?: { label: string; url: string } };
  };
};

export type UpdatesMail = { subject: string; html: string; text: string };

const https = (u: string | undefined) => (u && /^https:\/\//.test(u) ? u : null);

function point(text: string): string {
  return (
    `<tr><td style="padding:5px 44px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td width="26" valign="top" style="font:700 16px/1.5 ${FONT};color:${C.copper}">&#10003;</td>` +
    `<td valign="top" align="left" style="font:400 15px/1.55 ${FONT};color:${C.text};text-align:left">${esc(text)}</td>` +
    `</tr></table></td></tr>`
  );
}

// The letter's colours: a dark card on a light page, as in the note the person sends by hand.
const L = {
  page: "#f3f3f8",
  pageDark: "#0a0a0a",
  head: "#151515",
  body: "#1c1b1a",
  edge: "#2b2825",
  headLine: "#34312d",
  box: "#252422",
  boxLine: "#3a3733",
  peach: "#e8a383",
  link: "#9c4a2e",
  note: "#6b6b75",
};
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace";

/** Text made safe for HTML, with a web address in it made a link. */
function linked(text: string): string {
  return esc(text).replace(/https:\/\/[^\s<]+/g, (m) => {
    const url = m.replace(/[.,:!?)]+$/, "");
    const tail = m.slice(url.length);
    return `<a href="${url}" style="color:${L.peach};text-decoration:underline">${url}</a>${tail}`;
  });
}

/** A wide copper button, for the bottom of the box. Black words on the copper, as in the other emails. */
const bigButton = (href: string, words: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 0"><tr>` +
  `<td align="center" bgcolor="${C.copper}" style="background:${C.copper};border-radius:12px"><a href="${esc(href)}" style="display:block;padding:18px 20px;font:700 18px/1.3 ${FONT};color:#151515;text-decoration:none;text-align:center;border-radius:12px">${esc(words)}</a></td>` +
  `</tr></table>`;

const looksLikeSite = (s: string) => /^(https:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s.trim());

/**
 * A note: the entry's own paragraphs on a dark card with a header band, a box for what changed, and a
 * signature, with the links under the card. Made to look unlike the panel's dialog.
 */
function letter(entry: WhatsNew, paragraphs: string[], unsubscribeUrl: string): UpdatesMail {
  const subject = entry.email?.subject?.trim() || entry.title;
  // What sits at the right of the header, such as the version.
  const label = entry.email?.label?.trim();
  const sign = (entry.email?.signoff ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  // "Name" then "site": the name in bold and the site a link. Any other sign-off is plain lines.
  const card = sign.length > 1 && looksLikeSite(sign[sign.length - 1]!);
  const lastLine = sign[sign.length - 1] ?? "";
  const siteHref = /^https:\/\//.test(lastLine) ? lastLine : `https://${lastLine}`;
  const calloutLines = (entry.email?.callout?.lines ?? []).map((x) => x.trim()).filter(Boolean);
  const calloutLabel = entry.email?.callout?.label?.trim() || (label ? `What changed in ${label}` : "What changed");
  const after = Math.min(Math.max(entry.email?.callout?.after ?? 2, 0), paragraphs.length);
  const cb = entry.email?.callout?.button;
  const calloutButton = cb && cb.label?.trim() && https(cb.url) ? { label: cb.label.trim(), url: cb.url } : null;

  const p = (text: string) => `<p style="margin:0 0 20px;font:400 17px/1.65 ${FONT};color:${C.text}">${linked(text)}</p>`;
  const box = calloutLines.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 24px"><tr><td bgcolor="${L.box}" style="background:${L.box};border:1px solid ${L.boxLine};border-radius:14px;padding:24px 26px ${calloutButton ? "26px" : "6px"}">
<p style="margin:0 0 14px;font:700 13px/1.4 ${MONO};letter-spacing:.08em;text-transform:uppercase;color:${L.peach}">${esc(calloutLabel)}</p>
${calloutLines.map((l) => `<p style="margin:0 0 18px;font:400 17px/1.6 ${FONT};color:${C.text}">${linked(l)}</p>`).join("\n")}
${calloutButton ? bigButton(calloutButton.url, calloutButton.label) : ""}
</td></tr></table>`
    : "";
  const body = [...paragraphs.slice(0, after).map(p), box, ...paragraphs.slice(after).map(p)].filter(Boolean).join("\n");

  const signature = sign.length
    ? `<div style="height:1px;line-height:1px;background:${L.headLine};margin:12px 0 22px">&nbsp;</div>
${
  card
    ? `<p style="margin:0;font:700 18px/1.4 ${FONT};color:${C.text}">${esc(sign[0]!)}${sign.length > 2 ? "<br>" + sign.slice(1, -1).map((l) => `<span style="font-weight:400">${esc(l)}</span>`).join("<br>") : ""}</p>
<p style="margin:2px 0 0;font:400 16px/1.5 ${FONT}"><a href="${esc(siteHref)}" style="color:${L.peach};text-decoration:none">${esc(siteHref.replace(/^https:\/\//, ""))}</a></p>`
    : `<p style="margin:0;font:400 17px/1.65 ${FONT};color:${C.text}">${sign.map(esc).join("<br>")}</p>`
}`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(subject)}</title>
<style>
@media (prefers-color-scheme: dark) {
  .pg { background: ${L.pageDark} !important; }
  .ft a { color: ${L.peach} !important; }
  .fn, .fn a { color: ${C.faint} !important; }
}
</style>
</head>
<body class="pg" style="margin:0;padding:0;background:${L.page};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${L.page}">${esc(paragraphs.find((x) => x.length > 20) ?? subject)}&#8199;&zwnj;&#8199;&zwnj;&#8199;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="pg" bgcolor="${L.page}" style="background:${L.page}">
<tr><td align="center" style="padding:32px 14px 44px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${L.body}" style="width:100%;max-width:600px;background:${L.body};border:1px solid ${L.edge};border-radius:16px">
<tr><td bgcolor="${L.head}" style="background:${L.head};border-bottom:1px solid ${L.headLine};border-radius:15px 15px 0 0;padding:22px 32px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="left" valign="middle">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="middle" style="padding-right:12px"><img src="${SITE}/assets/logo.png" width="34" height="34" alt="" style="display:block;border:0"></td>
<td valign="middle" style="font:700 19px/1 ${FONT};color:#ffffff;letter-spacing:-.01em">CopperOS</td>
</tr></table>
</td>
${label ? `<td align="right" valign="middle" style="font:700 15px/1 ${MONO};color:${L.peach};text-align:right;white-space:nowrap;text-transform:uppercase">${esc(label)}</td>` : ""}
</tr></table>
</td></tr>
<tr><td align="left" style="text-align:left;padding:34px 32px 38px">
${body}
${signature}
</td></tr>
</table>
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
<tr><td align="left" style="padding:22px 6px 0">
<p class="ft" style="margin:0 0 6px;font:400 15px/1.6 ${FONT};color:${L.link}"><a href="${SITE}/" style="color:${L.link};text-decoration:none">Website</a> &nbsp;·&nbsp; <a href="${SITE}/setup/" style="color:${L.link};text-decoration:none">Setup guide</a> &nbsp;·&nbsp; <a href="https://github.com/Jesse0502/CopperOS" style="color:${L.link};text-decoration:none">GitHub</a></p>
<p class="fn" style="margin:0;font:400 14px/1.6 ${FONT};color:${L.note}">You're getting this as a CopperOS user. <a href="${esc(unsubscribeUrl)}" style="color:${L.note};text-decoration:underline">Unsubscribe from product updates</a>.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const plain = (t: string) => t;
  const text = [
    ...paragraphs.slice(0, after).map(plain),
    ...(calloutLines.length ? [[calloutLabel.toUpperCase(), ...calloutLines.map((l) => `- ${l}`), ...(calloutButton ? ["", `${calloutButton.label}: ${calloutButton.url}`] : [])].join("\n")] : []),
    ...paragraphs.slice(after).map(plain),
    ...(sign.length ? [sign.join("\n")] : []),
    "--",
    `Website: ${SITE}/  Setup guide: ${SITE}/setup/  GitHub: https://github.com/Jesse0502/CopperOS`,
    `You're getting this as a CopperOS user. Unsubscribe from product updates: ${unsubscribeUrl}`,
  ].join("\n\n");
  return { subject, html, text };
}

/** The what's-new email. `unsubscribeUrl` is this person's own link. */
export function whatsNewEmail(opts: { entry: WhatsNew; unsubscribeUrl: string }): UpdatesMail {
  const { entry, unsubscribeUrl } = opts;
  const own = (entry.email?.paragraphs ?? []).map((x) => x.trim()).filter(Boolean);
  if (own.length) return letter(entry, own, unsubscribeUrl);
  const subject = `${entry.tag ? `${entry.tag}: ` : ""}${entry.title}`;
  const points = entry.points ?? [];
  const cta = entry.cta && https(entry.cta.url) ? { label: entry.cta.label, url: entry.cta.url } : null;
  // A picture only from the website, as in the panel.
  const image = entry.image && entry.image.startsWith(`${SITE}/`) ? entry.image : null;

  const rows = `${logoRow}
${entry.tag ? `<tr><td align="center" style="padding:14px 36px 0"><span style="display:inline-block;padding:5px 11px;border:1px solid ${C.copper};border-radius:999px;font:600 11px/1 ${FONT};letter-spacing:.08em;text-transform:uppercase;color:${C.copper}">${esc(entry.tag)}</span></td></tr>` : ""}
<tr><td align="center" style="padding:14px 36px 4px">
<h1 style="margin:0;font:700 28px/1.2 ${FONT};letter-spacing:-.02em;color:${C.text}">${esc(entry.title)}</h1>
</td></tr>
${entry.lead ? `<tr><td align="center" style="padding:8px 44px 16px"><p style="margin:0;font:400 16px/1.6 ${FONT};color:${C.muted}">${esc(entry.lead)}</p></td></tr>` : ""}
${image ? `<tr><td style="padding:4px 36px 14px"><img src="${esc(image)}" width="528" alt="" style="display:block;width:100%;max-width:528px;height:auto;border:1px solid ${C.line};border-radius:12px"></td></tr>` : ""}
${points.map(point).join("\n")}
${cta ? `<tr><td align="center" style="padding:20px 36px 8px">${button(cta.url, cta.label)}</td></tr>` : ""}
<tr><td style="padding:12px 0 0">&nbsp;</td></tr>
${footer({
  first: "Questions? Reply to this email.",
  last: `Sent to CopperOS accounts. <a href="${esc(unsubscribeUrl)}" style="color:${C.faint};text-decoration:underline">Unsubscribe</a>`,
})}`;

  const html = shell({ subject, preheader: entry.lead || entry.title, rows });

  const text = [
    entry.tag ? `${entry.tag.toUpperCase()}` : "",
    entry.title,
    "",
    entry.lead ?? "",
    "",
    ...points.map((p) => `- ${p}`),
    ...(cta ? ["", `${cta.label}: ${cta.url}`] : []),
    "",
    "Questions? Reply to this email.",
    `CopperOS by Jassydev. Sent to CopperOS accounts. Unsubscribe: ${unsubscribeUrl}`,
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { subject, html, text };
}

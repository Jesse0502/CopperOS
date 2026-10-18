// The email for what is new in a release or a major feature (updates.ts). An entry in
// website/announcements.json can carry its own email copy (`email`): a few short paragraphs in a plain,
// left-aligned letter, written to be read as a note from a person and not as the panel's dialog. Without
// it the email is built from the dialog's own fields, as a centered card. Black and copper like the welcome
// email, and every one carries a link to unsubscribe from product updates.

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
  /** The email's own words. Paragraphs are plain text; the first is usually the greeting. */
  email?: { subject?: string; paragraphs?: string[]; signoff?: string; label?: string };
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

/**
 * A note: the entry's own paragraphs, left-aligned on the dark page with no card around them, a small
 * mark at the top and a sign-off. Made to look unlike the panel's dialog.
 */
function letter(entry: WhatsNew, paragraphs: string[], unsubscribeUrl: string): UpdatesMail {
  const subject = entry.email?.subject?.trim() || entry.title;
  const signoff = entry.email?.signoff?.trim();
  // What sits at the right of the header, such as the version.
  const label = entry.email?.label?.trim();
  const p = (text: string) => `<p style="margin:0 0 18px;font:400 16px/1.7 ${FONT};color:${C.text}">${esc(text)}</p>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page}">${esc(paragraphs.find((x) => x.length > 20) ?? subject)}&#8199;&zwnj;&#8199;&zwnj;&#8199;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page}">
<tr><td align="center" style="padding:36px 20px 48px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px">
<tr><td align="left" style="padding:0 0 28px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="left" valign="middle">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="middle" style="padding-right:10px"><img src="${SITE}/assets/logo.png" width="28" height="28" alt="" style="display:block;border:0"></td>
<td valign="middle" style="font:600 15px/1 ${FONT};color:#ffffff;letter-spacing:-.01em">CopperOS</td>
</tr></table>
</td>
${label ? `<td align="right" valign="middle" style="font:600 14px/1 ${FONT};color:${C.copper};text-align:right;white-space:nowrap">${esc(label)}</td>` : ""}
</tr></table>
</td></tr>
<tr><td align="left" style="text-align:left">
${paragraphs.map(p).join("\n")}
${signoff ? `<p style="margin:26px 0 0;font:400 16px/1.7 ${FONT};color:${C.text}">${signoff.split("\n").map((l) => esc(l.trim())).join("<br>")}</p>` : ""}
</td></tr>
<tr><td align="left" style="padding:44px 0 0;border-top:0">
<div style="height:1px;line-height:1px;background:${C.line};margin-bottom:16px">&nbsp;</div>
<p style="margin:0;font:400 12.5px/1.6 ${FONT};color:${C.faint}">You're getting this as a CopperOS user. <a href="${esc(unsubscribeUrl)}" style="color:${C.faint};text-decoration:underline">Unsubscribe from product updates</a>.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [...paragraphs, ...(signoff ? [signoff] : []), "--", `You're getting this as a CopperOS user. Unsubscribe from product updates: ${unsubscribeUrl}`].join("\n\n");
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

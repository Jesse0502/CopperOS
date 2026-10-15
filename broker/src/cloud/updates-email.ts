// The email for what is new in a release or a major feature (updates.ts): the same entry the panel
// shows as its dialog (website/announcements.json), so what people read in the panel and in their inbox
// is one piece of writing. Black and copper like the welcome email, and every one carries a link to
// unsubscribe from product updates.

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

/** The what's-new email. `unsubscribeUrl` is this person's own link. */
export function whatsNewEmail(opts: { entry: WhatsNew; unsubscribeUrl: string }): UpdatesMail {
  const { entry, unsubscribeUrl } = opts;
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

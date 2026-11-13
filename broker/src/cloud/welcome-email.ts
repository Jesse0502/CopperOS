// The email a new account gets once, when it signs up (welcome.ts): what a mold is, and five molds
// from the website's library page to try. It goes straight to the molds and stays short on purpose.
//
// It is a letter, like the what's-new email (updates-email.ts): a dark card with a header band (the
// mark, the name), left-aligned words, a box for the molds, a big copper button and a signature, on a
// dark page with the links under the card. It is dark on purpose, in every mail app. Laid out in
// tables with inline styles because that is what mail apps render the same.

import { C, esc, FONT, SITE } from "./email-kit.js";

// From the library page (website/library/index.html); the ids are its anchors and the tags are its labels.
// Each line says what the mold does, in the library's own terms.
const MOLDS = [
  { id: "jobs", tag: "Jobs", title: "Apply to jobs", body: "Applies only to listings that fit. You approve each one." },
  { id: "outreach", tag: "Outreach", title: "Cold outreach", body: "Reads each profile first, then writes a note that mentions something real." },
  { id: "leads", tag: "Sheets", title: "Build a lead list", body: "Fills a Google Sheet with matches, and why each one fits." },
  { id: "monitor", tag: "Social", title: "Monitor social media", body: "Watches X, Reddit and LinkedIn for your keywords and drafts replies. It never posts." },
  { id: "directories", tag: "Forms", title: "Submit to directories", body: "Fills in each directory's submit form. It never pays." },
];

const INTRO = "Thanks for signing up. Molds are tasks you save once and run again. Here are five to try:";
const OPEN = "Open one in the library and press Run in CopperOS.";
const OWN = "Want your own? Open Molds in the panel (the icon next to the clock) and choose New mold. Or just type a task: it asks before it submits.";
const HELP = "If something doesn't work, reply to this email. It comes straight to me.";

// The same colours as the what's-new letter, in its dark form.
const L = {
  page: "#0a0a0a",
  head: "#151515",
  body: "#1c1b1a",
  edge: "#2b2825",
  headLine: "#34312d",
  box: "#252422",
  boxLine: "#3a3733",
  peach: "#e8a383",
  note: "#8e8981",
};
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace";

export type WelcomeMail = { subject: string; html: string; text: string };

const p = (text: string) => `<p style="margin:0 0 20px;font:400 17px/1.65 ${FONT};color:${C.text}">${esc(text)}</p>`;

/** A mold as a card you can tap: its label, its name, what it does, and an arrow. The whole card is the link. */
function mold(m: (typeof MOLDS)[number]): string {
  const href = `${SITE}/library/#${m.id}`;
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px"><tr>` +
    `<td bgcolor="${L.box}" style="background:${L.box};border:1px solid ${L.boxLine};border-left:3px solid ${C.copper};border-radius:12px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td valign="middle"><a href="${href}" style="display:block;padding:16px 8px 16px 18px;text-decoration:none">` +
    `<span style="display:block;font:700 12px/1.4 ${MONO};letter-spacing:.1em;text-transform:uppercase;color:${L.peach}">${esc(m.tag)}</span>` +
    `<span style="display:block;margin-top:3px;font:700 18px/1.3 ${FONT};color:${C.text}">${esc(m.title)}</span>` +
    `<span style="display:block;margin-top:4px;font:400 15px/1.5 ${FONT};color:${C.muted}">${esc(m.body)}</span>` +
    `</a></td>` +
    `<td width="52" align="center" valign="middle"><a href="${href}" style="display:block;padding:16px 18px 16px 0;font:700 22px/1 ${FONT};color:${C.copper};text-decoration:none">&rarr;</a></td>` +
    `</tr></table></td></tr></table>`
  );
}

/** The welcome email. Replies go to the support address, which the sender sets; it is not printed. */
export function welcomeEmail(_opts: { support: string }): WelcomeMail {
  const subject = "Welcome to CopperOS: five molds to try";
  const preheader = "Apply to jobs, build lead lists, monitor social media. Pick one and run it.";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${L.page};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${L.page}">${esc(preheader)}&#8199;&zwnj;&#8199;&zwnj;&#8199;&zwnj;&#8199;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${L.page}" style="background:${L.page}">
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
<td align="right" valign="middle" style="font:700 15px/1 ${MONO};color:${L.peach};text-align:right;white-space:nowrap;text-transform:uppercase">Welcome</td>
</tr></table>
</td></tr>
<tr><td align="left" style="text-align:left;padding:34px 32px 38px">
${p("Hi,")}
${p(INTRO)}
${MOLDS.map(mold).join("\n")}
<div style="height:14px;line-height:14px;font-size:0">&nbsp;</div>
${p(OPEN)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 28px"><tr>
<td align="center" bgcolor="${C.copper}" style="background:${C.copper};border-radius:12px"><a href="${SITE}/library/" style="display:block;padding:18px 20px;font:700 18px/1.3 ${FONT};color:#151515;text-decoration:none;text-align:center;border-radius:12px">See all 24 molds</a></td>
</tr></table>
${p(OWN)}
${p(HELP)}
<div style="height:1px;line-height:1px;background:${L.headLine};margin:12px 0 22px">&nbsp;</div>
<p style="margin:0;font:700 18px/1.4 ${FONT};color:${C.text}">Jasmeet Singh</p>
<p style="margin:2px 0 0;font:400 16px/1.5 ${FONT}"><a href="https://jassydev.com" style="color:${L.peach};text-decoration:none">jassydev.com</a></p>
</td></tr>
</table>
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
<tr><td align="left" style="padding:22px 6px 0">
<p style="margin:0 0 6px;font:400 15px/1.6 ${FONT};color:${L.peach}"><a href="${SITE}/" style="color:${L.peach};text-decoration:none">Website</a> &nbsp;·&nbsp; <a href="${SITE}/setup/" style="color:${L.peach};text-decoration:none">Setup guide</a> &nbsp;·&nbsp; <a href="https://github.com/Jesse0502/CopperOS" style="color:${L.peach};text-decoration:none">GitHub</a></p>
<p style="margin:0;font:400 14px/1.6 ${FONT};color:${L.note}">Sent once, when you signed up.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    "Hi,",
    "",
    INTRO,
    "",
    ...MOLDS.map((m) => `- ${m.title} (${m.tag}): ${m.body} ${SITE}/library/#${m.id}`),
    "",
    OPEN,
    `See all 24 molds: ${SITE}/library/`,
    "",
    OWN,
    "",
    HELP,
    "",
    "Jasmeet Singh",
    "jassydev.com",
    "",
    "Sent once, when you signed up.",
  ].join("\n");

  return { subject, html, text };
}

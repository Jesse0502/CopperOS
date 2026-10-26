// The email a new account gets once, when it signs up (welcome.ts): three steps to start, what a
// mold is, and five molds from the website's library page to begin with. Short on purpose.

import { button, C, esc, FONT, footer, logoRow, shell, SITE } from "./email-kit.js";

const STEPS = [
  { title: "Open the panel", body: "Click the CopperOS icon in Chrome's toolbar." },
  { title: "Type a task", body: "Try “Summarize this page in three bullet points.”" },
  { title: "Approve when it asks", body: "It asks before it submits. Stop ends a task any time." },
];

// From the library page (website/library/index.html); the ids are its anchors.
const MOLDS = [
  { id: "jobs", title: "Apply to jobs", body: "Applies only to the listings that fit" },
  { id: "monitor", title: "Monitor social media", body: "Finds posts worth answering, never posts" },
  { id: "outreach", title: "Cold outreach", body: "Short notes that wait for your approval" },
  { id: "leads", title: "Build a lead list", body: "Adds matches to a Google Sheet" },
  { id: "directories", title: "Submit to directories", body: "Fills each directory's submit form" },
];

const MOLD_HELP =
  "A mold is a task you save once and run again. In the panel, open Molds (the icon next to the clock) and choose New mold. Or start from one of these:";

const INTRO = "CopperOS works in your own Chrome, signed in as you. Tell it what to do in plain words.";

export type WelcomeMail = { subject: string; html: string; text: string };

function step(n: number, s: (typeof STEPS)[number]): string {
  return (
    `<tr><td align="center" style="padding:10px 36px">` +
    `<div style="width:30px;height:30px;margin:0 auto 8px;border:1px solid ${C.copper};border-radius:50%;font:700 14px/28px ${FONT};color:${C.copper};text-align:center">${n}</div>` +
    `<p style="margin:0 0 2px;font:600 16px/1.3 ${FONT};color:${C.text}">${esc(s.title)}</p>` +
    `<p style="margin:0;font:400 14.5px/1.5 ${FONT};color:${C.muted}">${esc(s.body)}</p>` +
    `</td></tr>`
  );
}

/** A mold as a line: its name, linked to the library page, and what it does. */
function mold(m: (typeof MOLDS)[number]): string {
  return (
    `<tr><td align="center" style="padding:7px 36px">` +
    `<a href="${SITE}/library/#${m.id}" style="font:600 15px/1.3 ${FONT};color:${C.copper};text-decoration:none">${esc(m.title)}</a>` +
    `<div style="font:400 13.5px/1.45 ${FONT};color:${C.muted}">${esc(m.body)}</div>` +
    `</td></tr>`
  );
}

/** The welcome email. Replies go to the support address, which the sender sets; it is not printed. */
export function welcomeEmail(_opts: { support: string }): WelcomeMail {
  const subject = "Welcome to CopperOS";
  const preheader = "Open the panel, type a task, approve what it asks.";

  const rows = `${logoRow}
<tr><td align="center" style="padding:12px 36px 4px">
<h1 style="margin:0;font:700 28px/1.2 ${FONT};letter-spacing:-.02em;color:${C.text}">Welcome to <span style="color:${C.copper}">CopperOS</span></h1>
</td></tr>
<tr><td align="center" style="padding:8px 44px 18px">
<p style="margin:0;font:400 16px/1.6 ${FONT};color:${C.muted}">${esc(INTRO)}</p>
</td></tr>
${STEPS.map((s, i) => step(i + 1, s)).join("\n")}
<tr><td style="padding:14px 36px 0"><div style="height:1px;line-height:1px;background:${C.line}">&nbsp;</div></td></tr>
<tr><td align="center" style="padding:20px 44px 10px">
<p style="margin:0;font:400 14.5px/1.55 ${FONT};color:${C.muted}">${esc(MOLD_HELP)}</p>
</td></tr>
${MOLDS.map(mold).join("\n")}
<tr><td align="center" style="padding:18px 36px 26px">${button(`${SITE}/library/`, "See all molds")}</td></tr>
${footer({ first: "Questions? Reply to this email.", last: "Sent once, when you signed up." })}`;
  const html = shell({ subject, preheader, rows });

  const text = [
    "Welcome to CopperOS",
    "",
    INTRO,
    "",
    ...STEPS.map((s, i) => `${i + 1}. ${s.title}: ${s.body}`),
    "",
    MOLD_HELP,
    ...MOLDS.map((m) => `- ${m.title}: ${m.body} (${SITE}/library/#${m.id})`),
    "",
    `See all molds: ${SITE}/library/`,
    "",
    "Questions? Reply to this email.",
    "CopperOS by Jassydev. Sent once, when you signed up.",
  ].join("\n");

  return { subject, html, text };
}

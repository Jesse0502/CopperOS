// Where the Unsubscribe link in CopperOS's product emails goes (updates.ts). A public address behind a
// Function URL; a link only works for the person it was made for, since it carries a signature that only
// this service can make.
//
// A link opened in a browser asks first, and only the button does it: mail scanners and link previews
// open every link in a message, and that must not unsubscribe anyone. A mail app's own Unsubscribe button
// sends the POST itself (RFC 8058), so that answers at once.

import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import { C, esc, FONT } from "./email-kit.js";
import { optOut, validUnsubscribe } from "./updates.js";

function page(status: number, title: string, body: string): LambdaFunctionURLResult {
  return {
    statusCode: status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;background:${C.page};color:${C.text};font:16px/1.6 ${FONT}"><main style="max-width:30rem;margin:12vh auto;padding:0 20px;text-align:center">
<h1 style="font-size:1.5rem;margin:0 0 .75rem">${esc(title)}</h1><div style="color:${C.muted}">${body}</div></main></body></html>`,
  };
}

const button = `<button style="margin-top:1.5rem;padding:.8rem 1.6rem;border:0;border-radius:10px;background:${C.copper};color:#151515;font:700 15px ${FONT};cursor:pointer">Unsubscribe</button>`;

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const query = new URLSearchParams(event.rawQueryString ?? "");
  const userId = query.get("u") ?? "";
  const token = query.get("t") ?? "";
  const method = event.requestContext.http.method;
  try {
    if (!(await validUnsubscribe(userId, token))) return page(400, "This link isn't valid", "<p>Open it again from the email, or write to the address in it.</p>");

    if (method === "POST") {
      // The preview links in test emails have an id no account has: nothing is written for them.
      if (userId !== "preview") await optOut(userId);
      return page(200, "You're unsubscribed", "<p>You won't get product updates from CopperOS.</p>");
    }
    if (method === "GET" || method === "HEAD") {
      return page(200, "Unsubscribe from product updates?", `<p>Emails about what is new in CopperOS will stop.</p><form method="post" action="?${esc(query.toString())}">${button}</form>`);
    }
    return page(405, "Not allowed", "");
  } catch (err) {
    console.error(`[unsubscribe] ${String((err as Error)?.stack ?? err)}`);
    return page(500, "Something went wrong", "<p>Try again in a moment.</p>");
  }
}

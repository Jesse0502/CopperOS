// Sending an email from CopperOS through SES: the welcome email (welcome.ts) and what is new
// (updates.ts). From no-reply@ the sending domain; a reply goes to the support address.

import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

const ses = new SESv2Client({});

export type Mail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Extra headers, such as List-Unsubscribe. */
  headers?: Record<string, string>;
};

export async function sendMail(mail: Mail): Promise<void> {
  const support = process.env.REPLY_TO ?? "hello@jassydev.com";
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: `CopperOS <${process.env.FROM_ADDRESS}>`,
      Destination: { ToAddresses: [mail.to] },
      ReplyToAddresses: [support],
      Content: {
        Simple: {
          Subject: { Data: mail.subject, Charset: "UTF-8" },
          Body: { Html: { Data: mail.html, Charset: "UTF-8" }, Text: { Data: mail.text, Charset: "UTF-8" } },
          ...(mail.headers ? { Headers: Object.entries(mail.headers).map(([Name, Value]) => ({ Name, Value })) } : {}),
        },
      },
    }),
  );
}

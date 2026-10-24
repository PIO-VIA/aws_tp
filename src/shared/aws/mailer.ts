import nodemailer, { type Transporter } from "nodemailer";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { getConfig } from "../config";
import { log } from "../log";

let sesClientInstance: SESv2Client | null = null;
let smtpTransporterInstance: Transporter | null = null;

export interface SendMailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(options: SendMailOptions): Promise<{ success: boolean; messageId?: string }> {
  const config = getConfig();

  if (config.MAIL_DRIVER === "ses") {
    if (!sesClientInstance) {
      sesClientInstance = new SESv2Client({ region: config.AWS_REGION });
    }

    try {
      const res = await sesClientInstance.send(
        new SendEmailCommand({
          FromEmailAddress: config.MAIL_FROM,
          Destination: {
            ToAddresses: [options.to],
          },
          Content: {
            Simple: {
              Subject: { Data: options.subject, Charset: "UTF-8" },
              Body: {
                Text: { Data: options.text, Charset: "UTF-8" },
                ...(options.html ? { Html: { Data: options.html, Charset: "UTF-8" } } : {}),
              },
            },
          },
        }),
      );
      log.info("mailer.sent.ses", { to: options.to, subject: options.subject, messageId: res.MessageId });
      return { success: true, messageId: res.MessageId };
    } catch (err) {
      log.error("mailer.error.ses", { to: options.to, error: err });
      throw err;
    }
  }

  // Pilote SMTP (Mailpit en local)
  if (!smtpTransporterInstance) {
    smtpTransporterInstance = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: false,
      ignoreTLS: true,
    });
  }

  try {
    const info = await smtpTransporterInstance.sendMail({
      from: config.MAIL_FROM,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
    });
    log.info("mailer.sent.smtp", { to: options.to, subject: options.subject, messageId: info.messageId });
    return { success: true, messageId: info.messageId };
  } catch (err) {
    log.error("mailer.error.smtp", { to: options.to, error: err });
    throw err;
  }
}

export function resetMailer(): void {
  sesClientInstance = null;
  smtpTransporterInstance = null;
}

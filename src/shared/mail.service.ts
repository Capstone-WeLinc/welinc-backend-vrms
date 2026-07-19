import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;

  constructor() {
    const host = process.env.SMTP_HOST;
    const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 587;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (host && user && pass) {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: {
          user,
          pass,
        },
      });
      this.logger.log(`SMTP Mailer initialized on host ${host}:${port}`);
    } else {
      this.logger.warn(
        'SMTP environment variables (SMTP_HOST, SMTP_USER, SMTP_PASS) not fully set. Mailer will log to console in development mode.',
      );
    }
  }

  async sendMail(options: {
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<void> {
    const from = process.env.SMTP_FROM || 'WeLinc Logistics <no-reply@welinc.com>';

    if (this.transporter) {
      try {
        await this.transporter.sendMail({
          from,
          to: options.to,
          subject: options.subject,
          text: options.text,
          html: options.html,
        });
        this.logger.log(`Email successfully sent to ${options.to}`);
      } catch (error) {
        this.logger.error(`Failed to send email to ${options.to}`, error);
        this.logFallback(options);
      }
    } else {
      this.logFallback(options);
    }
  }

  private logFallback(options: { to: string; subject: string; text: string }) {
    const logMessage = `
==================================================
📬  [DEVELOPMENT MAIL FALLBACK]
Date:    ${new Date().toISOString()}
To:      ${options.to}
Subject: ${options.subject}
Content:
${options.text}
==================================================
`;
    console.log(logMessage);
  }
}

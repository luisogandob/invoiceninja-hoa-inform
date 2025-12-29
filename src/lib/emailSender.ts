import nodemailer, { Transporter } from 'nodemailer';
import type { SentMessageInfo } from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Email options for financial report
 */
export interface FinancialReportEmailOptions {
  to?: string;
  subject: string;
  text: string;
  html: string;
  pdfBuffer?: Buffer;
  pdfFilename?: string;
}

/**
 * Email send result
 */
export interface EmailResult {
  success: boolean;
  messageId: string;
  response?: string;
}

/**
 * Email Sender using Nodemailer
 * Handles sending financial reports via email
 */
class EmailSender {
  private transporter: Transporter | null = null;
  private from: string;
  private defaultTo: string;

  constructor() {
    this.from = process.env.EMAIL_FROM || '';
    this.defaultTo = process.env.EMAIL_TO || '';
  }

  /**
   * Initialize email transporter
   */
  init(): void {
    if (this.transporter) {
      return;
    }

    const config = {
      host: process.env.EMAIL_HOST,
      port: parseInt(process.env.EMAIL_PORT || '587'),
      secure: process.env.EMAIL_SECURE === 'true',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
      }
    };

    // Validate configuration
    if (!config.host || !config.auth.user || !config.auth.pass) {
      throw new Error('Email configuration missing. Please set EMAIL_HOST, EMAIL_USER, and EMAIL_PASSWORD in .env file');
    }

    this.transporter = nodemailer.createTransport(config);
    console.log('Email transporter initialized successfully');
  }

  /**
   * Send financial report email with PDF attachment
   */
  async sendFinancialReport(options: FinancialReportEmailOptions): Promise<EmailResult> {
    this.init();

    const {
      to = this.defaultTo,
      subject,
      text,
      html,
      pdfBuffer,
      pdfFilename = 'financial-report.pdf'
    } = options;

    if (!to) {
      throw new Error('Recipient email address is required');
    }

    const mailOptions: any = {
      from: this.from,
      to: to,
      subject: subject,
      text: text,
      html: html,
      attachments: []
    };

    // Add PDF attachment if provided
    if (pdfBuffer) {
      mailOptions.attachments.push({
        filename: pdfFilename,
        content: pdfBuffer,
        contentType: 'application/pdf'
      });
    }

    try {
      const info: SentMessageInfo = await this.transporter!.sendMail(mailOptions);
      console.log('Email sent successfully:', info.messageId);
      return {
        success: true,
        messageId: info.messageId,
        response: info.response
      };
    } catch (error) {
      console.error('Error sending email:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Send a simple notification email
   */
  async sendNotification(to: string, subject: string, message: string): Promise<EmailResult> {
    this.init();

    const mailOptions = {
      from: this.from,
      to: to || this.defaultTo,
      subject: subject,
      text: message,
      html: `<p>${message.replace(/\n/g, '<br>')}</p>`
    };

    try {
      const info: SentMessageInfo = await this.transporter!.sendMail(mailOptions);
      console.log('Notification sent successfully:', info.messageId);
      return {
        success: true,
        messageId: info.messageId
      };
    } catch (error) {
      console.error('Error sending notification:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Verify email configuration
   */
  async verifyConnection(): Promise<boolean> {
    this.init();

    try {
      await this.transporter!.verify();
      console.log('Email connection verified successfully');
      return true;
    } catch (error) {
      console.error('Email connection verification failed:', (error as Error).message);
      return false;
    }
  }
}

export default EmailSender;

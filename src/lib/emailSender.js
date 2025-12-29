import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Email Sender using Nodemailer
 * Handles sending expense reports via email
 */
class EmailSender {
  constructor() {
    this.transporter = null;
    this.from = process.env.EMAIL_FROM;
    this.defaultTo = process.env.EMAIL_TO;
  }

  /**
   * Initialize email transporter
   */
  init() {
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
   * Send expense report email with PDF attachment
   * @param {Object} options - Email options
   * @param {string} options.to - Recipient email address(es)
   * @param {string} options.subject - Email subject
   * @param {string} options.text - Plain text body
   * @param {string} options.html - HTML body
   * @param {Buffer} options.pdfBuffer - PDF attachment buffer
   * @param {string} options.pdfFilename - PDF filename
   * @returns {Promise<Object>} Send result
   */
  async sendExpenseReport(options) {
    this.init();

    const {
      to = this.defaultTo,
      subject,
      text,
      html,
      pdfBuffer,
      pdfFilename = 'expense-report.pdf'
    } = options;

    if (!to) {
      throw new Error('Recipient email address is required');
    }

    const mailOptions = {
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
      const info = await this.transporter.sendMail(mailOptions);
      console.log('Email sent successfully:', info.messageId);
      return {
        success: true,
        messageId: info.messageId,
        response: info.response
      };
    } catch (error) {
      console.error('Error sending email:', error.message);
      throw error;
    }
  }

  /**
   * Send a simple notification email
   * @param {string} to - Recipient email
   * @param {string} subject - Email subject
   * @param {string} message - Email message
   * @returns {Promise<Object>} Send result
   */
  async sendNotification(to, subject, message) {
    this.init();

    const mailOptions = {
      from: this.from,
      to: to || this.defaultTo,
      subject: subject,
      text: message,
      html: `<p>${message.replace(/\n/g, '<br>')}</p>`
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      console.log('Notification sent successfully:', info.messageId);
      return {
        success: true,
        messageId: info.messageId
      };
    } catch (error) {
      console.error('Error sending notification:', error.message);
      throw error;
    }
  }

  /**
   * Verify email configuration
   * @returns {Promise<boolean>} True if configuration is valid
   */
  async verifyConnection() {
    this.init();

    try {
      await this.transporter.verify();
      console.log('Email connection verified successfully');
      return true;
    } catch (error) {
      console.error('Email connection verification failed:', error.message);
      return false;
    }
  }
}

export default EmailSender;

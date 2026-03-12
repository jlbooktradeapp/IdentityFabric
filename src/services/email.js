/**
 * Email Service — sends reports via anonymous SMTP relay.
 * Uses nodemailer with no authentication (internal relay at smtp.tuhs.prv).
 */
const nodemailer = require('nodemailer');
const config = require('../config');
const logger = require('../config/logger');

// HTML escape to prevent injection in email templates
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Create reusable transporter — anonymous (no auth), plain SMTP
const transporter = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.secure,
  tls: {
    // Internal relay — accept self-signed certs
    rejectUnauthorized: false,
  },
  // No auth block = anonymous relay
});

/**
 * Send a scheduled report email with CSV attachment.
 *
 * @param {Object} options
 * @param {string} options.to - Recipient email
 * @param {string} options.scheduleName - Name of the schedule
 * @param {string} options.reportName - Name of the report
 * @param {string} options.description - Schedule description
 * @param {string} options.schedule - Frequency (Daily, Weekly, etc.)
 * @param {string} options.createdBy - Who created the schedule
 * @param {number} options.rowCount - Number of rows in the report
 * @param {string} options.csvContent - CSV string to attach
 * @param {string} options.csvFilename - Filename for the attachment
 */
async function sendScheduledReport(options) {
  const {
    to,
    scheduleName,
    reportName,
    description,
    schedule,
    createdBy,
    rowCount,
    csvContent,
    csvFilename,
  } = options;

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit',
  });

  const htmlBody = `
    <div style="font-family: Segoe UI, Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1a1d23; padding: 24px; border-radius: 8px 8px 0 0;">
        <h2 style="color: #4fd1c5; margin: 0; font-size: 20px;">Identity Fabric — Scheduled Report</h2>
      </div>
      <div style="background: #f8f9fa; padding: 24px; border: 1px solid #e2e8f0;">
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr>
            <td style="padding: 8px 12px; font-weight: 600; color: #4a5568; width: 140px;">Schedule Name</td>
            <td style="padding: 8px 12px; color: #2d3748;">${escHtml(scheduleName)}</td>
          </tr>
          <tr style="background: #fff;">
            <td style="padding: 8px 12px; font-weight: 600; color: #4a5568;">Report</td>
            <td style="padding: 8px 12px; color: #2d3748;">${escHtml(reportName)}</td>
          </tr>
          ${description ? `<tr>
            <td style="padding: 8px 12px; font-weight: 600; color: #4a5568;">Description</td>
            <td style="padding: 8px 12px; color: #2d3748;">${escHtml(description)}</td>
          </tr>` : ''}
          <tr style="background: #fff;">
            <td style="padding: 8px 12px; font-weight: 600; color: #4a5568;">Schedule</td>
            <td style="padding: 8px 12px; color: #2d3748;">${escHtml(schedule)}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; font-weight: 600; color: #4a5568;">Created By</td>
            <td style="padding: 8px 12px; color: #2d3748;">${escHtml(createdBy)}</td>
          </tr>
          <tr style="background: #fff;">
            <td style="padding: 8px 12px; font-weight: 600; color: #4a5568;">Delivered</td>
            <td style="padding: 8px 12px; color: #2d3748;">${dateStr} at ${timeStr}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; font-weight: 600; color: #4a5568;">Records</td>
            <td style="padding: 8px 12px; color: #2d3748;">${rowCount.toLocaleString()} rows</td>
          </tr>
        </table>
      </div>
      <div style="background: #edf2f7; padding: 16px 24px; border-radius: 0 0 8px 8px; border: 1px solid #e2e8f0; border-top: none;">
        <p style="margin: 0; font-size: 12px; color: #718096;">
          Report data is attached as a CSV file. This is an automated message from Identity Fabric.
          To stop receiving this report, contact the schedule creator or an administrator.
        </p>
      </div>
    </div>
  `;

  const textBody = [
    'Identity Fabric — Scheduled Report',
    '',
    `Schedule Name: ${scheduleName}`,
    `Report: ${reportName}`,
    description ? `Description: ${description}` : null,
    `Schedule: ${schedule}`,
    `Created By: ${createdBy}`,
    `Delivered: ${dateStr} at ${timeStr}`,
    `Records: ${rowCount.toLocaleString()} rows`,
    '',
    'Report data is attached as a CSV file.',
  ].filter(Boolean).join('\n');

  const mailOptions = {
    from: `"Identity Fabric Reports" <${config.smtp.from}>`,
    to,
    subject: `[Identity Fabric] ${scheduleName} — ${reportName} (${now.toISOString().split('T')[0]})`,
    text: textBody,
    html: htmlBody,
    attachments: [
      {
        filename: csvFilename,
        content: csvContent,
        contentType: 'text/csv',
      },
    ],
  };

  const info = await transporter.sendMail(mailOptions);
  logger.info(`Report email sent: "${scheduleName}" to ${to} (messageId: ${info.messageId})`);
  return info;
}

/**
 * Verify SMTP connectivity (called at startup).
 */
async function verifyConnection() {
  try {
    await transporter.verify();
    logger.info(`SMTP connected: ${config.smtp.host}:${config.smtp.port} (anonymous)`);
    return true;
  } catch (err) {
    logger.warn(`SMTP verification failed: ${err.message} — scheduled report emails may not send.`);
    return false;
  }
}

module.exports = {
  sendScheduledReport,
  verifyConnection,
};
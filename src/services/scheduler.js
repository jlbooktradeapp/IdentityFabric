/**
 * Report Scheduler — checks for due report schedules and delivers them via email.
 *
 * Runs on a configurable interval (default: every 60 seconds).
 * For each enabled schedule, checks if enough time has passed since lastRun
 * based on the configured frequency. If due, runs the report, generates CSV,
 * sends the email, and updates lastRun/nextRun timestamps.
 */
const config = require('../config');
const logger = require('../config/logger');
const mongo = require('./mongo');
const reports = require('./reports');
const email = require('./email');
const { checkDuplicates } = require('./duplicateCheck');

// Frequency → milliseconds mapping (minimum interval between runs)
const FREQUENCY_MS = {
  daily:     24 * 60 * 60 * 1000,
  weekly:    7 * 24 * 60 * 60 * 1000,
  biweekly:  14 * 24 * 60 * 60 * 1000,
  monthly:   30 * 24 * 60 * 60 * 1000,
  quarterly: 90 * 24 * 60 * 60 * 1000,
};

let intervalHandle = null;
let isRunning = false;

/**
 * Convert a schedule's runTime to 24-hour format.
 * Returns { hour24, minute } or null if no runTime.
 */
function getRunTime24(schedule) {
  if (!schedule.runTime || !schedule.runTime.hour) return null;
  let h = schedule.runTime.hour;
  const m = schedule.runTime.minute || 0;
  const ampm = (schedule.runTime.ampm || 'AM').toUpperCase();
  if (ampm === 'AM' && h === 12) h = 0;
  else if (ampm === 'PM' && h !== 12) h += 12;
  return { hour24: h, minute: m };
}

/**
 * Check if a schedule is due to run.
 * A schedule is due when:
 *   1. Enough time has passed since lastRun (based on frequency), AND
 *   2. The current hour/minute is at or past the configured run time.
 */
function isDue(schedule) {
  if (!schedule.enabled) return false;

  const now = new Date();
  const intervalMs = FREQUENCY_MS[schedule.schedule] || FREQUENCY_MS.daily;

  // Check if enough time has passed since last run
  if (schedule.lastRun) {
    const lastRunTime = new Date(schedule.lastRun).getTime();
    // Use 90% of interval to avoid drift causing missed runs
    if ((now.getTime() - lastRunTime) < (intervalMs * 0.9)) return false;
  }

  // Check time-of-day — only run at or after the configured time
  const rt = getRunTime24(schedule);
  if (rt) {
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const targetMinutes = rt.hour24 * 60 + rt.minute;
    // Allow a 5-minute window past the target time
    if (nowMinutes < targetMinutes || nowMinutes > targetMinutes + 5) return false;
  }

  return true;
}

/**
 * Calculate the next run time based on frequency and configured run time.
 */
function calcNextRun(schedule) {
  const intervalMs = FREQUENCY_MS[schedule.schedule] || FREQUENCY_MS.daily;
  const next = new Date(Date.now() + intervalMs);
  // Set the exact time if configured
  const rt = getRunTime24(schedule);
  if (rt) {
    next.setHours(rt.hour24, rt.minute, 0, 0);
  }
  return next.toISOString();
}

/**
 * Run a report and return all results (no pagination limit).
 * Passes any saved reportParams (groups, departments, etc.) to the report.
 */
async function runFullReport(reportId, reportParams = {}) {
  const params = { limit: 0, ...reportParams };
  // Convert arrays to JSON strings as the report runner expects
  if (params.groups && Array.isArray(params.groups)) {
    params.groups = JSON.stringify(params.groups);
  }
  if (params.departments && Array.isArray(params.departments)) {
    params.departments = JSON.stringify(params.departments);
  }
  const result = await reports.runReport(reportId, params);
  return result;
}

/**
 * Generate CSV string from report data rows.
 */
function generateCsv(rows) {
  if (!rows || rows.length === 0) return '';

  // Collect all unique keys across all rows
  const keys = new Set();
  rows.forEach(row => {
    Object.keys(row).forEach(k => {
      if (!k.startsWith('_meta') && k !== '_sources' && k !== '_lastUpdated'
          && k !== '_lastSeenBy' && k !== '_createdAt' && k !== '_modifiedAt') {
        keys.add(k);
      }
    });
  });

  const headers = [...keys];
  const csvRows = [headers.join(',')];

  for (const row of rows) {
    const values = headers.map(h => {
      let val = row[h];
      if (val === null || val === undefined) return '';
      if (typeof val === 'object') val = JSON.stringify(val);
      val = String(val);

      // Prevent CSV formula injection — prefix dangerous chars so Excel won't execute them
      if (/^[=+\-@\t\r]/.test(val)) {
        val = "'" + val;
      }

      val = val.replace(/"/g, '""');
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        val = `"${val}"`;
      }
      return val;
    });
    csvRows.push(values.join(','));
  }

  return csvRows.join('\n');
}

/**
 * Process a single schedule — run report, generate CSV, send email.
 */
async function processSchedule(schedule) {
  const col = await mongo.getReportSchedulesCollection();
  const { ObjectId } = require('mongodb');

  try {
    logger.info(`Scheduler: Running "${schedule.name}" (report: ${schedule.reportId})...`);

    // Run the full report with any saved parameters (groups, departments, etc.)
    const result = await runFullReport(schedule.reportId, schedule.reportParams || {});
    const rows = result.data?.results || result.data || [];
    const dataArray = Array.isArray(rows) ? rows : [rows];
    const rowCount = dataArray.length;

    // Generate CSV
    const csv = generateCsv(dataArray);
    const dateStr = new Date().toISOString().split('T')[0];
    const safeName = schedule.reportId.replace(/[^a-zA-Z0-9-_]/g, '_');
    const csvFilename = `${safeName}_${dateStr}.csv`;

    // Send email
    const freq = schedule.schedule
      ? schedule.schedule.charAt(0).toUpperCase() + schedule.schedule.slice(1)
      : 'Scheduled';

    await email.sendScheduledReport({
      to: schedule.deliverTo,
      scheduleName: schedule.name,
      reportName: schedule.reportName || schedule.reportId,
      description: schedule.description || '',
      schedule: freq,
      createdBy: schedule.createdBy || 'Unknown',
      rowCount,
      csvContent: csv,
      csvFilename,
    });

    // Update lastRun, nextRun, and clear any previous error
    const nextRun = calcNextRun(schedule);
    await col.updateOne(
      { _id: new ObjectId(schedule._id) },
      {
        $set: {
          lastRun: new Date().toISOString(),
          nextRun,
          lastStatus: 'success',
          lastError: null,
          updatedAt: new Date().toISOString(),
        },
      }
    );

    logger.info(`Scheduler: "${schedule.name}" delivered to ${schedule.deliverTo} (${rowCount} rows)`);
  } catch (err) {
    logger.error(`Scheduler: Failed "${schedule.name}": ${err.message}`);

    // Record the error but don't disable — will retry next cycle
    try {
      await col.updateOne(
        { _id: new ObjectId(schedule._id) },
        {
          $set: {
            lastRun: new Date().toISOString(),
            nextRun: calcNextRun(schedule),
            lastStatus: 'error',
            lastError: err.message,
            updatedAt: new Date().toISOString(),
          },
        }
      );
    } catch (updateErr) {
      logger.error(`Scheduler: Failed to update error status: ${updateErr.message}`);
    }
  }
}

/**
 * Main tick — called on each interval. Checks all schedules and processes due ones.
 */
async function tick() {
  if (isRunning) {
    logger.debug('Scheduler: Previous tick still running, skipping.');
    return;
  }

  isRunning = true;
  try {
    const col = await mongo.getReportSchedulesCollection();
    const schedules = await col.find({ enabled: true }).toArray();

    let dueCount = 0;
    for (const schedule of schedules) {
      if (isDue(schedule)) {
        dueCount++;
        await processSchedule(schedule);
      }
    }

    if (dueCount > 0) {
      logger.info(`Scheduler: Processed ${dueCount} due schedule(s).`);
    }

    // Run duplicate check on every tick — it is fast (projection-only scan)
    // and keeps the Duplicate flag current after every AD sync cycle.
    await checkDuplicates();
  } catch (err) {
    logger.error(`Scheduler tick error: ${err.message}`);
  } finally {
    isRunning = false;
  }
}

/**
 * Start the scheduler loop.
 */
function start() {
  if (!config.scheduler.enabled) {
    logger.info('Scheduler: Disabled via config.');
    return;
  }

  const intervalMs = config.scheduler.checkIntervalMs;
  logger.info(`Scheduler: Starting (check interval: ${intervalMs / 1000}s)`);

  // Verify SMTP on startup (non-blocking)
  email.verifyConnection();

  // Run first check after a short delay (let MongoDB fully initialize)
  setTimeout(() => {
    tick();
    intervalHandle = setInterval(tick, intervalMs);
  }, 5000);
}

/**
 * Stop the scheduler.
 */
function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('Scheduler: Stopped.');
  }
}

module.exports = { start, stop };
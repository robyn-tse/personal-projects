/**
 * sweep.js — main entry point
 * Usage: npm run sweep  (or: node src/sweep.js)
 * 
 * What it does:
 *   1. Fetches all new threads in your Gmail `wedding` label
 *   2. Downloads PDF/doc attachments
 *   3. Extracts text from PDFs
 *   4. Sends each reply + attachments to Claude for evaluation
 *      (pricing extracted, DKK→USD converted, capacity + budget checked, red flags flagged)
 *   5. Posts a digest DM to you on Slack
 *   6. Saves a full log to logs/
 */

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchWeddingThreads } from './gmail.js';
import { parsePdfBuffer, evaluateWithClaude } from './pdf.js';
import { sendSlackDigest } from './slack.js';
import { detectBounces, checkOverdueOutreach } from './alerts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.join(__dirname, '../logs');

async function sweep() {
  console.log('\n── Wedding Monitor sweep ─────────────────────────────────');
  console.log(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  console.log('──────────────────────────────────────────────────────────\n');

  mkdirSync(LOGS_DIR, { recursive: true });

  // 1. Fetch new threads
  const threads = await fetchWeddingThreads();

  // 1a. Detect bounces
  const bounces = detectBounces(threads);
  if (bounces.length > 0) {
    console.log('\n⚠️  ' + bounces.length + ' bounce(s) detected');
    bounces.forEach(b => console.log('   ✗ ' + b.subject + ' — ' + b.from));
  }

  // 1b. Check for overdue outreach (no reply after 36h)
  const overdue = await checkOverdueOutreach();
  if (overdue.length > 0) {
    const nudgeHours = process.env.NUDGE_HOURS || 36;
    console.log('\n⏰  ' + overdue.length + ' overdue (no reply after ' + nudgeHours + 'h)');
    overdue.forEach(o => console.log('   → ' + o.to + ' — "' + o.subject + '" (' + o.hoursElapsed + 'h ago)'));
  }

  const nonBounceThreads = threads.filter(t => !bounces.find(b => b.threadId === t.threadId));

  if (nonBounceThreads.length === 0 && bounces.length === 0 && overdue.length === 0) {
    await sendSlackDigest({ results: [], bounces: [], overdue: [] });
    return;
  }

  // 2. Process each non-bounce thread
  const results = [];

  for (const thread of nonBounceThreads) {
    console.log(`\nProcessing: "${thread.subject}" from ${thread.from}`);

    // 3. Extract text from PDF attachments
    const pdfTexts = [];
    for (const att of thread.attachments) {
      if (att.mimeType.includes('pdf')) {
        console.log(`  Parsing PDF: ${att.filename}`);
        const text = await parsePdfBuffer(att.buffer);
        pdfTexts.push(`[${att.filename}]\n${text}`);
      }
    }

    // 4. Evaluate with Claude
    console.log(`  Evaluating with Claude...`);
    const rawEval = await evaluateWithClaude({
      from: thread.from,
      subject: thread.subject,
      body: thread.body,
      pdfTexts,
    });

    // Pull the CATEGORY classification off the top, then clean it from the displayed text
    const catMatch = rawEval.match(/CATEGORY:\s*(VENUE|VENDOR|TRAVEL|OTHER)/i);
    const category = catMatch ? catMatch[1].toUpperCase() : 'OTHER';
    const evaluation = rawEval.replace(/^\s*CATEGORY:.*(\r?\n)?/im, '').trim();

    results.push({ ...thread, pdfTexts, evaluation, category });

    // Print to console too
    console.log(`  Category: ${category}`);
    console.log('\n' + evaluation + '\n');
    console.log('──────────────────────────────────────────────────────────');
  }

  // 5. Save full log
  const logFile = path.join(LOGS_DIR, `sweep-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(logFile, JSON.stringify(results.map(r => ({
    threadId: r.threadId,
    messageId: r.messageId,
    category: r.category,
    from: r.from,
    subject: r.subject,
    date: r.date,
    body: r.body,
    attachmentNames: r.attachments.map(a => a.filename),
    evaluation: r.evaluation,
    sweptAt: new Date().toISOString(),
  })), null, 2));
  console.log(`\n✓ Log saved: ${logFile}`);

  // 6. Send Slack digest
  await sendSlackDigest({ results, bounces, overdue });

  console.log('\n✓ Sweep complete.\n');
}

sweep().catch(err => {
  console.error('Sweep failed:', err);
  process.exit(1);
});

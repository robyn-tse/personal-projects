/**
 * send-outreach.js — send venue (or vendor/planner) outreach emails
 * Usage: npm run send
 * 
 * Reads from config/outreach-queue.json, sends each email, 
 * tags it with the `wedding` Gmail label, and marks it as sent.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendEmail } from './gmail.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = path.join(__dirname, '../config/outreach-queue.json');

function loadQueue() {
  if (!existsSync(QUEUE_PATH)) {
    console.log('No outreach queue found at config/outreach-queue.json');
    console.log('Create one using the template — see README.md');
    process.exit(0);
  }
  return JSON.parse(readFileSync(QUEUE_PATH, 'utf8'));
}

async function sendOutreach() {
  const queue = loadQueue();
  const pending = queue.filter(e => !e.sentAt);

  if (pending.length === 0) {
    console.log('No pending outreach in queue. All done!');
    return;
  }

  console.log(`\n── Sending ${pending.length} outreach email${pending.length > 1 ? 's' : ''} ──\n`);

  for (const item of pending) {
    try {
      console.log(`Sending to: ${item.to} — "${item.subject}"`);
      await sendEmail({
        to: item.to,
        subject: item.subject,
        body: item.body,
        labelName: process.env.GMAIL_LABEL || 'wedding',
      });
      item.sentAt = new Date().toISOString();
      console.log(`  ✓ Sent + tagged with wedding label`);
    } catch (err) {
      console.error(`  ✗ Failed: ${err.message}`);
      item.error = err.message;
    }
  }

  writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));
  console.log('\n✓ Queue updated.\n');
}

sendOutreach().catch(err => {
  console.error('Send failed:', err);
  process.exit(1);
});

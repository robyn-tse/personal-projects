/**
 * alerts.js — bounce detection + 36-hour no-reply nudges
 *
 * Bounce detection:
 *   Gmail delivers bounce notifications from mailer-daemon / postmaster.
 *   We scan the wedding label for those senders and flag them.
 *   Setup: create a Gmail filter so these auto-get the wedding label:
 *     From: (mailer-daemon OR postmaster) → apply label: wedding
 *
 * 36-hour nudge:
 *   Compares sentAt timestamps in outreach-queue.json against now.
 *   If no reply has arrived after NUDGE_HOURS, fires an alert.
 *   Reply detection is durable, not sweep-bound: fetchRepliedDomains() asks
 *   Gmail which recipient domains have any inbound message in the wedding
 *   label, and the first time a domain is seen to have replied we stamp
 *   repliedAt on its queue item (matched by domain). Stamped items are then
 *   skipped permanently, so a venue that replied in an earlier sweep is never
 *   falsely nudged.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchRepliedDomains } from './gmail.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = path.join(__dirname, '../config/outreach-queue.json');

const NUDGE_HOURS = Number(process.env.NUDGE_HOURS) || 36;
const BOUNCE_SENDERS = ['mailer-daemon', 'postmaster', 'mail delivery', 'delivery status', 'undeliverable'];

export function detectBounces(threads) {
  return threads.filter(thread => {
    const fromLower = thread.from.toLowerCase();
    const subjectLower = (thread.subject || '').toLowerCase();
    return (
      BOUNCE_SENDERS.some(s => fromLower.includes(s)) ||
      subjectLower.includes('delivery failure') ||
      subjectLower.includes('undeliverable') ||
      subjectLower.includes('mail delivery failed') ||
      subjectLower.includes('returned mail')
    );
  });
}

export async function checkOverdueOutreach() {
  if (!existsSync(QUEUE_PATH)) return [];
  const queue = JSON.parse(readFileSync(QUEUE_PATH, 'utf8'));

  // Items still awaiting a reply. If none, there's nothing to check or reconcile.
  const pending = queue.filter(item => item.sentAt && !item.repliedAt && !item.dismissed);
  if (pending.length === 0) return [];

  // Durable reply reconciliation: ask Gmail which recipient domains have
  // actually replied (any inbound message in the wedding label), independent
  // of what landed in this sweep. This backfills venues that replied in an
  // earlier sweep and keeps the check robust going forward. Matching is by
  // DOMAIN, so a reply from a different mailbox than the one we wrote to
  // (e.g. selskab@ when we emailed hotel@) still counts.
  let repliedDomains = new Map();
  try {
    repliedDomains = await fetchRepliedDomains();
  } catch (err) {
    console.warn(`  ↳ Could not reconcile replies from Gmail: ${err.message}`);
  }

  const now = Date.now();
  const overdue = [];
  let queueChanged = false;

  for (const item of pending) {
    const recipientDomain = item.to.split('@')[1]?.toLowerCase() || '';

    // They replied — stamp it durably on the queue so it's never nudged again.
    if (recipientDomain && repliedDomains.has(recipientDomain)) {
      item.repliedAt = repliedDomains.get(recipientDomain) || new Date().toISOString();
      queueChanged = true;
      continue;
    }

    const hoursElapsed = (now - new Date(item.sentAt).getTime()) / (1000 * 60 * 60);
    if (hoursElapsed < NUDGE_HOURS) continue;

    overdue.push({
      id: item.id,
      to: item.to,
      subject: item.subject,
      sentAt: item.sentAt,
      hoursElapsed: Math.round(hoursElapsed),
      category: item.category || 'unknown',
    });
  }

  if (queueChanged) {
    writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2) + '\n');
  }

  return overdue;
}

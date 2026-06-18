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
 *   If no reply thread exists for a sent email after NUDGE_HOURS, fires alert.
 *   A reply is detected by checking whether any seen thread subject matches
 *   the outreach subject (Re: ...) or the recipient domain has replied.
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = path.join(__dirname, '../config/outreach-queue.json');
const STATE_PATH = path.join(__dirname, '../logs/last-sweep.json');

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

export function checkOverdueOutreach(threads) {
  if (!existsSync(QUEUE_PATH)) return [];
  const queue = JSON.parse(readFileSync(QUEUE_PATH, 'utf8'));

  // Load seen thread metadata to check for replies
  let seenThreads = [];
  if (existsSync(STATE_PATH)) {
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    seenThreads = state.seenThreadIds || [];
  }

  // Build a set of reply signals from threads fetched this sweep
  // A reply matches if the thread subject contains "Re:" + original subject words
  // OR the sender domain matches the outreach recipient domain
  const replySignals = threads.map(t => ({
    subjectLower: (t.subject || '').toLowerCase(),
    fromDomain: t.from.split('@')[1]?.split('>')[0]?.toLowerCase() || '',
  }));

  const now = Date.now();
  const overdue = [];

  for (const item of queue) {
    if (!item.sentAt || item.repliedAt || item.dismissed) continue;

    const sentMs = new Date(item.sentAt).getTime();
    const hoursElapsed = (now - sentMs) / (1000 * 60 * 60);

    if (hoursElapsed < NUDGE_HOURS) continue;

    // Check if we've seen a reply (heuristic matching)
    const recipientDomain = item.to.split('@')[1]?.toLowerCase() || '';
    const originalSubjectWords = item.subject.toLowerCase().split(' ').filter(w => w.length > 3);

    const hasReply = replySignals.some(signal =>
      signal.fromDomain === recipientDomain ||
      originalSubjectWords.some(word => signal.subjectLower.includes(word))
    );

    if (!hasReply) {
      overdue.push({
        id: item.id,
        to: item.to,
        subject: item.subject,
        sentAt: item.sentAt,
        hoursElapsed: Math.round(hoursElapsed),
        category: item.category || 'unknown',
      });
    }
  }

  return overdue;
}

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

export function checkOverdueOutreach(conversations = []) {
  if (!existsSync(QUEUE_PATH)) return [];
  const queue = JSON.parse(readFileSync(QUEUE_PATH, 'utf8'));

  // Index live wedding-label conversations by the contact's domain.
  // A venue that's been un-labeled (e.g. rejected) simply won't appear here,
  // and a venue that replied will have an inbound message as its latest.
  const byDomain = new Map();
  for (const c of conversations) byDomain.set(c.counterpartyDomain, c);

  const now = Date.now();
  const overdue = [];

  for (const item of queue) {
    if (!item.sentAt || item.dismissed || item.repliedAt || !item.to) continue;

    const domain = item.to.split('@')[1]?.toLowerCase() || '';
    const conv = byDomain.get(domain);
    if (!conv) continue;                  // no longer in the wedding label → rejected/removed, not overdue
    const last = conv.messages[conv.messages.length - 1];
    if (!last || !last.fromMe) continue;  // latest message isn't mine → they replied, not overdue

    const lastMs = new Date(last.date).getTime();
    const baseMs = isNaN(lastMs) ? new Date(item.sentAt).getTime() : lastMs;
    const hoursElapsed = (now - baseMs) / (1000 * 60 * 60);
    if (hoursElapsed < NUDGE_HOURS) continue;

    overdue.push({
      id: item.id,
      to: item.to,
      subject: item.subject,
      hoursElapsed: Math.round(hoursElapsed),
      category: item.category || 'venue',
    });
  }

  return overdue;
}

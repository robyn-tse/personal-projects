/**
 * status.js — post a SEMANTIC "what needs my attention" board to Slack.
 * Usage: npm run status  (or: node src/status.js)
 *
 * Groups all wedding-label threads by contact, then has Claude read each contact's
 * full correspondence and judge what genuinely still needs attention — catching
 * "they replied but dodged my question" and "a new thread doesn't resolve an old one".
 * Posts to SLACK_CHANNEL_DEFAULT. Good as a daily 10am summary (see setup-cron.sh).
 */

import 'dotenv/config';
import { fetchWeddingConversations } from './gmail.js';
import { assessContactThreads } from './pdf.js';
import { sendStatusBoard } from './slack.js';

function buildTranscript(threads) {
  return threads.map(t => {
    const body = t.messages.map(m =>
      `[${m.fromMe ? 'ME' : 'THEM'} · ${m.date}]\n${m.text || '(no text)'}`
    ).join('\n\n');
    return `── Thread: ${t.subject || '(no subject)'} ──\n${body}`;
  }).join('\n\n========================\n\n');
}

function parseAssessment(text) {
  const grab = (label, next) => {
    const re = new RegExp(`${label}:\\s*([\\s\\S]*?)(?:\\n\\s*(?:${next})\\s*:|$)`, 'i');
    return (text.match(re)?.[1] || '').trim();
  };
  let status = grab('STATUS', 'OPEN ITEM|NEXT').toUpperCase();
  if (status.includes('NEEDS')) status = 'NEEDS MY ATTENTION';
  else if (status.includes('WAITING')) status = 'WAITING ON THEM';
  else status = 'NO OPEN ITEMS';
  return {
    status,
    openItem: grab('OPEN ITEM', 'NEXT|STATUS'),
    next: grab('NEXT', 'STATUS|OPEN ITEM'),
  };
}

async function status() {
  console.log('\n── Wedding status board (semantic) ───────────────────────');
  const threads = await fetchWeddingConversations();
  console.log(`Found ${threads.length} thread(s). Grouping by contact...`);

  // Group threads by counterparty domain (so a contact's multiple threads are judged together)
  const groups = new Map();
  for (const t of threads) {
    const key = t.counterpartyDomain;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const assessments = [];
  for (const [domain, ts] of groups) {
    // Display name: the most descriptive counterparty name in the group, else the domain
    const name = ts.map(t => t.counterpartyName).sort((a, b) => b.length - a.length)[0] || domain;
    console.log(`  Assessing ${name} (${ts.length} thread(s))...`);
    const raw = await assessContactThreads({ name, transcript: buildTranscript(ts) });
    const parsed = parseAssessment(raw);

    // Whose turn it is is set by who actually sent the LAST email (reliable) — not the
    // model — but only when there's an open item. Closed / no-action threads keep the
    // model's "NO OPEN ITEMS" read. This stops the model from mislabeling whose turn it is.
    if (parsed.status !== 'NO OPEN ITEMS') {
      const latest = ts.flatMap(t => t.messages).reduce((a, b) => new Date(b.date) >= new Date(a.date) ? b : a);
      parsed.status = latest.fromMe ? 'WAITING ON THEM' : 'NEEDS MY ATTENTION';
    }

    assessments.push({ name, domain, ...parsed });
    console.log(`    → ${parsed.status}`);
  }

  await sendStatusBoard(assessments);
  console.log('✓ Done.\n');
}

status().catch(err => {
  console.error('Status board failed:', err);
  process.exit(1);
});

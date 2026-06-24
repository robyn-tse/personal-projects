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
import { fetchWeddingConversations, threadIdsWithDrafts, createDraftReply } from './gmail.js';
import { assessContactThreads, draftReply } from './pdf.js';
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
    const latest = ts.flatMap(t => t.messages).reduce((a, b) => new Date(b.date) >= new Date(a.date) ? b : a);

    let parsed;
    try {
      parsed = parseAssessment(await assessContactThreads({ name, transcript: buildTranscript(ts) }));
    } catch (err) {
      // The API failed even after retries. NEVER silently drop the contact — fall
      // back to a deterministic last-sender read so it still shows on the board.
      console.warn(`    ⚠️ Assessment failed (${err.message}) — using last-sender fallback.`);
      parsed = {
        status: latest.fromMe ? 'WAITING ON THEM' : 'NEEDS MY ATTENTION',
        openItem: '(could not auto-assess — review this thread manually)',
        next: '',
      };
    }

    // Safety net only: if I literally sent the last email, the ball can't be in my
    // court, so downgrade a stray "NEEDS MY ATTENTION" to "WAITING ON THEM". The
    // harder call — when THEY sent last, is it a real reply or just an auto-ack? — is
    // left to the semantic judgment above (an acknowledgment stays WAITING ON THEM).
    if (latest.fromMe && parsed.status === 'NEEDS MY ATTENTION') {
      parsed.status = 'WAITING ON THEM';
    }

    // Stash the threads + latest message so we can draft a reply later if needed.
    assessments.push({ name, domain, ...parsed, _threads: ts, _latest: latest });
    console.log(`    → ${parsed.status}`);
  }

  // Draft replies for everything that needs my attention (set DRAFT_REPLIES=false to skip).
  // Drafts are created in-thread and never sent; skip threads that already have a draft.
  let drafted = 0;
  if (process.env.DRAFT_REPLIES !== 'false') {
    const haveDrafts = await threadIdsWithDrafts();
    for (const a of assessments.filter(x => x.status === 'NEEDS MY ATTENTION')) {
      // Reply in the thread that holds this contact's most recent message.
      const target = a._threads
        .slice()
        .sort((t1, t2) => {
          const d = t => Math.max(...t.messages.map(m => new Date(m.date).getTime()));
          return d(t2) - d(t1);
        })[0];
      if (!target) continue;
      if (haveDrafts.has(target.threadId)) {
        console.log(`  ✎ Draft already exists for ${a.name} — skipping.`);
        a.hasDraft = true;
        continue;
      }
      try {
        const body = await draftReply({
          name: a.name,
          transcript: buildTranscript(a._threads),
          openItem: a.openItem,
        });
        await createDraftReply({
          threadId: target.threadId,
          to: target.counterpartyEmail,
          subject: target.subject,
          inReplyTo: target.lastMessageIdHeader,
          body: body.trim(),
        });
        a.hasDraft = true;
        drafted++;
        console.log(`  ✎ Drafted reply for ${a.name}.`);
      } catch (err) {
        console.warn(`  ⚠️ Could not draft reply for ${a.name}: ${err.message}`);
      }
    }
  }

  await sendStatusBoard(assessments);
  console.log(`✓ Done. (${drafted} draft${drafted === 1 ? '' : 's'} created)\n`);
}

status().catch(err => {
  console.error('Status board failed:', err);
  process.exit(1);
});

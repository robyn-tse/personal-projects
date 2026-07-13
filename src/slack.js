/**
 * slack.js — Route the digest to category channels.
 *
 * Each evaluated reply is posted to the channel for its category:
 *   VENUE  → SLACK_CHANNEL_VENUES
 *   VENDOR → SLACK_CHANNEL_VENDORS
 *   TRAVEL → SLACK_CHANNEL_TRAVEL
 *   OTHER  → SLACK_CHANNEL_DEFAULT  (planners, anything else)
 * Bounces + overdue alerts go to SLACK_CHANNEL_DEFAULT.
 *
 * Channel values may be names ("venues") or IDs ("C0123…"). The bot must be a
 * member of each channel — invite it once with `/invite @<bot>` in each channel.
 * Empty sweeps post nothing (no channel noise).
 */

import 'dotenv/config';

const SLACK_API = 'https://slack.com/api';

async function slackPost(endpoint, body) {
  const res = await fetch(`${SLACK_API}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

function channelFor(category) {
  // Until we're talking to multiple audiences (vendors, guests, …), send everything to
  // the default channel. Set SLACK_SPLIT_CHANNELS=true in .env to route by category later.
  if (process.env.SLACK_SPLIT_CHANNELS !== 'true') return process.env.SLACK_CHANNEL_DEFAULT;
  const map = {
    VENUE: process.env.SLACK_CHANNEL_VENUES,
    VENDOR: process.env.SLACK_CHANNEL_VENDORS,
    TRAVEL: process.env.SLACK_CHANNEL_TRAVEL,
  };
  return map[category] || process.env.SLACK_CHANNEL_DEFAULT;
}

async function postBlocks(channel, blocks, fallbackText) {
  if (!channel) {
    console.warn('  ⚠️ Slack: no channel configured (check SLACK_CHANNEL_* in .env)');
    return { ok: false, error: 'no_channel' };
  }
  const res = await slackPost('chat.postMessage', { channel, blocks, text: fallbackText });
  if (!res.ok) {
    if (res.error === 'not_in_channel' || res.error === 'channel_not_found') {
      console.warn(`  ⚠️ Slack: couldn't post to "${channel}" (${res.error}). Invite the bot to that channel: "/invite @<bot>".`);
    } else {
      console.warn(`  ⚠️ Slack post to "${channel}" failed: ${res.error}`);
    }
  }
  return res;
}

// Priority signal from the recommended ACTION (uses literal emoji so Slack always renders them)
const actionEmoji = {
  '[FOLLOW UP URGENTLY]': '🔴',
  '[FOLLOW UP]': '🟡',
  '[WAIT FOR MORE INFO]': '🔵',
  '[DEPRIORITIZE]': '⚪',
  '[DECLINE]': '⛔',
};

// Parse the concise WHO / SUMMARY / NEXT STEPS / ACTION format (multi-line aware)
function parseConcise(text) {
  const out = { WHO: '', SUMMARY: '', 'NEXT STEPS': '', ACTION: '' };
  let current = null;
  for (const line of (text || '').split('\n')) {
    const m = line.match(/^\s*(WHO|SUMMARY|NEXT STEPS|ACTION)\s*:\s*(.*)$/i);
    if (m) {
      current = m[1].toUpperCase();
      out[current] = m[2].trim();
    } else if (current && line.trim()) {
      out[current] += (out[current] ? ' ' : '') + line.trim();
    }
  }
  return out;
}

function resultBlocks(r, now) {
  const f = parseConcise(r.evaluation);

  let action = '🔵';
  for (const [key, emoji] of Object.entries(actionEmoji)) {
    if (f.ACTION.includes(key)) { action = emoji; break; }
  }

  const who = f.WHO || r.subject || '(unknown)';
  const lines = [`${action} *${who}*`];
  if (f.SUMMARY) lines.push(`*Summary:* ${f.SUMMARY}`);
  if (f['NEXT STEPS']) lines.push(`*Next steps:* ${f['NEXT STEPS']}`);
  // Fallback if the model didn't follow the format
  if (!f.SUMMARY && !f['NEXT STEPS']) {
    lines.push((r.evaluation || '_No evaluation available_').slice(0, 1500));
  }

  const ctxBits = [r.category || 'OTHER'];
  if (r.attachments?.length) ctxBits.push(`📎 ${r.attachments.map(a => a.filename).join(', ')}`);
  ctxBits.push(`swept ${now}`);

  return [
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: ctxBits.join(' · ') }] },
    { type: 'divider' },
  ];
}

export async function sendSlackDigest({ results = [], bounces = [], overdue = [] }) {
  const now = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const total = results.length + bounces.length + overdue.length;
  if (total === 0) {
    console.log('No new items — staying quiet (no Slack post).');
    return;
  }

  const counts = {};

  // Route each evaluated reply to its category channel
  for (const r of results) {
    const channel = channelFor(r.category);
    const res = await postBlocks(channel, resultBlocks(r, now), `New ${(r.category || 'other').toLowerCase()} reply: ${r.subject || ''}`);
    if (res.ok) counts[r.category] = (counts[r.category] || 0) + 1;
  }

  const defaultChannel = process.env.SLACK_CHANNEL_DEFAULT;

  // Bounces → default channel
  if (bounces.length > 0) {
    await postBlocks(defaultChannel, [
      { type: 'section', text: { type: 'mrkdwn', text: `*❌ Bounced emails — action required*\nThese failed to deliver. Check the address and resend.` } },
      ...bounces.map(b => ({ type: 'section', text: { type: 'mrkdwn', text: `• *${b.subject || '(no subject)'}*\n  From: ${b.from}` } })),
      { type: 'divider' },
    ], 'Bounced emails');
  }

  // Overdue → default channel
  if (overdue.length > 0) {
    await postBlocks(defaultChannel, [
      { type: 'section', text: { type: 'mrkdwn', text: `*⏰ No reply after ${process.env.NUDGE_HOURS || 36} hours*` } },
      ...overdue.map(o => ({ type: 'section', text: { type: 'mrkdwn', text: `• *${o.to}* — "${o.subject}"\n  Sent ${o.hoursElapsed}h ago` } })),
      { type: 'divider' },
    ], 'Overdue outreach');
  }

  const summary = Object.entries(counts).map(([c, n]) => `${n} ${c.toLowerCase()}`).join(', ') || 'none';
  console.log(`✓ Slack digest routed — replies: ${summary}; ${bounces.length} bounces, ${overdue.length} overdue`);
}

// Semantic status board: Claude has judged, per contact, what genuinely needs attention.
// `assessments`: [{ name, status, openItem, next }] where status is one of
// 'NEEDS MY ATTENTION' | 'WAITING ON THEM' | 'NO OPEN ITEMS'.
export async function sendStatusBoard(assessments = []) {
  const channel = process.env.SLACK_CHANNEL_DEFAULT;
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium' });

  const needs = assessments.filter(a => a.status === 'NEEDS MY ATTENTION');
  const waiting = assessments.filter(a => a.status === 'WAITING ON THEM');
  // "No open items" contacts (closed / declined / resolved) are intentionally dropped
  // from the board — only the two actionable buckets are shown.

  const detail = (a) => {
    const item = a.openItem && a.openItem.toLowerCase() !== 'none' ? a.openItem : '';
    const lines = [`• *${a.name}*${item ? ` — ${item}` : ''}`];
    return lines.join('\n');
  };

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `💍 Wedding status — ${now}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `🔴 *Needs your attention — ${needs.length}*\n${needs.length ? needs.map(detail).join('\n') : '_None — all caught up 🎉_'}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `🟢 *Waiting on them — ${waiting.length}*\n${waiting.length ? waiting.map(detail).join('\n') : '_None_'}` } },
  ];
  const shown = needs.length + waiting.length;
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${shown} active · ${assessments.length} contact(s) total · from your Gmail "${process.env.GMAIL_LABEL || 'wedding'}" label` }] });

  const res = await postBlocks(channel, blocks, 'Wedding status board');
  if (res.ok) console.log(`✓ Status board sent — ${needs.length} need attention, ${waiting.length} waiting (${assessments.length - shown} closed/hidden).`);
  return res;
}

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

const actionEmoji = {
  '[FOLLOW UP URGENTLY]': ':red_circle:',
  '[FOLLOW UP]': ':yellow_circle:',
  '[WAIT FOR MORE INFO]': ':blue_circle:',
  '[DEPRIORITIZE]': ':white_circle:',
  '[DECLINE]': ':no_entry:',
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

  let action = ':blue_circle:';
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
  if (r.attachments?.length) ctxBits.push(`:paperclip: ${r.attachments.map(a => a.filename).join(', ')}`);
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
      { type: 'section', text: { type: 'mrkdwn', text: `*:x: Bounced emails — action required*\nThese failed to deliver. Check the address and resend.` } },
      ...bounces.map(b => ({ type: 'section', text: { type: 'mrkdwn', text: `• *${b.subject || '(no subject)'}*\n  From: ${b.from}` } })),
      { type: 'divider' },
    ], 'Bounced emails');
  }

  // Overdue → default channel
  if (overdue.length > 0) {
    await postBlocks(defaultChannel, [
      { type: 'section', text: { type: 'mrkdwn', text: `*:alarm_clock: No reply after ${process.env.NUDGE_HOURS || 36} hours*` } },
      ...overdue.map(o => ({ type: 'section', text: { type: 'mrkdwn', text: `• *${o.to}* — "${o.subject}"\n  Sent ${o.hoursElapsed}h ago` } })),
      { type: 'divider' },
    ], 'Overdue outreach');
  }

  const summary = Object.entries(counts).map(([c, n]) => `${n} ${c.toLowerCase()}`).join(', ') || 'none';
  console.log(`✓ Slack digest routed — replies: ${summary}; ${bounces.length} bounces, ${overdue.length} overdue`);
}

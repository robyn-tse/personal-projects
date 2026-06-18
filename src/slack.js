/**
 * slack.js — Send digest to your personal Slack DM
 * Handles: new replies, bounces, overdue outreach alerts
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

async function getDmChannel() {
  const res = await slackPost('conversations.open', { users: process.env.SLACK_USER_ID });
  if (!res.ok) throw new Error(`Slack DM open failed: ${res.error}`);
  return res.channel.id;
}

export async function sendSlackDigest({ results = [], bounces = [], overdue = [] }) {
  const channelId = await getDmChannel();
  const now = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const totalAlerts = results.length + bounces.length + overdue.length;

  if (totalAlerts === 0) {
    await slackPost('chat.postMessage', {
      channel: channelId,
      text: `💍 *Wedding Monitor — ${now}*\n\nAll quiet. No new replies, no bounces, no overdue outreach.`,
    });
    return;
  }

  // Header
  const headerParts = [];
  if (results.length > 0) headerParts.push(`${results.length} new repl${results.length > 1 ? 'ies' : 'y'}`);
  if (bounces.length > 0) headerParts.push(`${bounces.length} bounce${bounces.length > 1 ? 's' : ''}`);
  if (overdue.length > 0) headerParts.push(`${overdue.length} overdue`);

  await slackPost('chat.postMessage', {
    channel: channelId,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `💍 Wedding Monitor — ${headerParts.join(' · ')}` },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Swept at ${now}` }],
      },
      { type: 'divider' },
    ],
  });

  // ── Bounces ────────────────────────────────────────────────────────────────
  if (bounces.length > 0) {
    await slackPost('chat.postMessage', {
      channel: channelId,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*:x: Bounced emails — action required*\nThese emails failed to deliver. Check the address and resend.`,
          },
        },
        ...bounces.map(b => ({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `• *${b.subject || '(no subject)'}*\n  From: ${b.from}`,
          },
        })),
        { type: 'divider' },
      ],
    });
  }

  // ── Overdue ────────────────────────────────────────────────────────────────
  if (overdue.length > 0) {
    await slackPost('chat.postMessage', {
      channel: channelId,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*:alarm_clock: No reply after ${process.env.NUDGE_HOURS || 36} hours*\nConsider following up or trying an alternative contact.`,
          },
        },
        ...overdue.map(o => ({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `• *${o.to}* — "${o.subject}"\n  Sent ${o.hoursElapsed}h ago`,
          },
        })),
        { type: 'divider' },
      ],
    });
  }

  // ── New replies ────────────────────────────────────────────────────────────
  const actionEmoji = {
    '[FOLLOW UP URGENTLY]': ':red_circle:',
    '[FOLLOW UP]': ':yellow_circle:',
    '[WAIT FOR MORE INFO]': ':blue_circle:',
    '[DEPRIORITIZE]': ':white_circle:',
    '[DECLINE]': ':no_entry:',
  };

  for (const r of results) {
    let action = ':blue_circle:';
    for (const [key, emoji] of Object.entries(actionEmoji)) {
      if (r.evaluation?.includes(key)) { action = emoji; break; }
    }

    const attachmentNote = r.attachments?.length > 0
      ? `:paperclip: ${r.attachments.map(a => a.filename).join(', ')}`
      : 'No attachments';

    await slackPost('chat.postMessage', {
      channel: channelId,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${action} *${r.subject || '(no subject)'}*\nFrom: ${r.from}\n${attachmentNote}`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: r.evaluation
              ? r.evaluation.slice(0, 2900) + (r.evaluation.length > 2900 ? '\n_(truncated — see log)_' : '')
              : '_No evaluation available_',
          },
        },
        { type: 'divider' },
      ],
    });
  }

  console.log(`✓ Slack digest sent — ${results.length} replies, ${bounces.length} bounces, ${overdue.length} overdue`);
}

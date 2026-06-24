/**
 * gmail.js — Gmail reader for the wedding label
 * Returns new replies since last sweep, with attachment buffers.
 *
 * Dedup is per-MESSAGE (not per-thread): a follow-up reply inside an existing
 * thread is caught on the next sweep. For each thread we evaluate the latest
 * INBOUND message (i.e. not one you sent), so your own replies don't get scored.
 */

import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, '../logs/last-sweep.json');

// Optional domain → clean display-name map for the status board
let VENUE_NAMES = {};
try { VENUE_NAMES = JSON.parse(readFileSync(path.join(__dirname, '../config/venue-names.json'), 'utf8')); } catch { /* none */ }

function getOAuth2Client() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return client;
}

function loadState() {
  if (!existsSync(STATE_PATH)) return { lastSweepAt: null, seenMessageIds: [] };
  const s = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  return { lastSweepAt: s.lastSweepAt || null, seenMessageIds: s.seenMessageIds || [] };
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function decodeBase64(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function header(message, name) {
  return (message.payload.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

// Our own addresses (you + partner) — set OUR_EMAILS in .env, comma-separated.
const OURS = (process.env.OUR_EMAILS || process.env.GMAIL_ADDRESS || '')
  .toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
function isOurs(email) { return OURS.some(e => e && email.includes(e)); }
function isFromMe(message) { return isOurs(header(message, 'from').toLowerCase()); }

function extractBody(payload) {
  if (payload.body?.data) return decodeBase64(payload.body.data).toString('utf8');
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64(part.body.data).toString('utf8');
      }
    }
    for (const part of payload.parts) {
      const body = extractBody(part);
      if (body) return body;
    }
  }
  return '';
}

function extractAttachmentMeta(payload, parts = []) {
  if (payload.filename && payload.body?.attachmentId) {
    parts.push({
      filename: payload.filename,
      mimeType: payload.mimeType,
      attachmentId: payload.body.attachmentId,
      size: payload.body.size,
    });
  }
  if (payload.parts) payload.parts.forEach(p => extractAttachmentMeta(p, parts));
  return parts;
}

export async function fetchWeddingThreads() {
  const auth = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });
  const state = loadState();

  const label = process.env.GMAIL_LABEL || 'wedding';

  // Find or create the label
  const labelsRes = await gmail.users.labels.list({ userId: 'me' });
  const allLabels = labelsRes.data.labels || [];
  let labelId = allLabels.find(l => l.name.toLowerCase() === label.toLowerCase())?.id;

  if (!labelId) {
    console.log(`Label "${label}" not found in Gmail — creating it...`);
    const created = await gmail.users.labels.create({
      userId: 'me',
      requestBody: { name: label, labelListVisibility: 'labelShow', messageListVisibility: 'show' }
    });
    labelId = created.data.id;
    console.log(`✓ Label created: ${label} (${labelId})`);
  }

  // Threads with activity since the last sweep (catches new threads AND new
  // replies in existing threads). On the first run, fetch everything in the label.
  const query = state.lastSweepAt
    ? `after:${Math.floor(new Date(state.lastSweepAt).getTime() / 1000)}`
    : '';

  const threadsRes = await gmail.users.threads.list({
    userId: 'me',
    labelIds: [labelId],
    q: query,
    maxResults: 50,
  });

  const threads = threadsRes.data.threads || [];
  const results = [];
  const newlySeen = [];

  for (const t of threads) {
    const threadRes = await gmail.users.threads.get({ userId: 'me', id: t.id, format: 'full' });
    // Ignore our own unsent drafts when figuring out the latest inbound message.
    const messages = (threadRes.data.messages || []).filter(m => !(m.labelIds || []).includes('DRAFT'));
    if (messages.length === 0) continue;

    // Evaluate the latest INBOUND message (skip threads where you spoke last / only you).
    const latest = [...messages].reverse().find(m => !isFromMe(m));
    if (!latest) continue;

    // Per-message dedup: skip if we've already evaluated this exact reply.
    if (state.seenMessageIds.includes(latest.id)) continue;

    const from = header(latest, 'from');
    const subject = header(latest, 'subject');
    const date = header(latest, 'date');
    const body = extractBody(latest.payload);

    // Download PDF/doc attachments
    const attachmentMeta = extractAttachmentMeta(latest.payload);
    const attachments = [];
    for (const meta of attachmentMeta) {
      if (!meta.mimeType.includes('pdf') && !meta.mimeType.includes('word') && !meta.mimeType.includes('document')) {
        continue;
      }
      try {
        const attRes = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: latest.id,
          id: meta.attachmentId,
        });
        const buffer = decodeBase64(attRes.data.data);
        attachments.push({ filename: meta.filename, mimeType: meta.mimeType, buffer });
        console.log(`  ↳ Downloaded attachment: ${meta.filename} (${Math.round(buffer.length / 1024)}kb)`);
      } catch (err) {
        console.warn(`  ↳ Could not download ${meta.filename}: ${err.message}`);
      }
    }

    results.push({ threadId: t.id, messageId: latest.id, from, subject, date, body, attachments, messageCount: messages.length });
    newlySeen.push(latest.id);
  }

  if (results.length === 0) {
    console.log('No new wedding replies since last sweep.');
  } else {
    console.log(`Found ${results.length} new repl${results.length > 1 ? 'ies' : 'y'} in label "${label}"`);
  }

  saveState({
    lastSweepAt: new Date().toISOString(),
    seenMessageIds: [...state.seenMessageIds, ...newlySeen],
  });

  return results;
}

// Full conversation content for every wedding thread (for the semantic status board).
// Returns each thread with its message transcript and the counterparty.
export async function fetchWeddingConversations() {
  const auth = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });
  const label = process.env.GMAIL_LABEL || 'wedding';

  const labelsRes = await gmail.users.labels.list({ userId: 'me' });
  const labelId = (labelsRes.data.labels || []).find(l => l.name.toLowerCase() === label.toLowerCase())?.id;
  if (!labelId) return [];

  const res = await gmail.users.threads.list({ userId: 'me', labelIds: [labelId], maxResults: 100 });
  const out = [];

  for (const t of res.data.threads || []) {
    const tr = await gmail.users.threads.get({ userId: 'me', id: t.id, format: 'full' });
    // Exclude unsent DRAFT messages — our own auto-drafts must not be read as if
    // we'd already replied (that would corrupt whose-turn-it-is detection).
    const msgs = (tr.data.messages || []).filter(m => !(m.labelIds || []).includes('DRAFT'));
    if (msgs.length === 0) continue;

    const messages = msgs.map(m => ({
      fromMe: isFromMe(m),
      from: header(m, 'From'),
      to: header(m, 'To'),
      date: header(m, 'Date'),
      text: (extractBody(m.payload) || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500),
    }));

    // Counterparty = the most frequent non-"ours" address across all From/To headers
    // (robust to Felix being cc'd, forwards, and multi-recipient threads).
    const counts = {}, nameFor = {};
    for (const m of messages) {
      for (const raw of [m.from, m.to]) {
        for (const part of (raw || '').split(',')) {
          const email = (part.match(/<([^>]+)>/)?.[1] || part).trim().toLowerCase();
          if (!email.includes('@') || isOurs(email)) continue;
          counts[email] = (counts[email] || 0) + 1;
          if (!nameFor[email]) nameFor[email] = part.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || email;
        }
      }
    }
    const email = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const domain = email.split('@')[1] || email;
    const name = VENUE_NAMES[domain] || nameFor[email] || email;

    out.push({
      threadId: t.id,
      subject: header(msgs[msgs.length - 1], 'Subject'),
      counterpartyEmail: email,
      counterpartyDomain: domain,
      counterpartyName: name,
      // Message-ID of the latest message — used to thread a draft reply correctly.
      lastMessageIdHeader: header(msgs[msgs.length - 1], 'Message-ID'),
      messages,
    });
  }
  return out;
}

// Thread IDs that already have a draft in them — so we never create a duplicate draft.
export async function threadIdsWithDrafts() {
  const auth = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });
  const ids = new Set();
  let pageToken;
  do {
    const res = await gmail.users.drafts.list({ userId: 'me', maxResults: 100, pageToken });
    for (const d of res.data.drafts || []) {
      if (d.message?.threadId) ids.add(d.message.threadId);
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return ids;
}

// Create a reply draft inside an existing thread. Sets In-Reply-To / References so
// Gmail nests it under the conversation. Never sends — it just sits in Drafts.
export async function createDraftReply({ threadId, to, subject, inReplyTo, body }) {
  const auth = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  const from = process.env.GMAIL_ADDRESS;
  const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  const subjectEnc = `=?UTF-8?B?${Buffer.from(replySubject, 'utf8').toString('base64')}?=`;
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subjectEnc}`,
  ];
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
    lines.push(`References: ${inReplyTo}`);
  }
  lines.push(
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64'),
  );
  const raw = Buffer.from(lines.join('\r\n'), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw, threadId } },
  });
  return res.data;
}

export async function sendEmail({ to, subject, body, labelName }) {
  const auth = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  const from = process.env.GMAIL_ADDRESS;
  const subjectEnc = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subjectEnc}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64'),
  ].join('\r\n');
  const raw = Buffer.from(message, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const sent = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });

  // Apply wedding label to sent message
  if (labelName) {
    const labelsRes = await gmail.users.labels.list({ userId: 'me' });
    const labelId = labelsRes.data.labels?.find(l => l.name.toLowerCase() === labelName.toLowerCase())?.id;
    if (labelId) {
      await gmail.users.messages.modify({
        userId: 'me',
        id: sent.data.id,
        requestBody: { addLabelIds: [labelId] },
      });
    }
  }

  return sent.data;
}

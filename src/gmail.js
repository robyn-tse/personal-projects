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

function isFromMe(message) {
  const me = (process.env.GMAIL_ADDRESS || '').toLowerCase();
  return me && header(message, 'from').toLowerCase().includes(me);
}

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
    const messages = threadRes.data.messages || [];
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
    const msgs = tr.data.messages || [];
    if (msgs.length === 0) continue;

    const messages = msgs.map(m => ({
      fromMe: isFromMe(m),
      from: header(m, 'From'),
      to: header(m, 'To'),
      date: header(m, 'Date'),
      text: (extractBody(m.payload) || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500),
    }));

    // Counterparty = the other party (prefer an inbound sender, else the recipient I wrote to)
    const inbound = messages.find(m => !m.fromMe);
    const cpHeader = inbound ? inbound.from : (messages[0].to || messages[0].from || '');
    const email = (cpHeader.match(/<([^>]+)>/)?.[1] || cpHeader).trim().toLowerCase();
    const name = cpHeader.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || email;

    out.push({
      threadId: t.id,
      subject: header(msgs[msgs.length - 1], 'Subject'),
      counterpartyEmail: email,
      counterpartyDomain: email.split('@')[1] || email,
      counterpartyName: name,
      messages,
    });
  }
  return out;
}

export async function sendEmail({ to, subject, body, labelName }) {
  const auth = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  const from = process.env.GMAIL_ADDRESS;
  const raw = Buffer.from(
    `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

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

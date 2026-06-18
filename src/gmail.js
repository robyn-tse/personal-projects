/**
 * gmail.js — Gmail reader for the wedding label
 * Returns new threads since last sweep, with attachment buffers
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
  if (!existsSync(STATE_PATH)) return { lastSweepAt: null, seenThreadIds: [] };
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function decodeBase64(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
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

  // Fetch threads with this label
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
  const newThreadIds = threads
    .map(t => t.id)
    .filter(id => !state.seenThreadIds.includes(id));

  if (newThreadIds.length === 0) {
    console.log('No new wedding threads since last sweep.');
    saveState({ ...state, lastSweepAt: new Date().toISOString() });
    return [];
  }

  console.log(`Found ${newThreadIds.length} new thread(s) in label "${label}"`);

  const results = [];

  for (const threadId of newThreadIds) {
    const threadRes = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
    const messages = threadRes.data.messages || [];

    // We only care about the latest message in the thread (the reply)
    const latest = messages[messages.length - 1];
    const headers = latest.payload.headers || [];
    const get = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

    const from = get('from');
    const subject = get('subject');
    const date = get('date');
    const body = extractBody(latest.payload);

    // Download attachments
    const attachmentMeta = extractAttachmentMeta(latest.payload);
    const attachments = [];

    for (const meta of attachmentMeta) {
      if (!meta.mimeType.includes('pdf') && !meta.mimeType.includes('word') && !meta.mimeType.includes('document')) {
        continue; // only pull PDFs and docs
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

    results.push({ threadId, from, subject, date, body, attachments, messageCount: messages.length });
  }

  // Update state
  saveState({
    lastSweepAt: new Date().toISOString(),
    seenThreadIds: [...state.seenThreadIds, ...newThreadIds],
  });

  return results;
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

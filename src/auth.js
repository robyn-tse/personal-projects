/**
 * auth.js — run once to authorize Gmail access
 * Usage: node src/auth.js
 * Opens a browser, you approve, refresh token is saved to .env
 */

import { google } from 'googleapis';
import http from 'http';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '../.env');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',  // read + label + send
  'https://www.googleapis.com/auth/gmail.send',
];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',  // forces refresh_token to be returned
});

console.log('\n── Wedding Monitor: Gmail Auth ──────────────────────────\n');
console.log('Open this URL in your browser:\n');
console.log(authUrl);
console.log('\nWaiting for callback on http://localhost:3000 ...\n');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:3000');
  const code = url.searchParams.get('code');
  if (!code) return;

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h2>✓ Authorized. You can close this tab.</h2>');
  server.close();

  const { tokens } = await oauth2Client.getToken(code);
  const refreshToken = tokens.refresh_token;

  if (!refreshToken) {
    console.error('No refresh token returned. Try revoking access at myaccount.google.com/permissions and re-running.');
    process.exit(1);
  }

  // Write to .env
  let env = '';
  try { env = readFileSync(ENV_PATH, 'utf8'); } catch { env = ''; }

  if (env.includes('GOOGLE_REFRESH_TOKEN=')) {
    env = env.replace(/^GOOGLE_REFRESH_TOKEN=.*$/m, `GOOGLE_REFRESH_TOKEN=${refreshToken}`);
  } else {
    env += `\nGOOGLE_REFRESH_TOKEN=${refreshToken}`;
  }
  writeFileSync(ENV_PATH, env);

  console.log('✓ Refresh token saved to .env');
  console.log('You can now run: npm run sweep\n');
}).listen(3000);

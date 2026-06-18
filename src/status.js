/**
 * status.js — post a "what needs my attention" board to Slack.
 * Usage: npm run status  (or: node src/status.js)
 *
 * Lists every thread in the wedding label, grouped by who acted last:
 *   🔴 Your turn      — they replied last, you haven't responded
 *   🟢 Waiting on them — you replied last
 * Posts to SLACK_CHANNEL_DEFAULT. Good as a daily 10am summary (see setup-cron.sh).
 */

import 'dotenv/config';
import { fetchWeddingThreadSummaries } from './gmail.js';
import { sendStatusBoard } from './slack.js';

async function status() {
  console.log('\n── Wedding status board ──────────────────────────────────');
  const items = await fetchWeddingThreadSummaries();
  console.log(`Found ${items.length} thread(s) in the wedding label.`);
  await sendStatusBoard(items);
  console.log('✓ Done.\n');
}

status().catch(err => {
  console.error('Status board failed:', err);
  process.exit(1);
});

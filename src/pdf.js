/**
 * pdf.js — Extract text from PDF buffers and parse pricing with Claude
 */

import pdf from 'pdf-parse/lib/pdf-parse.js';
import 'dotenv/config';

const BUDGET_DKK = Number(process.env.BUDGET_DKK) || 600000;
const BUDGET_USD = Number(process.env.BUDGET_USD) || 85000;
const GUEST_MIN = Number(process.env.GUEST_COUNT_MIN) || 100;
const GUEST_MAX = Number(process.env.GUEST_COUNT_MAX) || 125;

async function getLiveDkkRate() {
  if (process.env.DKK_TO_USD_OVERRIDE) return Number(process.env.DKK_TO_USD_OVERRIDE);
  try {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/DKK');
    const data = await res.json();
    return data.rates?.USD || 0.145;
  } catch {
    return 0.145; // fallback
  }
}

export async function parsePdfBuffer(buffer) {
  try {
    const data = await pdf(buffer);
    return data.text;
  } catch (err) {
    return `[PDF extraction failed: ${err.message}]`;
  }
}

export async function evaluateWithClaude({ from, subject, body, pdfTexts }) {
  const dkkRate = await getLiveDkkRate();

  const attachmentSection = pdfTexts.length > 0
    ? `\n\n--- ATTACHMENTS ---\n${pdfTexts.map((t, i) => `[Attachment ${i + 1}]\n${t}`).join('\n\n')}`
    : '';

  const prompt = `You are helping evaluate venue responses for a destination wedding in coastal Denmark.

WEDDING REQUIREMENTS:
- Guest count: ${GUEST_MIN}–${GUEST_MAX} guests
- Budget: ${BUDGET_DKK.toLocaleString()} DKK (~$${BUDGET_USD.toLocaleString()} USD) for event costs (guest rooms paid separately)
- Format: Full weekend buyout — Friday evening informal gathering, Saturday tented outdoor dinner (4+ courses, open bar 5hrs, 4-piece band + DJ), Sunday breakfast
- Vibe: Warm, Nordic coastal, natural materials, unhurried — not formal or corporate
- Dates targeting: June or July 2027
- Guests: ~80% US-based flying into Copenhagen, some German family

CURRENT DKK→USD RATE: ${dkkRate.toFixed(4)} (1 DKK = $${dkkRate.toFixed(4)})

EMAIL FROM: ${from}
SUBJECT: ${subject}
EMAIL BODY:
${body}${attachmentSection}

First, classify this correspondence. Begin your reply with a single line in exactly this format:
CATEGORY: <one of VENUE, VENDOR, TRAVEL, OTHER>
  - VENUE — a wedding venue / location being considered to host the event
  - VENDOR — a service provider (photographer, videographer, florist, caterer, band/DJ, hair & makeup, rentals, cake, stationery, etc.)
  - TRAVEL — guest accommodation / hotel room blocks, flights, shuttles, transportation
  - OTHER — wedding planners, or anything that does not clearly fit the above

Then write a SHORT phone notification using exactly these four labels, each starting on a new line:

WHO: the venue/vendor/company/person, plus a few words on what they are.
SUMMARY: 2–4 sentences capturing their reply. Include key pricing (show DKK and the ~USD conversion at the rate above), dates/availability, and how it fits our ~${GUEST_MIN}–${GUEST_MAX} guests and budget. Call out any critical red flag or deadline. If there's no pricing yet, say so plainly.
NEXT STEPS: 1–2 sentences — what they proposed, and the single best next action for us.
ACTION: exactly one of [FOLLOW UP URGENTLY] [FOLLOW UP] [WAIT FOR MORE INFO] [DEPRIORITIZE] [DECLINE]

Keep it tight and skimmable — this goes to a phone. No section headers, no tables, no long breakdowns. Pull exact numbers but don't over-explain.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  return data.content?.[0]?.text || '[No evaluation returned]';
}

/**
 * Read all correspondence with one contact (possibly across several threads) and
 * judge what genuinely still needs attention — catching "they replied but dodged
 * my question" and "a new thread doesn't resolve an old open item".
 */
export async function assessContactThreads({ name, transcript }) {
  const prompt = `You track wedding-planning correspondence and tell me what still needs MY attention.

CONTACT: ${name}

Below is the full back-and-forth across ALL email threads with this contact (oldest first). "ME" = me (Robyn); "THEM" = the contact.

${transcript}

Judge the CURRENT state across everything above, then output EXACTLY these three lines:

STATUS: <one of NEEDS MY ATTENTION | WAITING ON THEM | NO OPEN ITEMS>
OPEN ITEM: <the specific question or item that's actually still open — name it concretely; "none" if nothing is pending>
NEXT: <one short sentence: the single best next action for me>

Rules:
- "NEEDS MY ATTENTION" = they're waiting on a reply from me, OR I asked something they never actually answered and I should follow up (e.g. they replied but dodged or ignored my question — even if in a different thread).
- "WAITING ON THEM" = I've asked something they haven't answered yet and the ball is legitimately with them (no action needed from me right now).
- "NO OPEN ITEMS" = nothing is pending either way.
- A newer email from them does NOT automatically resolve an earlier unanswered question. Judge by whether the actual question was addressed, not by who emailed last.
- Be concise and specific.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  return data.content?.[0]?.text || '';
}

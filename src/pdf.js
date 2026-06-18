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

Then return a structured evaluation with these sections (for non-venue categories, adapt sections 3–4: assess fit and pricing relevant to that category rather than guest capacity):

1. SENDER & VENUE — who replied, which venue/company
2. PRICING SUMMARY — extract all prices mentioned, convert DKK to USD, present both. If no pricing, say so.
3. CAPACITY FIT — can this venue host ${GUEST_MIN}–${GUEST_MAX} guests for the full weekend format? Any limitations?
4. BUDGET FIT — does total pricing fit within ${BUDGET_DKK.toLocaleString()} DKK / $${BUDGET_USD.toLocaleString()} USD? Flag if over.
5. RED FLAGS — any contract terms, restrictions, or gaps that need follow-up (e.g. no open bar, external planner fees, tent restrictions, minimum spend)
6. POSITIVE SIGNALS — what looks good about this venue/response
7. RECOMMENDED ACTION — one of: [FOLLOW UP URGENTLY] [FOLLOW UP] [WAIT FOR MORE INFO] [DEPRIORITIZE] [DECLINE]
8. SUGGESTED REPLY — 3–4 sentence follow-up email in a warm, direct tone (not formal, reads like a person wrote it)

Be specific. Pull exact numbers. Flag anything that needs negotiation.`;

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

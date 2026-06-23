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

// Call the Anthropic API with retry/backoff. A transient 429/529/5xx must NOT be
// swallowed into an empty string — that would silently collapse the status board.
async function anthropicMessages(payload, { retries = 4 } = {}) {
  let lastErr = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const data = await res.json();
      const text = data.content?.[0]?.text;
      if (text) return text;
      lastErr = 'empty response';
    } else {
      lastErr = `HTTP ${res.status}`;
      // Only retry on overload / rate-limit / server errors
      if (![429, 500, 502, 503, 529].includes(res.status)) break;
    }
    if (attempt < retries) {
      const waitMs = 1000 * 2 ** attempt; // 1s, 2s, 4s, 8s
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  throw new Error(`Anthropic API failed after ${retries + 1} attempt(s): ${lastErr}`);
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

  return anthropicMessages({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });
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

Definitions (judge by SUBSTANCE — who owes the next real move — NOT by who happened to email last):
- "NEEDS MY ATTENTION" = the ball is in MY court: they gave a substantive reply that now expects something from me (answered my question, sent pricing/a proposal, offered concrete dates/times to confirm, or asked me a question). I should respond or act.
- "WAITING ON THEM" = the ball is in THEIR court: I asked something substantive they haven't actually answered yet, OR their most recent message is only an auto-acknowledgment / routing note ("thanks for your inquiry, we'll forward this to our team / someone will be in touch / out-of-office"). An acknowledgment is NOT a real answer, so it stays WAITING ON THEM — I should not have to reply to it.
- "NO OPEN ITEMS" = nothing is pending either way: the relationship is closed or declined (they can't accommodate us / we've ruled them out / they rejected us), OR the immediate item is fully settled with no action left for either side right now (e.g. a visit is confirmed, or a question was answered and needs no follow-up).

Rules:
- An auto-reply, confirmation-of-receipt, or "we'll pass this along" does NOT put the ball in my court. Treat it as WAITING ON THEM.
- A newer email from them does NOT automatically resolve an earlier unanswered question, and does NOT automatically demand a reply. Judge by whether a real question or decision is now genuinely on my plate.
- If they declined us or cannot accommodate our request and there's nothing left to pursue, that's NO OPEN ITEMS.
- Be concise and specific.`;

  return anthropicMessages({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });
}

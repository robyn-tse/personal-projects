# Wedding Monitor

Automated sweep of your Gmail `wedding` label → Claude evaluation → Slack DM digest.

---

## What it does

**`npm run sweep`**
1. Finds all new threads in your `wedding` Gmail label since the last run
2. Downloads PDF/Word attachments
3. Extracts text from PDFs
4. Sends each reply to Claude for evaluation:
   - Pricing extracted + converted DKK → USD at live rate
   - Capacity check (100–125 guests, full weekend format)
   - Budget check (600,000 DKK / ~$85K)
   - Red flags flagged (contract gaps, restrictions, missing info)
   - Recommended action + suggested follow-up draft
5. Posts a digest DM to you on Slack
6. Saves a full JSON log in `logs/`

**`npm run send`**
Sends emails from `config/outreach-queue.json` and auto-tags them with the `wedding` label so replies get swept up automatically.

---

## Setup (one time)

### 1. Install dependencies
```bash
npm install
```

### 2. Set up Google Cloud project
1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (e.g. "wedding-monitor")
3. Enable the **Gmail API**
4. Go to APIs & Services → Credentials → Create Credentials → **OAuth 2.0 Client ID**
5. Application type: **Desktop app**
6. Download the JSON — copy `client_id` and `client_secret` into `.env`

### 3. Set up Slack app
1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch
2. App name: "Wedding Monitor", pick your workspace
3. Go to **OAuth & Permissions** → add these Bot Token Scopes:
   - `chat:write`
   - `im:write`
   - `users:read`
4. Install to workspace → copy **Bot OAuth Token** into `.env`
5. Find your Slack Member ID: click your name in Slack → profile → ⋯ → Copy member ID → paste into `.env`
6. In Slack, DM yourself from the bot once to open the channel (search for your app name)

### 4. Configure .env
```bash
cp .env.template .env
# Fill in all values
```

### 5. Authorize Gmail (one time)
```bash
node src/auth.js
# Opens browser → approve → refresh token auto-saved to .env
```

### 6. Set up Gmail bounce filter (one time)
Auto-tags bounce notifications so they're caught on sweep:
1. In Gmail → Settings → Filters → Create a new filter
2. **From** field: `mailer-daemon OR postmaster`
3. Click "Create filter" → check **Apply the label** → choose `wedding` → Save

### 7. (Optional) Adjust the no-reply alert window
In `.env`, set `NUDGE_HOURS=36` (default). Change to any value you want.

### 8. Test it
```bash
npm run sweep
```

---

## How ongoing sweeps work

Once a sweep has run, **future replies auto-flow in**: anything new in the `wedding`
Gmail label is caught on the next sweep and evaluated, while replies already seen are
skipped so you never get a duplicate digest or pay to re-evaluate the same email.

- Dedup is **per-message** (`logs/last-sweep.json` → `seenMessageIds`), so a follow-up
  reply inside an existing thread (e.g. a revised proposal in the same `RE:` chain) **is**
  caught — not just brand-new threads.
- For each thread it evaluates the latest **inbound** message, so your own sent replies
  are never scored.
- Each reply is evaluated **once**, then remembered.
- An **empty sweep posts nothing** — no channel noise when there's nothing new.

## Slack channel routing

Each evaluated reply is classified (by Claude) and posted to the matching channel:

| Category | Channel (`.env`) | What it is |
|---|---|---|
| VENUE | `SLACK_CHANNEL_VENUES` | wedding venues / locations |
| VENDOR | `SLACK_CHANNEL_VENDORS` | photographer, florist, caterer, band/DJ, rentals… |
| TRAVEL | `SLACK_CHANNEL_TRAVEL` | guest hotels / room blocks, flights, shuttles |
| OTHER | `SLACK_CHANNEL_DEFAULT` | wedding planners + anything else; also bounces & overdue alerts |

Channel values can be names (`venues`) or IDs (`C0123…`). **The bot must be a member of
each channel** — invite it once per channel with `/invite @<bot>`.

Each card leads with a colored circle = the recommended action:

| 🔴 | 🟡 | 🔵 | ⚪ | ⛔ |
|---|---|---|---|---|
| Follow up urgently | Follow up | Wait for more info | Deprioritize | Decline |

## Status board (`npm run status`)

Posts a "what needs my attention" overview to `SLACK_CHANNEL_DEFAULT`:

- **🔴 Needs your attention** — they're waiting on you, OR you asked something they never actually answered
- **🟢 Waiting on them** — you asked, the ball is legitimately with them
- **✅ No open items** — nothing pending

It groups every thread by contact and has Claude read each contact's full
correspondence to judge what's *genuinely* open — so it catches "they replied but
dodged my question" and won't treat a new email as resolving an earlier one. (Reads
message bodies, so it costs a little per run.) `setup-cron.sh` schedules it daily at
10:00 (laptop local time); run `npm run status` anytime for an on-demand check.

---

## Adding cron (when ready)

The quickest way — run the helper from the project root (sets it to every 2 hours):
```bash
./setup-cron.sh
```

It finds your `node` path, creates `logs/`, and installs the cron entry for you
(replacing any previous one). The sweep then runs every 2 hours **whenever your
laptop is awake** (cron skips runs while the machine is asleep — that's fine).

To do it manually instead — `crontab -e`, then add (runs every 2 hours):
```
0 */2 * * * cd /path/to/wedding-monitor && /usr/local/bin/node src/sweep.js >> logs/cron.log 2>&1
```
Find your node path with `which node`. Watch output with `tail -f logs/cron.log`.

---

## Extending to RSVPs, vendors, photographers

Everything runs off the `wedding` Gmail label. To add a new category:

1. Tag those emails with `wedding` in Gmail (manual, or set a filter)
2. Update the evaluation prompt in `src/pdf.js` → `evaluateWithClaude()` to recognize the new category
3. Or create a second label (e.g. `wedding-rsvp`) and add a second sweep function

The architecture is: **label filter → Gmail fetch → Claude eval → Slack output**. 
Each new category is just a new instance of that pipeline.

---

## Files

```
wedding-monitor/
├── src/
│   ├── auth.js              # one-time Gmail OAuth setup
│   ├── gmail.js             # Gmail reader + sender
│   ├── pdf.js               # PDF parser + Claude evaluation
│   ├── slack.js             # Slack DM digest
│   ├── sweep.js             # main entry point (npm run sweep)
│   └── send-outreach.js     # send queued emails (npm run send)
├── config/
│   └── outreach-queue.json  # emails to send
├── logs/                    # sweep logs (auto-created)
├── .env.template            # copy to .env and fill in
├── package.json
└── README.md
```

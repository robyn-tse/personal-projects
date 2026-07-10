/**
 * RSVP WEB APP — STEP 4: submitRsvp write-back + confirmation email
 * -----------------------------------------------------------------
 * Reads the "Guest List" tab, writes Attending/Language/Meal/Dietary per person,
 * Song Request(s) + Last Updated per household. Sends a bilingual confirmation
 * email if ≥1 guest is attending. Uses LockService to prevent concurrent clobber.
 *
 * SETUP (in your DEV copy of the sheet):
 *  1. Open "Wedding Tracker — DEV" -> Extensions -> Apps Script
 *  2. Replace the existing code with this whole file. Save.
 *  3. Deploy -> Manage deployments -> pencil -> Version: New version -> Deploy
 *     (Never click "New deployment" after the first deploy — it mints a new URL.)
 *
 * TEST CHECKLIST (see handoff doc for full matrix):
 *  - Submit hid=1 → only rows 2-3 change
 *  - Submit hid=7 → 4 rows written including kids
 *  - Submit twice with changed answers → overwrite, no duplicate rows
 *  - Uncheck everyone → all rows Attending="No"
 *  - Single-person household (hid=3)
 *  - Umlauts / special chars in names and note
 *  - Bad token → graceful error, no partial write
 *  - Two browsers simultaneously → LockService holds
 *  - Confirmation email arrives in correct language
 */

// ---------- CONFIG ----------
var SHEET_NAME = 'Guest List';
// TODO: replace both placeholders before first real send.
//   WEDDING_WEBSITE  — every confirmation email currently ships a dead link.
//   WEDDING_ICS      — the "Add to calendar" button is broken until this is set.
var WEDDING_WEBSITE = 'https://YOUR-WEDDING-WEBSITE.com';
var WEDDING_ICS     = WEDDING_WEBSITE + '/wedding.ics';

// Exact header spellings in row 1. Change here if you rename a column.
var COL = {
  token:    'Household Token',
  name:     'Guest Name',
  kid:      'Kid?',
  email:    'Email',
  attending: 'Attending',
  language:  'Language',
  meal:      'Meal',
  dietary:   'Dietary',
  song:      'Song Request(s)',
  updated:   'Last Updated',
  notes:     'Notes'
};
// ----------------------------


function doGet(e) {
  var hid     = (e && e.parameter && e.parameter.hid)  ? String(e.parameter.hid).trim()  : '';
  var rawLang = (e && e.parameter && e.parameter.lang) ? String(e.parameter.lang).trim() : '';
  var lang    = (rawLang === 'de') ? 'de' : 'en';
  return HtmlService.createHtmlOutput(buildPage(hid, lang))
    .setTitle('Robyn & Felix — RSVP')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}


/**
 * Called from the page via google.script.run.
 * Returns { found:true, greeting, members:[{name, attending, meal, language, dietary}], song }
 * or { found:false }.
 */
function getHousehold(hid) {
  if (!hid) return { found: false };

  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('Sheet "' + SHEET_NAME + '" not found.');

  var last = sh.getLastRow();
  if (last < 2) return { found: false };

  var values  = sh.getRange(1, 1, last, sh.getLastColumn()).getValues();
  var headers = values[0];
  var idx = resolveColumns_(headers);

  var members = [];
  var song = '';

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (String(row[idx.token]).trim() !== String(hid)) continue;

    var nm = String(row[idx.name]).trim();
    if (!nm) continue;

    members.push({
      name:      nm,
      attending: String(row[idx.attending] || '').trim(),
      meal:      String(row[idx.meal] || '').trim(),
      language:  String(row[idx.language] || '').trim(),
      dietary:   String(row[idx.dietary] || '').trim(),
      kid:       String(row[idx.kid] || '').trim() === 'Yes'
    });

    if (!song && idx.song > -1 && row[idx.song]) song = String(row[idx.song]).trim();
  }

  if (!members.length) return { found: false };

  return { found: true, greeting: greetingFor_(members), members: members, song: song };
}


/**
 * Write RSVP data back to the sheet.
 *
 * payload = {
 *   hid: "7",
 *   song: "Artist — Title",
 *   guests: [
 *     { name:"Wiebke", attending:true,  meal:"Meat",  language:"German", dietary:"" },
 *     { name:"Tobi",   attending:false, meal:"",      language:"",       dietary:"" }
 *   ]
 * }
 */
function submitRsvp(payload) {
  if (!payload || !payload.hid) throw new Error('Missing household token.');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // throws if it can't acquire within 30 s

  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
    if (!sh) throw new Error('Sheet "' + SHEET_NAME + '" not found.');

    var last = sh.getLastRow();
    if (last < 2) throw new Error('Sheet appears to be empty.');

    var range   = sh.getRange(1, 1, last, sh.getLastColumn());
    var values  = range.getValues();
    var headers = values[0];
    var idx     = resolveColumns_(headers);

    var hid  = String(payload.hid).trim();
    var now  = new Date();
    var song = String(payload.song || '').trim();

    // Translate German dropdown values to English before writing to the sheet
    var MEAL_MAP = { 'Fleisch': 'Meat', 'Pescetarisch': 'Pescatarian', 'Vegetarisch': 'Vegetarian' };
    var LANG_MAP = { 'Englisch': 'English', 'Kantonesisch': 'Cantonese', 'Deutsch': 'German' };

    // Build a name→payload-guest map (lower-cased for matching)
    var payloadByName = {};
    var guestArr = payload.guests || [];
    for (var gi = 0; gi < guestArr.length; gi++) {
      payloadByName[String(guestArr[gi].name).trim().toLowerCase()] = guestArr[gi];
    }

    // Collect household rows and all distinct email addresses
    var householdRows  = []; // 0-based indexes into values[]
    var emailsSeen     = {};
    var householdEmails = [];

    for (var r = 1; r < values.length; r++) {
      var row = values[r];
      if (String(row[idx.token]).trim() !== hid) continue;
      householdRows.push(r);
      if (idx.email > -1 && row[idx.email]) {
        var addr = String(row[idx.email]).trim();
        if (addr && !emailsSeen[addr.toLowerCase()]) {
          emailsSeen[addr.toLowerCase()] = true;
          householdEmails.push(addr);
        }
      }
    }

    if (!householdRows.length) {
      throw new Error('No rows found for token "' + hid + '". Check that the link is correct.');
    }

    // Phase 1 — validate: confirm every payload name matches a sheet row.
    // Nothing is written until this passes.
    var rowByName = {};
    for (var vi = 0; vi < householdRows.length; vi++) {
      var vnm = String(values[householdRows[vi]][idx.name]).trim();
      if (vnm) rowByName[vnm.toLowerCase()] = householdRows[vi];
    }
    var unmatchedPayload = [];
    for (var pi = 0; pi < guestArr.length; pi++) {
      var pLower = String(guestArr[pi].name).trim().toLowerCase();
      if (!(pLower in rowByName)) unmatchedPayload.push(guestArr[pi].name);
    }
    if (unmatchedPayload.length) {
      throw new Error('Submitted name(s) not found in sheet: ' + unmatchedPayload.join(', ') + '.');
    }

    // Phase 2 — write. Validation passed; safe to write.
    for (var ri = 0; ri < householdRows.length; ri++) {
      var rowIdx  = householdRows[ri];
      var rowData = values[rowIdx];
      var nm      = String(rowData[idx.name]).trim();
      var g       = payloadByName[nm.toLowerCase()];

      if (!g) {
        // Sheet name absent from payload — log for review.
        var currentNote = idx.notes > -1 ? String(rowData[idx.notes] || '') : '';
        var warningNote = '[RSVP mismatch ' + Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') + '] Name "' + nm + '" not in submitted payload.';
        if (currentNote.indexOf('[RSVP mismatch') === -1 && idx.notes > -1) {
          sh.getRange(rowIdx + 1, idx.notes + 1).setValue((currentNote ? currentNote + '\n' : '') + warningNote);
        }
        continue;
      }

      // Per-person write (normalise DE→EN dropdown values)
      var writeMeal = g.attending ? (MEAL_MAP[String(g.meal || '').trim()] || String(g.meal || '').trim()) : '';
      var writeLang = g.attending ? (LANG_MAP[String(g.language || '').trim()] || String(g.language || '').trim()) : '';
      sh.getRange(rowIdx + 1, idx.attending + 1).setValue(g.attending ? 'Yes' : 'No');
      sh.getRange(rowIdx + 1, idx.language + 1).setValue(writeLang);
      sh.getRange(rowIdx + 1, idx.meal + 1).setValue(writeMeal);
      sh.getRange(rowIdx + 1, idx.dietary + 1).setValue(g.attending ? String(g.dietary || '').trim() : '');

      // Household-level columns — write on every household row to keep the sheet consistent
      if (idx.song > -1) sh.getRange(rowIdx + 1, idx.song + 1).setValue(song);
      if (idx.updated > -1) sh.getRange(rowIdx + 1, idx.updated + 1).setValue(now);
    }

    SpreadsheetApp.flush();

    // Email is a courtesy; a failure must never roll back or mask the saved RSVP.
    if (householdEmails.length) {
      var attending = guestArr.filter(function(g) { return g.attending; });
      try {
        sendConfirmationEmail_(householdEmails.join(','), guestArr, attending, payload.lang, hid);
      } catch (emailErr) {
        console.error('sendConfirmationEmail_ failed for hid=' + hid + ': ' + emailErr);
      }
    }

  } finally {
    lock.releaseLock();
  }

  return { ok: true };
}


/**
 * Send a confirmation email in the language the guest selected on the form.
 * Uses MailApp (consumer Gmail cap ≈100 recipients/day).
 */
function sendConfirmationEmail_(toEmail, allGuests, attendingGuests, lang, hid) {
  var anyAttending = attendingGuests.length > 0;

  // Greeting uses all guests (the whole household), first names only
  var names = allGuests.map(function(g) { return g.name.split(' ')[0]; });
  var greeting;
  if (names.length === 1) {
    greeting = names[0];
  } else if (names.length === 2) {
    greeting = names[0] + ' & ' + names[1];
  } else {
    greeting = names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1];
  }

  var nameList = attendingGuests.map(function(g) { return g.name; });
  var isDE = (lang === 'de');
  var rsvpUrl = ScriptApp.getService().getUrl() + '?hid=' + hid + '&lang=' + lang;
  var websiteUrl = WEDDING_WEBSITE;

  var subjectEN = 'Robyn & Felix — We got your RSVP!';
  var subjectDE = 'Robyn & Felix — Wir haben euer RSVP erhalten!';

  var plainEN, htmlEN, plainDE, htmlDE;
  var footer = '——\nJuly 9–11, 2027 · Stella Maris, Denmark';
  var footerDE = '——\n9.–11. Juli 2027 · Stella Maris, Dänemark';
  var updateEN = 'You can always use your invitation link again to update your response:\n' + rsvpUrl;
  var updateDE = 'Ihr könnt euren Einladungslink jederzeit wieder nutzen, um eure Angaben zu aktualisieren:\n' + rsvpUrl;
  var updateHtmlEN = 'You can always use your <a href="' + rsvpUrl + '">invitation link</a> again to update your response.';
  var updateHtmlDE = 'Ihr könnt euren <a href="' + rsvpUrl + '">Einladungslink</a> jederzeit wieder nutzen, um eure Angaben zu aktualisieren.';

  if (anyAttending) {
    plainEN =
      'Hi ' + greeting + ',\n\n' +
      'We\'re so happy you\'ll be joining us!\n\n' +
      'Confirmed guests:\n' + nameList.join('\n') + '\n\n' +
      updateEN + '\n\n' +
      'In the meantime, visit our wedding website for more details on the weekend: ' + websiteUrl + '\n\n' +
      'We can\'t wait to celebrate with you!\n\n' +
      'With love,\nRobyn & Felix\n\n' + footer;

    htmlEN =
      '<p>Hi ' + greeting + ',</p>' +
      '<p>We\'re so happy you\'ll be joining us!</p>' +
      '<p><strong>Confirmed guests:</strong><br>' + nameList.join('<br>') + '</p>' +
      '<p>' + updateHtmlEN + '</p>' +
      '<p>In the meantime, visit our <a href="' + websiteUrl + '">wedding website</a> for more details on the weekend.</p>' +
      '<p>We can\'t wait to celebrate with you!</p>' +
      '<p>With love,<br>Robyn & Felix</p>' +
      '<p style="color:#6B7F6A;font-size:12px">' + footer.replace('\n', '<br>') + '</p>';

    plainDE =
      'Hallo ' + greeting + ',\n\n' +
      'Wir freuen uns so sehr, dass ihr dabei seid!\n\n' +
      'Bestätigte Gäste:\n' + nameList.join('\n') + '\n\n' +
      updateDE + '\n\n' +
      'In der Zwischenzeit besucht unsere Hochzeitswebsite für weitere Details zum Wochenende: ' + websiteUrl + '\n\n' +
      'Wir können es kaum erwarten, mit euch zu feiern!\n\n' +
      'Mit viel Liebe,\nRobyn & Felix\n\n' + footerDE;

    htmlDE =
      '<p>Hallo ' + greeting + ',</p>' +
      '<p>Wir freuen uns so sehr, dass ihr dabei seid!</p>' +
      '<p><strong>Bestätigte Gäste:</strong><br>' + nameList.join('<br>') + '</p>' +
      '<p>' + updateHtmlDE + '</p>' +
      '<p>In der Zwischenzeit besucht unsere <a href="' + websiteUrl + '">Hochzeitswebsite</a> für weitere Details zum Wochenende.</p>' +
      '<p>Wir können es kaum erwarten, mit euch zu feiern!</p>' +
      '<p>Mit viel Liebe,<br>Robyn & Felix</p>' +
      '<p style="color:#6B7F6A;font-size:12px">' + footerDE.replace('\n', '<br>') + '</p>';

  } else {
    plainEN =
      'Hi ' + greeting + ',\n\n' +
      'We\'re sad to miss you, but hope we can celebrate together another time soon!\n\n' +
      updateEN + '\n\n' +
      'With love,\nRobyn & Felix\n\n' + footer;

    htmlEN =
      '<p>Hi ' + greeting + ',</p>' +
      '<p>We\'re sad to miss you, but hope we can celebrate together another time soon!</p>' +
      '<p>' + updateHtmlEN + '</p>' +
      '<p>With love,<br>Robyn & Felix</p>' +
      '<p style="color:#6B7F6A;font-size:12px">' + footer.replace('\n', '<br>') + '</p>';

    plainDE =
      'Hallo ' + greeting + ',\n\n' +
      'Es tut uns leid, dass ihr nicht dabei sein könnt, aber wir hoffen, bald gemeinsam feiern zu können!\n\n' +
      updateDE + '\n\n' +
      'Mit viel Liebe,\nRobyn & Felix\n\n' + footerDE;

    htmlDE =
      '<p>Hallo ' + greeting + ',</p>' +
      '<p>Es tut uns leid, dass ihr nicht dabei sein könnt, aber wir hoffen, bald gemeinsam feiern zu können!</p>' +
      '<p>' + updateHtmlDE + '</p>' +
      '<p>Mit viel Liebe,<br>Robyn & Felix</p>' +
      '<p style="color:#6B7F6A;font-size:12px">' + footerDE.replace('\n', '<br>') + '</p>';
  }

  MailApp.sendEmail({
    to:       toEmail,
    subject:  isDE ? subjectDE : subjectEN,
    body:     isDE ? plainDE : plainEN,
    htmlBody: isDE ? htmlDE : htmlEN
  });
}



/** Map header names → 0-based column indexes. Immune to column reordering. */
function resolveColumns_(headers) {
  var map = {};
  for (var i = 0; i < headers.length; i++) {
    map[String(headers[i]).trim()] = i;
  }
  var idx = {};
  var required = ['token', 'name', 'attending', 'language', 'meal', 'dietary'];

  for (var key in COL) {
    var header = COL[key];
    idx[key] = (header in map) ? map[header] : -1;
  }
  for (var j = 0; j < required.length; j++) {
    if (idx[required[j]] === -1) {
      throw new Error('Missing required column: "' + COL[required[j]] + '" in "' + SHEET_NAME + '"');
    }
  }
  return idx;
}


/** "Nadia", "Nadia & Francis", "Nadia, Francis & Gaby" — first names only. */
function greetingFor_(members) {
  var first = members.map(function (m) { return m.name.split(' ')[0]; });
  if (first.length === 1) return first[0];
  if (first.length === 2) return first[0] + ' & ' + first[1];
  return first.slice(0, -1).join(', ') + ' & ' + first[first.length - 1];
}


// ============================ PAGE ============================

function buildPage(hid, lang) {
  lang = (lang === 'de') ? 'de' : 'en'; // defensive normalise
  var css =
':root{--ink:#1C2B3A;--cream:#F5EFE3;--sage:#6B7F6A;--burgundy:#6B2737;}' +
'*{box-sizing:border-box}' +
'body{margin:0;background:var(--cream);color:var(--ink);font-family:"DM Sans",-apple-system,sans-serif;font-weight:300;-webkit-font-smoothing:antialiased}' +
'.wrap{max-width:640px;margin:0 auto;padding:32px 24px 80px}' +
'.lang{display:flex;gap:4px;justify-content:flex-end;margin-bottom:32px}' +
'.lang button{background:none;border:1px solid rgba(28,43,58,.2);color:var(--ink);font-family:"DM Sans",sans-serif;font-size:11px;letter-spacing:.12em;text-transform:uppercase;padding:7px 14px;cursor:pointer;border-radius:2px;transition:.2s}' +
'.lang button.on{background:var(--ink);color:var(--cream);border-color:var(--ink)}' +
'.crest{text-align:center;font-size:22px;color:var(--sage);margin-bottom:20px;letter-spacing:.3em}' +
'h1{font-family:"Cormorant Garamond",Georgia,serif;font-weight:300;font-size:44px;line-height:1.15;text-align:center;margin:0 0 14px}' +
'.date{text-align:center;font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--sage);margin-bottom:44px}' +
'.rule{height:1px;background:rgba(28,43,58,.12);margin:0 0 40px}' +
'h2{font-family:"Cormorant Garamond",serif;font-weight:400;font-size:25px;margin:0 0 22px}' +
'.sub{font-size:14px;color:var(--sage);margin:-14px 0 24px;line-height:1.6}' +
'.person{background:#fff;border:1px solid rgba(28,43,58,.08);border-radius:3px;padding:18px 20px;margin-bottom:12px;transition:.2s}' +
'.person.yes{border-color:var(--sage);box-shadow:0 1px 10px rgba(107,127,106,.10)}' +
'.row{display:flex;align-items:center;gap:13px}' +
'.row input[type=checkbox]{appearance:none;-webkit-appearance:none;width:21px;height:21px;flex:none;cursor:pointer;border:1.5px solid rgba(28,43,58,.3);border-radius:2px;background:#fff;position:relative}' +
'.row input[type=checkbox]:checked{background:var(--sage);border-color:var(--sage)}' +
'.row input[type=checkbox]:checked::after{content:"";position:absolute;left:6.5px;top:2.5px;width:5px;height:10px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}' +
'.row label{font-size:17px;cursor:pointer;flex:1}' +
'.detail{display:none;margin-top:16px;padding-top:16px;border-top:1px solid rgba(28,43,58,.07)}' +
'.person.yes .detail{display:block}' +
'.field{margin-bottom:14px}.field:last-child{margin-bottom:0}' +
'.field label{display:block;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--sage);margin-bottom:7px}' +
'select,input[type=text],textarea{width:100%;padding:11px 12px;font-family:"DM Sans",sans-serif;font-size:15px;font-weight:300;color:var(--ink);background:var(--cream);border:1px solid rgba(28,43,58,.14);border-radius:2px;outline:none}' +
'select:focus,input:focus,textarea:focus{border-color:var(--sage)}' +
'textarea{resize:vertical;min-height:74px}' +
'.block{margin-top:40px}' +
'button.send{width:100%;margin-top:34px;padding:17px;background:var(--ink);color:var(--cream);border:none;border-radius:2px;font-family:"DM Sans",sans-serif;font-size:12px;letter-spacing:.2em;text-transform:uppercase;cursor:pointer;transition:.2s}' +
'button.send:hover{background:var(--burgundy)}' +
'button.send:disabled{opacity:.45;cursor:default}' +
'.err{display:none;margin-top:24px;padding:13px 16px;background:rgba(107,39,55,.06);border:1px solid rgba(107,39,55,.25);border-radius:2px;color:var(--burgundy);font-size:14px;line-height:1.5}' +
'.meta{text-align:center;font-size:13px;color:var(--sage);line-height:1.8;margin-top:18px}' +
'.done,.lost{display:none;text-align:center;padding:70px 0}' +
'.done h1,.lost h1{margin-bottom:18px}' +
'.done p,.lost p{color:var(--sage);font-size:15px;line-height:1.75}' +
'.loading{text-align:center;padding:90px 0;color:var(--sage);font-size:14px;letter-spacing:.1em;text-transform:uppercase}' +
'.foot{text-align:center;margin-top:52px;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--sage);opacity:.6}' +
'';

  var rsvpBaseUrl = ScriptApp.getService().getUrl();

  var js =
'var HID = ' + JSON.stringify(String(hid)) + ';' +
'var RSVP_URL = ' + JSON.stringify(rsvpBaseUrl + '?hid=' + String(hid) + '&lang=' + lang) + ';' +
'var MEMBERS = [], GREETING = "", SONG = "";' +
'var T={' +
'en:{hello:"Welcome, ",q1:"Who\'s joining us?",q1sub:"Please confirm each guest below.",q2:"A song to get you dancing",meal:"Meal",lang:"Language",diet:"Dietary needs or allergies",meals:["Meat","Pescatarian","Vegetarian"],langs:["English","Cantonese","German"],dietPh:"Optional",choose:"Please select\\u2026",err:"Please choose a meal and language for each guest attending.",songPh:"Artist \\u2014 Song title",date:"Stella Maris, Denmark · July 9–11, 2027",invite:"You\'re invited to a long weekend on the Danish coast: a boat, a dip in the sea, a candlelit dinner, and dancing late into the night with all our favorite people in one place. We hope you can celebrate with us!",q2opt:"(optional)",doneH:"We can\'t wait to<br>celebrate with you!",doneHDeclined:"We\'ll miss you — thank you for letting us know. Hope we can celebrate together another time!",daysTo:"days to go",gcal:"Add to calendar",send:"Send RSVP",deadline:"Please respond by February 28, 2027.",doneUpdate:"You can update your response anytime using this link.",doneP:"",lostH:"We couldn\'t find your invitation",lostP:"Please use the link from your invitation email,<br>or get in touch and we\'ll sort it out.",errH:"Something went wrong",errP:"Please refresh the page, or get in touch and we\'ll sort it out.",loading:"Loading\\u2026"},' +
'de:{hello:"Willkommen, ",q1:"Wer kommt mit?",q1sub:"Bitte best\\u00e4tigt jeden Gast unten.",q2:"Ein Lied zum Tanzen",meal:"Essen",lang:"Sprache",diet:"Unvertr\\u00e4glichkeiten oder Allergien",meals:["Fleisch","Pescetarisch","Vegetarisch"],langs:["Englisch","Kantonesisch","Deutsch"],dietPh:"Optional",choose:"Bitte w\\u00e4hlen\\u2026",err:"Bitte w\\u00e4hlt f\\u00fcr jeden teilnehmenden Gast Essen und Sprache aus.",songPh:"K\\u00fcnstler \\u2014 Titel",date:"Stella Maris, D\\u00e4nemark · 9.–11. Juli 2027",q2opt:"(optional)",doneH:"Wir k\\u00f6nnen es kaum<br>erwarten, mit euch zu feiern!",doneHDeclined:"Wir werden euch vermissen \\u2014 danke, dass ihr Bescheid gegeben habt. Wir hoffen, bald gemeinsam feiern zu k\\u00f6nnen!",invite:"Ihr seid eingeladen zu einem langen Wochenende an der d\\u00e4nischen K\\u00fcste \\u2014 ein Boot, ein Bad im Meer, ein Abendessen bei Kerzenschein und Tanzen bis tief in die Nacht mit all unseren Lieblingsmenschen an einem Ort. Wir hoffen, ihr k\\u00f6nnt mit uns feiern!",daysTo:"Tage noch",gcal:"Zum Kalender hinzuf\\u00fcgen",send:"RSVP Senden",deadline:"Bitte antwortet bis zum 28. Februar 2027.",doneUpdate:"Ihr k\\u00f6nnt eure Antwort jederzeit \\u00fcber diesen Link aktualisieren.",doneP:"",lostH:"Wir konnten eure Einladung nicht finden",lostP:"Bitte nutzt den Link aus eurer Einladungs-E-Mail,<br>oder meldet euch bei uns.",errH:"Etwas ist schiefgelaufen",errP:"Bitte die Seite neu laden oder bei uns melden \\u2014 wir helfen weiter.",loading:"L\\u00e4dt\\u2026"}};' +
'var lang=' + JSON.stringify(lang) + ';' +

'function clearErr(){document.getElementById("err").style.display="none";}' +
'function toggle(i){var p=document.getElementById("p"+i);p.className=document.getElementById("chk"+i).checked?"person yes":"person";clearErr();}' +
'function setLang(l){lang=l;document.getElementById("btnEn").className=(l==="en")?"on":"";document.getElementById("btnDe").className=(l==="de")?"on":"";if(MEMBERS.length)build();else showLost();}' +

'function showLost(){' +
'var t=T[lang];' +
'document.getElementById("loading").style.display="none";' +
'document.getElementById("form").style.display="none";' +
'document.getElementById("lostH").textContent=t.lostH;' +
'document.getElementById("lostP").innerHTML=t.lostP;' +
'document.getElementById("lost").style.display="block";}' +

'function showErr(err){' +
'console.error("getHousehold failed:",err);' +
'var t=T[lang];' +
'document.getElementById("loading").style.display="none";' +
'document.getElementById("form").style.display="none";' +
'document.getElementById("lostH").textContent=t.errH;' +
'document.getElementById("lostP").innerHTML=t.errP;' +
'document.getElementById("lost").style.display="block";}' +

'function build(){' +
'var t=T[lang];' +
'document.getElementById("loading").style.display="none";' +
'document.getElementById("lost").style.display="none";' +
'document.getElementById("form").style.display="block";' +
'document.getElementById("hello").textContent=t.hello+GREETING+"!";' +
'document.getElementById("q1").textContent=t.q1;' +
'document.getElementById("q1sub").textContent=t.q1sub;' +
'document.getElementById("q2text").textContent=t.q2;' +
'document.getElementById("send").textContent=t.send;' +
'document.getElementById("dateline").textContent=t.date;' +
'document.getElementById("invite").textContent=t.invite;' +
'document.getElementById("deadline").textContent=t.deadline;' +
'document.getElementById("song").placeholder=t.songPh;' +
'document.getElementById("doneH").innerHTML=t.doneH;' +
'document.getElementById("q2opt").textContent=t.q2opt;' +
'document.getElementById("doneP").innerHTML=t.doneP;' +
'var saved=[],i;' +
'for(i=0;i<MEMBERS.length;i++){var c=document.getElementById("chk"+i);' +
'var mi=document.getElementById("meal"+i),li=document.getElementById("lang"+i),di=document.getElementById("diet"+i);' +
'saved.push({on:c?c.checked:null,mi:mi?mi.selectedIndex:null,li:li?li.selectedIndex:null,dv:di?di.value:null});}' +
'var box=document.getElementById("people");box.innerHTML="";' +
'for(i=0;i<MEMBERS.length;i++){' +
'var mo="",lo="",m,l;' +
'mo+=\'<option value="" disabled selected>\'+t.choose+\'</option>\';' +
'lo+=\'<option value="" disabled selected>\'+t.choose+\'</option>\';' +
'for(m=0;m<t.meals.length;m++){mo+="<option>"+t.meals[m]+"</option>";}' +
'for(l=0;l<t.langs.length;l++){lo+="<option>"+t.langs[l]+"</option>";}' +
'var d=document.createElement("div");d.className="person";d.id="p"+i;' +
'd.innerHTML=' +
'\'<div class="row"><input type="checkbox" id="chk\'+i+\'" onchange="toggle(\'+i+\')"><label for="chk\'+i+\'">\'+MEMBERS[i].name+\'</label></div>\'+' +
'(MEMBERS[i].kid?"":\'<div class="detail">\'+' +
'\'<div class="field"><label>\'+t.meal+\'</label><select id="meal\'+i+\'" onchange="clearErr()">\'+mo+\'</select></div>\'+' +
'\'<div class="field"><label>\'+t.lang+\'</label><select id="lang\'+i+\'" onchange="clearErr()">\'+lo+\'</select></div>\'+' +
'\'<div class="field"><label>\'+t.diet+\'</label><input type="text" id="diet\'+i+\'" placeholder="\'+t.dietPh+\'"></div>\'+' +
'\'</div>\');' +
'box.appendChild(d);' +
// restore in-page edits if re-rendering (language toggle); else seed from sheet
'if(saved[i].on!==null){' +
'if(saved[i].on){document.getElementById("chk"+i).checked=true;toggle(i);}' +
'if(saved[i].mi)document.getElementById("meal"+i).selectedIndex=saved[i].mi;' +
'if(saved[i].li)document.getElementById("lang"+i).selectedIndex=saved[i].li;' +
'if(saved[i].dv)document.getElementById("diet"+i).value=saved[i].dv;' +
'}else{' +
'if(MEMBERS[i].attending==="Yes"){document.getElementById("chk"+i).checked=true;toggle(i);}' +
'var mv=MEMBERS[i].meal,lv=MEMBERS[i].language;' +
'if(mv){var ms=document.getElementById("meal"+i);for(m=0;m<ms.options.length;m++){if(ms.options[m].text===mv)ms.selectedIndex=m;}}' +
'if(lv){var ls=document.getElementById("lang"+i);for(l=0;l<ls.options.length;l++){if(ls.options[l].text===lv)ls.selectedIndex=l;}}' +
'if(MEMBERS[i].dietary)document.getElementById("diet"+i).value=MEMBERS[i].dietary;' +
'}}' +
'if(SONG&&!document.getElementById("song").value)document.getElementById("song").value=SONG;' +
'}' +

'function send(){' +
'var t=T[lang],i,miss=false;' +
'for(i=0;i<MEMBERS.length;i++){if(!MEMBERS[i].kid&&document.getElementById("chk"+i).checked){' +
'if(!document.getElementById("meal"+i).value||!document.getElementById("lang"+i).value){miss=true;}}}' +
'if(miss){var e=document.getElementById("err");e.textContent=t.err;e.style.display="block";e.scrollIntoView({behavior:"smooth",block:"center"});return;}' +
'var out={hid:HID,lang:lang,guests:[],song:document.getElementById("song").value};' +
'for(i=0;i<MEMBERS.length;i++){var g=document.getElementById("chk"+i).checked;' +
'out.guests.push({name:MEMBERS[i].name,attending:g,meal:(!MEMBERS[i].kid&&g)?document.getElementById("meal"+i).value:"",language:(!MEMBERS[i].kid&&g)?document.getElementById("lang"+i).value:"",dietary:(!MEMBERS[i].kid&&g)?document.getElementById("diet"+i).value:""});}' +
'document.getElementById("send").disabled=true;' +
'google.script.run.withSuccessHandler(function(){' +
'document.getElementById("form").style.display="none";' +
'var done=document.getElementById("done");done.style.display="block";window.scrollTo(0,0);' +
'var anyAttending=out.guests.some(function(g){return g.attending;});' +
'if(anyAttending){' +
'document.getElementById("doneH").innerHTML=T[lang].doneH;' +
'var wedding=new Date("2027-07-09T00:00:00");' +
'var diff=Math.ceil((wedding-new Date())/(1000*60*60*24));' +
'document.getElementById("countdown").innerHTML="<span style=\'display:block;font-size:44px;line-height:1.1\'>"+diff+"</span>"+T[lang].daysTo;' +
'document.getElementById("gcalLink").href=' + JSON.stringify(WEDDING_ICS) + ';document.getElementById("gcalLink").textContent=T[lang].gcal;document.getElementById("gcalLink").style.display="inline-block";' +
'}else{' +
'document.getElementById("doneH").innerHTML=T[lang].doneHDeclined;' +
'document.getElementById("countdown").style.display="none";' +
'}' +
'document.getElementById("doneUpdate").innerHTML=\'<a href="\'+RSVP_URL+\'" target="_top" style="color:var(--sage)">\'+T[lang].doneUpdate+\'</a>\';' +
'})' +
'.withFailureHandler(function(err){document.getElementById("send").disabled=false;' +
'var e=document.getElementById("err");e.textContent=String(err&&err.message?err.message:err);e.style.display="block";})' +
'.submitRsvp(out);}' +

// boot: fetch the household, then render
'document.getElementById("loading").textContent=T[lang].loading;' +
'google.script.run.withSuccessHandler(function(res){' +
'if(!res||!res.found){showLost();return;}' +
'MEMBERS=res.members;GREETING=res.greeting;SONG=res.song||"";build();})' +
'.withFailureHandler(function(err){showErr(err);})' +
'.getHousehold(HID);';

  return '<!DOCTYPE html><html><head><base target="_top"><meta charset="utf-8">' +
    '<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;600&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">' +
    '<style>' + css + '</style></head><body><div class="wrap">' +
    '<div class="lang"><button id="btnEn" class="' + (lang === 'en' ? 'on' : '') + '" onclick="setLang(\'en\')">English</button>' +
    '<button id="btnDe" class="' + (lang === 'de' ? 'on' : '') + '" onclick="setLang(\'de\')">Deutsch</button></div>' +

    '<div class="loading" id="loading">Loading&hellip;</div>' +

    '<div id="form" style="display:none">' +
    '<div class="crest">&#10022;</div>' +
    '<h1 id="hello"></h1>' +
    '<div class="date" id="dateline">Stella Maris, Denmark &middot; July 9&ndash;11, 2027</div>' +
    '<div class="rule"></div>' +
    '<p id="invite" style="font-size:15px;line-height:1.75;color:var(--ink);margin:0 0 40px"></p>' +
    '<h2 id="q1"></h2><div class="sub" id="q1sub"></div>' +
    '<div id="people"></div>' +
    '<div class="block"><h2 id="q2"><span id="q2text"></span> <span id="q2opt" style="font-family:\'DM Sans\',sans-serif;font-size:13px;font-weight:300;letter-spacing:0;text-transform:none;color:var(--sage)"></span></h2><div class="field">' +
    '<input type="text" id="song"></div></div>' +
    '<div class="err" id="err"></div>' +
    '<div class="meta" style="text-align:left;margin-bottom:16px"><span id="deadline"></span></div>' +
    '<button class="send" id="send" onclick="send()"></button>' +
    '<div class="foot">Robyn &amp; Felix</div></div>' +

    '<div class="done" id="done"><div class="crest">&#10022;</div>' +
    '<h1 id="doneH"></h1><p id="doneP"></p>' +
    '<div id="countdown" style="margin-top:32px;font-family:\'Cormorant Garamond\',serif;font-size:20px;color:var(--sage);letter-spacing:.1em"></div>' +
    '<a id="gcalLink" href="#" target="_blank" style="display:none;margin-top:28px;font-family:\'DM Sans\',sans-serif;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--sage);text-decoration:none;border:1px solid rgba(107,127,106,.4);padding:10px 20px;border-radius:2px;transition:.2s"></a>' +
    '<p id="doneUpdate" style="margin-top:28px;font-size:13px;color:var(--sage)"></p></div>' +

    '<div class="lost" id="lost"><div class="crest">&#10022;</div>' +
    '<h1 id="lostH"></h1><p id="lostP"></p></div>' +

    '</div><script>' + js + '<\/script></body></html>';
}

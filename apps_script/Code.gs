/**
 * GRACE HITL — label collection endpoint (Google Apps Script)
 *
 * Deploy this bound to a Google Sheet. Each label the web annotator produces is
 * POSTed here and appended as one row. Export the sheet to CSV and feed it to
 * sheet_to_labels.py to build the labels.jsonl that M5 (`run_hitl replay`) reads.
 *
 * SETUP
 *  1. Create a Google Sheet. Extensions -> Apps Script. Paste this in Code.gs.
 *  2. Run `setup` once (Run menu) to write the header row; approve permissions.
 *  3. Deploy -> New deployment -> type "Web app".
 *       Execute as: Me
 *       Who has access: Anyone   (required so validators' browsers can POST)
 *  4. Copy the /exec Web app URL into docs/config.js (APPS_SCRIPT_URL).
 *  5. Re-deploy (new version) whenever you edit this file.
 *
 * The browser POSTs Content-Type: text/plain to avoid a CORS preflight, so the
 * request is fire-and-forget (the app cannot read the response). Duplicates from
 * client retries are harmless: sheet_to_labels.py dedupes by (validator_id,
 * claim_id), keeping the last write.
 *
 * doGet(action=assign) is the OVERLAP ASSIGNER: it hands each validator a unique,
 * stable, dense seat index (0,1,2,...). The client turns that seat into a claim
 * subset (see app.js assignedClaims). The response is delivered via JSONP
 * (callback=...), because Apps Script cannot set CORS headers for a readable
 * cross-origin fetch. Seat allocation is guarded by LockService so two
 * simultaneous first-visits never get the same seat.
 */

var SHEET_NAME = 'labels';
var HEADERS = [
  'received_at', 'validator_id', 'claim_id', 'doc_id', 'round',
  'decision', 'elapsed_s', 'is_calibration', 'cc_score', 'client_ts'
];

var SEAT_SHEET = 'assignments';
var SEAT_HEADERS = ['validator_id', 'seat', 'assigned_at'];

function _sheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
  }
  return sh;
}

function _seatSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SEAT_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SEAT_SHEET);
    sh.appendRow(SEAT_HEADERS);
  }
  return sh;
}

/** Look up or allocate this validator's dense seat index. */
function _assignSeat(validatorId) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = _seatSheet();
    var last = sh.getLastRow();
    if (last >= 2) {
      var rows = sh.getRange(2, 1, last - 1, 2).getValues();  // [validator_id, seat]
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i][0]) === String(validatorId)) {
          return Number(rows[i][1]);            // idempotent: existing seat
        }
      }
      var seat = rows.length;                    // next dense seat = count so far
      sh.appendRow([validatorId, seat, new Date()]);
      return seat;
    }
    sh.appendRow([validatorId, 0, new Date()]);  // first validator
    return 0;
  } finally {
    lock.releaseLock();
  }
}

function _reply(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback) {                                // JSONP for cross-origin reads
    return ContentService
      .createTextOutput(callback + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  var callback = p.callback || '';
  if (p.action === 'assign' && p.validator) {
    var seat = _assignSeat(p.validator);
    return _reply({ ok: true, validator_id: p.validator, seat: seat }, callback);
  }
  // Health check: visiting the URL in a browser confirms the deployment is live.
  return _reply({ ok: true, service: 'grace-hitl-labels' }, callback);
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    // Accept a single label object or a batch (array) in one request.
    var items = Array.isArray(body) ? body : [body];
    var sh = _sheet();
    var now = new Date();
    var rows = items.map(function (r) {
      return [
        now,
        String(r.validator_id || ''),
        String(r.claim_id || ''),
        String(r.doc_id || ''),
        r.round != null ? r.round : '',
        String(r.decision || ''),
        r.elapsed_s != null ? r.elapsed_s : '',
        r.is_calibration ? true : false,
        r.cc_score != null ? r.cc_score : '',
        String(r.client_ts || '')
      ];
    });
    if (rows.length) {
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
    }
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, written: rows.length }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

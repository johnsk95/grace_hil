/* GRACE HITL — web annotator.
 *
 * Drop-in replacement for the M4 curses TUI. Loads pool.json, shows a passage +
 * a claim, records Confirm/Reject/Unsure with per-claim timing, and emits labels
 * in the exact schema M5 (`aggregate_labels`) reads:
 *   {claim_id, doc_id, validator_id, decision, elapsed_s, is_calibration, cc_score}
 * (plus round, client_ts — extra fields are ignored downstream).
 *
 * Identity is automatic: a per-browser id is generated once and persisted, so
 * different computers are distinct validators with nothing to type.
 *
 * Overlap assigner: the server (Apps Script doGet action=assign) hands each
 * validator a unique dense seat; assignedClaims() turns that seat into this
 * validator's claim subset so calibration claims go to everyone, a fraction of
 * the rest are labeled by OVERLAP_K validators (agreement), and the remainder
 * are single-labeled (coverage). Falls back to a hash-derived seat if the server
 * is unavailable, and to the whole pool if the assigner is off.
 *
 * Navigation: prev/next (buttons or ←/→) move through the assigned list,
 * including already-labeled claims, so a validator can go back and revise. The
 * latest decision per claim wins (server + export dedupe by validator+claim).
 *
 * Durability: every decision is written to localStorage immediately (source of
 * truth for resume + manual export). Labels also go to an outbox flushed to the
 * Apps Script sheet fire-and-forget; retries may duplicate a row, deduped on export.
 */
(function () {
  "use strict";

  var CFG = window.GRACE_CONFIG || {};
  var LS = window.localStorage;
  var K = {
    vid: "grace_hitl_validator_id",
    seat: "grace_hitl_seat",
    decisions: "grace_hitl_decisions",   // {claim_id: labelRecord}
    outbox: "grace_hitl_outbox",          // [labelRecord, ...] not yet acked as sent
  };

  // ── Identity ──────────────────────────────────────────────────────────────
  function getValidatorId() {
    var v = LS.getItem(K.vid);
    if (!v) {
      var uuid = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
      v = "V-" + uuid.replace(/-/g, "").slice(0, 8);
      LS.setItem(K.vid, v);
    }
    return v;
  }

  // ── Deterministic PRNG helpers ──────────────────────────────────────────────
  function hashStr(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seededShuffle(arr, seed) {
    var a = arr.slice(), rnd = mulberry32(seed >>> 0);
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // ── Overlap partition ───────────────────────────────────────────────────────
  // Pure function of (seat, config). Calibration first (shared, fixed order);
  // the rest are shuffled with the SHARED pool seed (identical for all clients),
  // split into an overlap block (each claim -> OVERLAP_K consecutive slots) and a
  // single block (each claim -> one slot), where slot = seat mod V. The visible
  // order of this validator's own claims is then shuffled by validator id (cosmetic).
  function assignedClaims(claims, seat) {
    var V = Math.max(1, CFG.N_VALIDATORS_EXPECTED || 6);
    var overlapK = Math.min(V, Math.max(1, CFG.OVERLAP_K || 2));
    var frac = Math.min(1, Math.max(0, CFG.OVERLAP_FRACTION != null ? CFG.OVERLAP_FRACTION : 0.3));
    var poolSeed = CFG.POOL_SEED || 1234567;

    var calib = claims.filter(function (c) { return c.is_calibration; })
      .sort(function (a, b) { return String(a.claim_id) < String(b.claim_id) ? -1 : 1; });
    var rest = seededShuffle(claims.filter(function (c) { return !c.is_calibration; }), poolSeed);

    var slot = ((seat % V) + V) % V;
    var nOverlap = Math.round(frac * rest.length);
    var mine = [];

    for (var i = 0; i < rest.length; i++) {
      if (i < nOverlap) {                          // overlap block: OVERLAP_K slots
        var start = i % V, hit = false;
        for (var j = 0; j < overlapK; j++) { if ((start + j) % V === slot) { hit = true; break; } }
        if (hit) mine.push(rest[i]);
      } else {                                     // single block: one slot
        if (i % V === slot) mine.push(rest[i]);
      }
    }
    return calib.concat(seededShuffle(mine, hashStr(vid)));
  }

  // ── State ────────────────────────────────────────────────────────────────
  var vid = getValidatorId();
  var pool = [];          // ordered claim records assigned to this validator
  var idx = 0;            // current position in `pool`
  var tStart = 0;         // performance.now() at render of current claim
  var decisions = readJSON(K.decisions, {});
  var outbox = readJSON(K.outbox, []);

  function readJSON(key, dflt) {
    try { return JSON.parse(LS.getItem(key)) || dflt; } catch (e) { return dflt; }
  }
  function writeJSON(key, val) { LS.setItem(key, JSON.stringify(val)); }

  // ── DOM ──────────────────────────────────────────────────────────────────
  var $ = function (id) { return document.getElementById(id); };
  var el = {
    study: $("study-name"), vtag: $("validator-tag"),
    progText: $("progress-text"), progFill: $("progress-fill"), syncDot: $("sync-dot"),
    intro: $("intro"), annotate: $("annotate"), done: $("done"),
    resumeNote: $("resume-note"), startBtn: $("start-btn"),
    ctx: $("context-text"), claim: $("claim-text"),
    calibBadge: $("calib-badge"),
    btnConfirm: $("btn-confirm"), btnReject: $("btn-reject"), btnUnsure: $("btn-unsure"),
    btnPrev: $("btn-prev"), btnNext: $("btn-next"), position: $("position"),
    doneSummary: $("done-summary"), downloadBtn: $("download-btn"), reviewBtn: $("review-btn"),
    floatExport: $("floating-export"), resyncNote: $("resync-note"),
  };

  // ── Boot ───────────────────────────────────────────────────────────────────
  el.study.textContent = CFG.STUDY_NAME || "GRACE claim verification";
  el.vtag.textContent = "· " + vid;

  fetch("pool.json", { cache: "no-store" })
    .then(function (r) {
      if (!r.ok) throw new Error("pool.json HTTP " + r.status);
      return r.json();
    })
    .then(function (data) {
      var allClaims = data.claims || [];
      resolveSeat(function (seat) {
        var assignOn = (CFG.OVERLAP_ASSIGN != null) ? CFG.OVERLAP_ASSIGN : !!CFG.APPS_SCRIPT_URL;
        if (assignOn) {
          pool = assignedClaims(allClaims, seat);
          if (pool.length === 0) pool = allClaims.slice();   // safety: never empty
        } else {
          pool = allClaims.slice();
        }
        onPoolReady();
      });
    })
    .catch(function (err) {
      el.intro.querySelector(".card").innerHTML =
        "<h1>Could not load claims</h1><p class='muted'>" + String(err) +
        "</p><p class='muted small'>Check that pool.json is deployed next to this page.</p>";
    });

  function onPoolReady() {
    var doneCount = countDecided();
    if (doneCount > 0 && doneCount < pool.length) {
      el.resumeNote.textContent = "Welcome back — you've labeled " + doneCount +
        " of " + pool.length + ". Resuming where you left off.";
      el.resumeNote.classList.remove("hidden");
      el.startBtn.textContent = "Resume";
    } else if (doneCount > 0 && doneCount >= pool.length) {
      el.startBtn.textContent = "Review my answers";
    }
    flushOutbox();
  }

  // ── Seat resolution (server assigner via JSONP, else hash fallback) ──────────
  function resolveSeat(cb) {
    var cached = LS.getItem(K.seat);
    if (cached != null && cached !== "") { cb(parseInt(cached, 10)); return; }

    var assignOn = (CFG.OVERLAP_ASSIGN != null) ? CFG.OVERLAP_ASSIGN : !!CFG.APPS_SCRIPT_URL;
    if (!assignOn || !CFG.APPS_SCRIPT_URL) { cb(hashSeat()); return; }

    var cbName = "graceSeatCb_" + hashStr(vid).toString(16);
    var done = false;
    var script = document.createElement("script");
    function cleanup() {
      try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
      if (script.parentNode) script.parentNode.removeChild(script);
      clearTimeout(timer);
    }
    window[cbName] = function (data) {
      if (done) return; done = true;
      var seat = (data && typeof data.seat === "number") ? data.seat : hashSeat();
      LS.setItem(K.seat, String(seat));
      cleanup(); cb(seat);
    };
    script.onerror = function () { if (done) return; done = true; cleanup(); cb(hashSeat()); };
    var sep = CFG.APPS_SCRIPT_URL.indexOf("?") >= 0 ? "&" : "?";
    script.src = CFG.APPS_SCRIPT_URL + sep + "action=assign&validator=" +
      encodeURIComponent(vid) + "&callback=" + cbName;
    var timer = setTimeout(function () {
      if (done) return; done = true; cleanup(); cb(hashSeat());   // don't block on a dead server
    }, 8000);
    document.body.appendChild(script);
  }
  function hashSeat() {
    return hashStr(vid) % Math.max(1, CFG.N_VALIDATORS_EXPECTED || 6);
  }

  function countDecided() {
    var n = 0;
    for (var i = 0; i < pool.length; i++) if (decisions[pool[i].claim_id]) n++;
    return n;
  }
  function firstUndecided() {
    for (var i = 0; i < pool.length; i++) if (!decisions[pool[i].claim_id]) return i;
    return 0;   // all decided -> start at the top for review
  }

  // ── Screen flow ─────────────────────────────────────────────────────────────
  el.startBtn.addEventListener("click", function () {
    idx = firstUndecided();
    el.intro.classList.add("hidden");
    el.done.classList.add("hidden");
    el.floatExport.classList.remove("hidden");
    el.annotate.classList.remove("hidden");
    render();
  });

  function render() {
    var rec = pool[idx];
    if (!rec) { showDone(); return; }
    updateProgress();
    el.ctx.textContent = rec.source_chunk_text || "(no passage)";
    el.ctx.scrollTop = 0;
    el.claim.textContent = rec.claim_text || "(no claim text)";
    el.calibBadge.classList.toggle("hidden", !rec.is_calibration);

    // Reflect any existing decision for this claim (revision support).
    var prior = decisions[rec.claim_id];
    var d = prior ? prior.decision : null;
    el.btnConfirm.classList.toggle("selected", d === "confirm");
    el.btnReject.classList.toggle("selected", d === "reject");
    el.btnUnsure.classList.toggle("selected", d === "unsure");

    el.btnPrev.disabled = (idx === 0);
    el.btnNext.disabled = (idx >= pool.length - 1);
    el.position.textContent = "Claim " + (idx + 1) + " of " + pool.length +
      (prior ? " · labeled: " + d : " · not yet labeled");

    tStart = performance.now();
  }

  function updateProgress() {
    var done = countDecided();
    el.progText.textContent = done + " / " + pool.length;
    el.progFill.style.width = (100 * done / Math.max(1, pool.length)) + "%";
  }

  function decide(decision) {
    var rec = pool[idx];
    if (!rec) return;
    var elapsed = (performance.now() - tStart) / 1000;
    var label = {
      claim_id: rec.claim_id,
      doc_id: rec.doc_id,
      validator_id: vid,
      decision: decision,                       // confirm | reject | unsure
      elapsed_s: Math.round(elapsed * 100) / 100,
      is_calibration: !!rec.is_calibration,
      cc_score: rec.cc_score != null ? rec.cc_score : 0.0,
      round: rec.round != null ? rec.round : null,
      client_ts: new Date().toISOString(),
    };
    var isRevision = !!decisions[rec.claim_id];
    decisions[rec.claim_id] = label;
    writeJSON(K.decisions, decisions);
    enqueue(label);

    if (isRevision) {
      render();                                 // stay put; just update the shown decision
      return;
    }
    if (countDecided() >= pool.length) { showDone(); return; }
    // fresh decision: advance to the next claim, preferring the next undecided one
    goNext(true);
  }

  // ── Navigation ────────────────────────────────────────────────────────────
  function goPrev() { if (idx > 0) { idx -= 1; render(); } }
  function goNext(preferUndecided) {
    if (preferUndecided) {
      for (var i = idx + 1; i < pool.length; i++) {
        if (!decisions[pool[i].claim_id]) { idx = i; render(); return; }
      }
      // none ahead undecided: fall back to the first undecided anywhere
      for (var j = 0; j < pool.length; j++) {
        if (!decisions[pool[j].claim_id]) { idx = j; render(); return; }
      }
    }
    if (idx < pool.length - 1) { idx += 1; render(); }
  }
  el.btnPrev.addEventListener("click", goPrev);
  el.btnNext.addEventListener("click", function () { goNext(false); });

  // ── Outbox / sync ────────────────────────────────────────────────────────
  function enqueue(label) {
    outbox.push(label);
    writeJSON(K.outbox, outbox);
    flushOutbox();
  }

  var flushing = false;
  function flushOutbox() {
    if (!CFG.APPS_SCRIPT_URL) { setSync("off"); return; }
    if (flushing || outbox.length === 0) { if (outbox.length === 0) setSync("ok"); return; }
    flushing = true;
    setSync("pending");
    var batchSize = Math.max(1, CFG.FLUSH_BATCH || 1);
    var batch = outbox.slice(0, batchSize);
    var payload = batch.length === 1 ? batch[0] : batch;
    // text/plain avoids a CORS preflight; response is opaque (no-cors).
    fetch(CFG.APPS_SCRIPT_URL, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    }).then(function () {
      outbox.splice(0, batch.length);       // assume delivered; dedup covers retries
      writeJSON(K.outbox, outbox);
      flushing = false;
      if (outbox.length > 0) flushOutbox(); else setSync("ok");
    }).catch(function () {
      flushing = false;
      setSync("pending");                   // network down; retry on next action/visit
    });
  }

  function setSync(state) {
    el.syncDot.className = "sync " + state;
    el.syncDot.title =
      state === "ok" ? "all labels submitted" :
      state === "pending" ? (outbox.length + " label(s) waiting to submit") :
      "auto-submit not configured — use the download button";
  }

  // ── Done + manual export ─────────────────────────────────────────────────
  function showDone() {
    el.annotate.classList.add("hidden");
    el.done.classList.remove("hidden");
    updateProgress();
    var n = 0;
    for (var i = 0; i < pool.length; i++) if (decisions[pool[i].claim_id]) n++;
    el.doneSummary.textContent = "You labeled " + n + " of " + pool.length + " assigned claims.";
    flushOutbox();
    el.resyncNote.textContent = CFG.APPS_SCRIPT_URL
      ? (outbox.length ? outbox.length + " still syncing — keep this tab open a moment." : "")
      : "Auto-submit is not configured; please send the downloaded file.";
  }

  el.reviewBtn.addEventListener("click", function () {
    idx = 0;
    el.done.classList.add("hidden");
    el.annotate.classList.remove("hidden");
    render();
  });

  function labelsJSONL() {
    return Object.keys(decisions).map(function (k) {
      return JSON.stringify(decisions[k]);
    }).join("\n") + "\n";
  }
  function downloadLabels() {
    var blob = new Blob([labelsJSONL()], { type: "application/x-ndjson" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "labels_" + vid + ".jsonl";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  el.downloadBtn.addEventListener("click", downloadLabels);
  el.floatExport.addEventListener("click", downloadLabels);

  // ── Decision buttons + keyboard ──────────────────────────────────────────
  el.btnConfirm.addEventListener("click", function () { decide("confirm"); });
  el.btnReject.addEventListener("click", function () { decide("reject"); });
  el.btnUnsure.addEventListener("click", function () { decide("unsure"); });

  document.addEventListener("keydown", function (e) {
    if (el.annotate.classList.contains("hidden")) return;
    var k = e.key.toLowerCase();
    if (k === "c") { e.preventDefault(); decide("confirm"); }
    else if (k === "r") { e.preventDefault(); decide("reject"); }
    else if (k === "u") { e.preventDefault(); decide("unsure"); }
    else if (k === "arrowleft") { e.preventDefault(); goPrev(); }
    else if (k === "arrowright") { e.preventDefault(); goNext(false); }
    else if (k === "arrowup") { e.preventDefault(); el.ctx.scrollTop -= 60; }
    else if (k === "arrowdown") { e.preventDefault(); el.ctx.scrollTop += 60; }
  });

  // Try to drain the outbox if the tab regains focus / connectivity.
  window.addEventListener("online", flushOutbox);
  window.addEventListener("focus", flushOutbox);
})();

// GRACE HITL annotator — deployment config.
//
// Paste your Google Apps Script Web App URL below (the .../exec URL from
// Deploy -> New deployment -> Web app). Until you do, the app still works:
// labels are saved locally and can be downloaded manually, they just are not
// auto-collected to the Sheet, and every validator sees the whole pool.
window.GRACE_CONFIG = {
  // e.g. "https://script.google.com/macros/s/AKfy.../exec"
  APPS_SCRIPT_URL: "",

  // Optional study label shown in the header.
  STUDY_NAME: "GRACE claim verification",

  // Flush queued labels to the sheet in batches of this size (1 = per label).
  FLUSH_BATCH: 1,

  // ── Overlap assigner ───────────────────────────────────────────────────────
  // The server hands each validator a unique dense seat (0,1,2,...); the client
  // turns that seat into a claim subset with the partition below. Set this to
  // the number of validators you actually recruit for exact coverage.
  N_VALIDATORS_EXPECTED: 10,
  // Each "overlap" claim is labeled by this many validators (for agreement).
  OVERLAP_K: 2,
  // Fraction of non-calibration claims placed in the overlap block; the rest are
  // single-labeled for coverage. Calibration claims always go to everyone.
  OVERLAP_FRACTION: 0.3,
  // Fixed seed for the shared shuffle that defines the partition. Must be the
  // same for every validator — do not vary per person.
  POOL_SEED: 1234567,
  // null = auto (assigner ON only when APPS_SCRIPT_URL is set); true/false forces it.
  OVERLAP_ASSIGN: null,
};

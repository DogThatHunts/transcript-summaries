// app.js — polls the Cloud Run pipeline-health endpoint and renders stat
// tiles, a 24h-progress headline + recent-trend sparklines (client-side
// only, via localStorage — no backend history needed), and per-lane
// open/closed/capacity cards. DASHBOARD_PLAN_2026-11-03.md.

const ENDPOINT = "https://transcription-bot-880476731187.europe-west1.run.app/pipeline-health";

const POLL_MS = 90_000; // within the requested 60-120s range

// ---- status tiles (unchanged shape from the first version) ---------------

const TRANSCRIBER_ORDER = [
  ["pending", "Pending", "neutral"],
  ["processing", "Processing", "neutral"],
  ["completed", "Completed", "good"],
  ["skipped", "Skipped", "warning"],
  ["failed", "Failed", "critical"],
];

// "(empty)" (never claimed), "pending" (deferred, still eligible), and
// "Revisit" (a truncated/incomplete summary waiting on a re-run) are all,
// from a viewer's standpoint, "hasn't produced a finished summary yet."
// Conflated into one "Pending" tile so this block reads congruently
// against Transcription's own single "Pending" tile. "Generating" is
// labeled "Processing" and "Passed" is labeled "Completed" to mirror
// Transcription's own vocabulary -- same underlying sheet values
// ("generating"/"Passed"), display label only.
const SUMMARIZER_ORDER = [
  ["pending", "Pending", "neutral"],
  ["generating", "Processing", "neutral"],
  ["Passed", "Completed", "good"],
  ["Skipped", "Skipped", "warning"],
  ["Failed", "Failed", "critical"],
];

function mergeEmptyAndRevisitIntoPending(counts) {
  const merged = { ...counts };
  merged.pending = (merged.pending || 0) + (merged["(empty)"] || 0) + (merged.Revisit || 0);
  delete merged["(empty)"];
  delete merged.Revisit;
  return merged;
}

// Publishing is entirely opt-in per row (no automatic eligibility pass like
// transcription/summarization have) -- a blank gh_publish_state means "never
// entered this workflow," not "pending," so the backend already drops blanks
// before this ever sees the data (get_column_counts). "withdraw"/"withdrawing"
// (pulling a published page back down) fold into Processing -- both are a
// transition in progress; "withdrawn" maps to Skipped -- an inert, no-longer-
// active end state, not a failure.
const PUBLISHER_ORDER = [
  ["publish", "Pending", "neutral"],
  ["publishing", "Processing", "neutral"],
  ["published", "Completed", "good"],
  ["withdrawn", "Skipped", "warning"],
  ["failed", "Failed", "critical"],
];

function mergeWithdrawingIntoPublishing(counts) {
  const merged = { ...counts };
  merged.publishing = (merged.publishing || 0) + (merged.withdrawing || 0) + (merged.withdraw || 0);
  delete merged.withdrawing;
  delete merged.withdraw;
  return merged;
}

function renderTiles(container, counts, order, badges) {
  container.innerHTML = "";
  const seen = new Set();
  for (const [key, label, status] of order) {
    seen.add(key);
    container.appendChild(tile(label, counts[key] || 0, status, (badges || {})[key]));
  }
  for (const key of Object.keys(counts)) {
    if (!seen.has(key)) container.appendChild(tile(key, counts[key], "neutral"));
  }
}

function tile(label, count, status, badge) {
  const el = document.createElement("div");
  el.className = `tile status-${status}`;
  el.innerHTML = `
    <div class="count">${count.toLocaleString()}</div>
    <div class="label"><span class="dot" aria-hidden="true"></span>${label}</div>
    ${badge ? `<span class="stuck-badge">${escapeHtml(badge)}</span>` : ""}
  `;
  return el;
}

// ---- lane cards (open/closed, reopens-at, capacity) -----------------------

const LANE_TIERS = ["small", "medium", "large"];

function renderLaneSilos(lanes) {
  const byTier = { small: [], medium: [], large: [] };
  for (const lane of lanes || []) {
    const tier = LANE_TIERS.includes(lane.tier) ? lane.tier : "small";
    byTier[tier].push(lane);
  }
  for (const tier of LANE_TIERS) {
    renderLaneSilo(document.getElementById(`lanes-${tier}`), byTier[tier]);
  }
}

// host_unreachable/ollama_down come from ollama_health.py's LAN probe of the
// mac-mini Ollama lane only (2026-11-09) -- everything else still just has
// open/closed from quota exhaustion. host_unreachable reuses the same
// critical (red) styling as a quota-closed lane, by the user's explicit
// choice: a dead host is at least as actionable as a closed lane, so it
// gets no weaker a signal. ollama_down gets its own color (light purple) --
// the host answered, Ollama itself didn't.
//
// rate_limited (2026-11-11) is a run-scoped soft exclusion
// (RotatingSummarizer.soft_exhausted_lanes(), orchestrator.py) -- a lane
// that failed the same way (a 429 burst, a repeated structured-output
// parse failure) on every row it was tried on this run, without ever
// tripping a persisted daily-quota signal. It is NOT "closed" in the
// quota sense -- it may well clear on the next run -- so it keeps the
// red/closed convention reserved for a confirmed quota exclusion and
// reuses ollama_down's same purple styling instead: open-but-unstable,
// the same shape as "the host answered, [the thing itself] didn't".
const LANE_STATUS_META = {
  host_unreachable: { cls: "critical", label: "Mac mini unreachable" },
  ollama_down: { cls: "ollama-down", label: "Ollama down" },
  rate_limited: { cls: "ollama-down", label: "Rate limited this run" },
  closed: { cls: "critical", label: "Closed" },
  open: { cls: "good", label: "Open" },
};

function renderLaneSilo(container, lanes) {
  container.innerHTML = "";
  if (!lanes.length) {
    container.innerHTML = '<p class="muted">No lane data yet — the summarizer syncs this once per run.</p>';
    return;
  }
  for (const lane of lanes) {
    const meta = LANE_STATUS_META[lane.status] || LANE_STATUS_META.open;
    const card = document.createElement("div");
    card.className = `lane-card status-${meta.cls}`;
    const reopens = lane.reopens_at ? new Date(lane.reopens_at).toLocaleString() : "";
    card.innerHTML = `
      <div class="lane-name">${escapeHtml(lane.provider)}/${escapeHtml(lane.model)}</div>
      <div class="lane-status"><span class="dot" aria-hidden="true"></span>${escapeHtml(meta.label)}</div>
      <div class="lane-meta">Capacity: ${escapeHtml(String(lane.capacity ?? "?"))} concurrent</div>
      ${reopens ? `<div class="lane-meta">Reopens: ${escapeHtml(reopens)}</div>` : ""}
    `;
    container.appendChild(card);
  }
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ---- client-side history: 24h delta headline + recent-trend sparklines ---
//
// Entirely local (localStorage) — no backend persistence. Durable across
// reloads on the SAME browser, but not shared between visitors/devices;
// good enough for "is this moving," not a multi-viewer audit trail.

const HISTORY_KEY = "pipelineHealthHistory";
const HISTORY_MAX_AGE_MS = 7 * 24 * 3600 * 1000; // keep a week
const HISTORY_MIN_GAP_MS = 15 * 60 * 1000;        // store at most 1 sample/15min
const DELTA_WINDOW_MS = 24 * 3600 * 1000;
const DELTA_TOLERANCE_MS = 2 * 3600 * 1000; // "near enough to 24h ago" to trust

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

function recordHistory(data) {
  let hist = loadHistory();
  const now = Date.now();
  const last = hist[hist.length - 1];
  if (!last || now - new Date(last.t).getTime() >= HISTORY_MIN_GAP_MS) {
    hist.push({
      t: data.as_of || new Date().toISOString(),
      transcriber: data.transcriber || {},
      summarizer: data.summarizer || {},
    });
  }
  const cutoff = now - HISTORY_MAX_AGE_MS;
  hist = hist.filter((h) => new Date(h.t).getTime() >= cutoff);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
  } catch {
    // storage full/unavailable (private window etc.) -- fine, just no history
  }
  return hist;
}

function closestSample(hist, msAgo, toleranceMs) {
  const target = Date.now() - msAgo;
  let best = null;
  let bestDiff = Infinity;
  for (const h of hist) {
    const diff = Math.abs(new Date(h.t).getTime() - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = h;
    }
  }
  return bestDiff <= toleranceMs ? best : null;
}

function renderDelta(hist, current) {
  const el = document.getElementById("delta");
  const past = closestSample(hist, DELTA_WINDOW_MS, DELTA_TOLERANCE_MS);
  if (!past) {
    el.textContent = "Building 24h trend — this grows in over the first day of viewing.";
    return;
  }
  const completedDelta = Math.max(0, (current.transcriber.completed || 0) - (past.transcriber.completed || 0));
  const passedDelta = Math.max(0, (current.summarizer.Passed || 0) - (past.summarizer.Passed || 0));
  el.textContent = `+${completedDelta.toLocaleString()} transcribed, +${passedDelta.toLocaleString()} summarized in the last ~24h`;
}

function sparklinePoints(hist, section, key, w, h) {
  const vals = hist.map((entry) => (entry[section] || {})[key] || 0);
  if (vals.length < 2) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const step = w / (vals.length - 1);
  return vals
    .map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`)
    .join(" ");
}

function renderSparkline(containerId, hist, section, key) {
  const container = document.getElementById(containerId);
  const w = 160;
  const h = 32;
  const pts = sparklinePoints(hist, section, key, w, h);
  if (!pts) {
    container.innerHTML = '<p class="muted small">Not enough history yet.</p>';
    return;
  }
  container.innerHTML = `<svg viewBox="0 0 ${w} ${h}" class="spark" aria-hidden="true"><polyline points="${pts}"></polyline></svg>`;
}

// ---- main poll loop --------------------------------------------------------

async function refresh() {
  const errorEl = document.getElementById("error");
  try {
    const resp = await fetch(ENDPOINT, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    const stuckCount = data.summarizer_stuck_claims || 0;
    const summarizerBadges = stuckCount > 0 ? { generating: `${stuckCount.toLocaleString()} stuck` } : {};

    renderTiles(document.getElementById("transcriber-tiles"), data.transcriber || {}, TRANSCRIBER_ORDER);
    renderTiles(document.getElementById("summarizer-tiles"), mergeEmptyAndRevisitIntoPending(data.summarizer || {}), SUMMARIZER_ORDER, summarizerBadges);
    renderTiles(document.getElementById("publisher-tiles"), mergeWithdrawingIntoPublishing(data.publisher || {}), PUBLISHER_ORDER);
    renderLaneSilos(data.lanes || []);

    const hist = recordHistory(data);
    renderDelta(hist, data);
    renderSparkline("spark-completed", hist, "transcriber", "completed");
    renderSparkline("spark-passed", hist, "summarizer", "Passed");

    const asOf = data.as_of ? new Date(data.as_of) : new Date();
    document.getElementById("as-of").textContent = `As of ${asOf.toLocaleString()}`;
    errorEl.hidden = true;
  } catch (err) {
    errorEl.textContent = `Could not load live status (${err.message}). Last known values shown below may be stale.`;
    errorEl.hidden = false;
  }
}

refresh();
setInterval(refresh, POLL_MS);

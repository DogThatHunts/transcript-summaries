// app.js — polls the Cloud Run pipeline-health endpoint and renders stat tiles.
// DASHBOARD_PLAN_2026-11-03.md

// Deployed 2026-11-04 — confirmed live and public (D-1 in the plan doc:
// the service's IAM policy already grants allUsers -> roles/run.invoker).
const ENDPOINT = "https://transcription-bot-880476731187.europe-west1.run.app/pipeline-health";

const POLL_MS = 90_000; // within the requested 60-120s range

// Fixed display order + status class per value, so tiles never reorder
// between polls and a value this page has never seen before still renders
// (falls back to "neutral") instead of silently disappearing.
const TRANSCRIBER_ORDER = [
  ["pending", "Pending", "neutral"],
  ["processing", "Processing", "neutral"],
  ["completed", "Completed", "good"],
  ["skipped", "Skipped", "warning"],
  ["failed", "Failed", "critical"],
];

const SUMMARIZER_ORDER = [
  ["(empty)", "Not started", "neutral"],
  ["pending", "Pending", "neutral"],
  ["generating", "Generating", "neutral"],
  ["Passed", "Passed", "good"],
  ["Revisit", "Revisit", "warning"],
  ["Skipped", "Skipped", "warning"],
  ["Failed", "Failed", "critical"],
];

function renderTiles(container, counts, order) {
  container.innerHTML = "";
  const seen = new Set();
  for (const [key, label, status] of order) {
    seen.add(key);
    container.appendChild(tile(label, counts[key] || 0, status));
  }
  // Any key the fixed order didn't anticipate still shows, rather than
  // being silently dropped — defaults to "neutral" since its meaning is
  // unknown to this page.
  for (const key of Object.keys(counts)) {
    if (!seen.has(key)) {
      container.appendChild(tile(key, counts[key], "neutral"));
    }
  }
}

function tile(label, count, status) {
  const el = document.createElement("div");
  el.className = `tile status-${status}`;
  el.innerHTML = `
    <div class="count">${count.toLocaleString()}</div>
    <div class="label"><span class="dot" aria-hidden="true"></span>${label}</div>
  `;
  return el;
}

async function refresh() {
  const errorEl = document.getElementById("error");
  try {
    const resp = await fetch(ENDPOINT, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    renderTiles(document.getElementById("transcriber-tiles"), data.transcriber || {}, TRANSCRIBER_ORDER);
    renderTiles(document.getElementById("summarizer-tiles"), data.summarizer || {}, SUMMARIZER_ORDER);
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

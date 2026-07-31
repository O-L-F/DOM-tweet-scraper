// ==UserScript==
// @name         Tweet Collector (auto-scroll + extract, no API)
// @namespace    local.tweetcollector
// @version      1.0
// @description  Auto-scrolls an X/Twitter profile timeline, extracts tweet text/day/account/type as it goes, and exports to CSV. No API calls, no login beyond your normal browser session.
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // Extracting
  
  function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return "h" + Math.abs(h);
  }

  function extractDayFromTimeEl(article) {
    const timeEl = article.querySelector("time[datetime]");
    if (!timeEl) return "";
    const dt = timeEl.getAttribute("datetime") || "";
    const m = dt.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : dt;
  }

  function extractStatusId(article) {
    const links = article.querySelectorAll('a[href*="/status/"]');
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/status\/(\d+)/);
      if (m) return m[1];
    }
    return null;
  }

  function extractTweetText(article) {
    let textEl = article.querySelector('[data-testid="tweetText"]');
    if (textEl) return textEl.textContent.trim();
    textEl = article.querySelector("[lang]");
    if (textEl) return textEl.textContent.trim();
    return "";
  }

  function isQuoteTweet(article) {
    const roleLinks = article.querySelectorAll('div[role="link"]');
    for (const el of roleLinks) {
      if (el.querySelector('[data-testid="tweetText"]')) return true;
    }
    return false;
  }

  function getRepostInfo(article) {
    const socialContextEls = article.querySelectorAll('[data-testid="socialContext"]');
    let isRepost = false;
    for (const el of socialContextEls) {
      const t = (el.textContent || "").toLowerCase();
      if (t.includes("reposted")) { isRepost = true; break; }
    }
    if (!isRepost) return { isRepost: false, authorHandle: null };
    const links = article.querySelectorAll('a[href*="/status/"]');
    let authorHandle = null;
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/^\/([^\/]+)\/status\/\d+/);
      if (m) { authorHandle = m[1]; break; }
    }
    return { isRepost: true, authorHandle };
  }

  // Show-more expansion.
  const LOG_TAG = "[TweetCollector]";

  async function expandShowMoreButtons(articles) {
    const entries = [];
    for (const article of articles) {
      const btn = article.querySelector('[data-testid="tweet-text-show-more-link"]');
      if (btn) {
        const statusId = extractStatusId(article) || "(no status id)";
        const beforeEl = article.querySelector('[data-testid="tweetText"]');
        entries.push({
          article,
          btn,
          statusId,
          beforeId: beforeEl ? beforeEl.id : null,
          beforeLen: beforeEl ? beforeEl.textContent.length : 0
        });
      }
    }
    if (entries.length === 0) return 0;

    console.log(`${LOG_TAG} found ${entries.length} show-more button(s) this pass:`, entries.map(e => e.statusId));
    for (const e of entries) {
      console.log(`${LOG_TAG} clicking show-more for status ${e.statusId}`);
      e.btn.click();
    }

    function isExpanded(e) {
      if (document.contains(e.btn)) return false;
      const nowEl = e.article.querySelector('[data-testid="tweetText"]');
      if (!nowEl) return false; // mid-swap, text node briefly absent
      return nowEl.id !== e.beforeId || nowEl.textContent.length > e.beforeLen;
    }

    for (let attempt = 0; attempt < 12; attempt++) {
      await sleep(180);
      const stillPending = entries.filter(e => !isExpanded(e));
      if (stillPending.length === 0) {
        console.log(`${LOG_TAG} all show-more buttons resolved (attempt ${attempt + 1})`);
        break;
      }
      console.log(`${LOG_TAG} attempt ${attempt + 1}: still stuck on`, stillPending.map(e => e.statusId));
      for (const e of stillPending) {
        if (document.contains(e.btn)) {
          try { e.btn.click(); } catch (err) { console.warn(`${LOG_TAG} click threw for ${e.statusId}`, err); }
        }
      }
    }

    const unresolved = entries.filter(e => !isExpanded(e)).map(e => e.statusId);
    if (unresolved.length > 0) {
      console.warn(`${LOG_TAG} gave up expanding (still truncated when stored):`, unresolved);
    }

    return entries.length;
  }

  function extractVisibleTweets(account) {
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    const results = [];
    for (const article of articles) {
      const text = extractTweetText(article);
      if (!text) continue;

      const day = extractDayFromTimeEl(article);
      const statusId = extractStatusId(article);
      const repostInfo = getRepostInfo(article);
      const type = repostInfo.isRepost
        ? "repost:" + (repostInfo.authorHandle || "unknown")
        : (isQuoteTweet(article) ? "quote" : "original");
      const key = statusId || simpleHash(account + "|" + day + "|" + text);

      results.push({ id: key, day: day || "", account, type, text });
    }
    return results;
  }

  // persistent storage
  
  const STORAGE_KEY = "tweetCollector.v1";

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.error("[TweetCollector] failed to load store", e);
      return {};
    }
  }

  function saveStore(store) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  }

  let store = loadStore();

  function addTweetsToStore(account, tweets) {
    if (!store[account]) store[account] = {};
    const addedItems = [];
    const updatedItems = [];
    let skipped = 0;
    for (const t of tweets) {
      const existing = store[account][t.id];
      const record = { day: t.day, account: t.account, type: t.type, text: t.text };
      if (!existing) {
        store[account][t.id] = record;
        addedItems.push(record);
      } else if (t.text.length > existing.text.length) {
        console.log(`${LOG_TAG} correcting stored text for ${t.id}: ${existing.text.length} -> ${t.text.length} chars`);
        store[account][t.id] = record;
        updatedItems.push(record);
      } else {
        skipped++;
      }
    }
    if (addedItems.length || updatedItems.length) saveStore(store);
    return { added: addedItems.length, updated: updatedItems.length, skipped, addedItems, updatedItems };
  }

  function accountRows(handle) {
    const bucket = store[handle] || {};
    return Object.values(bucket).sort((a, b) => (a.day || "").localeCompare(b.day || ""));
  }

  function allRows() {
    let out = [];
    for (const handle of Object.keys(store)) out = out.concat(accountRows(handle));
    return out;
  }

  // csv export
  
  function csvEscape(val) {
    const s = String(val == null ? "" : val);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCsv(rows) {
    const header = ["day", "account", "type", "text"];
    const lines = [header.join(",")];
    for (const r of rows) lines.push([r.day, r.account, r.type, r.text].map(csvEscape).join(","));
    return lines.join("\r\n");
  }

  function downloadCsv(filename, csvText) {
    const blob = new Blob(["\uFEFF" + csvText], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // current-profile detection

  function detectHandleFromUrl() {
    const m = window.location.pathname.match(/^\/([A-Za-z0-9_]{1,15})(\/|$)/);
    if (!m) return null;
    const reserved = ["home", "explore", "notifications", "messages", "i", "settings", "search", "compose"];
    if (reserved.includes(m[1].toLowerCase())) return null;
    return m[1];
  }

  //auto-scroll + collect loop
 
  let collecting = false;
  let stopRequested = false;
  let recentTweets = [];

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randInt(min, max) {
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  function jitter(base, pct = 0.35) {
    const delta = base * pct;
    const val = base + (Math.random() * 2 - 1) * delta;
    return Math.max(150, Math.round(val));
  }

  function pushRecent(items) {
    if (!items.length) return;
    recentTweets = recentTweets.concat(items).slice(-5);
  }

  function stopIfBeforeDate(tweets, cutoffDate) {
    if (!cutoffDate) return false;
    return tweets.some(t => t.day && t.day < cutoffDate);
  }

  async function runCollectionLoop({ account, maxScrolls, scrollStepPx, pauseMs, stopBeforeDate, onProgress }) {
    collecting = true;
    stopRequested = false;
    let scrollCount = 0;
    let sessionAdded = 0;
    let sessionUpdated = 0;
    let consecutiveNoNewTweets = 0;
    let stopReason = "max_scrolls";
    let stepsUntilLongPause = randInt(8, 14);

    while (scrollCount < maxScrolls && !stopRequested) {
      const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
      const expandedCount = await expandShowMoreButtons(articles);

      const found = extractVisibleTweets(account);
      const hitCutoff = stopIfBeforeDate(found, stopBeforeDate);
      const inRange = stopBeforeDate ? found.filter(t => !t.day || t.day >= stopBeforeDate) : found;

      const { added, updated, addedItems, updatedItems } = addTweetsToStore(account, inRange);
      sessionAdded += added;
      sessionUpdated += updated;
      pushRecent(addedItems.concat(updatedItems));

      if (added === 0 && updated === 0) {
        consecutiveNoNewTweets++;
      } else {
        consecutiveNoNewTweets = 0;
      }

      onProgress({
        scrollCount,
        maxScrolls,
        sessionAdded,
        sessionUpdated,
        totalForAccount: Object.keys(store[account] || {}).length,
        recentTweets,
        hitCutoff
      });

      if (hitCutoff) {
        stopReason = "date_cutoff";
        break;
      }

      if (consecutiveNoNewTweets >= 8) {
        stopReason = "no_new_tweets";
        break;
      }

      const step = jitter(scrollStepPx, 0.4);
      window.scrollBy(0, step);
      scrollCount++;

      let pause = jitter(pauseMs);
      stepsUntilLongPause--;
      if (stepsUntilLongPause <= 0) {
        pause += jitter(2200, 0.5);
        stepsUntilLongPause = randInt(8, 14);
      }
      await sleep(pause);
    }

    if (stopRequested) stopReason = "user_stopped";
    collecting = false;
    return { sessionAdded, sessionUpdated, scrollCount, stopReason };
  }

  function stopCollection() {
    stopRequested = true;
  }

  // on-page UI panel
  
  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      #tc-panel {
        position: fixed; bottom: 16px; right: 16px; z-index: 999999;
        width: 320px; background: #0b0e11; color: #e7e9ea;
        border: 1px solid #2a3140; border-radius: 12px; padding: 14px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        max-height: 80vh; overflow-y: auto;
      }
      #tc-panel h3 { margin: 0 0 8px; font-size: 14px; }
      #tc-panel h4 { margin: 10px 0 4px; font-size: 12px; color: #8b98a5; font-weight: 600; }
      #tc-panel .tc-row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
      #tc-panel button {
        background: #1d9bf0; color: white; border: none; border-radius: 999px;
        padding: 6px 12px; font-size: 12.5px; font-weight: 600; cursor: pointer;
      }
      #tc-panel button.secondary { background: transparent; border: 1px solid #2a3140; color: #e7e9ea; }
      #tc-panel button.danger { background: transparent; border: 1px solid #f4212e; color: #f4212e; }
      #tc-panel button:disabled { opacity: 0.4; cursor: not-allowed; }
      #tc-panel .tc-status { margin-top: 8px; font-size: 12px; color: #8b98a5; min-height: 32px; }
      #tc-panel .tc-handle { font-weight: 700; color: #1d9bf0; }
      #tc-panel input[type=number] {
        width: 55px; background: #0e1217; border: 1px solid #2a3140; color: #e7e9ea;
        border-radius: 6px; padding: 3px 6px; font-size: 12px;
      }
      #tc-panel label { font-size: 11.5px; color: #8b98a5; }
      #tc-preview { display: flex; flex-direction: column; gap: 6px; }
      #tc-preview .tc-tweet {
        background: #0e1217; border: 1px solid #202632; border-radius: 8px;
        padding: 6px 8px; font-size: 11.5px; line-height: 1.35;
      }
      #tc-preview .tc-tweet .tc-meta { color: #8b98a5; font-size: 10.5px; margin-bottom: 2px; }
      #tc-preview .tc-empty { color: #536471; font-size: 11.5px; }
    `;
    document.head.appendChild(style);
  }

  function buildPanel() {
    const panel = document.createElement("div");
    panel.id = "tc-panel";
    panel.innerHTML = `
      <h3>Tweet Collector</h3>
      <div>Detected profile: <span class="tc-handle" id="tc-handle">—</span></div>
      <div class="tc-row">
        <label>Max scrolls <input type="number" id="tc-maxscrolls" value="200" min="1" max="2000"></label>
        <label>Pause (ms) <input type="number" id="tc-pause" value="1100" min="300" max="8000"></label>
      </div>
      <div class="tc-row">
        <label><input type="checkbox" id="tc-stopdate-enabled" checked style="width:auto;"> Stop at date</label>
        <input type="date" id="tc-stopdate" value="2000-01-01">
      </div>
      <div class="tc-row">
        <button id="tc-start">Start collecting</button>
        <button id="tc-stop" class="secondary" disabled>Stop</button>
      </div>
      <div class="tc-status" id="tc-status">Idle. Default settings aim to cover a whole profile in one run — stops early once it hits already-collected content.</div>
      <h4>Sanity check — last 5 scraped</h4>
      <div id="tc-preview"><div class="tc-empty">Nothing scraped yet.</div></div>
      <div class="tc-row">
        <button id="tc-export-account" class="secondary">Export this account CSV</button>
      </div>
      <div class="tc-row">
        <button id="tc-export-all" class="secondary">Export ALL accounts CSV</button>
        <button id="tc-wipe" class="danger">Wipe all data</button>
      </div>
      <div class="tc-status" id="tc-storesummary"></div>
    `;
    document.body.appendChild(panel);
    return panel;
  }

  function refreshHandleDisplay() {
    const handleEl = document.getElementById("tc-handle");
    const handle = detectHandleFromUrl();
    handleEl.textContent = handle ? "@" + handle : "(not on a profile page)";
    return handle;
  }

  function refreshStoreSummary() {
    const el = document.getElementById("tc-storesummary");
    const handles = Object.keys(store);
    if (handles.length === 0) {
      el.textContent = "No accounts stored yet.";
      return;
    }
    el.textContent = handles.map(h => `@${h}: ${Object.keys(store[h]).length}`).join("  ·  ");
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function renderPreview(items) {
    const el = document.getElementById("tc-preview");
    if (!items || items.length === 0) {
      el.innerHTML = '<div class="tc-empty">Nothing scraped yet.</div>';
      return;
    }
    const ordered = items.slice().reverse();
    el.innerHTML = ordered.map(t => {
      const snippet = t.text.length > 140 ? t.text.slice(0, 140) + "…" : t.text;
      return `<div class="tc-tweet">
        <div class="tc-meta">${escapeHtml(t.day || "?")} · @${escapeHtml(t.account)} · ${escapeHtml(t.type)}</div>
        <div>${escapeHtml(snippet)}</div>
      </div>`;
    }).join("");
  }

  function initUI() {
    injectStyles();
    buildPanel();
    refreshHandleDisplay();
    refreshStoreSummary();
    renderPreview(recentTweets);

    const startBtn = document.getElementById("tc-start");
    const stopBtn = document.getElementById("tc-stop");
    const statusEl = document.getElementById("tc-status");

    startBtn.addEventListener("click", async () => {
      const handle = refreshHandleDisplay();
      if (!handle) {
        statusEl.textContent = "Navigate to a profile's Posts tab first (e.g. x.com/Alice_Weidel).";
        return;
      }
      const maxScrolls = parseInt(document.getElementById("tc-maxscrolls").value, 10) || 200;
      const pauseMs = parseInt(document.getElementById("tc-pause").value, 10) || 1100;
      const stopDateEnabled = document.getElementById("tc-stopdate-enabled").checked;
      const stopBeforeDate = stopDateEnabled ? (document.getElementById("tc-stopdate").value || null) : null;

      startBtn.disabled = true;
      stopBtn.disabled = false;
      statusEl.textContent = `Collecting for @${handle}... (scroll 0/${maxScrolls})`;

      const result = await runCollectionLoop({
        account: handle,
        maxScrolls,
        scrollStepPx: 600,
        pauseMs,
        stopBeforeDate,
        onProgress: (p) => {
          statusEl.textContent =
            `@${handle}: scroll ${p.scrollCount}/${p.maxScrolls} — ` +
            `+${p.sessionAdded} new, ${p.sessionUpdated} corrected (show-more expanded), ${p.totalForAccount} total stored.`;
          renderPreview(p.recentTweets);
        }
      });

      startBtn.disabled = false;
      stopBtn.disabled = true;
      const reasonText = {
        date_cutoff: `reached tweets older than ${stopBeforeDate} and stopped there`,
        no_new_tweets: `hit a stretch of already-collected content (likely end of available/loaded history)`,
        max_scrolls: `hit the max-scrolls limit — scroll down a bit manually and click Start again to continue`,
        user_stopped: `stopped by you`
      }[result.stopReason] || result.stopReason;
      statusEl.textContent =
        `Done. Added ${result.sessionAdded} new tweets, corrected ${result.sessionUpdated} truncated ` +
        `captures for @${handle} (${result.scrollCount} scroll steps). Stopped because: ${reasonText}.`;
      refreshStoreSummary();
    });

    stopBtn.addEventListener("click", () => {
      stopCollection();
      statusEl.textContent = "Stopping after current step...";
      startBtn.disabled = false;
      stopBtn.disabled = true;
    });

    document.getElementById("tc-export-account").addEventListener("click", () => {
      const handle = refreshHandleDisplay();
      if (!handle || !store[handle]) {
        statusEl.textContent = "No stored data for the current profile yet.";
        return;
      }
      downloadCsv(`tweets_${handle}.csv`, toCsv(accountRows(handle)));
    });

    document.getElementById("tc-export-all").addEventListener("click", () => {
      const rows = allRows();
      if (rows.length === 0) {
        statusEl.textContent = "Nothing stored yet.";
        return;
      }
      downloadCsv("tweets_all_accounts.csv", toCsv(rows));
    });

    document.getElementById("tc-wipe").addEventListener("click", () => {
      if (confirm("Delete ALL stored tweets for ALL accounts? This cannot be undone.")) {
        store = {};
        saveStore(store);
        recentTweets = [];
        refreshStoreSummary();
        renderPreview(recentTweets);
        statusEl.textContent = "All data wiped.";
      }
    });

    let lastPath = window.location.pathname;
    setInterval(() => {
      if (window.location.pathname !== lastPath) {
        lastPath = window.location.pathname;
        refreshHandleDisplay();
      }
    }, 1000);
  }

  // Boot
 
  if (document.getElementById("tc-panel")) return;
  initUI();

})();

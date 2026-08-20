// ==UserScript==
// @name         JSON twitter collector.
// @namespace    local.tweetcollector
// @version      1.3
// @description JSON stuff
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

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

  function getRepostInfo(article, fallbackAccount) {
    const socialContextEls = article.querySelectorAll('[data-testid="socialContext"]');
    let isRepost = false;
    let socialContextEl = null;
    for (const el of socialContextEls) {
      const t = (el.textContent || "").toLowerCase();
      if (t.includes("reposted")) { isRepost = true; socialContextEl = el; break; }
    }
    if (!isRepost) return { isRepost: false, originalPosterHandle: null, reposterHandle: null };

    const statusLinks = article.querySelectorAll('a[href*="/status/"]');
    let originalPosterHandle = null;
    for (const a of statusLinks) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/^\/([A-Za-z0-9_]{1,15})\/status\/\d+/);
      if (m) { originalPosterHandle = m[1]; break; }
    }

    let reposterHandle = null;
    if (socialContextEl) {

      const ancestorLink = socialContextEl.closest('a[href^="/"]');
      if (ancestorLink) {
        const href = ancestorLink.getAttribute("href") || "";
        const m = href.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
        if (m) reposterHandle = m[1];
      }

      if (!reposterHandle) {
        const profileLinks = socialContextEl.querySelectorAll('a[href^="/"]');
        for (const a of profileLinks) {
          const href = a.getAttribute("href") || "";
          const m = href.match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
          if (m) { reposterHandle = m[1]; break; }
        }
      }
    }
    if (!reposterHandle) reposterHandle = fallbackAccount || null;

    return { isRepost: true, originalPosterHandle, reposterHandle };
  }

  function extractQuotedAuthorHandle(article) {
    const roleLinks = article.querySelectorAll('div[role="link"]');
    for (const el of roleLinks) {
      if (!el.querySelector('[data-testid="tweetText"]')) continue;
      const links = el.querySelectorAll('a[href*="/status/"]');
      for (const a of links) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/^\/([A-Za-z0-9_]{1,15})\/status\/\d+/);
        if (m) return m[1];
      }
    }
    return null;
  }

  const LOG_TAG = "[TweetCollector]";

  const netLog = { requests: [], patched: false };
  let verboseNetworkLogging = false;

  function looksLikeTimelinePaginationUrl(url) {
    return /\/graphql\/[^/]+\/(UserTweets|UserTweetsAndReplies|UserMedia|UserArticlesTweets|ListLatestTweetsTimeline|ListTimeline)/i.test(url);
  }

  const graphqlOpCounts = {};
  function extractGraphqlOpName(url) {
    const m = url.match(/\/graphql\/[^/]+\/([A-Za-z0-9_]+)/);
    return m ? m[1] : null;
  }
  function maybeLogGraphqlCall(url) {
    if (!/\/graphql\//i.test(url)) return;
    const op = extractGraphqlOpName(url) || "(unrecognized graphql path)";
    graphqlOpCounts[op] = (graphqlOpCounts[op] || 0) + 1;
    if (verboseNetworkLogging) {
      console.log(`${LOG_TAG} graphql call: ${op} (seen ${graphqlOpCounts[op]}x this session)`);
    }
  }

  function recordTimelineRequest(url) {
    const now = Date.now();
    netLog.requests.push(now);
    if (netLog.requests.length > 1000) netLog.requests.shift();
    if (verboseNetworkLogging) {
      console.log(`${LOG_TAG} timeline request #${netLog.requests.length} at ${new Date(now).toISOString()} — ${url}`);
    }
  }

  function patchNetworkForDiagnostics() {
    if (netLog.patched) return;
    netLog.patched = true;

    const origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (...args) {
        try {
          const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
          maybeLogGraphqlCall(url);
          if (looksLikeTimelinePaginationUrl(url)) recordTimelineRequest(url);
        } catch (e) {}
        return origFetch.apply(this, args);
      };
    }

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try {
        maybeLogGraphqlCall(url);
        if (looksLikeTimelinePaginationUrl(url)) recordTimelineRequest(url);
      } catch (e) {}
      return origOpen.call(this, method, url, ...rest);
    };
  }

  function timelineRequestStats() {
    const now = Date.now();
    const lastTs = netLog.requests.length ? netLog.requests[netLog.requests.length - 1] : null;
    const last60s = netLog.requests.filter(t => now - t <= 60000).length;
    return {
      total: netLog.requests.length,
      lastAgoSec: lastTs !== null ? Math.round((now - lastTs) / 1000) : null,
      ratePerMin: last60s
    };
  }

  function looksRateLimited() {
    const container = document.querySelector('div[data-testid="primaryColumn"]') || document.body;
    const text = (container.innerText || "").slice(-3000);
    return /something went wrong|try reloading|rate limit|try again later|retry/i.test(text);
  }

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

    for (const e of entries) {
      e.btn.click();
    }

    function isExpanded(e) {
      if (document.contains(e.btn)) return false;
      const nowEl = e.article.querySelector('[data-testid="tweetText"]');
      if (!nowEl) return false;
      return nowEl.id !== e.beforeId || nowEl.textContent.length > e.beforeLen;
    }

    for (let attempt = 0; attempt < 12; attempt++) {
      await sleep(180);
      const stillPending = entries.filter(e => !isExpanded(e));
      if (stillPending.length === 0) break;
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

  function extractAuthorHandle(article) {
    const links = article.querySelectorAll('a[href*="/status/"]');
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/^\/([A-Za-z0-9_]{1,15})\/status\/\d+/);
      if (m) return m[1];
    }
    return null;
  }

  function extractVisibleTweets(fallbackAccount) {
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    const results = [];
    for (const article of articles) {
      const text = extractTweetText(article);
      if (!text) continue;

      const day = extractDayFromTimeEl(article);
      const statusId = extractStatusId(article);
      const repostInfo = getRepostInfo(article, fallbackAccount);

      let account, type;
      if (repostInfo.isRepost) {
        account = repostInfo.reposterHandle || fallbackAccount;
        type = "repost:" + (repostInfo.originalPosterHandle || "unknown");
      } else if (isQuoteTweet(article)) {
        account = extractAuthorHandle(article) || fallbackAccount;
        type = "quote:" + (extractQuotedAuthorHandle(article) || "unknown");
      } else {
        account = extractAuthorHandle(article) || fallbackAccount;
        type = "original";
      }

      const key = statusId || simpleHash(account + "|" + day + "|" + text);

      results.push({ id: key, day: day || "", account, type, text });
    }
    return results;
  }

  const STORAGE_KEY = "tweetCollector.v2";
  const IDB_NAME = "tweetCollectorDb";
  const IDB_STORE = "kv";

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) {
          req.result.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbDelete(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbListKeys() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  function slugifyDataset(name) {
    const s = (name || "").trim();
    if (!s || s.toLowerCase() === "default") return "default";
    return s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 60) || "default";
  }

  function storageKeyForDataset(datasetName) {
    const slug = slugifyDataset(datasetName);
    return slug === "default" ? STORAGE_KEY : `${STORAGE_KEY}::${slug}`;
  }

  function seenIndexKey(datasetName) {
    return storageKeyForDataset(datasetName) + "::seenIndex";
  }

  function pendingBatchKey(datasetName) {
    return storageKeyForDataset(datasetName) + "::pending";
  }

  async function listDatasetNames() {
    const keys = await idbListKeys();
    const names = new Set();
    const prefix = STORAGE_KEY;
    for (const k of keys) {
      if (!k.startsWith(prefix + "::")) continue;
      const afterPrefix = k.slice(prefix.length + 2);
      const firstSeg = afterPrefix.split("::")[0];
      if (firstSeg === "seenIndex" || firstSeg === "pending") {
        names.add("default");
      } else {
        names.add(firstSeg);
      }
    }
    return Array.from(names).sort((a, b) => (a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b)));
  }

  let currentDataset = "default";
  let seenIds = {};
  let pendingBatch = [];

  async function loadDatasetState(datasetName) {
    seenIds = {};
    pendingBatch = [];
    try {
      const raw = await idbGet(seenIndexKey(datasetName));
      if (raw) {
        for (const acct of Object.keys(raw)) seenIds[acct] = new Map(raw[acct]);
      }
    } catch (e) {
      console.error(`${LOG_TAG} failed to load seen-index for dataset "${datasetName}"`, e);
    }
    try {
      pendingBatch = (await idbGet(pendingBatchKey(datasetName))) || [];
    } catch (e) {
      pendingBatch = [];
    }

    for (const r of pendingBatch) {
      if (!seenIds[r.account]) seenIds[r.account] = new Map();
      const existingLen = seenIds[r.account].get(r.id);
      if (existingLen === undefined || r.text.length > existingLen) {
        seenIds[r.account].set(r.id, r.text.length);
      }
    }
  }

  async function checkpointSeenIndex() {
    try {
      const serializable = {};
      for (const acct of Object.keys(seenIds)) serializable[acct] = Array.from(seenIds[acct].entries());
      await idbSet(seenIndexKey(currentDataset), serializable);
    } catch (e) {
      console.error(`${LOG_TAG} failed to checkpoint dedup index — a future run might re-scrape a few already-exported tweets`, e);
    }
  }

  async function checkpointPendingBatch() {
    try {
      await idbSet(pendingBatchKey(currentDataset), pendingBatch);
    } catch (e) {
      console.error(`${LOG_TAG} failed to checkpoint pending batch — it stays in memory only until the next successful export`, e);
    }
  }

  async function wipeCurrentDataset() {
    try { await idbDelete(seenIndexKey(currentDataset)); } catch (e) {}
    try { await idbDelete(pendingBatchKey(currentDataset)); } catch (e) {}
  }

  function dedupeBatchKeepLongest(batch) {
    const byId = new Map();
    for (const r of batch) {
      const cur = byId.get(r.id);
      if (!cur || r.text.length > cur.text.length) byId.set(r.id, r);
    }
    return Array.from(byId.values());
  }

  function addTweetsToStore(tweets) {
    const addedItems = [];
    const updatedItems = [];
    let skipped = 0;
    for (const t of tweets) {
      const acct = t.account || "unknown";
      if (!seenIds[acct]) seenIds[acct] = new Map();
      const priorLen = seenIds[acct].get(t.id);
      const record = { id: t.id, day: t.day, account: acct, type: t.type, text: t.text };
      if (priorLen === undefined) {
        seenIds[acct].set(t.id, t.text.length);
        pendingBatch.push(record);
        addedItems.push(record);
      } else if (t.text.length > priorLen) {
        seenIds[acct].set(t.id, t.text.length);
        pendingBatch.push(record);
        updatedItems.push(record);
      } else {
        skipped++;
      }
    }
    return { added: addedItems.length, updated: updatedItems.length, skipped, addedItems, updatedItems };
  }

  function pendingRowsForAccount(handle) {
    return dedupeBatchKeepLongest(pendingBatch.filter(r => r.account === handle))
      .sort((a, b) => (a.day || "").localeCompare(b.day || ""));
  }

  function pendingRowsAll() {
    return dedupeBatchKeepLongest(pendingBatch)
      .sort((a, b) => (a.day || "").localeCompare(b.day || ""));
  }


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

  function toJson(rows) {
    return JSON.stringify(rows.map(r => ({ day: r.day, account: r.account, type: r.type, text: r.text })), null, 2);
  }

  function downloadJson(filename, jsonText) {
    const blob = new Blob([jsonText], { type: "application/json;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  let exportDirHandle = null;

  async function writeJsonToExportDir(filename, rows) {
    if (!exportDirHandle) return false;
    try {
      const fileHandle = await exportDirHandle.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(toJson(rows));
      await writable.close();
      return true;
    } catch (e) {
      console.error(`${LOG_TAG} auto-export write failed for ${filename}`, e);
      return false;
    }
  }

  function detectHandleFromUrl() {
    const m = window.location.pathname.match(/^\/([A-Za-z0-9_]{1,15})(\/|$)/);
    if (!m) return null;
    const reserved = ["home", "explore", "notifications", "messages", "i", "settings", "search", "compose"];
    if (reserved.includes(m[1].toLowerCase())) return null;
    return m[1];
  }

  function detectHandleFromFirstTweet() {
    const article = document.querySelector('article[data-testid="tweet"]');
    if (!article) return null;
    const link = article.querySelector('a[href*="/status/"]');
    if (!link) return null;
    const m = (link.getAttribute("href") || "").match(/^\/([A-Za-z0-9_]{1,15})\/status\//);
    return m ? m[1] : null;
  }

  let aggressiveMediaUnload = false;

  function unloadOffscreenMedia() {
    if (!aggressiveMediaUnload) return 0;
    const threshold = window.innerHeight * 4;
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    let unloaded = 0;
    for (const article of articles) {
      let rect;
      try { rect = article.getBoundingClientRect(); } catch (e) { continue; }
      if (rect.bottom < -threshold) {
        const imgs = article.querySelectorAll('img[src^="https://pbs.twimg.com"]');
        for (const img of imgs) {
          if (img.dataset.tcUnloaded) continue;
          try {
            img.dataset.tcUnloaded = "1";
            img.removeAttribute("srcset");
            img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7";
            unloaded++;
          } catch (e) {}
        }
      }
    }
    return unloaded;
  }


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

  function jitterCount(base, pct = 0.7) {
    const delta = base * pct;
    const val = base + (Math.random() * 2 - 1) * delta;
    return Math.max(1, Math.round(val));
  }

  function pushRecent(items) {
    if (!items.length) return;
    recentTweets = recentTweets.concat(items).slice(-5);
  }

  function computeScrollDelta(strategy, scrollCount, scrollStepPx) {
    if (strategy === "dips" && scrollCount > 0 && scrollCount % 7 === 0) {
      return -jitter(scrollStepPx * 0.6, 0.3);
    }
    if (strategy === "big-jumps" && scrollCount > 0 && scrollCount % 5 === 0) {
      return jitter(scrollStepPx * 4, 0.3);
    }
    return jitter(scrollStepPx, 0.4);
  }

  function stopIfBeforeDate(tweets, cutoffDate) {
    if (!cutoffDate) return false;
    return tweets.some(t => t.day && t.day < cutoffDate && !t.type.startsWith("repost:"));
  }

  let wakeLock = null;
  let wakeLockVisibilityHandler = null;

  async function requestWakeLock(logFn) {
    try {
      if ("wakeLock" in navigator) {
        wakeLock = await navigator.wakeLock.request("screen");
        logFn("Screen wake lock acquired — this keeps the display (and usually networking) from sleeping while this tab is visible.");
        wakeLock.addEventListener("release", () => {
          logFn("Screen wake lock was released (tab backgrounded/minimized, or the OS overrode it) — sleep/throttling is more likely again until you refocus this tab.");
        });
      } else {
        logFn("Wake Lock API isn't available in this browser — can't auto-prevent sleep. Keep this tab focused and disable system sleep manually during long runs.");
      }
    } catch (e) {
      logFn(`Wake lock request failed (${e && e.message ? e.message : e}) — keep this tab focused and disable system sleep manually during long runs.`);
    }
  }

  function releaseWakeLock() {
    if (wakeLockVisibilityHandler) {
      document.removeEventListener("visibilitychange", wakeLockVisibilityHandler);
      wakeLockVisibilityHandler = null;
    }
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }

  function setupWakeLockReacquire(logFn) {
    wakeLockVisibilityHandler = () => {
      if (document.visibilityState === "visible" && collecting && !wakeLock) {
        requestWakeLock(logFn);
      }
    };
    document.addEventListener("visibilitychange", wakeLockVisibilityHandler);
  }

  async function runCollectionLoop({
    account, maxScrolls, scrollStepPx, pauseMs, stopBeforeDate, onProgress,
    scrollStrategy = "steady-down",
    autoRetryEnabled = false,
    cooldownMs = 3 * 60 * 1000,
    maxRetries = 2,
    ignoreDuplicateStalls = false,
    pauseEveryTweets = 0,
    pauseMinutes = 5,
    autoExportEnabled = true,
    exportEveryN = 1000
  }) {
    collecting = true;
    stopRequested = false;
    let scrollCount = 0;
    let sessionAdded = 0;
    let sessionUpdated = 0;
    let consecutiveNoNewTweets = 0;
    let stopReason = "max_scrolls";
    let stepsUntilLongPause = randInt(8, 14);
    let retriesUsed = 0;
    let suspectedSuspendEvents = 0;
    let lastIterAt = Date.now();
    const sessionAccounts = new Set();
    let rateLimitCheckCounter = 0;

    let tweetsSinceBreak = 0;
    let nextBreakThreshold = pauseEveryTweets > 0 ? jitterCount(pauseEveryTweets, 0.7) : Infinity;
    let plannedBreaksTaken = 0;

    let exportPartNum = 1;
    let exportsWritten = 0;
    const exportActive = autoExportEnabled && !!exportDirHandle;

    const wakeLogFn = (msg) => console.log(`${LOG_TAG} ${msg}`);
    await requestWakeLock(wakeLogFn);
    setupWakeLockReacquire(wakeLogFn);

    function totalStoredForSessionAccounts() {
      let total = 0;
      for (const a of sessionAccounts) total += seenIds[a] ? seenIds[a].size : 0;
      return total;
    }

    async function flushExportBatch(reason) {
      if (!exportActive || pendingBatch.length === 0) return;
      const toWrite = dedupeBatchKeepLongest(pendingBatch);
      const filename = `tweets_${slugifyDataset(currentDataset)}_part${String(exportPartNum).padStart(4, "0")}_${Date.now()}.json`;
      const wrote = await writeJsonToExportDir(filename, toWrite);
      if (wrote) {
        exportsWritten++;
        exportPartNum++;
        const writtenCount = pendingBatch.length;
        pendingBatch = [];
        await checkpointPendingBatch();
        await checkpointSeenIndex();
        onProgress({
          scrollCount, maxScrolls, sessionAdded, sessionUpdated,
          totalForAccount: totalStoredForSessionAccounts(), accountsThisSession: sessionAccounts.size,
          recentTweets, netStats: timelineRequestStats(), retriesUsed,
          cooldownMessage: `Auto-exported ${writtenCount} tweets to ${filename} (${reason}); wiped from browser storage.`
        });
      } else {
        onProgress({
          scrollCount, maxScrolls, sessionAdded, sessionUpdated,
          totalForAccount: totalStoredForSessionAccounts(), accountsThisSession: sessionAccounts.size,
          recentTweets, netStats: timelineRequestStats(), retriesUsed,
          cooldownMessage: `Auto-export failed for ${filename} — check console. Nothing wiped; ${pendingBatch.length} tweets still buffered, will retry at next threshold or run end.`
        });
      }
    }

    while (scrollCount < maxScrolls && !stopRequested) {
      const nowIterAt = Date.now();
      const wallGap = nowIterAt - lastIterAt;
      lastIterAt = nowIterAt;
      if (scrollCount > 0 && wallGap > Math.max(15000, pauseMs * 5)) {
        suspectedSuspendEvents++;
        console.warn(`${LOG_TAG} large wall-clock gap since previous step: ${Math.round(wallGap / 1000)}s — looks like the system or tab was suspended, not a normal pause. (${suspectedSuspendEvents} such gap(s) so far this run.)`);
      }

      const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
      await expandShowMoreButtons(articles);
      unloadOffscreenMedia();

      const found = extractVisibleTweets(account);
      const hitCutoff = stopIfBeforeDate(found, stopBeforeDate);
      const inRange = stopBeforeDate
        ? found.filter(t => t.type.startsWith("repost:") || !t.day || t.day >= stopBeforeDate)
        : found;

      const { added, updated, addedItems, updatedItems } = addTweetsToStore(inRange);
      sessionAdded += added;
      sessionUpdated += updated;
      tweetsSinceBreak += added;
      pushRecent(addedItems.concat(updatedItems));
      for (const item of addedItems) sessionAccounts.add(item.account);
      for (const item of updatedItems) sessionAccounts.add(item.account);
      for (const t of inRange) sessionAccounts.add(t.account);

      if (exportActive && (addedItems.length || updatedItems.length)) {
        await checkpointPendingBatch();
      }

      if (added === 0 && updated === 0) {
        consecutiveNoNewTweets++;
      } else {
        consecutiveNoNewTweets = 0;
      }

      rateLimitCheckCounter++;
      let suspectRateLimitNow = false;
      if (rateLimitCheckCounter >= 8) {
        rateLimitCheckCounter = 0;
        suspectRateLimitNow = looksRateLimited();
      }

      const netStats = timelineRequestStats();
      const totalForAccount = totalStoredForSessionAccounts();

      onProgress({
        scrollCount,
        maxScrolls,
        sessionAdded,
        sessionUpdated,
        totalForAccount,
        accountsThisSession: sessionAccounts.size,
        recentTweets,
        hitCutoff,
        netStats,
        retriesUsed,
        suspectedSuspendEvents
      });

      if (hitCutoff) {
        stopReason = "date_cutoff";
        break;
      }

      if (exportActive && pendingBatch.length >= exportEveryN) {
        await flushExportBatch("threshold reached");
      }

      if (pauseEveryTweets > 0 && tweetsSinceBreak >= nextBreakThreshold) {
        plannedBreaksTaken++;
        tweetsSinceBreak = 0;
        const thisBreakThreshold = nextBreakThreshold;
        nextBreakThreshold = jitterCount(pauseEveryTweets, 0.7);
        onProgress({
          scrollCount, maxScrolls, sessionAdded, sessionUpdated,
          totalForAccount, accountsThisSession: sessionAccounts.size,
          recentTweets, netStats, retriesUsed,
          cooldownMessage: `Scheduled break #${plannedBreaksTaken}: pausing ${pauseMinutes} min after ~${thisBreakThreshold} tweets.`
        });
        console.log(`${LOG_TAG} scheduled break #${plannedBreaksTaken} — pausing ${pauseMinutes} min (hit ${thisBreakThreshold}-tweet threshold)`);
        await sleep(jitter(pauseMinutes * 60 * 1000));
      }

      if (suspectRateLimitNow) {
        if (autoRetryEnabled && retriesUsed < maxRetries) {
          retriesUsed++;
          const reqsBeforeWait = timelineRequestStats().total;
          onProgress({
            scrollCount, maxScrolls, sessionAdded, sessionUpdated,
            totalForAccount, accountsThisSession: sessionAccounts.size,
            recentTweets, netStats, retriesUsed,
            cooldownMessage: `Page shows a rate-limit/error message. Cooling down ${Math.round(cooldownMs / 60000)} min before retry ${retriesUsed}/${maxRetries}...`
          });
          await sleep(cooldownMs);
          window.scrollBy(0, -200);
          await sleep(400);
          window.scrollBy(0, 250);
          await sleep(jitter(pauseMs));
          const reqsAfterWait = timelineRequestStats().total;
          if (reqsAfterWait === reqsBeforeWait) {
            stopReason = "likely_rate_limited";
            break;
          }
          continue;
        }
        stopReason = "likely_rate_limited";
        break;
      }

      const stallThreshold = ignoreDuplicateStalls ? Infinity : 8;
      if (consecutiveNoNewTweets >= stallThreshold) {
        if (autoRetryEnabled && retriesUsed < maxRetries) {
          retriesUsed++;
          onProgress({
            scrollCount, maxScrolls, sessionAdded, sessionUpdated,
            totalForAccount, accountsThisSession: sessionAccounts.size,
            recentTweets, netStats, retriesUsed,
            cooldownMessage: `No new tweets loading. Cooling down ${Math.round(cooldownMs / 60000)} min before retry ${retriesUsed}/${maxRetries}...`
          });
          await sleep(cooldownMs);
          window.scrollBy(0, -200);
          await sleep(400);
          window.scrollBy(0, 250);
          await sleep(jitter(pauseMs));
          consecutiveNoNewTweets = 0;
          continue;
        }
        stopReason = "no_new_tweets";
        break;
      }

      const step = computeScrollDelta(scrollStrategy, scrollCount, scrollStepPx);
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
    await flushExportBatch("end of run");
    collecting = false;
    releaseWakeLock();
    return {
      sessionAdded, sessionUpdated, scrollCount, stopReason, retriesUsed,
      finalNetStats: timelineRequestStats(), suspectedSuspendEvents,
      accountsThisSession: sessionAccounts.size, plannedBreaksTaken,
      exportsWritten, exportActive
    };
  }

  function stopCollection() {
    stopRequested = true;
  }


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
      #tc-panel .tc-row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; align-items: center; }
      #tc-panel button {
        background: #1d9bf0; color: white; border: none; border-radius: 999px;
        padding: 6px 12px; font-size: 12.5px; font-weight: 600; cursor: pointer;
      }
      #tc-panel button.secondary { background: transparent; border: 1px solid #2a3140; color: #e7e9ea; }
      #tc-panel button.danger { background: transparent; border: 1px solid #f4212e; color: #f4212e; }
      #tc-panel button:disabled { opacity: 0.4; cursor: not-allowed; }
      #tc-panel .tc-status { margin-top: 8px; font-size: 12px; color: #8b98a5; min-height: 32px; }
      #tc-panel #tc-handle {
        font-weight: 700; color: #1d9bf0; background: #0e1217; border: 1px solid #2a3140;
        border-radius: 6px; padding: 4px 8px; font-size: 13px; width: 160px;
      }
      #tc-panel input[type=number] {
        width: 55px; background: #0e1217; border: 1px solid #2a3140; color: #e7e9ea;
        border-radius: 6px; padding: 3px 6px; font-size: 12px;
      }
      #tc-panel label { font-size: 11.5px; color: #8b98a5; }
      #tc-export-dir-label { font-size: 11px; color: #536471; }
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
      <div class="tc-row">
        <label>Dataset <input type="text" id="tc-dataset" value="default" placeholder="e.g. politicians-list"></label>
        <button id="tc-dataset-switch" class="secondary">Switch</button>
      </div>
      <div class="tc-row">
        <label>Existing datasets
          <select id="tc-dataset-list"><option value="">(loading...)</option></select>
        </label>
      </div>
      <div class="tc-row">
        <label>Account handle
          <input type="text" id="tc-handle" placeholder="auto-detected — edit if wrong">
        </label>
      </div>
      <div class="tc-row">
        <label>Max scrolls <input type="number" id="tc-maxscrolls" value="200" min="1" max="2000"></label>
        <label>Pause (ms) <input type="number" id="tc-pause" value="1100" min="300" max="8000"></label>
      </div>
      <div class="tc-row">
        <label><input type="checkbox" id="tc-stopdate-enabled" checked style="width:auto;"> Stop at date</label>
        <input type="date" id="tc-stopdate" value="2000-01-01">
      </div>
      <div class="tc-row">
        <label>Scroll strategy
          <select id="tc-strategy">
            <option value="steady-down">Steady down (default)</option>
            <option value="dips">Mostly down, occasional small dip up</option>
            <option value="big-jumps">Mostly down, occasional big jump</option>
          </select>
        </label>
      </div>
      <div class="tc-row">
        <label><input type="checkbox" id="tc-ignoredupes" style="width:auto;"> Don't stop on already-seen tweets (multi-account lists)</label>
      </div>
      <div class="tc-row">
        <label><input type="checkbox" id="tc-longbreak" style="width:auto;"> Take a break every
          <input type="number" id="tc-longbreak-count" value="40" min="1" max="5000" style="width:65px;">
          tweets, for
          <input type="number" id="tc-longbreak-minutes" value="5" min="1" max="180" style="width:50px;">
          min
        </label>
      </div>
      <div class="tc-row">
        <label><input type="checkbox" id="tc-autoretry" style="width:auto;"> Auto cooldown + retry on stall</label>
        <label>Cooldown (min) <input type="number" id="tc-cooldown" value="3" min="1" max="30"></label>
      </div>
      <h4>Auto-export to disk (also frees browser memory)</h4>
      <div class="tc-row">
        <button id="tc-choose-export-dir" class="secondary">Choose export folder</button>
        <span id="tc-export-dir-label">No folder chosen (auto-export off until you pick one)</span>
      </div>
      <div class="tc-row">
        <label><input type="checkbox" id="tc-autoexport-enabled" checked style="width:auto;"> Auto-export every
          <input type="number" id="tc-autoexport-every" value="1000" min="10" max="50000" style="width:70px;">
          tweets, then wipe from browser storage
        </label>
      </div>
      <h4>Performance (experimental)</h4>
      <div class="tc-row">
        <label><input type="checkbox" id="tc-verbose-logging" style="width:auto;"> Verbose console logging</label>
      </div>
      <div class="tc-row">
        <label><input type="checkbox" id="tc-media-unload" style="width:auto;"> Aggressively unload offscreen images</label>
      </div>
      <div class="tc-row">
        <button id="tc-start">Start collecting</button>
        <button id="tc-stop" class="secondary" disabled>Stop</button>
      </div>
      <div class="tc-status" id="tc-status">Idle. Default settings aim to cover a whole profile in one run — stops early once it hits already-collected content.</div>
      <div class="tc-status" id="tc-netstats"></div>
      <h4>Sanity check — last 5 scraped</h4>
      <div id="tc-preview"><div class="tc-empty">Nothing scraped yet.</div></div>
      <div class="tc-row">
        <button id="tc-export-account" class="secondary">Export pending (this account) CSV</button>
        <button id="tc-export-account-json" class="secondary">JSON</button>
      </div>
      <div class="tc-row">
        <button id="tc-export-all" class="secondary">Export pending (all accounts) CSV</button>
        <button id="tc-export-all-json" class="secondary">JSON</button>
      </div>
      <div class="tc-row">
        <button id="tc-wipe" class="danger">Wipe dataset (browser only)</button>
      </div>
      <div class="tc-status" id="tc-storesummary"></div>
    `;
    document.body.appendChild(panel);
    return panel;
  }

  function refreshHandleDisplay(forceOverwrite = false) {
    const handleEl = document.getElementById("tc-handle");
    const detected = detectHandleFromUrl() || detectHandleFromFirstTweet();
    if (detected && (forceOverwrite || !handleEl.value.trim())) {
      handleEl.value = detected;
    }
    return handleEl.value.trim() || null;
  }

  function refreshStoreSummary() {
    const el = document.getElementById("tc-storesummary");
    const handles = Object.keys(seenIds);
    if (handles.length === 0) {
      el.textContent = "No accounts tracked yet.";
      return;
    }
    const pendingCounts = {};
    for (const r of pendingBatch) pendingCounts[r.account] = (pendingCounts[r.account] || 0) + 1;
    el.textContent = handles.map(h => `@${h}: ${seenIds[h].size} seen (${pendingCounts[h] || 0} pending export)`).join("  ·  ");
  }

  async function refreshDatasetList() {
    const sel = document.getElementById("tc-dataset-list");
    if (!sel) return;
    let names;
    try {
      names = await listDatasetNames();
    } catch (e) {
      console.error(`${LOG_TAG} failed to list datasets`, e);
      sel.innerHTML = '<option value="">(couldn\'t load list)</option>';
      return;
    }
    if (names.length === 0) {
      sel.innerHTML = '<option value="">(none saved yet)</option>';
      return;
    }
    sel.innerHTML = names.map(n =>
      `<option value="${escapeHtml(n)}"${n === currentDataset ? " selected" : ""}>${escapeHtml(n)}</option>`
    ).join("");
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

    document.getElementById("tc-choose-export-dir").addEventListener("click", async () => {
      if (!window.showDirectoryPicker) {
        statusEl.textContent = "This browser doesn't support the folder-picker API (Chrome/Edge only) — use the manual Export buttons below instead.";
        return;
      }
      try {
        exportDirHandle = await window.showDirectoryPicker();
        document.getElementById("tc-export-dir-label").textContent = `Exporting to: ${exportDirHandle.name}/`;
      } catch (e) {
      }
    });

    document.getElementById("tc-verbose-logging").addEventListener("change", (e) => {
      verboseNetworkLogging = e.target.checked;
    });

    document.getElementById("tc-media-unload").addEventListener("change", (e) => {
      aggressiveMediaUnload = e.target.checked;
    });

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
      const scrollStrategy = document.getElementById("tc-strategy").value;
      const autoRetryEnabled = document.getElementById("tc-autoretry").checked;
      const cooldownMs = (parseInt(document.getElementById("tc-cooldown").value, 10) || 3) * 60 * 1000;
      const ignoreDuplicateStalls = document.getElementById("tc-ignoredupes").checked;
      const longBreakEnabled = document.getElementById("tc-longbreak").checked;
      const pauseEveryTweets = longBreakEnabled ? (parseInt(document.getElementById("tc-longbreak-count").value, 10) || 40) : 0;
      const pauseMinutes = parseInt(document.getElementById("tc-longbreak-minutes").value, 10) || 5;
      const autoExportEnabled = document.getElementById("tc-autoexport-enabled").checked;
      const exportEveryN = parseInt(document.getElementById("tc-autoexport-every").value, 10) || 1000;

      if (autoExportEnabled && !exportDirHandle) {
        statusEl.textContent = "Auto-export is checked but no folder is chosen yet — click \"Choose export folder\" first, or uncheck auto-export.";
        return;
      }
      if (!autoExportEnabled) {
        statusEl.textContent = "Heads up: auto-export is off, so nothing is saved durably during this run — only in memory until you stop and manually export. Recommended for short test runs only.";
      }

      startBtn.disabled = true;
      stopBtn.disabled = false;
      statusEl.textContent = `Collecting for @${handle}... (scroll 0/${maxScrolls})`;

      const result = await runCollectionLoop({
        account: handle,
        maxScrolls,
        scrollStepPx: 600,
        pauseMs,
        stopBeforeDate,
        scrollStrategy,
        autoRetryEnabled,
        cooldownMs,
        maxRetries: 2,
        ignoreDuplicateStalls,
        pauseEveryTweets,
        pauseMinutes,
        autoExportEnabled,
        exportEveryN,
        onProgress: (p) => {
          const acctNote = p.accountsThisSession > 1 ? ` across ${p.accountsThisSession} accounts` : "";
          statusEl.textContent = p.cooldownMessage ||
            (`scroll ${p.scrollCount}/${p.maxScrolls} — ` +
            `+${p.sessionAdded} new, ${p.sessionUpdated} corrected, ${p.totalForAccount} total seen this session${acctNote}, ${pendingBatch.length} pending export.` +
            (p.retriesUsed ? ` (retry ${p.retriesUsed}/2 used)` : ""));
          renderPreview(p.recentTweets);
          refreshStoreSummary();
          if (p.netStats) {
            const el = document.getElementById("tc-netstats");
            el.textContent = `Timeline requests seen this session: ${p.netStats.total}` +
              (p.netStats.lastAgoSec !== null ? ` (last one ${p.netStats.lastAgoSec}s ago, ${p.netStats.ratePerMin}/min)` : "");
          }
        }
      });

      startBtn.disabled = false;
      stopBtn.disabled = true;
      const reasonText = {
        date_cutoff: `reached tweets older than ${stopBeforeDate} and stopped there`,
        no_new_tweets: `hit a stretch of already-collected content (likely end of available/loaded history)`,
        likely_rate_limited: `page showed something that looks like a rate-limit/error message — check console log and the diagnostics line above; this is a strong signal it's a platform-side throttle, not an end of content`,
        max_scrolls: `hit the max-scrolls limit — scroll down a bit manually and click Start again to continue`,
        user_stopped: `stopped by you`
      }[result.stopReason] || result.stopReason;
      const retryNote = result.retriesUsed ? ` Used ${result.retriesUsed} auto-retry cooldown(s) along the way.` : "";
      const breakNote = result.plannedBreaksTaken ? ` Took ${result.plannedBreaksTaken} scheduled break(s).` : "";
      const exportNote = result.exportActive ? ` Wrote ${result.exportsWritten} export file(s) to disk and wiped them from browser storage.` : " Auto-export was off — remember to export manually before closing the tab.";
      const suspendNote = result.suspectedSuspendEvents
        ? ` Saw ${result.suspectedSuspendEvents} large wall-clock gap(s) that look like system/tab sleep, not a real stall — check console.`
        : "";
      const acctNote = result.accountsThisSession > 1 ? ` across ${result.accountsThisSession} accounts` : "";
      statusEl.textContent =
        `Done. Added ${result.sessionAdded} new tweets, corrected ${result.sessionUpdated} truncated ` +
        `captures${acctNote} (${result.scrollCount} scroll steps). Stopped because: ${reasonText}.${retryNote}${breakNote}${exportNote}${suspendNote} ` +
        `Total timeline requests observed: ${result.finalNetStats.total}.`;
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
      const rows = handle ? pendingRowsForAccount(handle) : [];
      if (rows.length === 0) {
        statusEl.textContent = "No pending (not-yet-auto-exported) data for the current profile.";
        return;
      }
      downloadCsv(`tweets_${handle}_pending.csv`, toCsv(rows));
    });

    document.getElementById("tc-export-account-json").addEventListener("click", () => {
      const handle = refreshHandleDisplay();
      const rows = handle ? pendingRowsForAccount(handle) : [];
      if (rows.length === 0) {
        statusEl.textContent = "No pending (not-yet-auto-exported) data for the current profile.";
        return;
      }
      downloadJson(`tweets_${handle}_pending.json`, toJson(rows));
    });

    document.getElementById("tc-export-all").addEventListener("click", () => {
      const rows = pendingRowsAll();
      if (rows.length === 0) {
        statusEl.textContent = "Nothing pending right now.";
        return;
      }
      downloadCsv("tweets_pending_all_accounts.csv", toCsv(rows));
    });

    document.getElementById("tc-export-all-json").addEventListener("click", () => {
      const rows = pendingRowsAll();
      if (rows.length === 0) {
        statusEl.textContent = "Nothing pending right now.";
        return;
      }
      downloadJson("tweets_pending_all_accounts.json", toJson(rows));
    });

    document.getElementById("tc-wipe").addEventListener("click", async () => {
      if (confirm("Clear this dataset's dedup index and pending (not-yet-exported) batch from the browser? Files already written to your export folder are not affected. This cannot be undone.")) {
        await wipeCurrentDataset();
        seenIds = {};
        pendingBatch = [];
        recentTweets = [];
        refreshStoreSummary();
        renderPreview(recentTweets);
        statusEl.textContent = "Dataset wiped from browser storage.";
      }
    });

    document.getElementById("tc-dataset-switch").addEventListener("click", async () => {
      if (collecting) {
        statusEl.textContent = "Stop the current run before switching datasets.";
        return;
      }
      const datasetInput = document.getElementById("tc-dataset");
      const requested = datasetInput.value.trim() || "default";
      statusEl.textContent = `Switching to dataset "${requested}"...`;
      currentDataset = requested;
      await loadDatasetState(currentDataset);
      datasetInput.value = slugifyDataset(requested);
      recentTweets = [];
      renderPreview(recentTweets);
      refreshStoreSummary();
      await refreshDatasetList();
      statusEl.textContent = `Now using dataset "${currentDataset}" (${Object.keys(seenIds).length} account(s) tracked, ${pendingBatch.length} pending export).`;
    });

    document.getElementById("tc-dataset-list").addEventListener("change", (e) => {
      if (e.target.value) document.getElementById("tc-dataset").value = e.target.value;
    });

    let lastPath = window.location.pathname;
    setInterval(() => {
      if (window.location.pathname !== lastPath) {
        lastPath = window.location.pathname;
        refreshHandleDisplay(true);
      } else {
        refreshHandleDisplay();
      }
    }, 1000);
  }

  (async () => {
    if (document.getElementById("tc-panel")) return;
    patchNetworkForDiagnostics();
    await loadDatasetState(currentDataset);
    initUI();
    refreshDatasetList();
  })();

})();

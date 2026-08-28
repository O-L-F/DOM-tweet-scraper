// ==UserScript==
// @name         JSON X-list collector
// @namespace    local.tweetcollector
// @version      4.0
// @description  Scrapes tweets from an X/Twitter LIST timeline into JSON.
// @match        https://x.com/i/lists/*
// @match        https://twitter.com/i/lists/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    "use strict";

    const LOG_TAG = "[TweetCollector]";
    const UNKNOWN_AUTHOR_TAG = "unknown_author";

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function simpleHash(str) {
        let h = 0;
        for (let i = 0; i < str.length; i++) {
            h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
        }
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
            if (t.includes("reposted")) {
                isRepost = true;
                socialContextEl = el;
                break;
            }
        }

        if (!isRepost) {
            return {
                isRepost: false,
                originalPosterHandle: null,
                reposterHandle: null
            };
        }

        const statusLinks = article.querySelectorAll('a[href*="/status/"]');
        let originalPosterHandle = null;

        for (const a of statusLinks) {
            const href = a.getAttribute("href") || "";
            const m = href.match(/^\/([A-Za-z0-9_]{1,15})\/status\/\d+/);
            if (m) {
                originalPosterHandle = m[1];
                break;
            }
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

                    if (m) {
                        reposterHandle = m[1];
                        break;
                    }
                }
            }
        }

        if (!reposterHandle) reposterHandle = fallbackAccount || null;

        return {
            isRepost: true,
            originalPosterHandle,
            reposterHandle
        };
    }

    function extractQuotedAuthorHandle(article) {
        const roleLinks = article.querySelectorAll('div[role="link"]');

        for (const el of roleLinks) {
            const textEl = el.querySelector('[data-testid="tweetText"]');
            if (!textEl) continue;

            const userNameEl = el.querySelector('[data-testid="User-Name"]');

            if (userNameEl) {
                for (const span of userNameEl.querySelectorAll("span")) {
                    const m = (span.textContent || "")
                        .trim()
                        .match(/^@([A-Za-z0-9_]{1,15})$/);

                    if (m) return m[1];
                }
            }

            const links = el.querySelectorAll('a[href*="/status/"]');

            for (const a of links) {
                const href = a.getAttribute("href") || "";
                const m = href.match(/^\/([A-Za-z0-9_]{1,15})\/status\/\d+/);

                if (m) return m[1];
            }
        }

        return null;
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
        const articles = Array.from(
            document.querySelectorAll('article[data-testid="tweet"]')
        );

        const results = [];

        for (const article of articles) {
            const text = extractTweetText(article);
            if (!text) continue;

            const day = extractDayFromTimeEl(article);
            const statusId = extractStatusId(article);
            const repostInfo = getRepostInfo(article, fallbackAccount);

            let account;
            let type;

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

            const key =
                statusId ||
                simpleHash(account + "|" + day + "|" + text);

            results.push({
                id: key,
                day: day || "",
                account,
                type,
                text
            });
        }

        return results;
    }

    const netLog = {
        requests: [],
        patched: false
    };

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
            console.log(
                `${LOG_TAG} graphql call: ${op} (seen ${graphqlOpCounts[op]}x this session)`
            );
        }
    }

    function recordTimelineRequest(url) {
        const now = Date.now();

        netLog.requests.push(now);

        if (netLog.requests.length > 1000) {
            netLog.requests.shift();
        }

        if (verboseNetworkLogging) {
            console.log(
                `${LOG_TAG} timeline request #${netLog.requests.length} at ${new Date(now).toISOString()} — ${url}`
            );
        }
    }

    const httpErrorLog = [];
    const networkFailureLog = [];

    function recordHttpErrorStatus(status, url) {
        httpErrorLog.push({ t: Date.now(), status, url: String(url || "") });

        if (httpErrorLog.length > 200) {
            httpErrorLog.shift();
        }

        if (verboseNetworkLogging) {
            console.warn(`${LOG_TAG} http error status ${status} on ${url}`);
        }
    }

    function recentHttpErrorCount(windowMs = 60000) {
        const now = Date.now();
        return httpErrorLog.filter(e => now - e.t <= windowMs).length;
    }

    function recordNetworkFailure(url, message) {
        networkFailureLog.push({
            t: Date.now(),
            url: String(url || ""),
            message: String(message || "")
        });

        if (networkFailureLog.length > 100) {
            networkFailureLog.shift();
        }

        if (verboseNetworkLogging) {
            console.warn(`${LOG_TAG} network-level failure on ${url}: ${message}`);
        }
    }

    function recentNetworkFailureCount(windowMs = 60000) {
        const now = Date.now();
        return networkFailureLog.filter(e => now - e.t <= windowMs).length;
    }

    function patchNetworkForDiagnostics() {
        if (netLog.patched) return;

        netLog.patched = true;

        const origFetch = window.fetch;

        if (origFetch) {
            window.fetch = function (...args) {
                let url = "";
                let isTimelineCall = false;

                try {
                    url =
                        typeof args[0] === "string"
                            ? args[0]
                            : (args[0] && args[0].url) || "";

                    maybeLogGraphqlCall(url);

                    isTimelineCall = looksLikeTimelinePaginationUrl(url);

                    if (isTimelineCall) {
                        recordTimelineRequest(url);
                    }
                } catch (e) {}

                const result = origFetch.apply(this, args);

                if (result && typeof result.then === "function") {
                    result.then(
                        res => {
                            try {
                                if (
                                    isTimelineCall &&
                                    res &&
                                    (res.status === 429 ||
                                        res.status === 403 ||
                                        res.status >= 500)
                                ) {
                                    recordHttpErrorStatus(res.status, url);
                                }
                            } catch (e) {}
                        },
                        err => {
                            if (isTimelineCall) {
                                recordNetworkFailure(
                                    url,
                                    err && err.message
                                );
                            }
                        }
                    );
                }

                return result;
            };
        }

        const origOpen = XMLHttpRequest.prototype.open;

        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            try {
                maybeLogGraphqlCall(url);

                const isTimelineCall =
                    looksLikeTimelinePaginationUrl(url);

                if (isTimelineCall) {
                    recordTimelineRequest(url);
                }

                this.addEventListener("loadend", () => {
                    try {
                        if (
                            isTimelineCall &&
                            (this.status === 429 ||
                                this.status === 403 ||
                                this.status >= 500)
                        ) {
                            recordHttpErrorStatus(this.status, url);
                        }
                    } catch (e) {}
                });

                this.addEventListener("error", () => {
                    if (isTimelineCall) {
                        recordNetworkFailure(url, "xhr network error");
                    }
                });
            } catch (e) {}

            return origOpen.call(this, method, url, ...rest);
        };
    }

    function timelineRequestStats() {
        const now = Date.now();

        const lastTs =
            netLog.requests.length
                ? netLog.requests[netLog.requests.length - 1]
                : null;

        const last60s = netLog.requests.filter(
            t => now - t <= 60000
        ).length;

        return {
            total: netLog.requests.length,
            lastAgoSec:
                lastTs !== null
                    ? Math.round((now - lastTs) / 1000)
                    : null,
            ratePerMin: last60s
        };
    }

    function isElementVisible(el) {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }


    function findVisibleRetryButton() {
        const buttons = document.querySelectorAll("button");

        for (const b of buttons) {
            const t = (b.textContent || "").trim();

            if (t === "Retry" && isElementVisible(b)) {
                return b;
            }
        }

        return null;
    }

    function looksRateLimited() {
        if (recentHttpErrorCount(60000) > 0) {
            return true;
        }

        if (recentNetworkFailureCount(60000) > 0) {
            return true;
        }

        const container =
            document.querySelector('div[data-testid="primaryColumn"]') ||
            document.body;

        const text = (container.innerText || "").slice(-3000);

        return /something went wrong|try reloading|rate limit|try again later|retry/i.test(
            text
        );
    }

    const expandGiveUpIds = new Set();

    async function expandShowMoreButtons(articles) {
        const entries = [];

        for (const article of articles) {
            const btn = article.querySelector(
                '[data-testid="tweet-text-show-more-link"]'
            );

            if (btn) {
                const statusId =
                    extractStatusId(article) || "(no status id)";

                if (expandGiveUpIds.has(statusId)) continue;

                const beforeEl =
                    article.querySelector('[data-testid="tweetText"]');

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

            const nowEl =
                e.article.querySelector('[data-testid="tweetText"]');

            if (!nowEl) return false;

            return (
                nowEl.id !== e.beforeId ||
                nowEl.textContent.length > e.beforeLen
            );
        }

        for (let attempt = 0; attempt < 12; attempt++) {
            await sleep(180);

            const stillPending =
                entries.filter(e => !isExpanded(e));

            if (stillPending.length === 0) break;

            for (const e of stillPending) {
                if (document.contains(e.btn)) {
                    try {
                        e.btn.click();
                    } catch (err) {
                        console.warn(
                            `${LOG_TAG} click threw for ${e.statusId}`,
                            err
                        );
                    }
                }
            }
        }

        const unresolved = entries
            .filter(e => !isExpanded(e))
            .map(e => e.statusId);

        if (unresolved.length > 0) {
            for (const id of unresolved) {
                expandGiveUpIds.add(id);
            }

            console.warn(
                `${LOG_TAG} gave up expanding (will not retry these again this session):`,
                unresolved
            );
        }

        return entries.length;
    }

    const STORAGE_KEY = "tweetCollector.v2";
    const IDB_NAME = "tweetCollectorDb";
    const IDB_STORE = "kv";
    const LAST_DATASET_KEY = "tweetCollector.lastDataset";

    function loadLastDatasetName() {
        try {
            return localStorage.getItem(LAST_DATASET_KEY) || "default";
        } catch (e) {
            return "default";
        }
    }

    function saveLastDatasetName(name) {
        try {
            localStorage.setItem(LAST_DATASET_KEY, name);
        } catch (e) {}
    }

    let dbPromise = null;

    function openDb() {
        if (dbPromise) return dbPromise;

        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(IDB_NAME, 1);

            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(IDB_STORE)) {
                    req.result.createObjectStore(IDB_STORE);
                }
            };

            req.onsuccess = () => resolve(req.result);
            req.onerror = () => {
                dbPromise = null;
                reject(req.error);
            };
        });

        return dbPromise;
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

        if (!s || s.toLowerCase() === "default") {
            return "default";
        }

        return (
            s
                .toLowerCase()
                .replace(/[^a-z0-9_-]+/g, "-")
                .slice(0, 60) || "default"
        );
    }

    function storageKeyForDataset(datasetName) {
        const slug = slugifyDataset(datasetName);

        return slug === "default"
            ? STORAGE_KEY
            : `${STORAGE_KEY}::${slug}`;
    }

    function seenIndexKey(datasetName) {
        return storageKeyForDataset(datasetName) + "::seenIndex";
    }

    function pendingBatchKey(datasetName) {
        return storageKeyForDataset(datasetName) + "::pending";
    }

    function heapLogKey(datasetName) {
        return storageKeyForDataset(datasetName) + "::heapLog";
    }

    async function listDatasetNames() {
        const keys = await idbListKeys();
        const names = new Set();
        const prefix = STORAGE_KEY;

        for (const k of keys) {
            if (!k.startsWith(prefix + "::")) continue;

            const afterPrefix = k.slice(prefix.length + 2);
            const firstSeg = afterPrefix.split("::")[0];

            if (
                firstSeg === "seenIndex" ||
                firstSeg === "pending" ||
                firstSeg === "heapLog"
            ) {
                names.add("default");
            } else {
                names.add(firstSeg);
            }
        }

        return Array.from(names).sort((a, b) =>
            a === "default"
                ? -1
                : b === "default"
                    ? 1
                    : a.localeCompare(b)
        );
    }

    let currentDataset = loadLastDatasetName();
    let seenIds = {};
    let pendingBatch = [];
    const MAX_SEEN_PER_ACCOUNT = 20000;

    function trimSeenIndexIfNeeded(acct) {
        const m = seenIds[acct];
        if (!m || m.size <= MAX_SEEN_PER_ACCOUNT) return;

       
        const excess = m.size - MAX_SEEN_PER_ACCOUNT;
        const it = m.keys();

        for (let i = 0; i < excess; i++) {
            const k = it.next().value;
            if (k === undefined) break;
            m.delete(k);
        }
    }

    async function loadDatasetState(datasetName) {
        seenIds = {};
        pendingBatch = [];

        try {
            const raw = await idbGet(seenIndexKey(datasetName));

            if (raw) {
                for (const acct of Object.keys(raw)) {
                    seenIds[acct] = new Map(raw[acct]);
                }
            }
        } catch (e) {
            console.error(
                `${LOG_TAG} failed to load seen-index for dataset "${datasetName}"`,
                e
            );
        }

        try {
            pendingBatch =
                (await idbGet(pendingBatchKey(datasetName))) || [];
        } catch (e) {
            pendingBatch = [];
        }

        for (const r of pendingBatch) {
            if (!seenIds[r.account]) {
                seenIds[r.account] = new Map();
            }

            const existingLen = seenIds[r.account].get(r.id);

            if (
                existingLen === undefined ||
                r.text.length > existingLen
            ) {
                seenIds[r.account].set(r.id, r.text.length);
            }
        }
    }

    async function checkpointSeenIndex() {
        try {
            const serializable = {};

            for (const acct of Object.keys(seenIds)) {
                serializable[acct] =
                    Array.from(seenIds[acct].entries());
            }

            await idbSet(
                seenIndexKey(currentDataset),
                serializable
            );
        } catch (e) {
            console.error(
                `${LOG_TAG} failed to checkpoint dedup index — a future run might re-scrape a few already-exported tweets`,
                e
            );
        }
    }

    async function checkpointPendingBatch() {
        try {
            await idbSet(
                pendingBatchKey(currentDataset),
                pendingBatch
            );
        } catch (e) {
            console.error(
                `${LOG_TAG} failed to checkpoint pending batch — it stays in memory only until the next successful export`,
                e
            );
        }
    }

    async function wipeCurrentDataset() {
        try {
            await idbDelete(seenIndexKey(currentDataset));
        } catch (e) {}

        try {
            await idbDelete(pendingBatchKey(currentDataset));
        } catch (e) {}

        try {
            await idbDelete(heapLogKey(currentDataset));
        } catch (e) {}
    }

    function dedupeBatchKeepLongest(batch) {
        const byId = new Map();

        for (const r of batch) {
            const cur = byId.get(r.id);

            if (!cur || r.text.length > cur.text.length) {
                byId.set(r.id, r);
            }
        }

        return Array.from(byId.values());
    }

    function addTweetsToStore(tweets) {
        const addedItems = [];
        const updatedItems = [];
        let skipped = 0;

        for (const t of tweets) {
            const acct = t.account || "unknown";

            if (!seenIds[acct]) {
                seenIds[acct] = new Map();
            }

            const priorLen = seenIds[acct].get(t.id);

            const record = {
                id: t.id,
                day: t.day,
                account: acct,
                type: t.type,
                text: t.text
            };

            if (priorLen === undefined) {
                seenIds[acct].set(t.id, t.text.length);
                trimSeenIndexIfNeeded(acct);
                pendingBatch.push(record);
                addedItems.push(record);
            } else if (t.text.length > priorLen) {
                seenIds[acct].set(t.id, t.text.length);
                trimSeenIndexIfNeeded(acct);
                pendingBatch.push(record);
                updatedItems.push(record);
            } else {
                skipped++;
            }
        }

        return {
            added: addedItems.length,
            updated: updatedItems.length,
            skipped,
            addedItems,
            updatedItems
        };
    }

    function pendingRowsAll() {
        return dedupeBatchKeepLongest(pendingBatch)
            .sort((a, b) =>
                (a.day || "").localeCompare(b.day || "")
            );
    }

    function toJson(rows) {
        return JSON.stringify(
            rows.map(r => ({
                day: r.day,
                account: r.account,
                type: r.type,
                text: r.text
            })),
            null,
            2
        );
    }

    function downloadJson(filename, jsonText) {
        const blob = new Blob(
            [jsonText],
            { type: "application/json;charset=utf-8;" }
        );

        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");

        a.href = url;
        a.download = filename;
        a.style.display = "none";

        document.body.appendChild(a);
        a.click();

        
        setTimeout(() => {
            if (a.parentNode) document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 30000);
    }

    let exportDirHandle = null;

    async function writeJsonToExportDir(filename, rows) {
        if (!exportDirHandle) return false;

        try {
            const fileHandle =
                await exportDirHandle.getFileHandle(
                    filename,
                    { create: true }
                );

            const writable = await fileHandle.createWritable();

            await writable.write(toJson(rows));
            await writable.close();

            return true;
        } catch (e) {
            console.error(
                `${LOG_TAG} auto-export write failed for ${filename}`,
                e
            );

            return false;
        }
    }

    async function exportDirPermissionGranted() {
        if (!exportDirHandle) return false;

        try {
            const state = await exportDirHandle.queryPermission({
                mode: "readwrite"
            });

            return state === "granted";
        } catch (e) {
            return false;
        }
    }

    
    async function ensureExportPermissionAtStart() {
        if (!exportDirHandle) return true; 

        const granted = await exportDirPermissionGranted();
        if (granted) return true;

        try {
            const result = await exportDirHandle.requestPermission({
                mode: "readwrite"
            });

            return result === "granted";
        } catch (e) {
            return false;
        }
    }

    function exportArchiveKey(datasetName) {
        return storageKeyForDataset(datasetName) + "::exportArchive";
    }

    async function archiveFallbackExport(filename, rows) {
        try {
            const key = exportArchiveKey(currentDataset);
            const archive = (await idbGet(key)) || [];

            archive.push({ t: Date.now(), filename, rows });

            if (archive.length > 200) {
                archive.shift();
            }

            await idbSet(key, archive);
        } catch (e) {
            console.error(
                `${LOG_TAG} failed to write fallback export to the recovery archive`,
                e
            );
        }
    }

    async function dumpExportArchive() {
        let archive;

        try {
            archive = (await idbGet(exportArchiveKey(currentDataset))) || [];
        } catch (e) {
            archive = [];
        }

        if (archive.length === 0) return 0;

        const allRows = dedupeBatchKeepLongest(
            archive.flatMap(a => a.rows)
        );

        downloadJson(
            `tweets_${slugifyDataset(currentDataset)}_recovered_archive.json`,
            toJson(allRows)
        );

        return allRows.length;
    }

    let diagRingBuffer = [];
    let lastDiagWriteAt = null;
    let lastDiagWriteError = null;
    let diagIntervalHandle = null;
    let diagEventsWired = false;

    function pushDiagRing(entry) {
        diagRingBuffer.push(entry);

        if (diagRingBuffer.length > 150) {
            diagRingBuffer.shift();
        }
    }

    async function logHeapSnapshot(settings, extra) {
        const s = settings || {};

        const entry = {
            t: Date.now(),
            pendingLen: pendingBatch.length,
            articleCount:
                document.querySelectorAll(
                    'article[data-testid="tweet"]'
                ).length,
            domNodeCount:
                document.getElementsByTagName("*").length,
            heapMB: performance.memory
                ? Math.round(
                    performance.memory.usedJSHeapSize /
                    1048576
                )
                : null,
            visibility: document.visibilityState,
            recentHttpErrors: recentHttpErrorCount(300000),
            recentNetworkFailures: recentNetworkFailureCount(300000),
            note: (extra && extra.note) || null,
            settings: {
                maxScrolls: s.maxScrolls,
                pauseMs: s.pauseMs,
                scrollStrategy: s.scrollStrategy,
                longBreakEnabled: s.longBreakEnabled,
                pauseEveryTweets: s.pauseEveryTweets,
                pauseMinutes: s.pauseMinutes,
                autoRetryEnabled: s.autoRetryEnabled,
                cooldownMinutes: s.cooldownMinutes,
                maxRetries: s.maxRetries,
                autoExportEnabled: s.autoExportEnabled,
                exportEveryN: s.exportEveryN,
                verboseConsoleLogging: s.verboseConsoleLogging
            }
        };

        pushDiagRing(entry);

        try {
            const key = heapLogKey(currentDataset);
            const log = (await idbGet(key)) || [];

            log.push(entry);

            
            if (log.length > 500) {
                log.splice(0, log.length - 500);
            }

            await idbSet(key, log);

            lastDiagWriteAt = Date.now();
            lastDiagWriteError = null;
        } catch (e) {
            lastDiagWriteError = (e && e.message) || String(e);

            console.error(
                `${LOG_TAG} diagnostic write failed`,
                e
            );
        }
    }

    function startDiagInterval(settings) {
        stopDiagInterval();

        
        diagIntervalHandle = setInterval(() => {
            logHeapSnapshot(settings);
        }, 60000);
    }

    function stopDiagInterval() {
        if (diagIntervalHandle) {
            clearInterval(diagIntervalHandle);
            diagIntervalHandle = null;
        }
    }

    function setupDiagnosticEventLogging(getSettings) {
        if (diagEventsWired) return;
        diagEventsWired = true;

        document.addEventListener("visibilitychange", () => {
            logHeapSnapshot(getSettings(), {
                note: `visibility -> ${document.visibilityState}`
            });
        });

        window.addEventListener("pagehide", () => {
            logHeapSnapshot(getSettings(), { note: "pagehide" });
        });

        window.addEventListener("freeze", () => {
            logHeapSnapshot(getSettings(), { note: "freeze" });
        });

        window.addEventListener("resume", () => {
            logHeapSnapshot(getSettings(), { note: "resume" });
        });
    }

    async function dumpDiagnosticsLog() {
        const key = heapLogKey(currentDataset);

        let log;

        try {
            log = (await idbGet(key)) || [];
        } catch (e) {
            log = [];
        }

        downloadJson(
            `tweets_${slugifyDataset(currentDataset)}_diagnostics.json`,
            JSON.stringify(
                {
                    persisted: log,
                    recentRingBuffer: diagRingBuffer,
                    lastDiagWriteAt,
                    lastDiagWriteError,
                    recentHttpErrorLog: httpErrorLog,
                    recentNetworkFailureLog: networkFailureLog
                },
                null,
                2
            )
        );
    }

    function isOnListTimeline() {
        return /^\/i\/lists\/\d+\/?$/.test(
            window.location.pathname
        );
    }

    let collecting = false;
    let stopRequested = false;
    let supervisorRunning = false;
    let recentTweets = [];

    function randInt(min, max) {
        return Math.floor(
            min + Math.random() * (max - min + 1)
        );
    }

    function jitter(base, pct = 0.35) {
        const delta = base * pct;
        const val =
            base +
            (Math.random() * 2 - 1) * delta;

        return Math.max(150, Math.round(val));
    }

    function jitterCount(base, pct = 0.7) {
        const delta = base * pct;
        const val =
            base +
            (Math.random() * 2 - 1) * delta;

        return Math.max(1, Math.round(val));
    }

    function pushRecent(items) {
        if (!items.length) return;

        recentTweets =
            recentTweets.concat(items).slice(-5);
    }

    function computeScrollDelta(
        strategy,
        scrollCount,
        scrollStepPx
    ) {
        if (
            strategy === "dips" &&
            scrollCount > 0 &&
            scrollCount % 7 === 0
        ) {
            return -jitter(
                scrollStepPx * 0.6,
                0.3
            );
        }

        if (
            strategy === "big-jumps" &&
            scrollCount > 0 &&
            scrollCount % 5 === 0
        ) {
            return jitter(
                scrollStepPx * 4,
                0.3
            );
        }

        return jitter(scrollStepPx, 0.4);
    }

    function stopIfBeforeDate(tweets, cutoffDate) {
        if (!cutoffDate) return false;

        return tweets.some(
            t =>
                t.day &&
                t.day < cutoffDate &&
                !t.type.startsWith("repost:")
        );
    }

    let wakeLock = null;
    let wakeLockVisibilityHandler = null;

    async function requestWakeLock(logFn) {
        try {
            if ("wakeLock" in navigator) {
                wakeLock =
                    await navigator.wakeLock.request("screen");

                logFn(
                    "Screen wake lock acquired — this keeps the display (and usually networking) from sleeping while this tab is visible."
                );

                wakeLock.addEventListener(
                    "release",
                    () => {
                        logFn(
                            "Screen wake lock was released (tab backgrounded/minimized, or the OS overrode it) — sleep/throttling is more likely again until you refocus this tab."
                        );
                    }
                );
            } else {
                logFn(
                    "Wake Lock API isn't available in this browser — can't auto-prevent sleep. Keep this tab focused and disable system sleep manually during long runs."
                );
            }
        } catch (e) {
            logFn(
                `Wake lock request failed (${e && e.message ? e.message : e}) — keep this tab focused and disable system sleep manually during long runs.`
            );
        }
    }

    function releaseWakeLock() {
        if (wakeLockVisibilityHandler) {
            document.removeEventListener(
                "visibilitychange",
                wakeLockVisibilityHandler
            );

            wakeLockVisibilityHandler = null;
        }

        if (wakeLock) {
            wakeLock.release().catch(() => {});
            wakeLock = null;
        }
    }

    function setupWakeLockReacquire(logFn) {
        wakeLockVisibilityHandler = () => {
            if (
                document.visibilityState === "visible" &&
                collecting &&
                !wakeLock
            ) {
                requestWakeLock(logFn);
            }
        };

        document.addEventListener(
            "visibilitychange",
            wakeLockVisibilityHandler
        );
    }

    const SOFT_RATE_CAP_PER_MIN = 30;
    const MAX_COOLDOWN_MS = 20 * 60 * 1000;

    async function runCollectionLoop({
        account,
        maxScrolls,
        scrollStepPx,
        pauseMs,
        stopBeforeDate,
        onProgress,
        scrollStrategy = "steady-down",
        autoRetryEnabled = false,
        cooldownMs = 3 * 60 * 1000,
        maxRetries = 2,
        stopOnSeenTweets = true,
        pauseEveryTweets = 0,
        pauseMinutes = 5,
        autoExportEnabled = true,
        exportEveryN = 1000,
        diagnosticSettings = {}
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

        const sessionAccounts = new Set();

        let tweetsSinceBreak = 0;

        let nextBreakThreshold =
            pauseEveryTweets > 0
                ? jitterCount(pauseEveryTweets, 0.7)
                : Infinity;

        let plannedBreaksTaken = 0;
        let exportPartNum = 1;
        let exportsWritten = 0;

        let exportActive =
            autoExportEnabled && !!exportDirHandle;

        const wakeLogFn = msg =>
            console.log(`${LOG_TAG} ${msg}`);

        await requestWakeLock(wakeLogFn);
        setupWakeLockReacquire(wakeLogFn);
        patchNetworkForDiagnostics();
        startDiagInterval(diagnosticSettings);

        function totalStoredForSessionAccounts() {
            let total = 0;

            for (const a of sessionAccounts) {
                total += seenIds[a]
                    ? seenIds[a].size
                    : 0;
            }

            return total;
        }

        async function flushExportBatch(reason) {
            if (pendingBatch.length === 0) return;
            if (!autoExportEnabled) return;

            const toWrite =
                dedupeBatchKeepLongest(pendingBatch);

            exportActive =
                !!exportDirHandle &&
                (await exportDirPermissionGranted());

            if (exportDirHandle && !exportActive) {
                
                await logHeapSnapshot(diagnosticSettings, {
                    note: "export folder permission not currently granted — using direct-download fallback for this batch"
                });
            }

            if (exportActive) {
                const filename =
                    `tweets_${slugifyDataset(currentDataset)}_part${String(exportPartNum).padStart(4, "0")}_${Date.now()}.json`;

                const wrote =
                    await writeJsonToExportDir(
                        filename,
                        toWrite
                    );

                if (wrote) {
                    exportsWritten++;
                    exportPartNum++;

                    const writtenCount =
                        pendingBatch.length;

                    pendingBatch = [];

                    await checkpointPendingBatch();
                    await checkpointSeenIndex();

                    onProgress({
                        scrollCount,
                        maxScrolls,
                        sessionAdded,
                        sessionUpdated,
                        totalForAccount:
                            totalStoredForSessionAccounts(),
                        accountsThisSession:
                            sessionAccounts.size,
                        recentTweets,
                        retriesUsed,
                        netStats:
                            timelineRequestStats(),
                        diagStatus: {
                            lastDiagWriteAt,
                            lastDiagWriteError
                        },
                        cooldownMessage:
                            `Auto-exported ${writtenCount} tweets to ${filename} (${reason}); wiped from browser storage.`
                    });

                    return;
                }

                exportActive = false;

                console.warn(
                    `${LOG_TAG} export folder write failed despite granted permission — falling back to a direct download for this batch.`
                );
            }

            const filename =
                `tweets_${slugifyDataset(currentDataset)}_fallback_${Date.now()}.json`;

            downloadJson(
                filename,
                toJson(toWrite)
            );

            await archiveFallbackExport(filename, toWrite);

            const writtenCount =
                pendingBatch.length;

            pendingBatch = [];

            await checkpointPendingBatch();
            await checkpointSeenIndex();

            onProgress({
                scrollCount,
                maxScrolls,
                sessionAdded,
                sessionUpdated,
                totalForAccount:
                    totalStoredForSessionAccounts(),
                accountsThisSession:
                    sessionAccounts.size,
                recentTweets,
                retriesUsed,
                netStats:
                    timelineRequestStats(),
                diagStatus: {
                    lastDiagWriteAt,
                    lastDiagWriteError
                },
                cooldownMessage:
                    `Direct-download fallback used for ${writtenCount} tweets (${filename}, reason: ${reason}) — also archived in browser storage as a safety net in case the download itself gets silently blocked; use "Recover export archive" if files don't show up.`
            });
        }

        while (
            scrollCount < maxScrolls &&
            !stopRequested
        ) {
            if (!isOnListTimeline()) {
                stopReason = "navigated_away";

                await logHeapSnapshot(diagnosticSettings, {
                    note: "navigated away from list mid-run"
                });

                break;
            }

            const articles = Array.from(
                document.querySelectorAll(
                    'article[data-testid="tweet"]'
                )
            );

            await expandShowMoreButtons(articles);

            const found =
                extractVisibleTweets(account);

            const hitCutoff =
                stopIfBeforeDate(
                    found,
                    stopBeforeDate
                );

            const inRange = stopBeforeDate
                ? found.filter(
                    t =>
                        t.type.startsWith("repost:") ||
                        !t.day ||
                        t.day >= stopBeforeDate
                )
                : found;

            const {
                added,
                updated,
                addedItems,
                updatedItems
            } = addTweetsToStore(inRange);

            sessionAdded += added;
            sessionUpdated += updated;
            tweetsSinceBreak += added;

            pushRecent(
                addedItems.concat(updatedItems)
            );

            for (const item of addedItems) {
                sessionAccounts.add(item.account);
            }

            for (const item of updatedItems) {
                sessionAccounts.add(item.account);
            }

            for (const t of inRange) {
                sessionAccounts.add(t.account);
            }

            if (
                autoExportEnabled &&
                (addedItems.length || updatedItems.length)
            ) {
                await checkpointPendingBatch();
            }

            if (added === 0 && updated === 0) {
                consecutiveNoNewTweets++;
            } else {
                consecutiveNoNewTweets = 0;
            }

            const suspectRateLimitNow =
                looksRateLimited();

            const totalForAccount =
                totalStoredForSessionAccounts();

            const netStats =
                timelineRequestStats();

            onProgress({
                scrollCount,
                maxScrolls,
                sessionAdded,
                sessionUpdated,
                totalForAccount,
                accountsThisSession:
                    sessionAccounts.size,
                recentTweets,
                hitCutoff,
                retriesUsed,
                netStats,
                diagStatus: {
                    lastDiagWriteAt,
                    lastDiagWriteError
                }
            });

            if (hitCutoff) {
                stopReason = "date_cutoff";
                break;
            }

            if (
                autoExportEnabled &&
                pendingBatch.length >= exportEveryN
            ) {
                await flushExportBatch(
                    "threshold reached"
                );
            }

            if (
                pauseEveryTweets > 0 &&
                tweetsSinceBreak >= nextBreakThreshold
            ) {
                plannedBreaksTaken++;
                tweetsSinceBreak = 0;

                const thisBreakThreshold =
                    nextBreakThreshold;

                nextBreakThreshold =
                    jitterCount(
                        pauseEveryTweets,
                        0.7
                    );

                onProgress({
                    scrollCount,
                    maxScrolls,
                    sessionAdded,
                    sessionUpdated,
                    totalForAccount,
                    accountsThisSession:
                        sessionAccounts.size,
                    recentTweets,
                    retriesUsed,
                    netStats,
                    diagStatus: {
                        lastDiagWriteAt,
                        lastDiagWriteError
                    },
                    cooldownMessage:
                        `Scheduled break #${plannedBreaksTaken}: pausing ${pauseMinutes} min after ~${thisBreakThreshold} tweets.`
                });

                console.log(
                    `${LOG_TAG} scheduled break #${plannedBreaksTaken} — pausing ${pauseMinutes} min (hit ${thisBreakThreshold}-tweet threshold)`
                );

                await sleep(
                    jitter(
                        pauseMinutes * 60 * 1000
                    )
                );
            }

            if (suspectRateLimitNow) {
                const retryBtn = findVisibleRetryButton();

                if (retryBtn) {
                    await logHeapSnapshot(diagnosticSettings, {
                        note: "clicked X's own \"Retry\" button on a \"Something went wrong\" tombstone"
                    });

                    retryBtn.click();
                    await sleep(jitter(2500, 0.3));

                    continue;
                }

                if (
                    autoRetryEnabled &&
                    retriesUsed < maxRetries
                ) {
                    retriesUsed++;

                    const backoffMultiplier =
                        Math.pow(1.7, retriesUsed - 1);

                    const thisCooldown =
                        Math.min(
                            jitter(
                                cooldownMs * backoffMultiplier,
                                0.25
                            ),
                            MAX_COOLDOWN_MS
                        );

                    onProgress({
                        scrollCount,
                        maxScrolls,
                        sessionAdded,
                        sessionUpdated,
                        totalForAccount,
                        accountsThisSession:
                            sessionAccounts.size,
                        recentTweets,
                        retriesUsed,
                        netStats,
                        diagStatus: {
                            lastDiagWriteAt,
                            lastDiagWriteError
                        },
                        cooldownMessage:
                            `Page (or the network layer) shows a rate-limit/error signal. Cooling down ~${Math.round(thisCooldown / 60000)} min before retry ${retriesUsed}/${maxRetries}...`
                    });

                    await logHeapSnapshot(diagnosticSettings, {
                        note: `rate-limit signal, retry ${retriesUsed}/${maxRetries}`
                    });

                    const cooldownStartedAt = Date.now();
                    const cooldownStartedHidden =
                        document.visibilityState !== "visible";

                    await sleep(thisCooldown);

                    const actualCooldownMs =
                        Date.now() - cooldownStartedAt;

                    if (actualCooldownMs > thisCooldown * 1.5) {
                        await logHeapSnapshot(diagnosticSettings, {
                            note:
                                `cooldown took ${Math.round(actualCooldownMs / 1000)}s vs ` +
                                `configured ${Math.round(thisCooldown / 1000)}s (tab hidden at start: ${cooldownStartedHidden}) — ` +
                                `likely background-tab timer throttling stretching the wait, not a persistent rate-limit condition`
                        });
                    }

                    window.scrollBy(0, -jitter(400, 0.3));
                    await sleep(400);

                    window.scrollBy(0, jitter(1300, 0.4));
                    await sleep(jitter(pauseMs));

                    continue;
                }

                stopReason = "likely_rate_limited";
                break;
            }

            const stallThreshold =
                stopOnSeenTweets
                    ? 8
                    : Infinity;

            if (
                consecutiveNoNewTweets >=
                stallThreshold
            ) {
                if (
                    autoRetryEnabled &&
                    retriesUsed < maxRetries
                ) {
                    retriesUsed++;

                    const backoffMultiplier =
                        Math.pow(1.7, retriesUsed - 1);

                    const thisCooldown =
                        Math.min(
                            jitter(
                                cooldownMs * backoffMultiplier,
                                0.25
                            ),
                            MAX_COOLDOWN_MS
                        );

                    onProgress({
                        scrollCount,
                        maxScrolls,
                        sessionAdded,
                        sessionUpdated,
                        totalForAccount,
                        accountsThisSession:
                            sessionAccounts.size,
                        recentTweets,
                        retriesUsed,
                        netStats,
                        diagStatus: {
                            lastDiagWriteAt,
                            lastDiagWriteError
                        },
                        cooldownMessage:
                            `No new tweets loading. Cooling down ~${Math.round(thisCooldown / 60000)} min before retry ${retriesUsed}/${maxRetries}...`
                    });

                    const cooldownStartedAt = Date.now();
                    const cooldownStartedHidden =
                        document.visibilityState !== "visible";

                    await sleep(thisCooldown);

                    const actualCooldownMs =
                        Date.now() - cooldownStartedAt;

                    if (actualCooldownMs > thisCooldown * 1.5) {
                        await logHeapSnapshot(diagnosticSettings, {
                            note:
                                `cooldown took ${Math.round(actualCooldownMs / 1000)}s vs ` +
                                `configured ${Math.round(thisCooldown / 1000)}s (tab hidden at start: ${cooldownStartedHidden}) — ` +
                                `likely background-tab timer throttling stretching the wait, not a persistent stall`
                        });
                    }

                    window.scrollBy(0, -jitter(400, 0.3));
                    await sleep(400);

                    window.scrollBy(0, jitter(1300, 0.4));
                    await sleep(jitter(pauseMs));

                    consecutiveNoNewTweets = 0;

                    continue;
                }

                stopReason = "no_new_tweets";
                break;
            }

            if (netStats.ratePerMin > SOFT_RATE_CAP_PER_MIN) {
                await sleep(jitter(4000, 0.4));
            }

            const step =
                computeScrollDelta(
                    scrollStrategy,
                    scrollCount,
                    scrollStepPx
                );

            window.scrollBy(0, step);
            scrollCount++;

            let pause = jitter(pauseMs);

            stepsUntilLongPause--;

            if (stepsUntilLongPause <= 0) {
                pause += jitter(2200, 0.5);
                stepsUntilLongPause =
                    randInt(8, 14);
            }

            await sleep(pause);
        }

        if (stopRequested) {
            stopReason = "user_stopped";
        }

        await flushExportBatch("end of run");

        stopDiagInterval();

        collecting = false;
        releaseWakeLock();

        return {
            sessionAdded,
            sessionUpdated,
            scrollCount,
            stopReason,
            retriesUsed,
            finalNetStats:
                timelineRequestStats(),
            accountsThisSession:
                sessionAccounts.size,
            plannedBreaksTaken,
            exportsWritten,
            exportActive
        };
    }

    function stopCollection() {
        stopRequested = true;
    }

    function injectStyles() {
        const style =
            document.createElement("style");

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
      #tc-panel .tc-tip { margin-top: 4px; font-size: 11px; color: #536471; }
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
        const panel =
            document.createElement("div");

        panel.id = "tc-panel";

        panel.innerHTML = `
      <h3>Tweet Collector (Lists only)</h3>
      <div class="tc-row">
        <label>Saved list name <input type="text" id="tc-dataset" value="${escapeHtml(currentDataset)}" placeholder="e.g. politicians-list"></label>
        <button id="tc-dataset-switch" class="secondary">Switch</button>
      </div>
      <div class="tc-row">
        <label>Existing saved lists
          <select id="tc-dataset-list"><option value="">(loading...)</option></select>
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
        <label><input type="checkbox" id="tc-stop-on-seen" style="width:auto;"> Stop once scrolling only turns up already-seen tweets</label>
      </div>
      <div class="tc-row">
        <label><input type="checkbox" id="tc-longbreak" style="width:auto;"> Take a break every
          <input type="number" id="tc-longbreak-count" value="40" min="1" max="5000" style="width:65px;">
          tweets, for
          <input type="number" id="tc-longbreak-minutes" value="5" min="1" max="180" style="width:50px;">
          min
        </label>
      </div>
      <div class="tc-tip">Tip: if you're running this on more than one machine on the same network at once, use a longer Pause (ms) and a shorter "every N tweets" break interval — it eases how correlated the two look to rate-limit heuristics.</div>
      <div class="tc-row">
        <label>When paused (rate limit, stall, batch boundary), auto-resume after ~
          <input type="number" id="tc-resume-minutes" value="6" min="1" max="120" style="width:55px;">
          min (jittered) — runs unattended until you click Stop or the date cutoff is reached
        </label>
      </div>
      <div class="tc-row">
        <label><input type="checkbox" id="tc-autoretry" style="width:auto;"> Auto cooldown + retry on stall</label>
        <label>Cooldown (min) <input type="number" id="tc-cooldown" value="3" min="1" max="30"></label>
        <label>Max retries <input type="number" id="tc-maxretries" value="2" min="0" max="20"></label>
      </div>
      <h4>Auto-export to disk (also frees browser memory)</h4>
      <div class="tc-row">
        <button id="tc-choose-export-dir" class="secondary">Choose export folder</button>
        <span id="tc-export-dir-label">No folder chosen (auto-export off until you pick one)</span>
      </div>
      <div class="tc-row">
        <button id="tc-regrant-dir" class="secondary">Re-grant folder access</button>
        <button id="tc-recover-archive" class="secondary">Recover export archive</button>
      </div>
      <div class="tc-row">
        <label><input type="checkbox" id="tc-autoexport-enabled" checked style="width:auto;"> Auto-export every
          <input type="number" id="tc-autoexport-every" value="1000" min="10" max="50000" style="width:70px;">
          tweets, then wipe from browser storage
        </label>
      </div>
      <h4>Diagnostics</h4>
      <div class="tc-row">
        <label><input type="checkbox" id="tc-verbose-logging" style="width:auto;"> Verbose console logging (GraphQL calls, timeline requests)</label>
      </div>
      <div class="tc-row">
        <button id="tc-dump-diagnostics" class="secondary">Dump diagnostics (heap/DOM log)</button>
      </div>
      <div class="tc-row">
        <button id="tc-start">Start collecting</button>
        <button id="tc-stop" class="secondary" disabled>Stop</button>
      </div>
      <div class="tc-status" id="tc-status">Idle. Navigate to a List's Tweets tab, then press Start.</div>
      <div class="tc-status" id="tc-netstats"></div>
      <div class="tc-status" id="tc-diagstatus"></div>
      <h4>Sanity check — last 5 scraped</h4>
      <div id="tc-preview"><div class="tc-empty">Nothing scraped yet.</div></div>
      <div class="tc-row">
        <button id="tc-export-all-json" class="secondary">Export pending (JSON)</button>
      </div>
      <div class="tc-row">
        <button id="tc-wipe" class="danger">Wipe saved list (browser only)</button>
      </div>
      <div class="tc-status" id="tc-storesummary"></div>
    `;

        document.body.appendChild(panel);

        return panel;
    }

    function refreshStoreSummary() {
        const el =
            document.getElementById(
                "tc-storesummary"
            );

        const handles = Object.keys(seenIds);

        if (handles.length === 0) {
            el.textContent =
                "No accounts tracked yet.";
            return;
        }

        const pendingCounts = {};

        for (const r of pendingBatch) {
            pendingCounts[r.account] =
                (pendingCounts[r.account] || 0) + 1;
        }

        el.textContent = handles
            .map(
                h =>
                    `@${h}: ${seenIds[h].size} seen (${pendingCounts[h] || 0} pending export)`
            )
            .join("  ·  ");
    }

    function updateDiagStatusUI() {
        const el =
            document.getElementById("tc-diagstatus");

        if (!el) return;

        if (lastDiagWriteError) {
            el.textContent =
                `Diagnostics: last write FAILED (${lastDiagWriteError}).`;
        } else if (lastDiagWriteAt) {
            el.textContent =
                `Diagnostics: last saved ${Math.round((Date.now() - lastDiagWriteAt) / 1000)}s ago.`;
        } else {
            el.textContent =
                "Diagnostics: no snapshot saved yet.";
        }
    }

    async function refreshDatasetList() {
        const sel =
            document.getElementById(
                "tc-dataset-list"
            );

        if (!sel) return;

        let names;

        try {
            names = await listDatasetNames();
        } catch (e) {
            console.error(
                `${LOG_TAG} failed to list datasets`,
                e
            );

            sel.innerHTML =
                '<option value="">(couldn\'t load list)</option>';

            return;
        }

        if (names.length === 0) {
            sel.innerHTML =
                '<option value="">(none saved yet)</option>';

            return;
        }

        sel.innerHTML = names
            .map(
                n =>
                    `<option value="${escapeHtml(n)}"${n === currentDataset ? " selected" : ""}>${escapeHtml(n)}</option>`
            )
            .join("");
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    function renderPreview(items) {
        const el =
            document.getElementById(
                "tc-preview"
            );

        if (!items || items.length === 0) {
            el.innerHTML =
                '<div class="tc-empty">Nothing scraped yet.</div>';

            return;
        }

        const ordered =
            items.slice().reverse();

        el.innerHTML = ordered
            .map(t => {
                const snippet =
                    t.text.length > 140
                        ? t.text.slice(0, 140) + "…"
                        : t.text;

                return `<div class="tc-tweet">
        <div class="tc-meta">${escapeHtml(t.day || "?")} · @${escapeHtml(t.account)} · ${escapeHtml(t.type)}</div>
        <div>${escapeHtml(snippet)}</div>
      </div>`;
            })
            .join("");
    }

    function readSettingsFromUI() {
        return {
            maxScrolls:
                parseInt(
                    document.getElementById(
                        "tc-maxscrolls"
                    ).value,
                    10
                ) || 200,

            pauseMs:
                parseInt(
                    document.getElementById(
                        "tc-pause"
                    ).value,
                    10
                ) || 1100,

            stopDateEnabled:
                document.getElementById(
                    "tc-stopdate-enabled"
                ).checked,

            stopBeforeDate:
                document.getElementById(
                    "tc-stopdate"
                ).value || null,

            scrollStrategy:
                document.getElementById(
                    "tc-strategy"
                ).value,

            autoRetryEnabled:
                document.getElementById(
                    "tc-autoretry"
                ).checked,

            cooldownMinutes:
                parseInt(
                    document.getElementById(
                        "tc-cooldown"
                    ).value,
                    10
                ) || 3,

            maxRetries:
                parseInt(
                    document.getElementById(
                        "tc-maxretries"
                    ).value,
                    10
                ) || 0,

            stopOnSeenTweets:
                document.getElementById(
                    "tc-stop-on-seen"
                ).checked,

            longBreakEnabled:
                document.getElementById(
                    "tc-longbreak"
                ).checked,

            pauseEveryTweets:
                parseInt(
                    document.getElementById(
                        "tc-longbreak-count"
                    ).value,
                    10
                ) || 40,

            pauseMinutes:
                parseInt(
                    document.getElementById(
                        "tc-longbreak-minutes"
                    ).value,
                    10
                ) || 5,

            autoExportEnabled:
                document.getElementById(
                    "tc-autoexport-enabled"
                ).checked,

            exportEveryN:
                parseInt(
                    document.getElementById(
                        "tc-autoexport-every"
                    ).value,
                    10
                ) || 1000,

            verboseConsoleLogging:
                document.getElementById(
                    "tc-verbose-logging"
                ).checked,

            resumeAfterMinutes:
                parseInt(
                    document.getElementById(
                        "tc-resume-minutes"
                    ).value,
                    10
                ) || 6
        };
    }

    function applySettingsToUI(settings) {
        if (!settings) return;

        document.getElementById(
            "tc-maxscrolls"
        ).value = settings.maxScrolls;

        document.getElementById(
            "tc-pause"
        ).value = settings.pauseMs;

        document.getElementById(
            "tc-stopdate-enabled"
        ).checked = !!settings.stopDateEnabled;

        if (settings.stopBeforeDate) {
            document.getElementById(
                "tc-stopdate"
            ).value = settings.stopBeforeDate;
        }

        document.getElementById(
            "tc-strategy"
        ).value = settings.scrollStrategy;

        document.getElementById(
            "tc-autoretry"
        ).checked = !!settings.autoRetryEnabled;

        document.getElementById(
            "tc-cooldown"
        ).value = settings.cooldownMinutes;

        document.getElementById(
            "tc-maxretries"
        ).value = settings.maxRetries;

        document.getElementById(
            "tc-stop-on-seen"
        ).checked = !!settings.stopOnSeenTweets;

        document.getElementById(
            "tc-longbreak"
        ).checked = !!settings.longBreakEnabled;

        document.getElementById(
            "tc-longbreak-count"
        ).value = settings.pauseEveryTweets;

        document.getElementById(
            "tc-longbreak-minutes"
        ).value = settings.pauseMinutes;

        document.getElementById(
            "tc-autoexport-enabled"
        ).checked = !!settings.autoExportEnabled;

        document.getElementById(
            "tc-autoexport-every"
        ).value = settings.exportEveryN;

        if (settings.resumeAfterMinutes) {
            document.getElementById(
                "tc-resume-minutes"
            ).value = settings.resumeAfterMinutes;
        }
    }

    function initUI() {
        injectStyles();
        buildPanel();
        refreshStoreSummary();
        renderPreview(recentTweets);
        updateDiagStatusUI();

        setInterval(updateDiagStatusUI, 5000);

        setupDiagnosticEventLogging(readSettingsFromUI);

        const startBtn =
            document.getElementById(
                "tc-start"
            );

        const stopBtn =
            document.getElementById(
                "tc-stop"
            );

        const statusEl =
            document.getElementById(
                "tc-status"
            );

        document
            .getElementById(
                "tc-choose-export-dir"
            )
            .addEventListener(
                "click",
                async () => {
                    if (!window.showDirectoryPicker) {
                        statusEl.textContent =
                            "This browser doesn't support the folder-picker API (Chrome/Edge only) — use the manual Export button below instead.";

                        return;
                    }

                    try {
                        exportDirHandle =
                            await window.showDirectoryPicker();

                        document.getElementById(
                            "tc-export-dir-label"
                        ).textContent =
                            `Exporting to: ${exportDirHandle.name}/`;
                    } catch (e) {}
                }
            );

        document
            .getElementById("tc-regrant-dir")
            .addEventListener("click", async () => {
                if (!exportDirHandle) {
                    statusEl.textContent =
                        'No export folder has been chosen yet — click "Choose export folder" first.';

                    return;
                }

                try {
                    const result =
                        await exportDirHandle.requestPermission({
                            mode: "readwrite"
                        });

                    statusEl.textContent =
                        result === "granted"
                            ? "Export folder access re-granted — auto-export to disk will resume on the next flush."
                            : `Permission request returned "${result}" — auto-export to disk stays off until this is granted.`;
                } catch (e) {
                    statusEl.textContent = `Re-grant attempt failed: ${e && e.message ? e.message : e}`;
                }
            });

        document
            .getElementById("tc-recover-archive")
            .addEventListener("click", async () => {
                const count = await dumpExportArchive();

                statusEl.textContent =
                    count > 0
                        ? `Recovered ${count} tweet(s) from the fallback-export safety net and downloaded them.`
                        : "Nothing in the recovery archive for this saved list.";
            });

        document
            .getElementById(
                "tc-verbose-logging"
            )
            .addEventListener(
                "change",
                e => {
                    verboseNetworkLogging =
                        e.target.checked;
                }
            );

        document
            .getElementById(
                "tc-dump-diagnostics"
            )
            .addEventListener(
                "click",
                async () => {
                    await dumpDiagnosticsLog();

                    statusEl.textContent =
                        "Diagnostics log downloaded (heap size, DOM node count, article count, pending-batch size, visibility/backgrounding events, and recent HTTP error statuses).";
                }
            );

        function describeStopReason(reason, stopBeforeDate) {
            return (
                {
                    date_cutoff:
                        `reached tweets older than ${stopBeforeDate} and stopped there`,

                    no_new_tweets:
                        "hit a stretch of already-collected content (likely end of available/loaded history)",

                    likely_rate_limited:
                        "page or network layer showed something that looks like a rate-limit/error signal",

                    navigated_away:
                        "the page isn't on a list timeline right now",

                    max_scrolls:
                        "reached this batch's scroll limit (not a problem — just a checkpoint)",

                    user_stopped:
                        "stopped by you"
                }[reason] || reason
            );
        }

        
        const IMMEDIATE_RESUME_REASONS = new Set(["max_scrolls"]);
        const TERMINAL_REASONS = new Set(["user_stopped", "date_cutoff"]);

        function cancelableSleep(ms) {
            return new Promise(resolve => {
                const start = Date.now();

                (function check() {
                    if (
                        !supervisorRunning ||
                        Date.now() - start >= ms
                    ) {
                        resolve();
                    } else {
                        setTimeout(check, 500);
                    }
                })();
            });
        }

        async function runOneCycle(s, stopBeforeDate, cooldownMs, pauseEveryTweets) {
            return runCollectionLoop({
                account: UNKNOWN_AUTHOR_TAG,
                maxScrolls: s.maxScrolls,
                scrollStepPx: 600,
                pauseMs: s.pauseMs,
                stopBeforeDate,
                scrollStrategy: s.scrollStrategy,
                autoRetryEnabled: s.autoRetryEnabled,
                cooldownMs,
                maxRetries: s.maxRetries,
                stopOnSeenTweets: s.stopOnSeenTweets,
                pauseEveryTweets,
                pauseMinutes: s.pauseMinutes,
                autoExportEnabled: s.autoExportEnabled,
                exportEveryN: s.exportEveryN,
                diagnosticSettings: s,

                onProgress: p => {
                    const acctNote =
                        p.accountsThisSession > 1
                            ? ` across ${p.accountsThisSession} accounts`
                            : "";

                    statusEl.textContent =
                        p.cooldownMessage ||
                        (
                            `scroll ${p.scrollCount}/${p.maxScrolls} — ` +
                            `+${p.sessionAdded} new, ${p.totalForAccount} total seen this session${acctNote}, ${pendingBatch.length} pending export.` +
                            (
                                p.retriesUsed
                                    ? ` (retry ${p.retriesUsed}/${s.maxRetries} used)`
                                    : ""
                            )
                        );

                    renderPreview(p.recentTweets);
                    refreshStoreSummary();
                    updateDiagStatusUI();

                    if (p.netStats) {
                        const el =
                            document.getElementById("tc-netstats");

                        el.textContent =
                            `Timeline requests seen this session: ${p.netStats.total}` +
                            (
                                p.netStats.lastAgoSec !== null
                                    ? ` (last one ${p.netStats.lastAgoSec}s ago, ${p.netStats.ratePerMin}/min)`
                                    : ""
                            );
                    }
                }
            });
        }

        async function runSupervisorLoop(s, stopBeforeDate, cooldownMs, pauseEveryTweets) {
            let totalsAdded = 0;
            let cycles = 0;

            while (supervisorRunning) {
                if (!isOnListTimeline()) {
                    statusEl.textContent =
                        "Not on a list timeline right now — waiting, will keep checking...";

                    await cancelableSleep(jitter(30000, 0.3));
                    continue;
                }

                cycles++;

                const result =
                    await runOneCycle(
                        s,
                        stopBeforeDate,
                        cooldownMs,
                        pauseEveryTweets
                    );

                totalsAdded += result.sessionAdded;

                if (!supervisorRunning) break;

                if (TERMINAL_REASONS.has(result.stopReason)) {
                    const acctNote =
                        result.accountsThisSession > 1
                            ? ` across ${result.accountsThisSession} accounts`
                            : "";

                    statusEl.textContent =
                        `Done. Added ${totalsAdded} new tweets total${acctNote} over ${cycles} cycle(s). ` +
                        `Stopped because: ${describeStopReason(result.stopReason, stopBeforeDate)}. ` +
                        `Total timeline requests observed: ${result.finalNetStats.total}.`;

                    supervisorRunning = false;
                    break;
                }

                const waitMs =
                    IMMEDIATE_RESUME_REASONS.has(result.stopReason)
                        ? jitter(8000, 0.5)
                        : jitter(s.resumeAfterMinutes * 60000, 0.45);

                statusEl.textContent =
                    `Paused (${describeStopReason(result.stopReason, stopBeforeDate)}). ` +
                    `+${totalsAdded} new so far over ${cycles} cycle(s). ` +
                    `Auto-resuming in ~${Math.round(waitMs / 60000) || 1} min...`;

                await cancelableSleep(waitMs);
            }

            refreshStoreSummary();

            startBtn.disabled = false;
            stopBtn.disabled = true;
        }

        async function startCollecting() {
            if (collecting || supervisorRunning) {
                statusEl.textContent =
                    "A collection run is already in progress — stop it before starting a new one.";

                return;
            }

            if (!isOnListTimeline()) {
                statusEl.textContent =
                    "This tool only runs on a List's Tweets tab (a URL like x.com/i/lists/12345). Navigate there and press Start again.";

                return;
            }

            const s = readSettingsFromUI();

            const stopBeforeDate =
                s.stopDateEnabled
                    ? s.stopBeforeDate
                    : null;

            const cooldownMs =
                s.cooldownMinutes *
                60 *
                1000;

            const pauseEveryTweets =
                s.longBreakEnabled
                    ? s.pauseEveryTweets
                    : 0;

            if (
                s.autoExportEnabled &&
                !exportDirHandle
            ) {
                statusEl.textContent =
                    'Auto-export is checked but no folder is chosen yet — click "Choose export folder" first, or uncheck auto-export.';

                return;
            }

            if (!s.autoExportEnabled) {
                statusEl.textContent =
                    "Heads up: auto-export is off, so nothing is saved durably during this run — only in memory until you stop and manually export. Recommended for short test runs only.";
            }

            
            if (s.autoExportEnabled && exportDirHandle) {
                statusEl.textContent =
                    "Checking export folder permission...";

                const ok = await ensureExportPermissionAtStart();

                if (!ok) {
                    statusEl.textContent =
                        'Export folder permission was not granted. Click "Re-grant folder access" and try Start again, or uncheck auto-export.';

                    return;
                }
            }

            supervisorRunning = true;
            startBtn.disabled = true;
            stopBtn.disabled = false;

            statusEl.textContent =
                `Collecting this list... (scroll 0/${s.maxScrolls})`;

            runSupervisorLoop(
                s,
                stopBeforeDate,
                cooldownMs,
                pauseEveryTweets
            );
        }

        startBtn.addEventListener(
            "click",
            startCollecting
        );

        stopBtn.addEventListener(
            "click",
            () => {
                supervisorRunning = false;
                stopCollection();

                statusEl.textContent =
                    "Stopping after current step (won't auto-resume)...";

                stopBtn.disabled = true;
            }
        );

        document
            .getElementById(
                "tc-export-all-json"
            )
            .addEventListener(
                "click",
                () => {
                    const rows =
                        pendingRowsAll();

                    if (rows.length === 0) {
                        statusEl.textContent =
                            "Nothing pending right now.";

                        return;
                    }

                    downloadJson(
                        "tweets_pending_all_accounts.json",
                        toJson(rows)
                    );
                }
            );

        document
            .getElementById("tc-wipe")
            .addEventListener(
                "click",
                async () => {
                    if (
                        confirm(
                            "Clear this saved list's dedup index and pending (not-yet-exported) batch from the browser? Files already written to your export folder are not affected. This cannot be undone."
                        )
                    ) {
                        await wipeCurrentDataset();

                        seenIds = {};
                        pendingBatch = [];
                        recentTweets = [];

                        refreshStoreSummary();
                        renderPreview(recentTweets);

                        statusEl.textContent =
                            "Saved list wiped from browser storage.";
                    }
                }
            );

        document
            .getElementById(
                "tc-dataset-switch"
            )
            .addEventListener(
                "click",
                async () => {
                    if (collecting) {
                        statusEl.textContent =
                            "Stop the current run before switching saved lists.";

                        return;
                    }

                    const datasetInput =
                        document.getElementById(
                            "tc-dataset"
                        );

                    const requested =
                        datasetInput.value.trim() ||
                        "default";

                    statusEl.textContent =
                        `Switching to saved list "${requested}"...`;

                    currentDataset = requested;
                    saveLastDatasetName(currentDataset);

                    await loadDatasetState(
                        currentDataset
                    );

                    datasetInput.value =
                        slugifyDataset(
                            requested
                        );

                    recentTweets = [];

                    renderPreview(
                        recentTweets
                    );

                    refreshStoreSummary();
                    updateDiagStatusUI();
                    await refreshDatasetList();

                    statusEl.textContent =
                        `Now using saved list "${currentDataset}" (${Object.keys(seenIds).length} account(s) tracked, ${pendingBatch.length} pending export).`;
                }
            );

        document
            .getElementById(
                "tc-dataset-list"
            )
            .addEventListener(
                "change",
                e => {
                    if (e.target.value) {
                        document.getElementById(
                            "tc-dataset"
                        ).value =
                            e.target.value;
                    }
                }
            );
    }

    (async () => {
        if (
            document.getElementById(
                "tc-panel"
            )
        ) {
            return;
        }

        patchNetworkForDiagnostics();

        await loadDatasetState(
            currentDataset
        );

        initUI();
        refreshDatasetList();
    })();
})();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const app = express();

app.use(cors());
app.use(express.json());

const OFFLINE_THRESHOLD_MS = 2 * 60 * 1000;
const PLAYERLIST_CACHE_TTL_MS = 60 * 1000;
const PERSIST_PATH = path.join(__dirname, "data", "persist.json");

const players = {};
const modUsers = new Set();
const rankCache = {};

let mstPlayerList = [];
let mstPlayerListUpdatedAt = 0;
let mstPlayerListUpdatedBy = null;

function ensureDataDir() {
    const dir = path.join(__dirname, "data");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadPersist() {
    ensureDataDir();
    if (!fs.existsSync(PERSIST_PATH)) return;
    try {
        const raw = fs.readFileSync(PERSIST_PATH, "utf8");
        const data = JSON.parse(raw);
        if (data.players) Object.assign(players, data.players);
        if (data.modUsers) data.modUsers.forEach(u => modUsers.add(u));
        if (data.rankCache) Object.assign(rankCache, data.rankCache);
    } catch (e) {
        console.error("[persist] Failed to load:", e.message);
    }
}

function savePersist() {
    ensureDataDir();
    try {
        const data = {
            players,
            modUsers: [...modUsers],
            rankCache,
        };
        fs.writeFileSync(PERSIST_PATH, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
        console.error("[persist] Failed to save:", e.message);
    }
}

setInterval(savePersist, 30_000);
process.on("SIGTERM", () => { savePersist(); process.exit(0); });
process.on("SIGINT",  () => { savePersist(); process.exit(0); });

function stripCodes(s) {
    return String(s || "").replace(/§./g, "").trim();
}

function stripWeirdChars(str) {
    return String(str || "")
        .normalize("NFKD")
        .replace(/[^\p{L}\p{N}\[\]\s_§+\-]/gu, "")
        .trim();
}

function normalizeRank(rank) {
    return stripCodes(rank)
        .replace(/[\[\]]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
}

function rankWeight(mstRank) {
    if (!mstRank) return 0;
    const code = extractFirstColorCode(mstRank);
    const name = normalizeRank(mstRank);

    if (name === "owner")                         return 10000;
    if (name === "manager")                       return 9000;
    if (name === "admn" || name === "admin")      return 8000;
    if (name === "dev"  || name === "developer")  return 7000;
    if (name === "mod"  || name === "moderator")  return 6000;
    if (name === "build" || name === "builder")   return 5000;

    if (name === "t5") {
        if (code === "4") return 450;
        if (code === "6") return 440;
        if (code === "7") return 430;
        return 440;
    }
    if (name === "t4") {
        if (code === "9") return 420;
        if (code === "3") return 410;
        return 415;
    }
    if (name === "t3") return 300;
    if (name === "t2") return 200;
    if (name === "t1") return 100;

    return 0;
}

function extractFirstColorCode(s) {
    const m = String(s || "").match(/§([0-9a-fA-Fk-oK-O])/);
    return m ? m[1].toLowerCase() : null;
}

function hasUsedMod(username) {
    return modUsers.has(String(username || "").toLowerCase());
}

function parseTabName(rawName) {
    const raw = String(rawName || "").trim();
    const stripped = stripCodes(raw);

    const bracketMatches = [...stripped.matchAll(/\[([^\]]+)\]/g)];
    const brackets = bracketMatches.map(m => ({
        full: m[0],
        value: m[1],
        index: m.index
    }));

    let hypixelRankStripped = "";
    let mstRankStripped = "";
    let username = stripped;

    if (brackets.length > 0 && brackets[0].index === 0) {
        hypixelRankStripped = brackets[0].full;
    }

    if (brackets.length > 0) {
        const last = brackets[brackets.length - 1];
        const lastEndsAt = last.index + last.full.length;
        if (lastEndsAt === stripped.length) {
            mstRankStripped = last.full;
        }
    }

    if (hypixelRankStripped && mstRankStripped && hypixelRankStripped === mstRankStripped) {
        mstRankStripped = "";
    }

    if (hypixelRankStripped) username = username.slice(hypixelRankStripped.length).trim();
    if (mstRankStripped)     username = username.slice(0, username.length - mstRankStripped.length).trim();
    if (!username)           username = stripped.replace(/\[[^\]]+\]/g, "").trim();

    const key = (username || stripped).toLowerCase();

    let mstRankRaw = "";
    let hypixelRankRaw = hypixelRankStripped;

    if (mstRankStripped) {
        mstRankRaw = extractRawSegment(raw, mstRankStripped);
        rankCache[key] = {
            mstRank: mstRankRaw || mstRankStripped,
            hypixelRank: hypixelRankRaw
        };
    } else if (rankCache[key]) {
        mstRankRaw     = rankCache[key].mstRank;
        hypixelRankRaw = hypixelRankRaw || rankCache[key].hypixelRank;
    }

    return {
        raw,
        username: username || stripped,
        hypixelRank: hypixelRankRaw,
        mstRank: mstRankRaw || mstRankStripped,
        rankWeight: rankWeight(mstRankRaw || mstRankStripped),
        usedMod: hasUsedMod(username || stripped)
    };
}

function extractRawSegment(raw, strippedTarget) {
    const pattern = strippedTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`((?:§.)*${pattern.split("").join("(?:§.)*")})`);
    const m = raw.match(re);
    return m ? m[1] : strippedTarget;
}

function isOnlineMst(username) {
    const p = players[username];
    if (!p) return false;
    const now = Date.now();
    return (now - p.lastPing) < OFFLINE_THRESHOLD_MS && p.status === "mst";
}

function makeSort() {
    return (a, b) => {
        const aOnline = isOnlineMst(a.username);
        const bOnline = isOnlineMst(b.username);
        if (a.usedMod !== b.usedMod) return a.usedMod ? -1 : 1;
        if (aOnline !== bOnline) return aOnline ? -1 : 1;
        const rankDiff = b.rankWeight - a.rankWeight;
        if (rankDiff !== 0) return rankDiff;
        return a.username.localeCompare(b.username, undefined, { sensitivity: "base", numeric: true });
    };
}

function mostRecentMstPinger() {
    let best = null, bestTime = 0;
    const now = Date.now();
    for (const p of Object.values(players)) {
        if (p.status === "mst" && (now - p.lastPing) < OFFLINE_THRESHOLD_MS && p.lastPing > bestTime) {
            bestTime = p.lastPing;
            best = p.username;
        }
    }
    return best;
}

app.post("/ping", (req, res) => {
    const { username, status, playerList } = req.body;
    if (!username || typeof username !== "string") {
        return res.status(400).json({ error: "Missing username" });
    }

    const cleanUsername = username.trim();
    modUsers.add(cleanUsername.toLowerCase());

    const now = Date.now();
    const existing = players[cleanUsername];
    const normalizedStatus = ["mst", "lobby", "queue"].includes(status) ? status : "offline";
    const previouslyOnline = existing ? (now - existing.lastPing) < OFFLINE_THRESHOLD_MS : false;
    const statusChanged = !existing || existing.status !== normalizedStatus || !previouslyOnline;

    players[cleanUsername] = {
        username: cleanUsername,
        status: normalizedStatus,
        lastPing: now,
        firstSeen: existing ? existing.firstSeen : now,
        statusSince: statusChanged ? now : existing.statusSince,
    };

    if (normalizedStatus === "mst" && Array.isArray(playerList) && playerList.length > 0) {
        const cacheExpired = (now - mstPlayerListUpdatedAt) >= PLAYERLIST_CACHE_TTL_MS;
        const isMostRecent = mostRecentMstPinger() === cleanUsername;

        if (cacheExpired || isMostRecent) {
            const seen = new Set();
            mstPlayerList = playerList
                .filter(name => typeof name === "string" && name.trim())
                .map(parseTabName)
                .filter(p => {
                    const key = p.username.toLowerCase();
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
            mstPlayerList.sort(makeSort());
            mstPlayerListUpdatedAt = now;
            mstPlayerListUpdatedBy = cleanUsername;

            for (const p of mstPlayerList) {
                const uname = p.username;
                if (!uname) continue;
                const existingP = players[uname];
                const wasOnlineMst = existingP
                    && (now - existingP.lastPing) < OFFLINE_THRESHOLD_MS
                    && existingP.status === 'mst';
                players[uname] = {
                    username: uname,
                    status: 'mst',
                    lastPing: wasOnlineMst ? existingP.lastPing : now,
                    firstSeen: existingP ? existingP.firstSeen : now,
                    statusSince: wasOnlineMst ? existingP.statusSince : now,
                };
            }
        }
    }

    return res.json({ ok: true });
});

app.get("/players", (req, res) => {
    const now = Date.now();

    const playerRows = Object.values(players).map((p) => {
        const online = now - p.lastPing < OFFLINE_THRESHOLD_MS;
        const status = online ? p.status : "offline";
        const statusSince = online ? p.statusSince : p.lastPing;
        const key = p.username.toLowerCase();
        const cached = rankCache[key] || {};

        return {
            username: p.username,
            status,
            statusSince,
            firstSeen: p.firstSeen,
            lastPing: p.lastPing,
            online,
            usedMod: hasUsedMod(p.username),
            mstRank: cached.mstRank || "",
            hypixelRank: cached.hypixelRank || "",
            rankWeight: rankWeight(cached.mstRank || "")
        };
    });

    playerRows.sort(makeSort());
    return res.json(playerRows);
});

app.get("/mst-playerlist", (req, res) => {
    mstPlayerList.sort(makeSort());
    return res.json(mstPlayerList);
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

loadPersist();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MST Tracker running on port ${PORT}`));

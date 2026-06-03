const express = require("express");
const cors = require("cors");
const path = require("path");
const app = express();

app.use(cors());
app.use(express.json());

const OFFLINE_THRESHOLD_MS = 2 * 60 * 1000;

const players = {};
const modUsers = new Set();

let mstPlayerList = [];

function stripWeirdChars(str) {
    return String(str || "")
        .normalize("NFKD")
        .replace(/[^\p{L}\p{N}\[\]\s_+-]/gu, "")
        .trim();
}

function normalizeRank(rank) {
    return stripWeirdChars(rank)
        .replace(/[\[\]]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
}

function rankWeight(rank) {
    const r = normalizeRank(rank);

    switch (r) {
        case "owner":
            return 1000;

        case "dev":
        case "developer":
            return 900;

        case "admn":
        case "admin":
            return 800;

        case "manager":
            return 700;

        case "mod":
        case "moderator":
            return 600;

        case "build":
        case "builder":
            return 500;

        case "t5":
            return 50;

        case "t4":
            return 40;

        case "t3":
            return 30;

        case "t2":
            return 20;

        case "t1":
            return 10;

        default:
            return 0;
    }
}

function parseTabName(rawName) {
    const raw = String(rawName || "").trim();

    const bracketMatches = [...raw.matchAll(/\[([^\]]+)\]/g)];

    const brackets = bracketMatches.map(m => ({
        full: m[0],
        value: m[1],
        index: m.index
    }));

    let hypixelRank = "";
    let mstRank = "";
    let username = raw;

    if (brackets.length > 0 && brackets[0].index === 0) {
        hypixelRank = brackets[0].full;
    }

    if (brackets.length > 0) {
        const last = brackets[brackets.length - 1];
        const lastEndsAt = last.index + last.full.length;

        if (lastEndsAt === raw.length) {
            mstRank = last.full;
        }
    }

    if (hypixelRank) {
        username = username.slice(hypixelRank.length).trim();
    }

    if (mstRank) {
        username = username.slice(0, username.length - mstRank.length).trim();
    }

    if (!username) {
        username = raw.replace(/\[[^\]]+\]/g, "").trim();
    }

    return {
        raw,
        username: username || raw,
        hypixelRank,
        mstRank,
        rankWeight: rankWeight(mstRank),
        usedMod: hasUsedMod(username || raw)
    };
}

function hasUsedMod(username) {
    return modUsers.has(String(username || "").toLowerCase());
}

function sortMstPlayerList(list) {
    return list.sort((a, b) => {
        // 1. Anyone who has ever used the mod first
        if (a.usedMod !== b.usedMod) {
            return a.usedMod ? -1 : 1;
        }

        // 2. Staff rank order, then T5 -> T1
        const rankDiff = b.rankWeight - a.rankWeight;
        if (rankDiff !== 0) return rankDiff;

        // 3. A-Z inside each group
        return a.username.localeCompare(b.username, undefined, {
            sensitivity: "base",
            numeric: true
        });
    });
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

    const normalizedStatus = ["mst", "lobby", "queue"].includes(status)
        ? status
        : "offline";

    const previouslyOnline = existing
        ? (now - existing.lastPing) < OFFLINE_THRESHOLD_MS
        : false;

    const statusChanged = !existing
        || existing.status !== normalizedStatus
        || !previouslyOnline;

    players[cleanUsername] = {
        username: cleanUsername,
        status: normalizedStatus,
        lastPing: now,
        firstSeen: existing ? existing.firstSeen : now,
        statusSince: statusChanged ? now : existing.statusSince,
    };

    if (normalizedStatus === "mst" && Array.isArray(playerList)) {
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

        sortMstPlayerList(mstPlayerList);
    }

    return res.json({ ok: true });
});

app.get("/players", (req, res) => {
    const now = Date.now();

    const result = Object.values(players).map((p) => {
        const online = now - p.lastPing < OFFLINE_THRESHOLD_MS;
        const status = online ? p.status : "offline";
        const statusSince = online ? p.statusSince : p.lastPing;

        return {
            username: p.username,
            status,
            statusSince,
            firstSeen: p.firstSeen,
            lastPing: p.lastPing,
            online,
            usedMod: hasUsedMod(p.username)
        };
    });

    result.sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;

        return a.username.localeCompare(b.username, undefined, {
            sensitivity: "base",
            numeric: true
        });
    });

    return res.json(result);
});

app.get("/mst-playerlist", (req, res) => {
    return res.json(mstPlayerList);
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MST Tracker running on port ${PORT}`));

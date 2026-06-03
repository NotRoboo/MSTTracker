const express = require("express");
const cors = require("cors");
const path = require("path");
const app = express();

app.use(cors());
app.use(express.json());

const OFFLINE_THRESHOLD_MS = 2 * 60 * 1000;

const players = {};

app.post("/ping", (req, res) => {
    const { username, status } = req.body;

    if (!username || typeof username !== "string") {
        return res.status(400).json({ error: "Missing username" });
    }

    const now = Date.now();
    const existing = players[username];

    const normalizedStatus = ["mst", "lobby", "queue"].includes(status) ? status : "offline";

    const previouslyOnline = existing
        ? (now - existing.lastPing) < OFFLINE_THRESHOLD_MS
        : false;

    const statusChanged = !existing
        || existing.status !== normalizedStatus
        || !previouslyOnline;

    players[username] = {
        username,
        status: normalizedStatus,
        lastPing: now,
        firstSeen: existing ? existing.firstSeen : now,
        statusSince: statusChanged ? now : existing.statusSince,
    };

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
        };
    });

    result.sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return a.username.localeCompare(b.username);
    });

    return res.json(result);
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MST Tracker running on port ${PORT}`));

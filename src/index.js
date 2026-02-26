const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// Serve admin dashboard static files (build)
app.use(express.static(path.join(__dirname, "../../admin-dashboard/build")));

const httpServer = createServer(app);
const PORT = process.env.PORT || 4000;

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});

const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingInterval: 10000,
  pingTimeout: 5000,
});

// ============================================================
// Station store: Map<socketId, stationInfo>
// ============================================================
const stations = new Map();

function getStationList() {
  return Array.from(stations.values()).map((s) => ({
    socketId: s.socketId,
    stationId: s.stationId,
    stationIp: s.stationIp,
    hostname: s.hostname,
    platform: s.platform,
    cpuModel: s.cpuModel,
    totalMemory: s.totalMemory,
    status: s.status,
    connectedAt: s.connectedAt,
    screenInfo: s.screenInfo || null,
  }));
}

// ============================================================
// REST API for admin dashboard
// ============================================================
app.get("/api/stations", (req, res) => {
  res.json({ stations: getStationList() });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", stationsOnline: stations.size });
});

// Fallback to admin dashboard
app.get("*", (req, res, next) => {
  if (req.url.startsWith("/socket.io")) return next();
  res.sendFile(path.join(__dirname, "../../admin-dashboard/public/index.html"));
});

// ============================================================
// Namespace: /agents — for station agents
// ============================================================
const agentNS = io.of("/agents");

agentNS.on("connection", (socket) => {
  const { stationId, stationIp, hostname, platform, cpuModel, totalMemory } =
    socket.handshake.auth;

  const stationInfo = {
    socketId: socket.id,
    stationId: stationId || "Unknown",
    stationIp: stationIp || socket.handshake.address,
    hostname: hostname || "Unknown",
    platform: platform || "Unknown",
    cpuModel: cpuModel || "",
    totalMemory: totalMemory || 0,
    status: "online",
    connectedAt: new Date().toISOString(),
    screenInfo: null,
  };

  stations.set(socket.id, stationInfo);
  console.log(
    `✅ Station "${stationId}" (${stationIp}) connected [${socket.id}]`,
  );

  // Notify all admins
  adminNS.emit("station-online", stationInfo);
  adminNS.emit("station-list", getStationList());

  // Station sends screen info (resolution, etc.)
  socket.on("screen-info", (info) => {
    const station = stations.get(socket.id);
    if (station) {
      station.screenInfo = info;
      stations.set(socket.id, station);
      adminNS.emit("station-list", getStationList());
    }
  });

  // ---- WebRTC Signaling: Station → Admin ----
  socket.on("offer", ({ targetAdminId, sdp }) => {
    console.log(`📡 Offer from station ${stationId} → admin ${targetAdminId}`);
    adminNS.to(targetAdminId).emit("offer", {
      stationSocketId: socket.id,
      stationId,
      sdp,
    });
  });

  socket.on("answer", ({ targetAdminId, sdp }) => {
    console.log(`📡 Answer from station ${stationId} → admin ${targetAdminId}`);
    adminNS.to(targetAdminId).emit("answer", {
      stationSocketId: socket.id,
      sdp,
    });
  });

  socket.on("icecandidate", ({ targetAdminId, candidate }) => {
    adminNS.to(targetAdminId).emit("icecandidate", {
      stationSocketId: socket.id,
      candidate,
    });
  });

  // Station reports status updates
  socket.on("status-update", (data) => {
    const station = stations.get(socket.id);
    if (station) {
      Object.assign(station, data);
      stations.set(socket.id, station);
      adminNS.emit("station-list", getStationList());
    }
  });

  // Station screenshot (thumbnail for dashboard)
  socket.on("screenshot", ({ targetAdminId, image }) => {
    adminNS.to(targetAdminId).emit("screenshot", {
      stationSocketId: socket.id,
      image,
    });
  });

  socket.on("disconnect", () => {
    console.log(`❌ Station "${stationId}" disconnected`);
    stations.delete(socket.id);
    adminNS.emit("station-offline", { socketId: socket.id, stationId });
    adminNS.emit("station-list", getStationList());
  });
});

// ============================================================
// Namespace: /admin — for admin dashboard
// ============================================================
const adminNS = io.of("/admin");

adminNS.on("connection", (socket) => {
  console.log(`👤 Admin connected [${socket.id}]`);

  // Send current station list
  socket.emit("station-list", getStationList());

  // ---- Admin requests to view a station screen ----
  socket.on("request-screen", ({ stationSocketId }) => {
    console.log(`🖥️  Admin requests screen from ${stationSocketId}`);
    agentNS.to(stationSocketId).emit("request-screen", {
      adminSocketId: socket.id,
    });
  });

  // ---- Admin stops viewing ----
  socket.on("stop-screen", ({ stationSocketId }) => {
    agentNS.to(stationSocketId).emit("stop-screen", {
      adminSocketId: socket.id,
    });
  });

  // ---- WebRTC Signaling: Admin → Station ----
  socket.on("offer", ({ stationSocketId, sdp }) => {
    agentNS.to(stationSocketId).emit("offer", {
      targetAdminId: socket.id,
      sdp,
    });
  });

  socket.on("answer", ({ stationSocketId, sdp }) => {
    console.log(`📡 Answer from admin → station ${stationSocketId}`);
    agentNS.to(stationSocketId).emit("answer", {
      adminSocketId: socket.id,
      sdp,
    });
  });

  socket.on("icecandidate", ({ stationSocketId, candidate }) => {
    agentNS.to(stationSocketId).emit("icecandidate", {
      adminSocketId: socket.id,
      candidate,
    });
  });

  // ---- Remote Control Commands ----
  // Mouse move (high frequency - no logging)
  socket.on(
    "mouse-move",
    ({ stationSocketId, x, y, screenWidth, screenHeight }) => {
      agentNS
        .to(stationSocketId)
        .emit("mouse-move", { x, y, screenWidth, screenHeight });
    },
  );

  // Mouse down (click start)
  socket.on(
    "mouse-click",
    ({
      stationSocketId,
      button,
      double,
      type,
      x,
      y,
      screenWidth,
      screenHeight,
    }) => {
      agentNS.to(stationSocketId).emit("mouse-click", {
        button,
        double,
        type,
        x,
        y,
        screenWidth,
        screenHeight,
      });
    },
  );

  // Mouse up (click release)
  socket.on(
    "mouse-up",
    ({ stationSocketId, button, x, y, screenWidth, screenHeight }) => {
      agentNS
        .to(stationSocketId)
        .emit("mouse-up", { button, x, y, screenWidth, screenHeight });
      console.log("check mouse-up");
    },
  );

  // Mouse scroll
  socket.on("mouse-scroll", ({ stationSocketId, deltaX, deltaY }) => {
    agentNS.to(stationSocketId).emit("mouse-scroll", { deltaX, deltaY });
  });

  // Keyboard - key down
  socket.on(
    "key-down",
    ({ stationSocketId, key, code, keyCode, modifiers }) => {
      agentNS
        .to(stationSocketId)
        .emit("key-down", { key, code, keyCode, modifiers });
    },
  );

  // Keyboard - key up
  socket.on("key-up", ({ stationSocketId, key, code, keyCode }) => {
    agentNS.to(stationSocketId).emit("key-up", { key, code, keyCode });
  });

  // Legacy key events (backward compat)
  socket.on("key-tap", ({ stationSocketId, key, modifiers }) => {
    agentNS.to(stationSocketId).emit("key-tap", { key, modifiers });
  });

  socket.on("key-type", ({ stationSocketId, text }) => {
    agentNS.to(stationSocketId).emit("key-type", { text });
  });

  // ---- Management Commands ----
  socket.on("lock-station", ({ stationSocketId }) => {
    console.log(`🔒 Lock station ${stationSocketId}`);
    agentNS.to(stationSocketId).emit("lock-station");
  });

  socket.on("unlock-station", ({ stationSocketId }) => {
    console.log(`🔓 Unlock station ${stationSocketId}`);
    agentNS.to(stationSocketId).emit("unlock-station");
  });

  socket.on("shutdown-station", ({ stationSocketId }) => {
    console.log(`⏻ Shutdown station ${stationSocketId}`);
    agentNS.to(stationSocketId).emit("shutdown-station");
  });

  socket.on("restart-station", ({ stationSocketId }) => {
    console.log(`🔄 Restart station ${stationSocketId}`);
    agentNS.to(stationSocketId).emit("restart-station");
  });

  socket.on("message-station", ({ stationSocketId, message }) => {
    agentNS.to(stationSocketId).emit("show-message", { message });
  });

  socket.on("open-app", ({ stationSocketId, appPath }) => {
    agentNS.to(stationSocketId).emit("open-app", { appPath });
  });

  socket.on("request-screenshot", ({ stationSocketId }) => {
    agentNS.to(stationSocketId).emit("request-screenshot", {
      targetAdminId: socket.id,
    });
  });

  // ---- Broadcast to multiple stations ----
  socket.on("broadcast-command", ({ command, stationSocketIds, payload }) => {
    console.log(
      `📢 Broadcast "${command}" to ${stationSocketIds.length} stations`,
    );
    stationSocketIds.forEach((id) => {
      agentNS.to(id).emit(command, payload || {});
    });
  });

  socket.on("disconnect", () => {
    console.log(`👤 Admin disconnected [${socket.id}]`);
  });
});

// ============================================================
// Graceful shutdown
// ============================================================
process.on("SIGTERM", () => {
  console.log("Shutting down...");
  httpServer.close();
  process.exit(0);
});

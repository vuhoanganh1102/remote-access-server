# Tài liệu luồng hoạt động - Remote Net Management System

## Tổng quan kiến trúc

Hệ thống gồm 3 thành phần chính giao tiếp với nhau qua mạng LAN:

```
┌────────────────────────────────────────────────────────────┐
│                   MÁY CHỦ (192.168.1.100)                  │
│                                                            │
│  ┌─────────────────┐       ┌───────────────────────────┐   │
│  │   SERVER :4000   │◄─────►│   ADMIN DASHBOARD (React) │   │
│  │ Express+Socket.IO│       │   http://IP:4000          │   │
│  │                  │       │                           │   │
│  │  Namespace:      │       │  • useSocket (Socket.IO)  │   │
│  │  /agents ──┐     │       │  • useWebRTC (RTCPeer)    │   │
│  │  /admin  ──┤     │       │  • StationCard            │   │
│  │            │     │       │  • RemoteViewer            │   │
│  └────────┬───┘     │       └───────────────────────────┘   │
└───────────┼─────────────────────────────────────────────────┘
            │ Socket.IO qua LAN
  ┌─────────┼──────────┬──────────────────┐
  │         │          │                  │
┌─▼──────┐ ┌▼───────┐ ┌▼────────┐  ┌─────▼──┐
│ PC-01  │ │ PC-02  │ │ PC-03  │  │ PC-N   │
│ Agent  │ │ Agent  │ │ Agent  │  │ Agent  │
│Electron│ │Electron│ │Electron│  │Electron│
└────────┘ └────────┘ └────────┘  └────────┘
  STATION AGENT (chạy ngầm - system tray)
```

---

## Thành phần 1: Server (`server/src/index.js`)

### Vai trò

Server là trung tâm điều phối toàn bộ hệ thống. Nó không xử lý video hay điều khiển trực tiếp, mà đóng 3 vai trò:

1. **HTTP Server**: Serve giao diện Admin Dashboard (React build) + REST API
2. **Signaling Server**: Chuyển tiếp SDP offer/answer và ICE candidates giữa Admin ↔ Agent để thiết lập WebRTC
3. **Command Relay**: Chuyển tiếp lệnh quản lý (khóa máy, tắt máy, gửi tin nhắn...) từ Admin xuống Agent

### Chi tiết khởi tạo

```
Express App
  ├── cors({ origin: '*' })         → Cho phép mọi origin kết nối
  ├── express.json()                → Parse JSON body
  ├── express.static(build/)        → Serve React dashboard build
  │
  ├── GET /api/stations             → REST API trả danh sách máy trạm
  ├── GET /api/health               → Health check + số máy online
  └── GET * (fallback)              → Trả index.html (SPA routing)
      └── SKIP /socket.io/*         → Không chặn Socket.IO handshake
```

Server tạo `httpServer` từ Express app, rồi mount Socket.IO lên cùng HTTP server đó. Socket.IO được cấu hình:

- **transports**: `['polling', 'websocket']` — bắt đầu bằng HTTP long-polling, sau đó tự động upgrade lên WebSocket. Thứ tự này quan trọng vì nếu dùng WebSocket trước mà handshake chưa hoàn thành sẽ gây lỗi "WebSocket is closed before the connection is established".
- **allowUpgrades: true** — cho phép upgrade từ polling → websocket
- **pingInterval/pingTimeout**: 25s/20s — server gửi ping mỗi 25 giây, nếu client không phản hồi trong 20 giây thì coi là disconnect

### Quản lý trạng thái máy trạm

Server dùng `Map<socketId, stationInfo>` để lưu thông tin tất cả máy trạm đang online:

```javascript
stationInfo = {
  socketId, // ID socket duy nhất do Socket.IO cấp
  stationId, // Tên máy (hostname hoặc custom)
  stationIp, // IP nội bộ của máy trạm
  hostname, // Hostname hệ điều hành
  platform, // 'win32', 'linux', 'darwin'
  cpuModel, // Model CPU
  totalMemory, // RAM tổng (GB)
  status, // 'online'
  connectedAt, // Thời điểm kết nối (ISO string)
  screenInfo, // { width, height, scaleFactor } — gửi sau khi connect
};
```

Hàm `getStationList()` chuyển Map thành array để gửi cho Admin Dashboard.

### Namespace `/agents` — Kênh dành cho máy trạm

Khi một Station Agent kết nối:

1. **Đọc auth data** từ `socket.handshake.auth` — chứa `stationId, stationIp, hostname, platform, cpuModel, totalMemory` mà agent gửi kèm khi connect
2. **Lưu vào stations Map** với key là `socket.id`
3. **Thông báo tất cả admin** đang online qua 2 event:
   - `station-online`: thông tin máy vừa kết nối
   - `station-list`: danh sách đầy đủ tất cả máy (để admin dashboard cập nhật giao diện)

Agent có thể gửi thêm:

- `screen-info`: thông tin độ phân giải màn hình → server cập nhật vào stationInfo và broadcast lại cho admin
- `status-update`: cập nhật trạng thái bất kỳ
- `screenshot`: gửi ảnh chụp màn hình thumbnail → server chuyển thẳng tới admin đã yêu cầu (`targetAdminId`)

**Signaling relay (Agent → Admin)**:

- `offer` → server nhận SDP offer từ agent, chuyển tới đúng admin qua `adminNS.to(targetAdminId).emit('offer', ...)`
- `answer` → tương tự
- `icecandidate` → tương tự

Khi agent disconnect: xóa khỏi Map, thông báo tất cả admin.

### Namespace `/admin` — Kênh dành cho Admin Dashboard

Khi Admin Dashboard kết nối:

1. Ngay lập tức nhận `station-list` chứa tất cả máy đang online

Admin có thể gửi:

**Yêu cầu xem màn hình:**

- `request-screen` → server forward tới agent: "admin muốn xem màn hình của bạn"
- `stop-screen` → server forward: "admin đã đóng viewer"

**Signaling relay (Admin → Agent):**

- `offer`, `answer`, `icecandidate` → server chuyển tiếp qua `agentNS.to(stationSocketId)`

**Điều khiển từ xa:**

- `mouse-move` với `{ stationSocketId, x, y, screenWidth, screenHeight }` → forward tới agent
- `mouse-click` với `{ stationSocketId, button, double }` → forward
- `mouse-scroll` với `{ stationSocketId, deltaX, deltaY }` → forward
- `key-tap` với `{ stationSocketId, key, modifiers }` → forward (phím đặc biệt + tổ hợp)
- `key-type` với `{ stationSocketId, text }` → forward (gõ ký tự thường)

**Lệnh quản lý:**

- `lock-station` → agent khóa màn hình
- `unlock-station` → agent mở khóa
- `shutdown-station` → agent chạy lệnh shutdown
- `restart-station` → agent chạy lệnh restart
- `message-station` → agent hiện dialog thông báo
- `open-app` → agent mở ứng dụng

**Broadcast (lệnh hàng loạt):**

- `broadcast-command` với `{ command, stationSocketIds, payload }` → gửi cùng lệnh tới nhiều agent cùng lúc

---

## Thành phần 2: Station Agent (`station-agent/`)

### Vai trò

Agent là ứng dụng Electron chạy ngầm trên mỗi máy trạm. Nó thực hiện:

1. **Kết nối server** qua Socket.IO và tự động reconnect
2. **Capture màn hình** bằng Electron `desktopCapturer` API
3. **Stream video** qua WebRTC peer-to-peer tới Admin Dashboard
4. **Thực thi lệnh** từ admin (di chuột, click, gõ phím, khóa máy, tắt máy...)
5. **Chạy ngầm** trong system tray, không hiện cửa sổ

### Kiến trúc nội bộ Agent

Agent có 3 layer giao tiếp qua IPC (Inter-Process Communication):

```
┌──────────────────────────────────────────────────┐
│  MAIN PROCESS (main.js)                          │
│                                                  │
│  • Socket.IO client → kết nối server /agents     │
│  • desktopCapturer → lấy danh sách screen        │
│  • robotjs → điều khiển chuột/bàn phím thật      │
│  • child_process → shutdown, restart, lock screen │
│  • Tray icon → menu ngầm trong system tray       │
│  • IPC handlers → relay giữa renderer ↔ server   │
│                                                  │
│  ▼ ipcMain ◄──── ipcRenderer ▲                   │
│                                                  │
│  PRELOAD (preload.js)                            │
│  • contextBridge.exposeInMainWorld('agentAPI')   │
│  • Expose 20+ methods cho renderer gọi           │
│                                                  │
│  ▼ window.agentAPI                               │
│                                                  │
│  RENDERER (renderer/index.html)                  │
│  • WebRTC RTCPeerConnection                      │
│  • getUserMedia (chromeMediaSource: 'desktop')   │
│  • Quản lý nhiều peer connections (Map)          │
│  • Giao diện debug log                           │
└──────────────────────────────────────────────────┘
```

### Main Process (`main.js`) — Chi tiết

**Khởi tạo (app.on 'ready'):**

```
1. createWindow()       → Tạo BrowserWindow ẩn (show: false, skipTaskbar: true)
                          Load renderer/index.html
                          Khi đóng cửa sổ → ẩn thay vì quit (chạy ngầm)

2. createTray()         → Tạo icon trong system tray
                          Menu: Station ID, IP, Show Window, Quit
                          Double-click tray → show window

3. setupIPC()           → Đăng ký IPC handlers:
                          'webrtc-offer'       → forward SDP tới server
                          'webrtc-answer'      → forward SDP tới server
                          'webrtc-icecandidate' → forward ICE tới server
                          'screenshot-ready'   → forward screenshot tới server
                          'get-sources'        → gọi desktopCapturer, trả kết quả

4. connectToServer()    → Kết nối Socket.IO tới server
                          Gửi systemInfo qua auth
                          Đăng ký tất cả event handlers

5. setLoginItemSettings → Đăng ký auto-start khi Windows/Linux khởi động
```

**Thu thập system info:**

```javascript
getSystemInfo() = {
  stationId:   os.hostname() hoặc config.STATION_ID,
  stationIp:   IP nội bộ IPv4 đầu tiên tìm được (bỏ qua loopback),
  hostname:    os.hostname(),
  platform:    'win32' | 'linux' | 'darwin',
  cpuModel:    os.cpus()[0].model,
  totalMemory: os.totalmem() quy đổi ra GB,
}
```

**Socket event handlers trong main process:**

Khi server gửi xuống, main process nhận và xử lý theo 3 cách:

1. **Forward sang renderer** (qua IPC) — cho các event cần WebRTC:
   - `request-screen` → renderer: bắt đầu capture + tạo WebRTC connection
   - `stop-screen` → renderer: đóng WebRTC connection
   - `offer/answer/icecandidate` → renderer: xử lý WebRTC signaling
   - `mouse-move/click/scroll/key-tap/key-type` → renderer (chỉ để log)

2. **Xử lý trực tiếp** — cho các lệnh hệ thống:
   - `lock-station` → gọi `lockScreen()`: Windows `LockWorkStation` hoặc Linux `loginctl lock-session`
   - `shutdown-station` → `shutdown /s /t 30` (Win) hoặc `shutdown -h +1` (Linux)
   - `restart-station` → `shutdown /r /t 30` (Win) hoặc `shutdown -r +1` (Linux)
   - `show-message` → `dialog.showMessageBox()` hiện popup trên máy trạm
   - `open-app` → `start` (Win) hoặc `xdg-open` (Linux)

3. **Cả hai** — ví dụ `lock-station` vừa forward sang renderer (cập nhật UI log) vừa gọi `lockScreen()` trực tiếp

### Preload Script (`preload.js`)

Preload chạy trong context đặc biệt — có quyền truy cập cả Node.js (`ipcRenderer`) lẫn browser (`window`). Nó dùng `contextBridge` để expose an toàn một API object `window.agentAPI` cho renderer:

```
window.agentAPI = {
  // Gọi main process
  getSources()            → ipcRenderer.send('get-sources')
  sendOffer(data)         → ipcRenderer.send('webrtc-offer', data)
  sendAnswer(data)        → ipcRenderer.send('webrtc-answer', data)
  sendIceCandidate(data)  → ipcRenderer.send('webrtc-icecandidate', data)
  sendScreenshot(data)    → ipcRenderer.send('screenshot-ready', data)

  // Nhận từ main process (callback pattern)
  onSourcesList(cb)       → ipcRenderer.on('sources-list', cb)
  onStartScreenShare(cb)  → ipcRenderer.on('start-screen-share', cb)
  onStopScreenShare(cb)   → ipcRenderer.on('stop-screen-share', cb)
  onWebRTCOffer(cb)       → ipcRenderer.on('webrtc-offer', cb)
  onWebRTCAnswer(cb)      → ipcRenderer.on('webrtc-answer', cb)
  onWebRTCIceCandidate(cb)→ ipcRenderer.on('webrtc-icecandidate', cb)
  onMouseMove(cb)         → ipcRenderer.on('remote-mouse-move', cb)
  onMouseClick(cb)        → ipcRenderer.on('remote-mouse-click', cb)
  onKeyTap(cb)            → ipcRenderer.on('remote-key-tap', cb)
  onLock(cb)              → ipcRenderer.on('lock-station', cb)
  onUnlock(cb)            → ipcRenderer.on('unlock-station', cb)
  onShowMessage(cb)       → ipcRenderer.on('show-message', cb)
  onTakeScreenshot(cb)    → ipcRenderer.on('take-screenshot', cb)
}
```

Thiết kế này tuân thủ security best practice của Electron: `contextIsolation: true` + `nodeIntegration: false`. Renderer không truy cập trực tiếp Node.js, chỉ qua API đã được kiểm soát.

### Renderer (`renderer/index.html`) — Chi tiết

Renderer là nơi thực sự xử lý WebRTC. Nó chạy trong Chromium browser của Electron.

**Quản lý nhiều peer connections:**

```javascript
const peerConnections = new Map(); // Map<adminSocketId, RTCPeerConnection>
```

Mỗi admin xem màn hình sẽ có 1 RTCPeerConnection riêng. Điều này cho phép nhiều admin cùng xem 1 máy trạm.

**Luồng startScreenShare(adminSocketId):**

```
1. Gọi window.agentAPI.getSources()
   → Main process chạy desktopCapturer.getSources({ types: ['screen'] })
   → Trả về danh sách màn hình

2. Nhận sources qua callback onSourcesList
   → Chọn source đầu tiên (màn hình chính)

3. Gọi navigator.mediaDevices.getUserMedia({
     video: {
       mandatory: {
         chromeMediaSource: 'desktop',        // API đặc biệt của Electron
         chromeMediaSourceId: source.id,      // ID màn hình cụ thể
         maxWidth: 1920, maxHeight: 1080,     // Giới hạn resolution
         maxFrameRate: 30                     // Giới hạn FPS
       }
     }
   })
   → Trả về MediaStream chứa video track của màn hình

4. Gọi setupPeerConnection(adminSocketId, stream)
```

**setupPeerConnection(adminSocketId, stream):**

```
1. Tạo RTCPeerConnection mới với STUN server
   → STUN giúp discover public IP, trong LAN thường không cần
     nhưng thêm vào để đảm bảo hoạt động mọi trường hợp

2. Thêm video track vào connection
   → stream.getTracks().forEach(track => pc.addTrack(track, stream))

3. Đăng ký onicecandidate
   → Mỗi khi tìm được ICE candidate → gửi qua IPC → main → server → admin

4. Đăng ký oniceconnectionstatechange
   → 'connected': cập nhật UI "Screen sharing active"
   → 'disconnected'/'failed': gọi stopScreenShare() cleanup

5. Tạo SDP Offer
   → pc.createOffer() → pc.setLocalDescription(sdp) → gửi offer tới admin
   → Offer mô tả: "Tôi có 1 video track, codec VP8/VP9/H264, muốn gửi cho bạn"

6. Lưu pc vào peerConnections Map
```

**Nhận WebRTC Answer từ admin:**

```
onWebRTCAnswer → pc.setRemoteDescription(answer)
→ WebRTC bắt đầu quá trình kết nối P2P
→ ICE candidates được trao đổi qua server
→ Khi tìm được đường kết nối trực tiếp → video bắt đầu stream
```

---

## Thành phần 3: Admin Dashboard (`admin-dashboard/`)

### Vai trò

Giao diện web chạy trên browser của máy chủ (hoặc bất kỳ máy nào trong LAN). Hiển thị danh sách máy trạm, cho phép xem màn hình realtime và điều khiển từ xa.

### Cấu trúc components

```
App.js
  ├── useSocket()          → Hook quản lý Socket.IO connection
  ├── useWebRTC()          → Hook quản lý WebRTC peer connection
  │
  ├── Header
  │   ├── Trạng thái kết nối (🟢/🔴)
  │   ├── Số máy online / tổng
  │   └── Bulk action buttons (Khóa/Mở/Restart/Tắt tất cả)
  │
  ├── Station Grid
  │   └── StationCard × N  → Mỗi máy trạm 1 card
  │       ├── Status indicator (online/offline)
  │       ├── Info: IP, OS, Screen resolution, RAM
  │       └── Action buttons: Xem, Khóa, Mở, Nhắn, Restart, Tắt
  │
  └── RemoteViewer (overlay fullscreen)
      ├── Toolbar: tên máy, IP, resolution, nút Đóng
      └── Video element + event handlers (mouse, keyboard)
```

### useSocket Hook (`hooks/useSocket.js`) — Chi tiết

**Xác định Server URL:**

```
Nếu REACT_APP_SERVER_URL env variable có → dùng luôn
Nếu đang chạy trên port 3000 (React dev server) → trỏ tới hostname:4000
Nếu production (server serve static) → dùng window.location.origin
```

Điều này giải quyết vấn đề: khi dev, React chạy port 3000 nhưng server chạy port 4000.

**Kết nối Socket.IO:**

```javascript
io(`${SERVER_URL}/admin`, {
  transports: ["polling", "websocket"], // Polling trước, upgrade sau
  upgrade: true,
  reconnection: true, // Tự reconnect
  reconnectionDelay: 1000, // 1 giây giữa mỗi lần thử
  reconnectionAttempts: Infinity, // Không giới hạn
  timeout: 20000, // Timeout 20 giây
  forceNew: true, // Luôn tạo connection mới
});
```

**State được quản lý:**

- `connected` (boolean): trạng thái kết nối
- `stations` (array): danh sách tất cả máy trạm từ server

**Events được lắng nghe:**

- `station-list` → cập nhật toàn bộ danh sách stations
- `station-online` → log (danh sách đã được cập nhật qua station-list)
- `station-offline` → log

**3 methods được expose:**

- `emit(event, data)` → gửi event tới server, kiểm tra connected trước
- `on(event, callback)` → đăng ký listener, trả về cleanup function
- `off(event, callback)` → hủy listener

### useWebRTC Hook (`hooks/useWebRTC.js`) — Chi tiết

Hook này quản lý 1 RTCPeerConnection tại 1 thời điểm (admin xem 1 máy trạm).

**connectToStation(stationSocketId, videoElement):**

```
1. cleanup() — đóng connection cũ nếu có

2. emit('request-screen', { stationSocketId })
   → Server forward tới agent
   → Agent bắt đầu capture màn hình + tạo WebRTC offer

3. Tạo RTCPeerConnection mới
   → addTransceiver('video', { direction: 'recvonly' })
   → Admin chỉ nhận video, không gửi

4. Đăng ký onicecandidate
   → Gửi ICE candidate về server → forward tới agent

5. Đăng ký ontrack
   → Khi nhận được video track từ agent
   → Gán stream vào <video> element → play()
   → Resolve promise (kết nối thành công)

6. Đăng ký socket listeners:
   handleOffer: nhận SDP offer từ agent
   → setRemoteDescription(offer)
   → createAnswer()
   → setLocalDescription(answer)
   → emit('answer', ...) gửi về agent

   handleIceCandidate: nhận ICE candidate từ agent
   → Validate: sdpMid hoặc sdpMLineIndex phải không null
     (ICE end-of-candidates có cả hai null → bỏ qua → tránh lỗi
      "Failed to construct RTCIceCandidate")
   → pc.addIceCandidate()
```

**disconnect():**

```
1. emit('stop-screen') → thông báo agent ngừng stream
2. off() — hủy socket listeners (offer, icecandidate)
3. cleanup() — đóng RTCPeerConnection
```

### App.js — Chi tiết

**handleView(station):**

- Nếu đang xem máy này → toggle off (disconnect)
- Nếu chưa xem → set viewingStation → connectToStation()
- Nếu lỗi → clear viewingStation

**handleLock/Unlock/Message/Shutdown/Restart:**

- Mỗi action emit 1 event tới server với `stationSocketId`
- Các action nguy hiểm (Khóa, Tắt, Restart) có `window.confirm()` trước
- Message dùng `window.prompt()` để nhập nội dung

**handleBulkAction(command):**

- Lấy tất cả socketId từ stations
- emit `broadcast-command` → server gửi command tới tất cả agent

**Render:**

- stations.length === 0 → hiện empty state
- Có stations → render grid StationCard
- viewingStation !== null → hiện RemoteViewer overlay

### RemoteViewer (`components/RemoteViewer.js`) — Chi tiết

Fullscreen overlay chứa video stream + event handlers để điều khiển máy trạm từ xa.

**Mouse handling:**

```javascript
handleMouseMove(e) {
  // Tính tọa độ tương đối trong video element
  rect = e.target.getBoundingClientRect()
  x = e.clientX - rect.left
  y = e.clientY - rect.top

  emit('mouse-move', {
    stationSocketId,
    x, y,                              // Tọa độ trên admin screen
    screenWidth: rect.width,           // Kích thước hiển thị
    screenHeight: rect.height
  })
  // Agent nhận → quy đổi tỉ lệ → robotjs.moveMouse(hostX, hostY)
}

handleMouseClick(e) {
  button = e.button === 2 ? 'right' : 'left'
  emit('mouse-click', { stationSocketId, button, double: false })
}

handleWheel(e) {
  emit('mouse-scroll', { stationSocketId, deltaX, deltaY })
}
```

**Keyboard handling:**

```javascript
handleKeyDown(e) {
  e.preventDefault()  // Chặn browser xử lý phím

  // Thu thập modifiers
  modifiers = []
  if (e.ctrlKey)  modifiers.push('control')
  if (e.altKey)   modifiers.push('alt')
  if (e.shiftKey) modifiers.push('shift')
  if (e.metaKey)  modifiers.push('command')

  // Map tên phím sang format robotjs hiểu
  keyMap = { 'Enter': 'enter', 'ArrowUp': 'up', 'F5': 'f5', ... }

  if (ký_tự_đơn && không_có_modifier) {
    emit('key-type', { text: e.key })     // Gõ ký tự: robotjs.typeString()
  } else {
    emit('key-tap', { key, modifiers })   // Tổ hợp phím: robotjs.keyTap()
  }
}
```

`tabIndex={0}` và `container.focus()` đảm bảo div nhận được keyboard events.

---

## Luồng hoạt động chi tiết

### Luồng 1: Khởi động hệ thống

```
BƯỚC 1: Khởi động Server
  server$ npm start
  → Express + Socket.IO listen trên 0.0.0.0:4000
  → Sẵn sàng nhận kết nối từ agents và admin

BƯỚC 2: Mở Admin Dashboard
  Browser → http://192.168.1.100:4000
  → Server trả về React app (index.html + JS bundle)
  → React app mount → useSocket() chạy
  → Socket.IO connect tới ws://192.168.1.100:4000/admin
  → Server: "👤 Admin connected"
  → Server gửi station-list (rỗng ban đầu)
  → Dashboard hiện: "Chưa có máy trạm nào kết nối"

BƯỚC 3: Khởi động Station Agent trên máy trạm
  station$ npm start
  → Electron app ready
  → createWindow(): BrowserWindow ẩn, load renderer/index.html
  → createTray(): Icon system tray
  → setupIPC(): Đăng ký IPC handlers
  → connectToServer(): Socket.IO connect tới http://192.168.1.100:4000/agents
     auth = { stationId: 'PC-01', stationIp: '192.168.1.101', ... }

BƯỚC 4: Server nhận agent connection
  → Tạo stationInfo, lưu vào Map
  → adminNS.emit('station-list', [...]) → tất cả admin nhận
  → Dashboard cập nhật: hiện StationCard cho PC-01 (🟢 online)

BƯỚC 5: Agent gửi screen-info
  → socket.emit('screen-info', { width: 1920, height: 1080, scaleFactor: 1 })
  → Server cập nhật stationInfo → broadcast station-list
  → Dashboard cập nhật: StationCard hiện "Screen: 1920x1080"
```

### Luồng 2: Xem màn hình máy trạm (WebRTC)

Đây là luồng phức tạp nhất, bao gồm signaling + ICE + media flow.

```
Admin click "🖥️ Xem" trên StationCard của PC-01
│
▼ App.js: handleView(station)
│ setViewingStation(station) → hiện RemoteViewer overlay
│ connectToStation(station.socketId, videoRef.current)
│
▼ useWebRTC: connectToStation()
│ ① emit('request-screen', { stationSocketId: 'abc123' })
│
▼ Server /admin namespace
│ Nhận 'request-screen' → agentNS.to('abc123').emit('request-screen', { adminSocketId: 'xyz789' })
│
▼ Agent main.js
│ Nhận 'request-screen' → mainWindow.webContents.send('start-screen-share', { adminSocketId: 'xyz789' })
│
▼ Agent preload.js → renderer
│ onStartScreenShare callback fires
│
▼ Agent renderer: startScreenShare('xyz789')
│ ② window.agentAPI.getSources() → main process
│    → desktopCapturer.getSources({ types: ['screen'] })
│    → reply: [{ id: 'screen:0:0', name: 'Entire Screen', ... }]
│
│ ③ navigator.mediaDevices.getUserMedia({
│      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: 'screen:0:0' } }
│    })
│    → MediaStream: video track 1920x1080@30fps
│
│ ④ setupPeerConnection('xyz789', stream)
│    → new RTCPeerConnection({ iceServers: [STUN] })
│    → pc.addTrack(videoTrack, stream)
│    → pc.createOffer() → setLocalDescription(offer)
│
│ ⑤ sendOffer({ targetAdminId: 'xyz789', sdp: offer })
│    → IPC → main.js → socket.emit('offer', ...)
│
▼ Server /agents namespace
│ Nhận 'offer' → adminNS.to('xyz789').emit('offer', { stationSocketId: 'abc123', sdp })
│
▼ Admin Dashboard: useWebRTC handleOffer()
│ ⑥ pc.setRemoteDescription(offer)
│    → pc.createAnswer() → setLocalDescription(answer)
│    → emit('answer', { stationSocketId: 'abc123', sdp: answer })
│
▼ Server /admin namespace
│ Nhận 'answer' → agentNS.to('abc123').emit('answer', { adminSocketId: 'xyz789', sdp })
│
▼ Agent renderer: onWebRTCAnswer
│ ⑦ pc.setRemoteDescription(answer)
│
│ === ICE Candidate Exchange (song song) ===
│
│ Cả 2 bên tìm ICE candidates (đường kết nối khả dĩ):
│   - host candidate: IP nội bộ trực tiếp (192.168.1.x)
│   - srflx candidate: IP qua STUN (trong LAN = giống host)
│
│ Agent: pc.onicecandidate → sendIceCandidate → IPC → server → admin
│ Admin: pc.onicecandidate → emit('icecandidate') → server → agent
│
│ Validate trước khi addIceCandidate:
│   if (candidate.sdpMid !== null || candidate.sdpMLineIndex !== null)
│   → Bỏ qua end-of-candidates signal (cả hai null)
│
│ === ICE Connected ===
│ ⑧ Tìm được host candidate match (cùng subnet 192.168.1.x)
│    → Direct P2P connection established
│    → Video stream bắt đầu flow trực tiếp Agent → Admin
│    → KHÔNG qua server
│
▼ Admin: pc.ontrack fires
│ ⑨ videoElement.srcObject = stream
│    → videoElement.play()
│    → Admin thấy màn hình PC-01 realtime trong RemoteViewer
```

### Luồng 3: Điều khiển chuột từ xa

```
Admin di chuột trên RemoteViewer <video>
│
▼ RemoteViewer: handleMouseMove(e)
│ Tính tọa độ tương đối: x=500, y=300 (trong video 960x540 trên browser)
│ emit('mouse-move', { stationSocketId, x:500, y:300, screenWidth:960, screenHeight:540 })
│
▼ Server /admin
│ Nhận 'mouse-move' → agentNS.to(stationSocketId).emit('mouse-move', { x, y, screenWidth, screenHeight })
│
▼ Agent main.js
│ Nhận 'mouse-move' → forward qua IPC tới renderer (cho logging)
│ ĐỒNG THỜI có thể xử lý trực tiếp bằng robotjs:
│
│ Quy đổi tỉ lệ:
│   ratioX = screenInfo.width / screenWidth = 1920 / 960 = 2.0
│   ratioY = screenInfo.height / screenHeight = 1080 / 540 = 2.0
│   hostX = 500 * 2.0 = 1000
│   hostY = 300 * 2.0 = 600
│
│ robotjs.moveMouse(1000, 600)
│ → Con chuột thật trên PC-01 di chuyển tới vị trí (1000, 600)
│ → Admin thấy chuột di chuyển trên video stream (qua WebRTC)
```

### Luồng 4: Khóa tất cả máy (Broadcast)

```
Admin click "🔒 Khóa tất cả"
│
▼ App.js: handleBulkAction('lock-station')
│ window.confirm("Khóa tất cả máy?") → OK
│ stationSocketIds = stations.map(s => s.socketId) = ['abc', 'def', 'ghi']
│ emit('broadcast-command', { command: 'lock-station', stationSocketIds })
│
▼ Server /admin
│ Nhận 'broadcast-command'
│ Loop: agentNS.to('abc').emit('lock-station')
│        agentNS.to('def').emit('lock-station')
│        agentNS.to('ghi').emit('lock-station')
│
▼ Mỗi Agent main.js
│ Nhận 'lock-station'
│ → lockScreen(): exec('rundll32.exe user32.dll,LockWorkStation')  // Windows
│                  exec('loginctl lock-session')                     // Linux
│ → mainWindow.webContents.send('lock-station') → renderer log
│
→ Tất cả máy trạm bị khóa màn hình cùng lúc
```

### Luồng 5: Gửi tin nhắn tới 1 máy

```
Admin click "💬 Nhắn" trên StationCard của PC-02
│
▼ App.js: handleMessage(station)
│ message = window.prompt("Gửi tin nhắn đến PC-02:")
│ → Admin nhập: "Hết giờ rồi, vui lòng tắt máy!"
│ emit('message-station', { stationSocketId, message })
│
▼ Server /admin
│ Nhận 'message-station' → agentNS.to(stationSocketId).emit('show-message', { message })
│
▼ Agent main.js
│ Nhận 'show-message'
│ → dialog.showMessageBox({
│     type: 'info',
│     title: 'Thông báo từ quản lý',
│     message: 'Hết giờ rồi, vui lòng tắt máy!',
│     buttons: ['OK']
│   })
│ → Popup hiện trên màn hình PC-02
```

### Luồng 6: Agent mất kết nối và reconnect

```
Mạng LAN gián đoạn hoặc server restart
│
▼ Agent Socket.IO detect disconnect
│ socket.on('disconnect') fires
│ → updateTrayTooltip('Disconnected')
│ → Console: "❌ Disconnected from server"
│
▼ Server
│ agentNS socket.on('disconnect') fires
│ → stations.delete(socket.id)
│ → adminNS.emit('station-offline', { stationId: 'PC-01' })
│ → adminNS.emit('station-list', [...]) → Dashboard cập nhật: PC-01 biến mất
│
▼ Agent Socket.IO auto reconnect
│ Cấu hình: reconnectionDelay: 3000ms, reconnectionAttempts: Infinity
│ → Thử kết nối lại mỗi 3 giây
│ → Khi server online lại:
│
▼ Agent reconnect thành công
│ socket.on('connect') fires
│ → Gửi lại screen-info
│ → updateTrayTooltip('Connected')
│
▼ Server nhận connection mới
│ → stationInfo mới (socketId mới)
│ → broadcast station-list → Dashboard: PC-01 🟢 online lại
```

---

## Tóm tắt kênh truyền dữ liệu

| Dữ liệu                     | Kênh       | Đường đi                                    |
| --------------------------- | ---------- | ------------------------------------------- |
| Danh sách máy trạm          | Socket.IO  | Server → Admin                              |
| Signaling (SDP, ICE)        | Socket.IO  | Admin ↔ Server ↔ Agent                      |
| Video stream màn hình       | WebRTC P2P | Agent → Admin (trực tiếp, không qua server) |
| Lệnh chuột/bàn phím         | Socket.IO  | Admin → Server → Agent                      |
| Lệnh quản lý (khóa, tắt...) | Socket.IO  | Admin → Server → Agent                      |
| Thông báo/tin nhắn          | Socket.IO  | Admin → Server → Agent                      |

**Điểm quan trọng**: Video stream đi trực tiếp P2P giữa Agent và Admin qua WebRTC, không qua server. Server chỉ làm signaling ban đầu và relay lệnh điều khiển. Điều này giảm tải cho server và đảm bảo latency thấp (<10ms trong LAN).

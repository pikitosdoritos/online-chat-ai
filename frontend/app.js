const usernameModal = document.getElementById("usernameModal");
const usernameForm = document.getElementById("usernameForm");
const usernameInput = document.getElementById("usernameInput");
const messageForm = document.getElementById("messageForm");
const messageInput = document.getElementById("messageInput");
const messageList = document.getElementById("messageList");
const statusBadge = document.getElementById("statusBadge");
const presenceBanner = document.getElementById("presenceBanner");

let username = "";
let socket = null;
let reconnectTimer = null;

function escapeHtml(unsafe) {
  const div = document.createElement("div");
  div.innerText = unsafe;
  return div.innerHTML;
}

function formatTime(isoTime) {
  const date = new Date(isoTime);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function setStatus(mode, label) {
  statusBadge.className = `status ${mode}`;
  statusBadge.textContent = label;
}

function showPresence(text) {
  presenceBanner.textContent = text;
  presenceBanner.classList.remove("hidden");
  setTimeout(() => {
    presenceBanner.classList.add("hidden");
  }, 2200);
}

function appendMessage(message, isOwnMessage = false) {
  const item = document.createElement("li");
  item.className = `message ${isOwnMessage ? "own" : ""}`;
  item.innerHTML = `
    <div class="message-author">${escapeHtml(message.username)}</div>
    <p class="message-content">${escapeHtml(message.content)}</p>
    <div class="message-time">${formatTime(message.created_at)}</div>
  `;
  messageList.appendChild(item);
  messageList.scrollTop = messageList.scrollHeight;
}

async function loadHistory() {
  const response = await fetch("/api/messages?limit=100");
  if (!response.ok) {
    throw new Error("Failed to load message history.");
  }
  const messages = await response.json();
  messageList.innerHTML = "";
  for (const message of messages) {
    appendMessage(message, message.username === username);
  }
}

function getSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const encodedUsername = encodeURIComponent(username);
  return `${protocol}://${window.location.host}/ws/chat?username=${encodedUsername}`;
}

function connectWebSocket() {
  if (!username) return;

  setStatus("connecting", "Connecting...");
  socket = new WebSocket(getSocketUrl());

  socket.addEventListener("open", () => {
    setStatus("online", "Online");
  });

  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "message") {
      appendMessage(payload, payload.username === username);
      return;
    }
    if (payload.type === "presence") {
      if (payload.event === "join") {
        showPresence(`${payload.username} joined (${payload.connected_count} online)`);
      } else if (payload.event === "leave") {
        showPresence(`${payload.username} left (${payload.connected_count} online)`);
      }
      return;
    }
    if (payload.type === "error") {
      showPresence(payload.message);
    }
  });

  socket.addEventListener("close", () => {
    setStatus("offline", "Offline");
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      connectWebSocket();
    }, 1800);
  });
}

usernameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = usernameInput.value.trim();
  if (!value) return;
  username = value;
  usernameModal.style.display = "none";

  try {
    await loadHistory();
  } catch (error) {
    showPresence("History unavailable, continuing without it.");
  }
  connectWebSocket();
  messageInput.focus();
});

messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(text);
  messageInput.value = "";
});

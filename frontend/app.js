const usernameModal = document.getElementById("usernameModal");
const usernameForm = document.getElementById("usernameForm");
const usernameInput = document.getElementById("usernameInput");
const messageForm = document.getElementById("messageForm");
const messageInput = document.getElementById("messageInput");
const messageList = document.getElementById("messageList");
const statusBadge = document.getElementById("statusBadge");
const presenceBanner = document.getElementById("presenceBanner");
const emojiToggle = document.getElementById("emojiToggle");
const emojiPicker = document.getElementById("emojiPicker");
const fileInput = document.getElementById("fileInput");
const uploadStatus = document.getElementById("uploadStatus");
const participantsList = document.getElementById("participantsList");

let username = "";
let socket = null;
let reconnectTimer = null;
let pendingUpload = null;
let audioContext = null;

const EMOJIS = ["😀", "😂", "😍", "😎", "🤖", "🔥", "🎉", "👍", "🙏", "❤️", "👀", "💡"];

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

function getUserColor(usernameValue) {
  const palette = [
    "#60A5FA",
    "#34D399",
    "#F472B6",
    "#FBBF24",
    "#A78BFA",
    "#22D3EE",
    "#FB7185",
    "#4ADE80",
    "#F97316",
    "#818CF8",
  ];
  if (!usernameValue) return palette[0];
  let total = 0;
  for (let i = 0; i < usernameValue.length; i += 1) {
    total += (i + 1) * usernameValue.charCodeAt(i);
  }
  return palette[total % palette.length];
}

function getMessageColor(message) {
  return message.user_color || getUserColor(message.username);
}

function hexToRgba(hexColor, alpha) {
  const clean = (hexColor || "").replace("#", "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    return `rgba(255, 255, 255, ${alpha})`;
  }
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function renderParticipants(participants) {
  participantsList.innerHTML = "";
  for (const participant of participants) {
    const li = document.createElement("li");
    li.className = "participant-item";
    li.innerHTML = `
      <span class="participant-dot" style="background:${escapeHtml(participant.color || getUserColor(participant.username))};"></span>
      <span>${escapeHtml(participant.username)}</span>
    `;
    participantsList.appendChild(li);
  }
}

function playSendSound() {
  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    const now = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(820, now);
    oscillator.frequency.exponentialRampToValueAtTime(560, now + 0.08);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.1);
  } catch (error) {
    // Ignore audio issues on unsupported browsers.
  }
}

function mediaMarkup(message) {
  if (!message.file_path || message.deleted) return "";
  if (message.message_type === "image") {
    return `<img class="media-preview" src="${escapeHtml(message.file_path)}" alt="${escapeHtml(message.original_file_name || "Image")}" />`;
  }
  if (message.message_type === "video") {
    return `<video class="media-preview" controls src="${escapeHtml(message.file_path)}"></video>`;
  }
  if (message.message_type === "audio") {
    return `<audio class="media-preview" controls src="${escapeHtml(message.file_path)}"></audio>`;
  }
  return `<a class="file-link" href="${escapeHtml(message.file_path)}" target="_blank" rel="noopener noreferrer" download>${escapeHtml(message.original_file_name || "Download file")}</a>`;
}

function actionButtonsMarkup(message, isOwnMessage) {
  if (!isOwnMessage || message.deleted) return "";
  const canEdit = message.message_type === "text";
  return `
    <div class="message-actions">
      ${canEdit ? '<button type="button" class="action-btn" data-action="edit">Edit</button>' : ""}
      <button type="button" class="action-btn" data-action="delete">Delete</button>
    </div>
  `;
}

function messageTemplate(message, isOwnMessage = false) {
  const editedLabel = message.edited ? '<span class="edited-label">(edited)</span>' : "";
  const authorColor = getMessageColor(message);
  return `
    <div class="message-author">
      <span class="author-dot" style="background:${escapeHtml(authorColor)};"></span>
      ${escapeHtml(message.username)}
    </div>
    <p class="message-content">${escapeHtml(message.content || "")}</p>
    ${mediaMarkup(message)}
    <div class="message-time">${formatTime(message.created_at)} ${editedLabel}</div>
    ${actionButtonsMarkup(message, isOwnMessage)}
  `;
}

function createOrUpdateMessage(message) {
  const isOwnMessage = message.username === username;
  const baseColor = getMessageColor(message);
  let item = document.querySelector(`[data-message-id="${message.id}"]`);
  if (!item) {
    item = document.createElement("li");
    item.dataset.messageId = String(message.id);
    messageList.appendChild(item);
  }
  item.className = `message ${isOwnMessage ? "own" : ""} ${message.deleted ? "deleted" : ""}`;
  item.style.setProperty("--message-bg", hexToRgba(baseColor, 0.12));
  item.style.setProperty("--message-border", hexToRgba(baseColor, 0.33));
  item.style.setProperty("--message-bg-own", hexToRgba(baseColor, 0.2));
  item.style.setProperty("--message-border-own", hexToRgba(baseColor, 0.5));
  item.innerHTML = messageTemplate(message, isOwnMessage);
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
    createOrUpdateMessage(message);
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
    if (payload.type === "message_created") {
      createOrUpdateMessage(payload.message);
      return;
    }
    if (payload.type === "message_updated") {
      createOrUpdateMessage(payload.message);
      return;
    }
    if (payload.type === "message_deleted") {
      createOrUpdateMessage(payload.message);
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
    if (payload.type === "participants_update") {
      renderParticipants(payload.participants || []);
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

function sendSocketPayload(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

function setUploadStatus(text) {
  if (!text) {
    uploadStatus.textContent = "";
    uploadStatus.classList.add("hidden");
    return;
  }
  uploadStatus.textContent = text;
  uploadStatus.classList.remove("hidden");
}

function buildEmojiPicker() {
  emojiPicker.innerHTML = "";
  for (const emoji of EMOJIS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "emoji-option";
    button.textContent = emoji;
    button.addEventListener("click", () => {
      messageInput.value += emoji;
      messageInput.focus();
    });
    emojiPicker.appendChild(button);
  }
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
  if (!pendingUpload && !text) return;

  if (pendingUpload) {
    const sent = sendSocketPayload({
      action: "send",
      content: text || pendingUpload.original_file_name || "Shared a file",
      message_type: pendingUpload.message_type,
      file_path: pendingUpload.file_path,
      original_file_name: pendingUpload.original_file_name,
    });
    if (!sent) return;
    playSendSound();
    pendingUpload = null;
    fileInput.value = "";
    setUploadStatus("");
    messageInput.value = "";
    return;
  }

  const sent = sendSocketPayload({
    action: "send",
    content: text,
    message_type: "text",
  });
  if (!sent) return;
  playSendSound();
  messageInput.value = "";
});

emojiToggle.addEventListener("click", () => {
  emojiPicker.classList.toggle("hidden");
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  try {
    setUploadStatus("Uploading...");
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || "Upload failed.");
    }
    pendingUpload = data;
    setUploadStatus(`Ready to send: ${data.original_file_name}`);
  } catch (error) {
    pendingUpload = null;
    setUploadStatus(error.message || "Upload failed.");
  }
});

messageList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const action = target.dataset.action;
  if (!action) return;
  const item = target.closest("[data-message-id]");
  if (!item) return;
  const messageId = Number(item.getAttribute("data-message-id"));
  if (!Number.isFinite(messageId)) return;

  if (action === "edit") {
    const currentTextNode = item.querySelector(".message-content");
    const currentText = currentTextNode ? currentTextNode.textContent || "" : "";
    const next = window.prompt("Edit your message", currentText);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    sendSocketPayload({
      action: "edit",
      id: messageId,
      content: trimmed,
    });
    return;
  }

  if (action === "delete") {
    const confirmed = window.confirm("Delete this message?");
    if (!confirmed) return;
    sendSocketPayload({
      action: "delete",
      id: messageId,
    });
  }
});

buildEmojiPicker();

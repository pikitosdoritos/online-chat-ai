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
const editModal = document.getElementById("editModal");
const editForm = document.getElementById("editForm");
const editInput = document.getElementById("editInput");
const editCancelBtn = document.getElementById("editCancelBtn");
const deleteModal = document.getElementById("deleteModal");
const deleteConfirmBtn = document.getElementById("deleteConfirmBtn");
const deleteCancelBtn = document.getElementById("deleteCancelBtn");

let username = "";
let socket = null;
let reconnectTimer = null;
let pendingUpload = null;
let audioContext = null;
let participantUsernames = [];
let activeMessageId = null;
const userColorMap = new Map();
const USERNAME_STORAGE_KEY = "glass_chat_username";

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

function hashUsername(usernameValue) {
  let hash = 0;
  for (let i = 0; i < usernameValue.length; i += 1) {
    hash = (hash * 31 + usernameValue.charCodeAt(i)) % 360;
  }
  return Math.abs(hash);
}

function rebuildUserColors() {
  const namesFromMessages = Array.from(document.querySelectorAll("[data-username]"))
    .map((node) => node.getAttribute("data-username"))
    .filter(Boolean);
  const allNames = [...new Set([...participantUsernames, ...namesFromMessages])].sort((a, b) =>
    a.localeCompare(b)
  );

  const usedHues = new Set();
  userColorMap.clear();
  for (const name of allNames) {
    let hue = hashUsername(name);
    while (usedHues.has(hue)) {
      hue = (hue + 29) % 360;
    }
    usedHues.add(hue);
    userColorMap.set(name, `hsl(${hue} 85% 60%)`);
  }
}

function getUserColor(usernameValue) {
  return userColorMap.get(usernameValue) || "#60A5FA";
}

function getMessageColor(message) {
  return getUserColor(message.username);
}

function colorToRgba(colorValue, alpha) {
  if (colorValue.startsWith("#")) {
    const clean = colorValue.replace("#", "").trim();
    if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
      return `rgba(255, 255, 255, ${alpha})`;
    }
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (colorValue.startsWith("hsl(")) {
    return colorValue.replace("hsl(", "hsla(").replace(")", ` / ${alpha})`);
  }
  return `rgba(255, 255, 255, ${alpha})`;
}

function refreshMessageColors() {
  const items = document.querySelectorAll("[data-message-id]");
  for (const item of items) {
    const author = item.getAttribute("data-username") || "";
    const bubble = item.querySelector(".message-bubble");
    if (!author || !bubble) continue;
    const color = getUserColor(author);
    bubble.style.setProperty("--message-bg", colorToRgba(color, 0.12));
    bubble.style.setProperty("--message-border", colorToRgba(color, 0.33));
    bubble.style.setProperty("--message-bg-own", colorToRgba(color, 0.2));
    bubble.style.setProperty("--message-border-own", colorToRgba(color, 0.5));
    const dot = item.querySelector(".author-dot");
    if (dot) {
      dot.style.background = color;
    }
  }
}

function renderParticipants(participants) {
  participantUsernames = (participants || []).map((participant) => participant.username).filter(Boolean);
  rebuildUserColors();
  participantsList.innerHTML = "";
  for (const participant of participants || []) {
    const li = document.createElement("li");
    li.className = "participant-item";
    const participantColor = getUserColor(participant.username);
    li.innerHTML = `
      <span class="participant-dot" style="background:${escapeHtml(participantColor)};"></span>
      <span>${escapeHtml(participant.username)}</span>
    `;
    participantsList.appendChild(li);
  }
  refreshMessageColors();
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
    <div class="message-side-actions">
      ${canEdit ? '<button type="button" class="action-btn" data-action="edit">Edit</button>' : ""}
      <button type="button" class="action-btn danger" data-action="delete">Delete</button>
    </div>
  `;
}

function bubbleTemplate(message) {
  const editedLabel = message.edited ? '<span class="edited-label">(edited)</span>' : "";
  const authorColor = getMessageColor(message);
  const ownMessageMenu =
    message.username === username && !message.deleted
      ? '<button type="button" class="message-menu-btn" data-action="toggle-menu" aria-label="Message actions">⋯</button>'
      : "";
  return `
    ${ownMessageMenu}
    <div class="message-author">
      <span class="author-dot" style="background:${escapeHtml(authorColor)};"></span>
      ${escapeHtml(message.username)}
    </div>
    <p class="message-content">${escapeHtml(message.content || "")}</p>
    ${mediaMarkup(message)}
    <div class="message-time">${formatTime(message.created_at)} ${editedLabel}</div>
  `;
}

function createOrUpdateMessage(message) {
  let item = document.querySelector(`[data-message-id="${message.id}"]`);
  if (!item) {
    item = document.createElement("li");
    item.dataset.messageId = String(message.id);
    messageList.appendChild(item);
  }

  item.dataset.username = message.username;
  const isOwnMessage = message.username === username;
  const baseColor = getMessageColor(message);
  item.className = `message-item ${isOwnMessage ? "own" : ""} ${message.deleted ? "deleted" : ""}`;
  item.innerHTML = `
    <div class="message-shell">
      ${actionButtonsMarkup(message, isOwnMessage)}
      <div class="message-bubble ${isOwnMessage ? "own" : ""} ${message.deleted ? "deleted" : ""}">
        ${bubbleTemplate(message)}
      </div>
    </div>
  `;

  const bubble = item.querySelector(".message-bubble");
  if (bubble) {
    bubble.style.setProperty("--message-bg", colorToRgba(baseColor, 0.12));
    bubble.style.setProperty("--message-border", colorToRgba(baseColor, 0.33));
    bubble.style.setProperty("--message-bg-own", colorToRgba(baseColor, 0.2));
    bubble.style.setProperty("--message-border-own", colorToRgba(baseColor, 0.5));
  }
  messageList.scrollTop = messageList.scrollHeight;
}

async function loadHistory() {
  const response = await fetch("/api/messages?limit=100");
  if (!response.ok) {
    throw new Error("Failed to load message history.");
  }
  const messages = await response.json();
  messageList.innerHTML = "";
  const uniqueNames = [...new Set(messages.map((message) => message.username).filter(Boolean))];
  participantUsernames = [...new Set([...participantUsernames, ...uniqueNames])];
  rebuildUserColors();
  for (const message of messages) {
    createOrUpdateMessage(message);
  }
  refreshMessageColors();
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

function closeAllMessageMenus() {
  document.querySelectorAll(".message-shell.menu-open").forEach((node) => {
    node.classList.remove("menu-open");
  });
}

function openEditDialog(messageId, currentText) {
  activeMessageId = messageId;
  editInput.value = currentText || "";
  if (typeof editModal.showModal === "function") {
    editModal.showModal();
  } else {
    editModal.classList.remove("hidden");
  }
  setTimeout(() => {
    editInput.focus();
    editInput.select();
  }, 0);
}

function closeEditDialog() {
  activeMessageId = null;
  if (typeof editModal.close === "function" && editModal.open) {
    editModal.close();
  } else {
    editModal.classList.add("hidden");
  }
  editInput.value = "";
}

function openDeleteDialog(messageId) {
  activeMessageId = messageId;
  if (typeof deleteModal.showModal === "function") {
    deleteModal.showModal();
  } else {
    deleteModal.classList.remove("hidden");
  }
}

function closeDeleteDialog() {
  activeMessageId = null;
  if (typeof deleteModal.close === "function" && deleteModal.open) {
    deleteModal.close();
  } else {
    deleteModal.classList.add("hidden");
  }
}

async function startChatSession(chosenUsername) {
  username = chosenUsername.trim();
  if (!username) return;
  localStorage.setItem(USERNAME_STORAGE_KEY, username);
  usernameModal.style.display = "none";
  usernameInput.value = username;

  try {
    await loadHistory();
  } catch (error) {
    showPresence("History unavailable, continuing without it.");
  }
  connectWebSocket();
  messageInput.focus();
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
  await startChatSession(value);
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
  const shell = item.querySelector(".message-shell");

  if (action === "toggle-menu") {
    const isOpen = shell && shell.classList.contains("menu-open");
    closeAllMessageMenus();
    if (shell && !isOpen) {
      shell.classList.add("menu-open");
    }
    return;
  }

  if (action === "edit") {
    const currentTextNode = item.querySelector(".message-content");
    const currentText = currentTextNode ? currentTextNode.textContent || "" : "";
    closeAllMessageMenus();
    openEditDialog(messageId, currentText);
    return;
  }

  if (action === "delete") {
    closeAllMessageMenus();
    openDeleteDialog(messageId);
  }
});

editForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const trimmed = editInput.value.trim();
  if (!trimmed || !Number.isFinite(activeMessageId)) return;
  sendSocketPayload({
    action: "edit",
    id: activeMessageId,
    content: trimmed,
  });
  closeEditDialog();
});

editCancelBtn.addEventListener("click", () => {
  closeEditDialog();
});

deleteCancelBtn.addEventListener("click", () => {
  closeDeleteDialog();
});

deleteConfirmBtn.addEventListener("click", () => {
  if (!Number.isFinite(activeMessageId)) return;
  sendSocketPayload({
    action: "delete",
    id: activeMessageId,
  });
  closeDeleteDialog();
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const clickedMenuButton = target.closest(".message-menu-btn");
  const clickedActions = target.closest(".message-side-actions");
  if (!clickedMenuButton && !clickedActions) {
    closeAllMessageMenus();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeAllMessageMenus();
  }
});

editModal.addEventListener("click", (event) => {
  if (event.target === editModal && editModal.open) {
    closeEditDialog();
  }
});

deleteModal.addEventListener("click", (event) => {
  if (event.target === deleteModal && deleteModal.open) {
    closeDeleteDialog();
  }
});

editModal.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeEditDialog();
});

deleteModal.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDeleteDialog();
});

const rememberedUsername = localStorage.getItem(USERNAME_STORAGE_KEY);
if (rememberedUsername && rememberedUsername.trim()) {
  startChatSession(rememberedUsername.trim());
}

buildEmojiPicker();

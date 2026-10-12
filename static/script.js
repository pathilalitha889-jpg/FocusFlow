const $ = (id) => document.getElementById(id);
const USER_KEY = document.body.dataset.userId || "default";
const STATS_KEY = `focusflow_stats_v1_user_${USER_KEY}`;
const REMINDER_KEY = `focusflow_reminders_v1_user_${USER_KEY}`;

let tasks = [];
let activeFilter = "all";
let activeView = "all";
let stats = loadStats();
let timerSeconds = 25 * 60;
let timerInterval = null;
let selectedMinutes = 25;
let selectedMode = "focus";
let reminderInterval = null;
let audioContext = null;
let toastTimeout = null;
let reminderState = loadReminderState();

function loadStats() {
    try {
        const saved = JSON.parse(localStorage.getItem(STATS_KEY) || "{}");
        return {
            focusMinutes: Number(saved.focusMinutes) || 0,
            streak: Number(saved.streak) || 0,
            lastStudyDate: saved.lastStudyDate || ""
        };
    } catch {
        return { focusMinutes: 0, streak: 0, lastStudyDate: "" };
    }
}
function saveStats() {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats));
}
function loadReminderState() {
    try {
        return JSON.parse(localStorage.getItem(REMINDER_KEY) || "{}");
    } catch {
        return {};
    }
}
function saveReminderState() {
    try { localStorage.setItem(REMINDER_KEY, JSON.stringify(reminderState)); } catch {}
}
function localDate(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}
function updateStudyStreak() {
    const today = localDate();
    if (stats.lastStudyDate === today) return;
    if (!stats.lastStudyDate) stats.streak = 1;
    else {
        const previous = new Date(stats.lastStudyDate + "T12:00:00");
        const current = new Date(today + "T12:00:00");
        const difference = Math.round((current - previous) / 86400000);
        stats.streak = difference === 1 ? stats.streak + 1 : 1;
    }
    stats.lastStudyDate = today;
    saveStats();
}
async function apiRequest(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...(options.headers || {})
        }
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
}
async function loadTasks() {
    const data = await apiRequest("/api/tasks");
    return data.map(task => ({
        ...task,
        id: String(task.id),
        completed: Boolean(task.completed),
        completedDate: task.completed_date || ""
    }));
}
function formatDate(dateString) {
    if (!dateString) return "";
    return new Date(dateString + "T12:00:00").toLocaleDateString("en-IN", {
        day: "numeric", month: "short"
    });
}
function formatTaskDeadline(deadline) {
    if (!deadline) return "";
    if (!deadline.includes("T")) return formatDate(deadline); // existing date-only task
    const parsed = new Date(deadline);
    if (Number.isNaN(parsed.getTime())) return formatDate(deadline.slice(0, 10));
    return parsed.toLocaleString("en-IN", {
        day: "numeric", month: "short", hour: "numeric", minute: "2-digit"
    });
}
function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, char => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
}
function getTaskPriority(task) {
    if (!task.deadline) return { rank: 4, label: "No deadline", className: "priority-none" };
    const today = localDate();
    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrow = localDate(tomorrowDate);
    const deadlineDate = task.deadline.slice(0, 10);
    if (deadlineDate < today) return { rank: 0, label: "Overdue", className: "priority-overdue" };
    if (deadlineDate === today) return { rank: 1, label: "Due today", className: "priority-today" };
    if (deadlineDate === tomorrow) return { rank: 2, label: "Due tomorrow", className: "priority-tomorrow" };
    return { rank: 3, label: "Upcoming", className: "priority-upcoming" };
}
function showError(message) {
    const error = $("errorMessage");
    if (error) {
        error.textContent = message;
        error.hidden = false;
    } else {
        alert(message);
    }
}
function clearError() {
    const error = $("errorMessage");
    if (error) { error.textContent = ""; error.hidden = true; }
}
function getVisibleTasks() {
    return tasks.filter(task => {
        if (activeView === "pending" && task.completed) return false;
        if (activeView === "completed" && !task.completed) return false;
        if (activeFilter === "pending" && task.completed) return false;
        if (activeFilter === "completed" && !task.completed) return false;
        return true;
    });
}
function renderTasks() {
    const list = $("taskList");
    if (!list) return;
    const visible = getVisibleTasks();
    const sorted = [...visible].sort((a, b) => {
        if (a.completed !== b.completed) return Number(a.completed) - Number(b.completed);
        if (a.completed) return (b.completed_date || "").localeCompare(a.completed_date || "");
        const pa = getTaskPriority(a), pb = getTaskPriority(b);
        if (pa.rank !== pb.rank) return pa.rank - pb.rank;
        return (a.deadline || "9999-12-31").localeCompare(b.deadline || "9999-12-31");
    });
    if ($("visibleTaskCount")) $("visibleTaskCount").textContent = sorted.length;
    if (sorted.length === 0) {
        list.innerHTML = `<div class="empty-state"><span class="empty-icon">✦</span><strong>${activeView === "completed" || activeFilter === "completed" ? "No completed tasks yet" : activeView === "pending" || activeFilter === "pending" ? "You're all caught up!" : "Your plan starts here"}</strong><p>${activeView === "completed" || activeFilter === "completed" ? "Complete a task and your progress will appear here." : activeView === "pending" || activeFilter === "pending" ? "Add a task whenever you're ready." : "Add your first task and build momentum."}</p></div>`;
        return;
    }
    list.innerHTML = sorted.map(task => {
        const priority = getTaskPriority(task);
        return `<div class="task-row ${task.completed ? "done" : ""}">
            <input class="task-check" type="checkbox" data-action="toggle" data-id="${escapeHTML(task.id)}" aria-label="Complete ${escapeHTML(task.title)}" ${task.completed ? "checked" : ""}>
            <div class="task-info">
                <span class="task-name">${escapeHTML(task.title)}</span>
                <div class="task-meta">
                    <span class="category-pill">${escapeHTML(task.category)}</span>
                    ${task.deadline ? `<span class="task-deadline">Due ${escapeHTML(formatTaskDeadline(task.deadline))}</span>` : ""}
                    ${!task.completed ? `<span class="priority-badge ${priority.className}">${priority.label}</span>` : ""}
                </div>
            </div>
            <button class="delete-btn" type="button" data-action="delete" data-id="${escapeHTML(task.id)}" aria-label="Delete ${escapeHTML(task.title)}">Delete</button>
        </div>`;
    }).join("");
}
function renderStats() {
    const total = tasks.length;
    const completed = tasks.filter(task => task.completed).length;
    const pending = total - completed;
    if ($("totalCount")) $("totalCount").textContent = total;
    if ($("completedCount")) $("completedCount").textContent = completed;
    if ($("pendingCount")) $("pendingCount").textContent = pending;
    if ($("focusMinutes")) $("focusMinutes").textContent = stats.focusMinutes;
    if ($("taskProgress")) $("taskProgress").style.width = `${total ? completed / total * 100 : 0}%`;
    if ($("progressText")) $("progressText").textContent = `${total ? Math.round(completed / total * 100) : 0}% completed`;
}
function renderWeek() {
    const dateElement = $("todayDate");
    if (dateElement) {
        dateElement.textContent = new Date().toLocaleDateString("en-IN", {
            weekday: "long", day: "numeric", month: "short"
        }).toUpperCase();
    }
}
function renderChart() {
    const chart = $("chartArea");
    if (!chart) return;
    const today = new Date();
    const start = new Date(today);
    start.setHours(12, 0, 0, 0);
    start.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const counts = [];
    for (let i = 0; i < 7; i++) {
        const date = new Date(start);
        date.setDate(start.getDate() + i);
        const key = localDate(date);
        const count = tasks.filter(task => task.completed && task.completedDate === key).length;
        counts.push({ day: date.toLocaleDateString("en", { weekday: "short" }), count, today: key === localDate() });
    }
    const maximum = Math.max(1, ...counts.map(day => day.count));
    chart.innerHTML = counts.map(day => `<div class="chart-column ${day.today ? "today-chart" : ""}">
        <div class="chart-track"><div class="chart-bar" style="height:${Math.max(3, day.count / maximum * 100)}%"></div></div>
        <span class="chart-label">${day.day}</span>
    </div>`).join("");
    const total = counts.reduce((sum, day) => sum + day.count, 0);
    if ($("chartTotal")) $("chartTotal").textContent = `${total} ${total === 1 ? "win" : "wins"}`;
}
function renderAll() {
    renderTasks();
    renderStats();
    renderWeek();
    renderChart();
}
function setActiveFilter(filter) {
    activeFilter = filter;
    document.querySelectorAll(".filter-btn").forEach(button => {
        button.classList.toggle("selected", button.dataset.filter === filter);
    });
    renderTasks();
}
function setActiveView(view) {
    activeView = view;
    activeFilter = "all";
    document.querySelectorAll(".nav-item").forEach(button => {
        button.classList.toggle("active", button.dataset.view === view);
    });
    document.querySelectorAll(".filter-btn").forEach(button => {
        button.classList.toggle("selected", button.dataset.filter === "all");
    });
    if ($("taskHeading")) {
        $("taskHeading").firstChild.textContent =
            view === "pending" ? "To do " : view === "completed" ? "Completed " : "My tasks ";
    }
    renderTasks();
}
function reminderStorageKey(task, kind) {
    return `${task.id}|${task.deadline}|${kind}`;
}
function hasReminderFired(key) {
    return Boolean(reminderState[key]);
}
function markReminderFired(key) {
    reminderState[key] = new Date().toISOString();
    saveReminderState();
}
function showReminderToast(title, message) {
    const toast = $("reminderToast");
    if (!toast) return;
    $("reminderToastTitle").textContent = title;
    $("reminderToastMessage").textContent = message;
    toast.hidden = false;
    if (toastTimeout !== null) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { toast.hidden = true; }, 15000);
}
function playAlarmSound() {
    if (!audioContext || audioContext.state !== "running") return;
    // Three short synthesized beeps. No external audio file is needed.
    const baseTime = audioContext.currentTime + 0.02;
    for (let i = 0; i < 3; i++) {
        const startAt = baseTime + i * 0.38;
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(880, startAt);
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(0.22, startAt + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.23);
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start(startAt);
        oscillator.stop(startAt + 0.25);
    }
}
function sendBrowserNotification(title, message, tag) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try {
        const notification = new Notification(title, {
            body: message,
            tag,
            requireInteraction: true
        });
        notification.onclick = () => {
            window.focus();
            notification.close();
        };
    } catch (error) {
        console.warn("Browser notification could not be shown:", error);
    }
}
function triggerTaskReminder(task, kind) {
    const key = reminderStorageKey(task, kind);
    if (hasReminderFired(key)) return;
    markReminderFired(key); // mark first so interval ticks cannot repeat it
    const dueText = formatTaskDeadline(task.deadline);
    const title = kind === "before" ? "Deadline in 5 minutes" : "Task deadline reached";
    const message = kind === "before"
        ? `${task.title} is due at ${dueText}. Get ready to finish it.`
        : `${task.title} was due at ${dueText}.`;
    showReminderToast(title, message);
    playAlarmSound();
    sendBrowserNotification(title, message, `focusflow-${key}`);
}
function checkTaskReminders() {
    const now = Date.now();
    const fiveMinutes = 5 * 60 * 1000;
    const lateGrace = 2 * 60 * 60 * 1000;
    for (const task of tasks) {
        if (task.completed || !task.deadline || !task.deadline.includes("T")) continue;
        const dueAt = new Date(task.deadline).getTime();
        if (!Number.isFinite(dueAt)) continue;
        const remaining = dueAt - now;
        if (remaining > 0 && remaining <= fiveMinutes) {
            triggerTaskReminder(task, "before");
        }
        if (remaining <= 0 && now - dueAt <= lateGrace) {
            triggerTaskReminder(task, "due");
        }
    }
}
function updateReminderStatus(message) {
    if ($("reminderStatus")) $("reminderStatus").textContent = message;
}
async function enableTaskReminders() {
    const button = $("enableRemindersBtn");
    if (button) button.disabled = true;
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
            if (!audioContext) audioContext = new AudioContextClass();
            if (audioContext.state !== "running") await audioContext.resume();
        }
        let notificationStatus = "";
        if (!("Notification" in window)) {
            notificationStatus = "This browser does not support desktop notifications.";
        } else if (Notification.permission === "granted") {
            notificationStatus = "Browser notifications are allowed.";
        } else if (Notification.permission === "denied") {
            notificationStatus = "Browser notifications are blocked; allow them in site settings.";
        } else {
            const permission = await Notification.requestPermission();
            notificationStatus = permission === "granted"
                ? "Browser notifications are allowed."
                : "Notifications were not allowed; this tab can still show reminders.";
        }
        if (audioContext && audioContext.state === "running") {
            playAlarmSound(); // instant sound test so the user knows the alarm is enabled
            updateReminderStatus(`Alerts enabled for this tab. ${notificationStatus} Keep FocusFlow open for scheduled reminders.`);
            if (button) button.textContent = "Alerts enabled ✓";
        } else {
            updateReminderStatus(`${notificationStatus} Sound is unavailable in this browser. Keep this tab open for on-page reminders.`);
            if (button) button.textContent = "Try enabling again";
        }
    } catch (error) {
        console.error(error);
        updateReminderStatus("Could not enable alerts. Check this site's browser permissions and try again.");
    } finally {
        if (button) button.disabled = false;
    }
}
if ($("enableRemindersBtn")) {
    $("enableRemindersBtn").addEventListener("click", enableTaskReminders);
}
if ($("closeReminderToast")) {
    $("closeReminderToast").addEventListener("click", () => {
        if ($("reminderToast")) $("reminderToast").hidden = true;
        if (toastTimeout !== null) clearTimeout(toastTimeout);
    });
}
if ("Notification" in window && Notification.permission === "granted") {
    updateReminderStatus("Browser notifications are allowed. Click Enable alerts to reactivate alarm sound in this tab.");
}
reminderInterval = setInterval(checkTaskReminders, 10000);
document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkTaskReminders();
});
if ($("addBtn")) {
    $("addBtn").addEventListener("click", () => {
        const form = $("taskForm");
        if (!form) return;
        form.hidden = !form.hidden;
        if (!form.hidden && $("taskInput")) $("taskInput").focus();
    });
}
if ($("cancelBtn")) {
    $("cancelBtn").addEventListener("click", () => {
        $("taskForm").reset();
        $("taskForm").hidden = true;
        clearError();
    });
}
if ($("taskForm")) {
    $("taskForm").addEventListener("submit", async event => {
        event.preventDefault();
        clearError();
        const title = $("taskInput").value.trim();
        if (!title) { showError("Please enter a task name."); return; }
        const deadline = $("taskDeadline").value;
        if (deadline && deadline < "0001-01-01") { showError("Please choose a valid deadline."); return; }
        const button = $("saveTaskBtn");
        button.disabled = true;
        try {
            await apiRequest("/api/tasks", {
                method: "POST",
                body: JSON.stringify({
                    title,
                    category: $("taskCategory").value,
                    deadline
                })
            });
            tasks = await loadTasks();
            $("taskForm").reset();
            $("taskForm").hidden = true;
            activeView = "all";
            activeFilter = "all";
            document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.view === "all"));
            document.querySelectorAll(".filter-btn").forEach(item => item.classList.toggle("selected", item.dataset.filter === "all"));
            if ($("taskHeading")) $("taskHeading").firstChild.textContent = "My tasks ";
            renderAll();
        } catch (error) {
            console.error(error);
            showError(error.message || "Could not save task. Check that Flask is running.");
        } finally {
            button.disabled = false;
        }
    });
}
if ($("taskList")) {
    $("taskList").addEventListener("change", async event => {
        const checkbox = event.target.closest('[data-action="toggle"]');
        if (!checkbox) return;
        clearError();
        const id = checkbox.dataset.id;
        checkbox.disabled = true;
        try {
            await apiRequest(`/api/tasks/${encodeURIComponent(id)}`, {
                method: "PATCH",
                body: JSON.stringify({ completed: checkbox.checked })
            });
            tasks = await loadTasks();
            if (checkbox.checked) updateStudyStreak();
            renderAll();
        } catch (error) {
            console.error(error);
            checkbox.checked = !checkbox.checked;
            showError(error.message);
        } finally {
            checkbox.disabled = false;
        }
    });
    $("taskList").addEventListener("click", async event => {
        const button = event.target.closest('[data-action="delete"]');
        if (!button) return;
        if (!confirm("Delete this task?")) return;
        clearError();
        button.disabled = true;
        try {
            await apiRequest(`/api/tasks/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" });
            tasks = await loadTasks();
            renderAll();
        } catch (error) {
            console.error(error);
            showError(error.message);
            button.disabled = false;
        }
    });
}
document.querySelectorAll(".filter-btn").forEach(button => {
    button.addEventListener("click", () => setActiveFilter(button.dataset.filter || "all"));
});
document.querySelectorAll(".nav-item").forEach(button => {
    button.addEventListener("click", () => setActiveView(button.dataset.view || "all"));
});
function renderTimer() {
    if (!$("timer") || !$("timerCircle")) return;
    const minutes = Math.floor(timerSeconds / 60);
    const seconds = timerSeconds % 60;
    $("timer").textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    const total = selectedMinutes * 60;
    const progress = total ? (total - timerSeconds) / total : 0;
    const degrees = Math.min(360, Math.max(0, progress * 360));
    const color = selectedMode === "focus" ? "#8a76e5" : "#70b990";
    $("timerCircle").style.background = `conic-gradient(${color} ${degrees}deg, #e7e0ff ${degrees}deg)`;
}
function stopTimer() {
    if (timerInterval !== null) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}
function chooseTimer(minutes, mode) {
    stopTimer();
    selectedMinutes = minutes;
    selectedMode = mode;
    timerSeconds = minutes * 60;
    if ($("startBtn")) $("startBtn").textContent = "▶ Start focus";
    if ($("timerMode")) $("timerMode").textContent = mode === "focus" ? "FOCUS SESSION" : "SHORT BREAK";
    document.querySelectorAll(".mode-btn").forEach(button => button.classList.toggle("active", button.dataset.mode === mode));
    renderTimer();
}
document.querySelectorAll(".mode-btn").forEach(button => {
    button.addEventListener("click", () => chooseTimer(Number(button.dataset.minutes), button.dataset.mode));
});
if ($("startBtn")) {
    $("startBtn").addEventListener("click", () => {
        if (timerInterval !== null) {
            stopTimer();
            $("startBtn").textContent = "▶ Resume";
            return;
        }
        if (timerSeconds <= 0) return;
        $("startBtn").textContent = "Ⅱ Pause session";
        timerInterval = setInterval(() => {
            timerSeconds--;
            renderTimer();
            if (timerSeconds <= 0) {
                stopTimer();
                if (selectedMode === "focus") {
                    stats.focusMinutes += selectedMinutes;
                    updateStudyStreak();
                    saveStats();
                }
                $("startBtn").textContent = "✓ Session complete";
                renderStats();
                alert(selectedMode === "focus"
                    ? "Focus session complete! Great work. 💜"
                    : "Break complete! Ready when you are. 🌱");
            }
        }, 1000);
    });
}
if ($("resetBtn")) {
    $("resetBtn").addEventListener("click", () => chooseTimer(selectedMinutes, selectedMode));
}
(async function initializePage() {
    try {
        tasks = await loadTasks();
        clearError();
    } catch (error) {
        console.error(error);
        showError("Could not connect to the backend. Make sure Flask is running, then refresh this page.");
    }
    renderAll();
    chooseTimer(25, "focus");
    checkTaskReminders();
})();

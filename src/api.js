// api.js
import { queueAction, flushQueue } from "./offlineQueue.js";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "https://your-server.example.com";
const TOKEN_KEY = "site-clock-token";
const EMPLOYEE_KEY = "site-clock-employee";

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function saveSession(token, employee) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(EMPLOYEE_KEY, JSON.stringify(employee));
}

function getSavedEmployee() {
  const raw = localStorage.getItem(EMPLOYEE_KEY);
  return raw ? JSON.parse(raw) : null;
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EMPLOYEE_KEY);
}

async function apiFetch(path, { method = "GET", body } = {}) {
  const token = getToken();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try {
    data = await res.json();
  } catch (parseErr) {
    // The server returned something that isn't JSON at all (a plain
    // 404/502 error page rather than our API actually responding) --
    // surface a clear message instead of a cryptic parse error.
    throw new Error(`The server didn't respond as expected (status ${res.status}). Please try again in a moment.`);
  }
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function login(email, pin) {
  const data = await apiFetch("/api/auth/login", { method: "POST", body: { email, pin } });
  saveSession(data.token, data.employee);
  return data.employee;
}

async function restoreSession() {
  if (!getToken()) return null;
  try {
    return await apiFetch("/api/auth/me");
  } catch {
    clearSession();
    return null;
  }
}

async function forgotPin(email) {
  return apiFetch("/api/auth/forgot-pin", { method: "POST", body: { email } });
}

async function getMySchedule(start, end) {
  const params = new URLSearchParams();
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  const qs = params.toString();
  return apiFetch(`/api/schedule/me${qs ? `?${qs}` : ""}`);
}

async function getCustomers() {
  return apiFetch("/api/schedule/customers");
}

async function getScheduleUnseenCount() {
  return apiFetch("/api/schedule/unseen-count");
}

async function getMyTimeOffRequests() {
  return apiFetch("/api/schedule/time-off");
}

async function requestTimeOff(startDate, endDate, note) {
  return apiFetch("/api/schedule/time-off", {
    method: "POST",
    body: { start_date: startDate, end_date: endDate, note: note || undefined },
  });
}

async function cancelTimeOffRequest(id) {
  return apiFetch(`/api/schedule/time-off/${id}`, { method: "DELETE" });
}

async function getTodaysRoute() {
  return apiFetch("/api/schedule/routing/today");
}

// Every pull sheet in the company, regardless of source type or job --
// visible to every employee, not just whoever's assigned to the job it was
// built from (an earlier version scoped this to job assignments, but many
// quotes/invoices aren't tied to a job at all, which meant those pull
// sheets never reached anyone).
async function getMyPullSheets() {
  return apiFetch("/api/schedule/pull-sheets");
}

async function getPullSheetsUnseenCount() {
  return apiFetch("/api/schedule/pull-sheets/unseen-count");
}

async function getMyPullSheet(id) {
  return apiFetch(`/api/schedule/pull-sheets/${id}`);
}

// Reports what was actually grabbed off the shelf for each item -- purely
// informational, does not touch real inventory (the admin's Mark Fulfilled
// button is what actually consumes stock, using these reported quantities).
// items: [{ id, quantity_pulled }]
async function submitPulledQuantities(id, items) {
  return apiFetch(`/api/schedule/pull-sheets/${id}/pulled`, { method: "PATCH", body: { items } });
}

// Read-only mirror of the admin apps' company-logo card -- lets the header
// show the same branding the admin apps do instead of the generic app name.
async function getCompanyLogo() {
  return apiFetch("/api/schedule/company-logo");
}

// ---------- Inventory (permission-gated, see employees.can_manage_inventory) ----------
// Every call here 403s server-side if the logged-in employee doesn't have
// the permission -- the app only shows the Inventory tab at all when
// employee.can_manage_inventory is true (set at login/restoreSession time),
// but the backend re-checks independently rather than trusting that.
async function getMyInventoryItems() {
  return apiFetch("/api/employee-inventory/items");
}

async function lookupInventoryBarcode(barcode) {
  return apiFetch(`/api/employee-inventory/lookup-barcode/${encodeURIComponent(barcode)}`);
}

async function addInventoryCatalogItem(payload) {
  return apiFetch("/api/employee-inventory/catalog-items", { method: "POST", body: payload });
}

async function updateInventoryCatalogItem(id, patch) {
  return apiFetch(`/api/employee-inventory/catalog-items/${id}`, { method: "PATCH", body: patch });
}

// Read-only attachment access for the employee app -- metadata list plus a
// blob-URL viewer, mirroring the pattern used in the admin pages'
// viewAttachment. Employees can look at what's attached to a job but never
// upload or delete (that's admin-only, see routes/attachments.js).
async function getJobAttachments(jobId) {
  return apiFetch(`/api/schedule/jobs/${jobId}/attachments`);
}

async function viewAttachment(id) {
  const token = getToken();
  const res = await fetch(`${API_BASE_URL}/api/schedule/attachments/${id}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let message = "Couldn't load that file.";
    try {
      const data = await res.json();
      if (data.error) message = data.error;
    } catch {}
    throw new Error(message);
  }
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  window.open(blobUrl, "_blank");
}

async function getChatUnreadCount() {
  return apiFetch("/api/chat/unread-count");
}

async function getChatMessages() {
  return apiFetch("/api/chat/messages");
}

async function sendChatMessage(body) {
  return apiFetch("/api/chat/messages", { method: "POST", body: { body } });
}

async function getCoworkers() {
  return apiFetch("/api/team-chat/coworkers");
}

async function getTeamUnreadCount() {
  return apiFetch("/api/team-chat/unread-count");
}

async function getTeamThreads() {
  return apiFetch("/api/team-chat/threads");
}

async function createTeamThread(employeeIds, name) {
  return apiFetch("/api/team-chat/threads", { method: "POST", body: { employee_ids: employeeIds, name } });
}

async function getTeamMessages(threadId) {
  return apiFetch(`/api/team-chat/threads/${threadId}/messages`);
}

async function sendTeamMessage(threadId, body) {
  return apiFetch(`/api/team-chat/threads/${threadId}/messages`, { method: "POST", body: { body } });
}

async function getVapidPublicKey() {
  return apiFetch("/api/push/vapid-public-key");
}

async function subscribePush(subscription) {
  return apiFetch("/api/push/subscribe", { method: "POST", body: subscription });
}

async function unsubscribePush(endpoint) {
  return apiFetch("/api/push/unsubscribe", { method: "POST", body: { endpoint } });
}

function logout() {
  clearSession();
}

// Wraps a mutating clock action: try it live, and if the network request
// itself fails (offline, not a server error), queue it for later instead
// of losing the tap. Returns { ok, offline } so the UI can show
// "saved offline, will sync" rather than a hard failure.
async function clockAction(path, body) {
  try {
    const data = await apiFetch(path, { method: "POST", body });
    return { ok: true, offline: false, data };
  } catch (err) {
    if (navigator.onLine) {
      // We have a connection but the server rejected the request —
      // a real error (e.g. "already clocked in"), don't queue it.
      throw err;
    }
    await queueAction({ path, method: "POST", body });
    return { ok: true, offline: true };
  }
}

function startAutoSync() {
  const trySync = () => flushQueue(apiFetch);
  window.addEventListener("online", trySync);
  trySync(); // also try once on load in case actions queued during a previous session
}

export {
  login,
  restoreSession,
  logout,
  getSavedEmployee,
  clockAction,
  startAutoSync,
  apiFetch,
  forgotPin,
  getMySchedule,
  getCustomers,
  getScheduleUnseenCount,
  getMyTimeOffRequests,
  requestTimeOff,
  cancelTimeOffRequest,
  getTodaysRoute,
  getCompanyLogo,
  getJobAttachments,
  viewAttachment,
  getChatUnreadCount,
  getChatMessages,
  sendChatMessage,
  getCoworkers,
  getTeamUnreadCount,
  getTeamThreads,
  createTeamThread,
  getTeamMessages,
  sendTeamMessage,
  getVapidPublicKey,
  subscribePush,
  unsubscribePush,
  getMyPullSheets,
  getPullSheetsUnseenCount,
  getMyPullSheet,
  submitPulledQuantities,
  getMyInventoryItems,
  lookupInventoryBarcode,
  addInventoryCatalogItem,
  updateInventoryCatalogItem,
};

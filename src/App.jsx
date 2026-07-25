import { useState, useEffect, useRef } from "react";
import { Play, Pause, Square, MapPin, Plane, Clock, Send, LogOut, Mail, CalendarDays, Timer, Users, MessageCircle } from "lucide-react";
import {
  login,
  restoreSession,
  logout,
  clockAction,
  startAutoSync,
  apiFetch,
  forgotPin,
  getMySchedule,
  getCustomers,
  getScheduleUnseenCount,
  getChatUnreadCount,
  getChatMessages,
  sendChatMessage,
  getVapidPublicKey,
  subscribePush,
} from "./api.js";
import { useGeoAutoClock, markManualClockOut, clearAutoClockInSuppression } from "./geoAutoClock.js";

const JOB_COLORS = {
  rust: "#FF4433",
  amber: "#FFA400",
  teal: "#00B871",
  blue: "#1E88FF",
  purple: "#9B30FF",
  rose: "#FF2D95",
  charcoal: "#707B85",
};

// Converts the VAPID public key (base64url) into the Uint8Array format the
// browser's Push API expects.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

// Best-effort: registers this device for job-scheduling push notifications.
// Silently does nothing if the browser doesn't support it, permission is
// denied, or the backend hasn't configured VAPID keys yet -- none of that
// should block the employee from using the time clock itself.
async function setupPushNotifications() {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      await subscribePush(existing.toJSON());
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return;
    const { publicKey } = await getVapidPublicKey();
    if (!publicKey) return;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await subscribePush(subscription.toJSON());
  } catch {
    // Non-fatal -- the employee just won't get push notifications on this device.
  }
}

const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');`;

const CHARCOAL = "#1F2421";
const PAPER = "#F4F2ED";
const AMBER = "#F4B04C";
const AMBER_DEEP = "#DB8A16";
const TEAL = "#46705F";
const TEAL_DEEP = "#2B453C";
const RUST = "#D35A34";
const RUST_DEEP = "#A63D20";
const LINE = "#D8D3C4";

// Full-screen clock-in celebration, shown briefly after a clock-in when the
// employee has a clock-in animation picked (set per-person in the admin
// app's employee section, via clock_in_animation: "none" | "fireworks" |
// "birthday"). Pure canvas animations, no dependencies. Both animations run
// for exactly the same duration so they feel consistent.
const ANIMATION_DURATION_MS = 12000;
const FIREWORKS_DURATION_MS = ANIMATION_DURATION_MS;

function FireworksOverlay({ onDone }) {
  const canvasRef = useRef(null);
  // The parent re-renders every second (its clock ticker), which would hand
  // us a brand-new onDone function each time. Stashing it in a ref (instead
  // of putting it in the effect's dependency array) means the animation
  // below starts exactly once and isn't restarted by unrelated re-renders.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);
    function handleResize() {
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    }
    window.addEventListener("resize", handleResize);

    const colors = ["#FF2EC4", "#39FF14", "#00E5FF", "#FFF01F", "#FF6A00", "#B026FF"];
    let particles = [];

    function spawnBurst() {
      const cx = width * (0.2 + Math.random() * 0.6);
      const cy = height * (0.2 + Math.random() * 0.4);
      const color = colors[Math.floor(Math.random() * colors.length)];
      const count = 32;
      for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 * i) / count;
        const speed = 2 + Math.random() * 3;
        particles.push({
          x: cx,
          y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 1,
          color,
        });
      }
    }

    const startedAt = performance.now();
    const burstIntervalMs = 900; // roughly one new burst per ~0.9s
    let lastBurstAt = -Infinity;
    let raf;
    let stopped = false;

    function tick(now) {
      const elapsed = now - startedAt;
      ctx.clearRect(0, 0, width, height);

      // Keep launching new bursts until the 15-second window is up.
      if (elapsed < FIREWORKS_DURATION_MS && now - lastBurstAt >= burstIntervalMs) {
        spawnBurst();
        lastBurstAt = now;
      }

      particles.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.045; // gravity
        p.life -= 0.014;
      });
      particles = particles.filter((p) => p.life > 0);

      particles.forEach((p) => {
        ctx.globalAlpha = Math.max(p.life, 0);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;

      // Hard stop at 15 seconds even if particles are still fading, so it
      // never appears to run indefinitely.
      if (elapsed >= FIREWORKS_DURATION_MS && (particles.length === 0 || elapsed >= FIREWORKS_DURATION_MS + 1200)) {
        if (!stopped) {
          stopped = true;
          window.removeEventListener("resize", handleResize);
          onDoneRef.current && onDoneRef.current();
        }
        return;
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: "fixed", inset: 0, zIndex: 9999, pointerEvents: "none" }}
    />
  );
}

// Full-screen confetti + "Happy Birthday" celebration, shown briefly after a
// clock-in when the employee's clock_in_animation is "birthday". Mirrors
// FireworksOverlay's ref-based timing so it isn't restarted by unrelated
// re-renders, and hard-stops at the same ANIMATION_DURATION_MS.
function BirthdayOverlay({ name, onDone }) {
  const canvasRef = useRef(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);
    function handleResize() {
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    }
    window.addEventListener("resize", handleResize);

    const colors = ["#FF2EC4", "#39FF14", "#00E5FF", "#FFF01F", "#FF6A00", "#B026FF"];
    let pieces = [];

    function spawnConfetti(count) {
      for (let i = 0; i < count; i++) {
        pieces.push({
          x: Math.random() * width,
          y: -20 - Math.random() * height * 0.3,
          vx: (Math.random() - 0.5) * 1.6,
          vy: 2 + Math.random() * 2,
          size: 6 + Math.random() * 6,
          rotation: Math.random() * Math.PI * 2,
          rotSpeed: (Math.random() - 0.5) * 0.2,
          color: colors[Math.floor(Math.random() * colors.length)],
        });
      }
    }
    spawnConfetti(80);

    const startedAt = performance.now();
    const spawnIntervalMs = 350;
    let lastSpawnAt = 0;
    let raf;
    let stopped = false;

    function tick(now) {
      const elapsed = now - startedAt;
      ctx.clearRect(0, 0, width, height);

      // Keep sprinkling in new confetti until the window is up.
      if (elapsed < ANIMATION_DURATION_MS && now - lastSpawnAt >= spawnIntervalMs) {
        spawnConfetti(18);
        lastSpawnAt = now;
      }

      pieces.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.rotSpeed;
      });
      pieces = pieces.filter((p) => p.y < height + 30);

      pieces.forEach((p) => {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      });

      // Hard stop at the same duration as the fireworks animation, even if
      // a few pieces are still drifting down, so it never runs indefinitely.
      if (elapsed >= ANIMATION_DURATION_MS && (pieces.length === 0 || elapsed >= ANIMATION_DURATION_MS + 1200)) {
        if (!stopped) {
          stopped = true;
          window.removeEventListener("resize", handleResize);
          onDoneRef.current && onDoneRef.current();
        }
        return;
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, pointerEvents: "none" }}>
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0 }} />
      <div
        style={{
          position: "absolute",
          top: "38%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          textAlign: "center",
          color: "#fff",
          textShadow: "0 2px 12px rgba(0,0,0,0.45)",
          fontSize: "clamp(24px, 6vw, 44px)",
          fontWeight: 800,
          padding: "0 16px",
        }}
      >
        🎉 Happy Birthday{name ? `, ${name}` : ""}! 🎂
      </div>
    </div>
  );
}

function pad(n) { return n.toString().padStart(2, "0"); }

function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function formatClock(date) {
  if (!date) return "—";
  return new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(seconds) {
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function getPayPeriod(date) {
  const y = date.getFullYear();
  const m = date.getMonth();
  if (date.getDate() <= 15) {
    return { start: new Date(y, m, 1), end: new Date(y, m, 15, 23, 59, 59) };
  }
  const lastDay = new Date(y, m + 1, 0).getDate();
  return { start: new Date(y, m, 16), end: new Date(y, m, lastDay, 23, 59, 59) };
}

function formatDateShort(d) {
  return new Date(d).toLocaleDateString([], { month: "short", day: "numeric" });
}

// "14:30:00" / "14:30" -> "2:30 PM". Returns "" for null/undefined, so it's
// safe to use directly wherever a job's start_time might not be set (the
// admin app's "No specific time" toggle leaves it null).
function formatTimeLabel(timeStr) {
  if (!timeStr) return "";
  const [hStr, mStr] = timeStr.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

function googleMapsDirectionsUrl(address) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
}

// Combines street/city/state/zip into a single display string, e.g.
// "123 Main St, Denver, CO 80202" -- skips whichever parts are blank.
function formatAddress(street, city, state, zip) {
  const cityStateZip = [city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [street, cityStateZip].filter(Boolean).join(", ");
}

function dateToStr(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function todayStr() {
  return dateToStr(new Date());
}

// Given "YYYY-MM-DD" strings, steps through every date in [startStr, endStr]
// using UTC arithmetic only, so there's no local-timezone off-by-one risk
// near midnight.
function eachDateStrInRange(startStr, endStr, cb) {
  let [y, m, d] = startStr.slice(0, 10).split("-").map(Number);
  const [ey, em, ed] = endStr.slice(0, 10).split("-").map(Number);
  let cursor = Date.UTC(y, m - 1, d);
  const end = Date.UTC(ey, em - 1, ed);
  while (cursor <= end) {
    const cd = new Date(cursor);
    cb(cd.getUTCFullYear() + "-" + String(cd.getUTCMonth() + 1).padStart(2, "0") + "-" + String(cd.getUTCDate()).padStart(2, "0"));
    cursor += 24 * 60 * 60 * 1000;
  }
}

const DOW_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Compact summary row -- tap it to see the full details (customer, phone,
// address, notes) in JobDetailSheet below. Keeps the day list scannable
// even when several jobs land on the same day.
function EventCard({ job, onSelect }) {
  const dateLabel =
    job.start_date === job.end_date
      ? formatDateShort(job.start_date)
      : `${formatDateShort(job.start_date)} – ${formatDateShort(job.end_date)}`;
  const timeLabel = formatTimeLabel(job.start_time);
  return (
    <button
      onClick={() => onSelect(job)}
      style={{
        background: "#fff",
        border: `1px solid rgba(31,36,33,0.05)`,
        boxShadow: "0 6px 16px rgba(31,36,33,0.06), 0 1px 3px rgba(31,36,33,0.04)",
        textAlign: "left",
        width: "100%",
      }}
      className="rounded-xl p-4 flex items-center gap-2"
    >
      <span
        style={{ background: JOB_COLORS[job.color] || RUST, width: 10, height: 10 }}
        className="rounded-full flex-shrink-0"
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">
          {job.title}
          {job.event_type && job.event_type !== "job" && (
            <span
              className="ml-2 rounded"
              style={{
                fontSize: "10px",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                padding: "2px 6px",
                background: LINE,
                color: "#5C6660",
              }}
            >
              {job.event_type === "personal" ? "Personal" : "Other"}
            </span>
          )}
        </div>
        <div className="text-xs mt-0.5" style={{ color: "#8A8578" }}>
          {dateLabel}
          {timeLabel && ` · ${timeLabel}`}
        </div>
      </div>
      <span style={{ color: "#8A8578", fontSize: 18, flexShrink: 0 }}>&rsaquo;</span>
    </button>
  );
}

// Bottom-sheet with the full picture for one job: customer name, a tel:
// link for the phone, a Google Maps directions link for the address, and
// any notes. Tapping the dimmed backdrop closes it, same as the admin apps.
function JobDetailSheet({ job, onClose }) {
  if (!job) return null;
  const jobAddress = formatAddress(job.customer_street, job.customer_city, job.customer_state, job.customer_zip);
  const dateLabel =
    job.start_date === job.end_date
      ? formatDateShort(job.start_date)
      : `${formatDateShort(job.start_date)} – ${formatDateShort(job.end_date)}`;
  const timeLabel = formatTimeLabel(job.start_time);

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(31,36,33,0.5)", zIndex: 100 }}
      className="flex items-end"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: PAPER,
          width: "100%",
          maxHeight: "80vh",
          overflowY: "auto",
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          boxShadow: "0 -12px 32px rgba(31,36,33,0.18)",
          padding: "20px 20px calc(20px + env(safe-area-inset-bottom))",
        }}
      >
        <div className="flex items-start justify-between gap-2 mb-1">
          <div className="flex items-center gap-2 min-w-0">
            <span
              style={{ background: JOB_COLORS[job.color] || RUST, width: 10, height: 10 }}
              className="rounded-full flex-shrink-0"
            />
            <span className="text-base font-medium truncate">{job.title}</span>
            {job.event_type && job.event_type !== "job" && (
              <span
                className="rounded flex-shrink-0"
                style={{
                  fontSize: "10px",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  padding: "2px 6px",
                  background: LINE,
                  color: "#5C6660",
                }}
              >
                {job.event_type === "personal" ? "Personal" : "Other"}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            style={{ fontSize: 22, lineHeight: 1, color: CHARCOAL, background: "transparent", border: "none", flexShrink: 0 }}
          >
            &times;
          </button>
        </div>
        <div className="text-xs mb-3" style={{ color: "#8A8578" }}>
          {dateLabel}
          {timeLabel && ` · ${timeLabel}`}
        </div>

        {job.customer_name && (
          <div className="text-sm font-medium mt-2" style={{ color: CHARCOAL }}>{job.customer_name}</div>
        )}
        {job.customer_phone && (
          <a
            href={`tel:${job.customer_phone.replace(/[^0-9+]/g, "")}`}
            className="text-sm mt-1 block underline"
            style={{ color: RUST }}
          >
            {job.customer_phone}
          </a>
        )}
        {jobAddress && (
          <a
            href={googleMapsDirectionsUrl(jobAddress)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm mt-1 block underline"
            style={{ color: RUST }}
          >
            {jobAddress}
          </a>
        )}
        {job.notes && (
          <p className="text-sm mt-3 pt-3" style={{ color: "#5C6660", borderTop: `1px solid ${LINE}` }}>
            {job.notes}
          </p>
        )}
      </div>
    </div>
  );
}

function CalendarView({ schedule, loading, monthAnchor, onPrevMonth, onNextMonth, onToday }) {
  const [selectedDay, setSelectedDay] = useState(todayStr());
  const [selectedJob, setSelectedJob] = useState(null);

  const jobsByDate = {};
  schedule.forEach((job) => {
    eachDateStrInRange(job.start_date, job.end_date, (dateStr) => {
      if (!jobsByDate[dateStr]) jobsByDate[dateStr] = [];
      jobsByDate[dateStr].push(job);
    });
  });

  const year = monthAnchor.getFullYear();
  const month = monthAnchor.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayStr();

  const cells = [];
  for (let b = 0; b < firstDow; b++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(day);
  while (cells.length % 7 !== 0) cells.push(null);

  const dayEvents = selectedDay ? jobsByDate[selectedDay] || [] : [];

  return (
    <div style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
      <div className="mb-4 flex items-center justify-between">
        <h2 style={{ fontFamily: "'Oswald', sans-serif" }} className="text-sm uppercase tracking-widest">
          Schedule
        </h2>
        <button
          onClick={() => {
            onToday();
            setSelectedDay(todayStr());
          }}
          className="text-xs underline"
          style={{ color: "#8A8578" }}
        >
          Today
        </button>
      </div>

      <div className="flex items-center justify-between mb-3">
        <button
          onClick={onPrevMonth}
          style={{ border: "none", background: "#fff", boxShadow: "0 3px 8px rgba(31,36,33,0.1)" }}
          className="rounded-xl px-3 py-1 text-sm"
        >
          ‹
        </button>
        <span style={{ fontFamily: "'Oswald', sans-serif" }} className="text-sm uppercase tracking-widest">
          {MONTH_LABELS[month]} {year}
        </span>
        <button
          onClick={onNextMonth}
          style={{ border: "none", background: "#fff", boxShadow: "0 3px 8px rgba(31,36,33,0.1)" }}
          className="rounded-xl px-3 py-1 text-sm"
        >
          ›
        </button>
      </div>

      {loading ? (
        <p className="text-sm" style={{ color: "#8A8578" }}>Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-7 gap-1 mb-1">
            {DOW_LABELS.map((l, i) => (
              <div key={i} className="text-center text-[10px] uppercase" style={{ color: "#8A8578" }}>
                {l}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1 mb-6">
            {cells.map((day, i) => {
              if (day == null) return <div key={i} />;
              const dateStr = year + "-" + String(month + 1).padStart(2, "0") + "-" + String(day).padStart(2, "0");
              const dayJobs = jobsByDate[dateStr] || [];
              const isToday = dateStr === today;
              const isSelected = dateStr === selectedDay;
              return (
                <button
                  key={i}
                  onClick={() => setSelectedDay(dateStr === selectedDay ? null : dateStr)}
                  style={{
                    border: isSelected || isToday ? "none" : `1px solid rgba(31,36,33,0.05)`,
                    background: isSelected
                      ? `linear-gradient(135deg, #E06A45, ${RUST})`
                      : isToday
                      ? `linear-gradient(135deg, #F9C978, ${AMBER})`
                      : "#fff",
                    boxShadow: isSelected
                      ? "0 3px 8px rgba(211,90,52,0.35)"
                      : isToday
                      ? "0 3px 8px rgba(219,138,22,0.3)"
                      : "0 2px 6px rgba(31,36,33,0.04)",
                  }}
                  className="rounded-xl py-1.5 flex flex-col items-center gap-0.5"
                >
                  <span className="text-xs" style={{ color: isSelected ? "#fff" : CHARCOAL, fontWeight: isSelected || isToday ? 700 : 400 }}>{day}</span>
                  {dayJobs.length > 0 && (
                    <span className="flex gap-0.5">
                      {dayJobs.slice(0, 3).map((j, idx) => (
                        <span
                          key={idx}
                          style={{
                            width: 4,
                            height: 4,
                            borderRadius: "50%",
                            background: JOB_COLORS[j.color] || RUST,
                          }}
                        />
                      ))}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {selectedDay ? (
            <>
              <h3 className="text-xs uppercase tracking-widest mb-2" style={{ color: "#8A8578" }}>
                {new Date(year, month, Number(selectedDay.split("-")[2])).toLocaleDateString([], {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
              </h3>
              {dayEvents.length === 0 ? (
                <p className="text-sm" style={{ color: "#8A8578" }}>Nothing scheduled that day.</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {dayEvents.map((job) => (
                    <EventCard key={job.id} job={job} onSelect={setSelectedJob} />
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="text-sm" style={{ color: "#8A8578" }}>Tap a day to see what's scheduled.</p>
          )}
        </>
      )}
      <JobDetailSheet job={selectedJob} onClose={() => setSelectedJob(null)} />
    </div>
  );
}

function CustomersView({ customers, loading }) {
  const [search, setSearch] = useState("");
  const filtered = customers.filter(
    (c) => !search || c.name.toLowerCase().indexOf(search.toLowerCase()) !== -1
  );

  return (
    <div style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
      <div className="mb-4 flex items-center justify-between">
        <h2 style={{ fontFamily: "'Oswald', sans-serif" }} className="text-sm uppercase tracking-widest">
          Customers
        </h2>
      </div>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by name..."
        style={{ border: `1px solid ${LINE}`, background: "#FBFAF7" }}
        className="w-full px-3 py-2 text-sm rounded-xl mb-4 outline-none"
      />
      {loading ? (
        <p className="text-sm" style={{ color: "#8A8578" }}>Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm" style={{ color: "#8A8578" }}>
          {customers.length === 0 ? "No customers yet." : "No customers match that search."}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((c) => {
            const address = formatAddress(c.street, c.city, c.state, c.zip);
            return (
              <div
                key={c.id}
                style={{
                  background: "#fff",
                  border: `1px solid rgba(31,36,33,0.05)`,
                  boxShadow: "0 6px 16px rgba(31,36,33,0.06), 0 1px 3px rgba(31,36,33,0.04)",
                }}
                className="rounded-xl p-4"
              >
                <div className="text-sm font-medium mb-1">{c.name}</div>
                {c.phone && (
                  <a
                    href={`tel:${c.phone.replace(/[^0-9+]/g, "")}`}
                    className="text-xs block underline"
                    style={{ color: RUST }}
                  >
                    {c.phone}
                  </a>
                )}
                {c.email && (
                  <a href={`mailto:${c.email}`} className="text-xs block underline" style={{ color: RUST }}>
                    {c.email}
                  </a>
                )}
                {address && (
                  <a
                    href={googleMapsDirectionsUrl(address)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs block underline mt-0.5"
                    style={{ color: RUST }}
                  >
                    {address}
                  </a>
                )}
                {c.notes && (
                  <p className="text-xs mt-2 pt-2" style={{ color: "#8A8578", borderTop: `1px solid ${LINE}` }}>
                    {c.notes}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Direct chat with the office (there's one thread per employee). Stays
// visible after clocking out so history isn't lost, but the composer is
// disabled until the next clock-in -- messages can only be sent while on
// the clock.
function ChatView({ messages, loading, onClock, onSend }) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  async function handleSend() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await onSend(text);
      setDraft("");
    } catch {
      // onSend already surfaces the error via actionError upstream
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ fontFamily: "'IBM Plex Mono', monospace", minHeight: "calc(100vh - 220px)" }} className="flex flex-col">
      <div className="mb-4 flex items-center justify-between">
        <h2 style={{ fontFamily: "'Oswald', sans-serif" }} className="text-sm uppercase tracking-widest">
          Chat
        </h2>
      </div>

      {loading ? (
        <p className="text-sm" style={{ color: "#8A8578" }}>Loading…</p>
      ) : messages.length === 0 ? (
        <p className="text-sm mb-4" style={{ color: "#8A8578" }}>No messages yet.</p>
      ) : (
        <div className="flex flex-col gap-2 mb-4">
          {messages.map((m) => (
            <div
              key={m.id}
              style={{
                alignSelf: m.sender === "employee" ? "flex-end" : "flex-start",
                maxWidth: "78%",
                background: m.sender === "employee" ? `linear-gradient(135deg, #F9C978, ${AMBER})` : "#F1EDE3",
                color: CHARCOAL,
                borderBottomRightRadius: m.sender === "employee" ? 4 : 14,
                borderBottomLeftRadius: m.sender === "employee" ? 14 : 4,
              }}
              className="rounded-2xl px-3 py-2 text-sm"
            >
              {m.body}
              <div className="text-[10px] mt-0.5" style={{ color: "#8A8578" }}>
                {new Date(m.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}

      {onClock ? (
        <div className="flex gap-2 mt-auto pt-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="Type a message..."
            style={{ border: `1px solid ${LINE}`, background: "#FBFAF7" }}
            className="flex-1 px-3 py-2 text-sm rounded-xl outline-none"
          />
          <button
            onClick={handleSend}
            disabled={sending}
            style={{ background: `linear-gradient(135deg, #F9C978, ${AMBER})`, color: CHARCOAL }}
            className="rounded-xl px-4 text-sm font-medium flex items-center justify-center"
          >
            <Send size={16} />
          </button>
        </div>
      ) : (
        <p className="text-xs mt-auto pt-2" style={{ color: "#8A8578" }}>
          Clock in to send a message.
        </p>
      )}
    </div>
  );
}

export default function TimeClock() {
  const [checkingSession, setCheckingSession] = useState(true);
  const [loggedIn, setLoggedIn] = useState(false);
  const [employee, setEmployee] = useState(null);

const [emailInput, setEmailInput] = useState("");
  const [pinInput, setPinInput] = useState("");
  const [loginError, setLoginError] = useState("");
  const [pinResetMsg, setPinResetMsg] = useState("");

  const [status, setStatus] = useState("off"); // off | working | break
  const [entryId, setEntryId] = useState(null);
  const [jobName, setJobName] = useState("");
  const [jobDraft, setJobDraft] = useState("");
  const [location, setLocation] = useState("in_town"); // matches backend enum
  const [clockInTime, setClockInTime] = useState(null);
  const [breakStartedAt, setBreakStartedAt] = useState(null);

  const [log, setLog] = useState([]); // entries from time_entry_durations for this pay period
  const [view, setView] = useState("clock"); // clock | schedule | customers
  const [schedule, setSchedule] = useState([]);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleMonthAnchor, setScheduleMonthAnchor] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const [customers, setCustomers] = useState([]);
  const [customersLoading, setCustomersLoading] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatUnreadCount, setChatUnreadCount] = useState(0);
  const [scheduleUnseenCount, setScheduleUnseenCount] = useState(0);
  const [now, setNow] = useState(new Date());
  const [submitted, setSubmitted] = useState(false);
  const [actionError, setActionError] = useState("");
  const [savedOffline, setSavedOffline] = useState(false);
  // "fireworks" | "birthday" | null -- which clock-in celebration overlay
  // (if any) is currently showing, based on the employee's clock_in_animation.
  const [activeAnimation, setActiveAnimation] = useState(null);
  // Geolocation-based auto clock in/out — each company sets its own shop
  // location (Settings tab in the admin app); the backend sends it back on
  // login and on session restore, attached to the employee object.
  const SHOP_LAT = employee?.shop_lat != null ? Number(employee.shop_lat) : NaN;
  const SHOP_LNG = employee?.shop_lng != null ? Number(employee.shop_lng) : NaN;
  const SHOP_RADIUS_M = employee?.shop_radius_m != null ? Number(employee.shop_radius_m) : 152; // ~500ft

  async function autoClockIn() {
    setActionError("");
    const res = await clockAction("/api/time-entries/clock-in", {
      job_name: "Shop",
      location_type: "in_town",
    });
    setSavedOffline(res.offline);
    if (res.data) {
      setEntryId(res.data.id);
      setClockInTime(res.data.clock_in);
    } else {
      setClockInTime(new Date().toISOString());
    }
    setJobName("Shop");
    setStatus("working");
    if (employee?.clock_in_animation === "fireworks" || employee?.clock_in_animation === "birthday") {
      setActiveAnimation(employee.clock_in_animation);
    }
  }

  async function autoClockOut() {
    if (!entryId) return;
    setActionError("");
    const res = await clockAction(`/api/time-entries/${entryId}/clock-out`, {});
    setSavedOffline(res.offline);
    setStatus("off");
    setEntryId(null);
    setJobName("");
    setClockInTime(null);
    setSubmitted(false);
    await refreshFromServer();
  }

  const geo = useGeoAutoClock({
    status,
    locationMode: location,
    autoClockIn,
    autoClockOut,
    shopLat: SHOP_LAT,
    shopLng: SHOP_LNG,
    radiusMeters: SHOP_RADIUS_M,
    clockOutTime: employee?.auto_clockout_time,
    sessionReady: !checkingSession,
  });
  useEffect(() => {
    if (status === "off") return;
    if (!("geolocation" in navigator)) return;

    function sendPing() {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          apiFetch("/api/time-entries/ping-location", {
            method: "POST",
            body: { lat: pos.coords.latitude, lng: pos.coords.longitude },
          }).catch(() => {});
        },
        () => {},
        { enableHighAccuracy: true, maximumAge: 60000, timeout: 15000 }
      );
    }

    sendPing();
    const interval = setInterval(sendPing, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [status]);
  useEffect(() => {
    if (status === "off") return;

    async function checkPingRequest() {
      try {
        const data = await apiFetch("/api/time-entries/ping-status");
        if (data.shouldPing) {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              apiFetch("/api/time-entries/ping-location", {
                method: "POST",
                body: { lat: pos.coords.latitude, lng: pos.coords.longitude },
              }).catch(() => {});
            },
            () => {},
            { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
          );
        }
      } catch {}
    }

    checkPingRequest();
    const interval = setInterval(checkPingRequest, 20000);
    return () => clearInterval(interval);
  }, [status]);
  const tickRef = useRef(null);

  useEffect(() => {
    tickRef.current = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(tickRef.current);
  }, []);

  // On launch: try to restore a saved session, then load current status + this period's log.
  useEffect(() => {
    (async () => {
      startAutoSync();
      const emp = await restoreSession();
      if (emp) {
        setEmployee(emp);
        setLoggedIn(true);
        await refreshFromServer();
        setupPushNotifications();
      }
      setCheckingSession(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If a job notification is tapped while the app is in the background,
  // the service worker posts a message asking us to jump to the Schedule tab.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    function handleMessage(event) {
      if (event.data?.type !== "navigate") return;
      if (event.data.url?.includes("/schedule")) setView("schedule");
      if (event.data.url?.includes("/chat")) setView("chat");
    }
    navigator.serviceWorker.addEventListener("message", handleMessage);
    return () => navigator.serviceWorker.removeEventListener("message", handleMessage);
  }, []);

  async function loadSchedule(anchor) {
    setScheduleLoading(true);
    try {
      const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const monthEnd = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
      const rows = await getMySchedule(dateToStr(monthStart), dateToStr(monthEnd));
      setSchedule(rows);
      // GET /schedule/me marks this employee's job assignments seen
      // server-side as a side effect of loading -- reflect that locally
      // right away instead of waiting for the next unseen-count poll.
      setScheduleUnseenCount(0);
    } catch {
      // non-fatal — leave whatever was last loaded
    } finally {
      setScheduleLoading(false);
    }
  }

  async function refreshScheduleUnseenCount() {
    try {
      const { count } = await getScheduleUnseenCount();
      setScheduleUnseenCount(count);
    } catch {
      // non-fatal — badge just won't update this cycle
    }
  }

  async function loadCustomers() {
    setCustomersLoading(true);
    try {
      const rows = await getCustomers();
      setCustomers(rows);
    } catch {
      // non-fatal — leave whatever was last loaded
    } finally {
      setCustomersLoading(false);
    }
  }

  // Full fetch -- marks the office's messages as read. Only call this when
  // the Chat tab is actually open; use refreshChatUnreadCount for background
  // polling so the badge doesn't get silently cleared before it's seen.
  async function loadChatMessages() {
    setChatLoading(true);
    try {
      const rows = await getChatMessages();
      setChatMessages(rows);
      setChatUnreadCount(0);
    } catch {
      // non-fatal — leave whatever was last loaded
    } finally {
      setChatLoading(false);
    }
  }

  async function refreshChatUnreadCount() {
    try {
      const { count } = await getChatUnreadCount();
      setChatUnreadCount(count);
    } catch {
      // non-fatal — badge just won't update this cycle
    }
  }

  async function handleSendChatMessage(body) {
    const saved = await sendChatMessage(body);
    setChatMessages((prev) => [...prev, saved]);
  }

  function goPrevMonth() {
    setScheduleMonthAnchor((a) => new Date(a.getFullYear(), a.getMonth() - 1, 1));
  }
  function goNextMonth() {
    setScheduleMonthAnchor((a) => new Date(a.getFullYear(), a.getMonth() + 1, 1));
  }
  function goToday() {
    const n = new Date();
    setScheduleMonthAnchor(new Date(n.getFullYear(), n.getMonth(), 1));
  }

  useEffect(() => {
    if (view === "schedule" && loggedIn) loadSchedule(scheduleMonthAnchor);
    if (view === "customers" && loggedIn) loadCustomers();
    if (view === "chat" && loggedIn) loadChatMessages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, loggedIn, scheduleMonthAnchor]);

  // Background poll for the Chat and Schedule tabs' badges -- deliberately
  // uses the lightweight count-only endpoints (not the full fetches) so
  // neither one silently marks things seen/read before the tab is actually
  // opened. Each is skipped while its own tab is open, since the full
  // fetch there already keeps its count at 0.
  useEffect(() => {
    if (!loggedIn) return;
    refreshChatUnreadCount();
    refreshScheduleUnseenCount();
    const interval = setInterval(() => {
      if (view !== "chat") refreshChatUnreadCount();
      if (view !== "schedule") refreshScheduleUnseenCount();
    }, 15000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn, view]);

  async function refreshFromServer() {
    try {
      const period = getPayPeriod(new Date());
      const rows = await apiFetch(
        `/api/time-entries?start=${period.start.toISOString()}&end=${period.end.toISOString()}`
      );
      setLog(rows.filter((r) => r.clock_out)); // completed shifts for the log list
      const open = rows.find((r) => !r.clock_out);
      if (open) {
        setEntryId(open.time_entry_id);
        setJobName(open.job_name);
        setLocation(open.location_type);
        setClockInTime(open.clock_in);
        if (open.open_break_start) {
          setStatus("break");
          setBreakStartedAt(open.open_break_start);
        } else {
          setStatus("working");
          setBreakStartedAt(null);
        }
      }
    } catch (err) {
      setActionError("Couldn't reach the server — showing your last known status.");
    }
  }

  async function handleLogin() {
    setLoginError("");
    const email = emailInput.trim();
    if (!email || !pinInput) {
      setLoginError("Enter your email and PIN.");
      return;
    }
    try {
      const emp = await login(email, pinInput);
      setEmployee(emp);
      setLoggedIn(true);
      setPinInput("");
      await refreshFromServer();
      setupPushNotifications();
    } catch (err) {
      setLoginError(err.message || "Login failed.");
    }
  }

  async function handleForgotPin() {
    setLoginError("");
    setPinResetMsg("");
    const email = emailInput.trim();
    if (!email) {
      setLoginError("Enter your email above first, then tap \"Forgot PIN?\" again.");
      return;
    }
    try {
      await forgotPin(email);
      setPinResetMsg("If that email has an account, we've sent a link to reset your PIN.");
    } catch (err) {
      setLoginError(err.message || "Couldn't reach the server. Try again.");
    }
  }

  function handleLogout() {
    logout();
    setLoggedIn(false);
    setEmployee(null);
    setStatus("off");
    setEntryId(null);
    setLog([]);
  }
  async function clockIn() {
    setActionError("");
    const res = await clockAction("/api/time-entries/clock-in", {
      job_name: jobDraft.trim() || "Untitled job",
      location_type: location,
    });
    setSavedOffline(res.offline);
    if (res.data) {
      setEntryId(res.data.id);
      setClockInTime(res.data.clock_in);
    } else {
      // offline: fake a local id so the UI still works until it syncs
      setClockInTime(new Date().toISOString());
    }
    setJobName(jobDraft.trim() || "Untitled job");
    setStatus("working");
    setJobDraft("");
    // A fresh manual clock-in means any earlier "don't auto clock-in" flag
    // (from a previous manual clock-out) is stale — clear it.
    clearAutoClockInSuppression();
    if (employee?.clock_in_animation === "fireworks" || employee?.clock_in_animation === "birthday") {
      setActiveAnimation(employee.clock_in_animation);
    }
  }

  async function startBreak() {
    setActionError("");
    const res = await clockAction(`/api/time-entries/${entryId}/break-start`, {});
    setSavedOffline(res.offline);
    setBreakStartedAt(new Date().toISOString());
    setStatus("break");
  }

  async function endBreak() {
    setActionError("");
    const res = await clockAction(`/api/time-entries/${entryId}/break-end`, {});
    setSavedOffline(res.offline);
    setBreakStartedAt(null);
    setStatus("working");
  }

  async function clockOut() {
    setActionError("");
    const res = await clockAction(`/api/time-entries/${entryId}/clock-out`, {});
    setSavedOffline(res.offline);
    setStatus("off");
    setEntryId(null);
    setJobName("");
    setClockInTime(null);
    setSubmitted(false);
    // Manual clock-out takes precedence over auto clock-in: don't let the
    // geo check clock them right back in just because they're still
    // standing at the shop. This sticks even if the app is closed and
    // reopened, and only clears once they've actually left.
    markManualClockOut();
    await refreshFromServer();
  }

  const elapsedMs = clockInTime ? now - new Date(clockInTime) : 0;
  const currentBreakMs = status === "break" && breakStartedAt ? now - new Date(breakStartedAt) : 0;
  const LONG_SHIFT_MS = 10 * 60 * 60 * 1000; // 10 hours
  const shiftTooLong = (status === "working" || status === "break") && elapsedMs > LONG_SHIFT_MS;

  const statusMeta = {
    off: { label: "OFF THE CLOCK", color: "#6b6759", bg: "#EDEAE1", shadow: "none" },
    working: { label: "WORKING", color: "#fff", bg: `linear-gradient(135deg, #5C9481, ${TEAL_DEEP})`, shadow: "0 3px 8px rgba(43,69,60,0.4)" },
    break: { label: "ON BREAK", color: "#fff", bg: `linear-gradient(135deg, #E4794F, ${RUST_DEEP})`, shadow: "0 3px 8px rgba(166,61,32,0.4)" },
  }[status];

  const period = getPayPeriod(now);
  const periodTotalSeconds = log.reduce((s, e) => s + Number(e.worked_seconds || 0), 0);

  async function submitHours() {
    setActionError("");
    try {
      await apiFetch("/api/timesheets/submit", { method: "POST" });
      setSubmitted(true);
    } catch (err) {
      setActionError(err.message || "Nothing to submit yet.");
    }
  }

  if (checkingSession) {
    return (
      <div style={{ background: PAPER, minHeight: "100vh" }} className="w-full min-h-screen flex items-center justify-center">
        <style>{FONT_IMPORT}</style>
        <p style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#8A8578" }} className="text-sm">
          Loading…
        </p>
      </div>
    );
  }

  if (!loggedIn) {
    return (
      <div style={{ background: PAPER, minHeight: "100vh", color: CHARCOAL, fontFamily: "'IBM Plex Mono', monospace" }} className="w-full min-h-screen flex items-center justify-center px-4">
        <style>{FONT_IMPORT}</style>
        <div style={{ border: `1px solid rgba(31,36,33,0.06)`, background: "#fff", boxShadow: "0 20px 45px rgba(31,36,33,0.14), 0 4px 12px rgba(31,36,33,0.08)" }} className="w-full max-w-xs rounded-2xl p-6">
          <h1 style={{ fontFamily: "'Oswald', sans-serif" }} className="text-xl font-semibold uppercase mb-1 text-center">
            Site Clock
          </h1>
          <p className="text-xs text-center mb-5" style={{ color: "#8A8578" }}>Your personal time clock</p>
          <input
  autoFocus
  type="email"
  value={emailInput}
  onChange={(e) => setEmailInput(e.target.value)}
  placeholder="Your email"
            style={{ border: `1.5px solid ${LINE}`, background: "#FBFAF7" }}
            className="w-full px-3 py-2.5 text-sm rounded-xl mb-3 outline-none"
          />
          <input
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLogin()}
            placeholder="PIN"
            type="password"
            inputMode="numeric"
            style={{ border: `1.5px solid ${LINE}`, background: "#FBFAF7" }}
            className="w-full px-3 py-2.5 text-sm rounded-xl mb-3 outline-none"
          />
          {loginError && (
            <p className="text-xs mb-3" style={{ color: RUST }}>{loginError}</p>
          )}
          {pinResetMsg && (
            <p className="text-xs mb-3" style={{ color: TEAL }}>{pinResetMsg}</p>
          )}
          <button
            onClick={handleLogin}
            style={{
              color: CHARCOAL, fontFamily: "'Oswald', sans-serif",
              background: `linear-gradient(180deg, #F9C978 0%, ${AMBER} 55%, ${AMBER_DEEP} 100%)`,
              boxShadow: "0 4px 10px rgba(219,138,22,0.35), inset 0 1px 0 rgba(255,255,255,0.5)",
            }}
            className="w-full py-2.5 rounded-xl text-sm font-semibold"
          >
            CONTINUE
          </button>
          <button
            type="button"
            onClick={handleForgotPin}
            className="w-full text-center mt-3 text-xs underline"
            style={{ color: "#8A8578", background: "none", border: "none" }}
          >
            Forgot PIN?
          </button>
          <p className="text-[10px] text-center mt-4" style={{ color: "#8A8578" }}>
            You only need to do this once on this device.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: PAPER, minHeight: "100vh", color: CHARCOAL }} className="w-full min-h-screen pb-16">
      <style>{FONT_IMPORT}</style>
      {activeAnimation === "fireworks" && <FireworksOverlay onDone={() => setActiveAnimation(null)} />}
      {activeAnimation === "birthday" && <BirthdayOverlay name={employee?.name} onDone={() => setActiveAnimation(null)} />}
      <div style={{ fontFamily: "'IBM Plex Mono', monospace" }} className="max-w-md mx-auto px-4 pt-8">
        <div className="flex items-baseline justify-between mb-1">
          <h1 style={{ fontFamily: "'Oswald', sans-serif", letterSpacing: "0.02em" }} className="text-2xl font-semibold uppercase">
            Site Clock
          </h1>
          <button onClick={handleLogout} className="text-xs flex items-center gap-1" style={{ color: "#8A8578" }}>
            <LogOut size={12} /> {employee?.name}
          </button>
        </div>
        <div className="h-px w-full mb-6" style={{ background: `repeating-linear-gradient(90deg, ${LINE} 0 6px, transparent 6px 12px)` }} />

        {view === "schedule" ? (
          <CalendarView
            schedule={schedule}
            loading={scheduleLoading}
            monthAnchor={scheduleMonthAnchor}
            onPrevMonth={goPrevMonth}
            onNextMonth={goNextMonth}
            onToday={goToday}
          />
        ) : view === "customers" ? (
          <CustomersView customers={customers} loading={customersLoading} />
        ) : view === "chat" ? (
          <ChatView
            messages={chatMessages}
            loading={chatLoading}
            onClock={status !== "off"}
            onSend={handleSendChatMessage}
          />
        ) : (
        <>
        {actionError && (
          <div style={{ background: "#fff", border: `1.5px solid ${RUST}`, color: RUST, boxShadow: "0 6px 16px rgba(211,90,52,0.1)" }} className="rounded-xl p-3 mb-4 text-xs">
            {actionError}
          </div>
        )}
        {savedOffline && (
          <div style={{ background: "#fff", border: `1.5px dashed ${AMBER}` }} className="rounded-xl p-3 mb-4 text-xs">
            No connection — saved on this device and will sync automatically once you're back online.
          </div>
        )}{geo.configured && geo.permission === "denied" && (
          <div style={{ background: "#fff", border: `1.5px dashed ${RUST}`, color: RUST }} className="rounded-xl p-3 mb-4 text-xs">
            Location access is off, so auto clock-in/out won't work — the manual buttons below still do. To enable it, allow location for this site in your phone's settings.
          </div>
        )}
        {shiftTooLong && (
          <div style={{ background: "#fff", border: `1.5px solid ${RUST}`, color: RUST, boxShadow: "0 6px 16px rgba(211,90,52,0.1)" }} className="rounded-xl p-3 mb-4 text-xs">
            You've been clocked in for over 10 hours — did you forget to clock out?
          </div>
        )}
        <div style={{ border: `1px solid rgba(31,36,33,0.06)`, background: "#fff", boxShadow: "0 10px 24px rgba(31,36,33,0.08), 0 2px 6px rgba(31,36,33,0.05)" }} className="rounded-2xl p-5 mb-6">
          <div className="flex items-center justify-between mb-4">
            <span style={{ background: statusMeta.bg, color: statusMeta.color, fontFamily: "'Oswald', sans-serif", boxShadow: statusMeta.shadow, fontWeight: 700 }} className="px-3 py-1.5 text-xs tracking-widest rounded-full">
              {statusMeta.label}
            </span>
            <span className="text-xs" style={{ color: "#8A8578" }}>{now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</span>
          </div>

          <div className="text-center mb-4">
            <div
              style={{
                fontFamily: "'Oswald', sans-serif", letterSpacing: "0.03em",
                background: status === "off" ? "none" : `linear-gradient(135deg, ${CHARCOAL}, #3a4440)`,
                WebkitBackgroundClip: status === "off" ? "unset" : "text",
                backgroundClip: status === "off" ? "unset" : "text",
                color: status === "off" ? CHARCOAL : "transparent",
              }}
              className="text-5xl font-semibold tabular-nums"
            >
              {status === "off" ? "00:00:00" : formatElapsed(elapsedMs)}
            </div>
            {status === "break" && (
              <div className="text-xs mt-1" style={{ color: "#8A8578" }}>
                break {formatElapsed(currentBreakMs)}
              </div>
            )}
          </div>

          {status === "off" ? (
            <input
              value={jobDraft}
              onChange={(e) => setJobDraft(e.target.value)}
              placeholder="Job / site name"
              style={{ border: `1.5px solid ${LINE}`, background: "#FBFAF7" }}
              className="w-full px-3 py-2 text-sm rounded-xl mb-3 outline-none"
            />
          ) : (
            <div className="flex items-center gap-2 mb-3 text-sm">
              <Clock size={14} style={{ color: "#8A8578" }} />
              <span className="font-medium">{jobName}</span>
              <span style={{ color: "#8A8578" }}>· in since {formatClock(clockInTime)}</span>
            </div>
          )}

          <div className="flex mb-4 rounded-xl overflow-hidden" style={{ border: `1.5px solid ${CHARCOAL}` }}>
            <button
              disabled={status !== "off"}
              onClick={() => setLocation("in_town")}
              style={{
                background: location === "in_town" ? `linear-gradient(135deg, #5C9481, ${TEAL_DEEP})` : "transparent",
                color: location === "in_town" ? "#fff" : CHARCOAL, fontFamily: "'Oswald', sans-serif",
              }}
              className="flex-1 py-2 text-sm flex items-center justify-center gap-1.5 disabled:opacity-60"
            >
              <MapPin size={14} /> IN TOWN
            </button>
            <button
              disabled={status !== "off"}
              onClick={() => setLocation("traveling")}
              style={{
                background: location === "traveling" ? `linear-gradient(135deg, #E4794F, ${RUST_DEEP})` : "transparent",
                color: location === "traveling" ? "#fff" : CHARCOAL, fontFamily: "'Oswald', sans-serif",
              }}
              className="flex-1 py-2 text-sm flex items-center justify-center gap-1.5 disabled:opacity-60 border-l"
            >
              <Plane size={14} /> TRAVELING
            </button>
          </div>

          <div className="flex gap-2">
            {status === "off" && (
              <button
                onClick={clockIn}
                style={{
                  color: CHARCOAL, fontFamily: "'Oswald', sans-serif",
                  background: `linear-gradient(180deg, #F9C978 0%, ${AMBER} 55%, ${AMBER_DEEP} 100%)`,
                  boxShadow: "0 4px 10px rgba(219,138,22,0.35), inset 0 1px 0 rgba(255,255,255,0.5)",
                }}
                className="flex-1 py-3 rounded-xl text-sm font-semibold flex items-center justify-center gap-2"
              >
                <Play size={16} /> CLOCK IN
              </button>
            )}
            {status === "working" && (
              <>
                <button onClick={startBreak} style={{ border: `1.5px solid ${CHARCOAL}`, background: "#fff", fontFamily: "'Oswald', sans-serif" }} className="flex-1 py-3 rounded-xl text-sm font-semibold flex items-center justify-center gap-2">
                  <Pause size={16} /> BREAK
                </button>
                <button
                  onClick={clockOut}
                  style={{
                    color: PAPER, fontFamily: "'Oswald', sans-serif",
                    background: `linear-gradient(165deg, #2b322e 0%, ${CHARCOAL} 65%)`,
                    boxShadow: "0 4px 10px rgba(31,36,33,0.35)",
                  }}
                  className="flex-1 py-3 rounded-xl text-sm font-semibold flex items-center justify-center gap-2"
                >
                  <Square size={14} /> CLOCK OUT
                </button>
              </>
            )}
            {status === "break" && (
              <button
                onClick={endBreak}
                style={{
                  color: "#fff", fontFamily: "'Oswald', sans-serif",
                  background: `linear-gradient(135deg, #E4794F, ${RUST_DEEP})`,
                  boxShadow: "0 4px 10px rgba(166,61,32,0.35)",
                }}
                className="flex-1 py-3 rounded-xl text-sm font-semibold flex items-center justify-center gap-2"
              >
                <Play size={16} /> END BREAK
              </button>
            )}
          </div>
        </div>

        <div
          style={{
            border: `1px solid rgba(31,36,33,0.06)`, color: PAPER,
            background: `linear-gradient(165deg, #2b322e 0%, ${CHARCOAL} 65%)`,
            boxShadow: "0 10px 24px rgba(31,36,33,0.18)",
          }}
          className="rounded-2xl p-4 mb-6"
        >
          <div className="flex items-center justify-between mb-1">
            <span style={{ fontFamily: "'Oswald', sans-serif" }} className="text-xs uppercase tracking-widest opacity-80">
              Current pay period
            </span>
            <span className="text-xs opacity-70">{formatDateShort(period.start)} – {formatDateShort(period.end)}</span>
          </div>
          <div style={{ fontFamily: "'Oswald', sans-serif" }} className="text-3xl font-semibold tabular-nums mb-3">
            {formatDuration(periodTotalSeconds)}
          </div>
          <button
            onClick={submitHours}
            disabled={log.length === 0}
            style={{
              color: CHARCOAL, fontFamily: "'Oswald', sans-serif",
              background: `linear-gradient(180deg, #F9C978 0%, ${AMBER} 55%, ${AMBER_DEEP} 100%)`,
              boxShadow: "0 4px 10px rgba(219,138,22,0.35), inset 0 1px 0 rgba(255,255,255,0.5)",
            }}
            className="w-full py-2.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-40"
          >
            <Send size={14} /> SUBMIT HOURS FOR PAYROLL
          </button>
          {submitted && (
            <p className="text-[11px] mt-2 flex items-center gap-1 opacity-80">
              <Mail size={11} /> Sent — you and the office both got a copy.
            </p>
          )}
        </div>

        <div className="mb-3 flex items-center justify-between">
          <h2 style={{ fontFamily: "'Oswald', sans-serif" }} className="text-sm uppercase tracking-widest">
            This Period's Punches
          </h2>
          <span className="text-xs" style={{ color: "#8A8578" }}>{log.length} total</span>
        </div>

        {log.length === 0 ? (
          <p className="text-sm" style={{ color: "#8A8578" }}>No completed shifts yet this pay period.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {log.map((entry) => (
              <div
                key={entry.time_entry_id}
                style={{ background: "#fff", border: `1px solid rgba(31,36,33,0.05)`, boxShadow: "0 6px 16px rgba(31,36,33,0.06), 0 1px 3px rgba(31,36,33,0.04)" }}
                className="rounded-xl p-4"
              >
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <div className="text-sm font-medium">{entry.job_name}</div>
                    <div className="text-xs flex items-center gap-1 mt-0.5" style={{ color: "#8A8578" }}>
                      {entry.location_type === "in_town" ? (<><MapPin size={11} /> In town</>) : (<><Plane size={11} /> Traveling</>)}
                    </div>
                  </div>
                  <div style={{ fontFamily: "'Oswald', sans-serif" }} className="text-lg font-semibold tabular-nums">
                    {formatDuration(entry.worked_seconds)}
                  </div>
                </div>
                <div className="flex justify-between text-xs pt-2" style={{ color: "#8A8578", borderTop: `1px solid ${LINE}` }}>
                  <span>{formatClock(entry.clock_in)} → {formatClock(entry.clock_out)}</span>
                  {entry.break_seconds > 0 && <span>break {formatDuration(entry.break_seconds)}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
        </>
        )}
      </div>

      <div
        style={{ background: "#fff", borderTop: `1px solid ${LINE}`, boxShadow: "0 -8px 20px rgba(31,36,33,0.06)" }}
        className="fixed bottom-0 left-0 right-0 flex"
      >
        <div className="max-w-md mx-auto w-full flex">
          <button
            onClick={() => setView("clock")}
            style={{ color: view === "clock" ? CHARCOAL : "#8A8578", fontFamily: "'Oswald', sans-serif" }}
            className="flex-1 py-3 text-xs flex flex-col items-center gap-1 uppercase tracking-widest"
          >
            <span
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 12,
                background: view === "clock" ? `linear-gradient(135deg, #F9C978, ${AMBER})` : "transparent",
                boxShadow: view === "clock" ? "0 3px 8px rgba(219,138,22,0.35)" : "none",
              }}
            >
              <Timer size={16} style={{ color: view === "clock" ? CHARCOAL : "#8A8578" }} />
            </span>
            Clock
          </button>
          <button
            onClick={() => setView("schedule")}
            style={{ color: view === "schedule" ? CHARCOAL : "#8A8578", fontFamily: "'Oswald', sans-serif", position: "relative" }}
            className="flex-1 py-3 text-xs flex flex-col items-center gap-1 uppercase tracking-widest"
          >
            <span
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 12,
                background: view === "schedule" ? `linear-gradient(135deg, #F9C978, ${AMBER})` : "transparent",
                boxShadow: view === "schedule" ? "0 3px 8px rgba(219,138,22,0.35)" : "none",
              }}
            >
              <CalendarDays size={16} style={{ color: view === "schedule" ? CHARCOAL : "#8A8578" }} />
            </span>
            Schedule
            {scheduleUnseenCount > 0 && (
              <span
                style={{
                  position: "absolute", top: 2, right: "22%",
                  background: RUST, color: "#fff", fontSize: 9, fontWeight: 800,
                  borderRadius: 20, padding: "1px 5px", minWidth: 14, textAlign: "center", lineHeight: 1.3,
                }}
              >
                {scheduleUnseenCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setView("customers")}
            style={{ color: view === "customers" ? CHARCOAL : "#8A8578", fontFamily: "'Oswald', sans-serif" }}
            className="flex-1 py-3 text-xs flex flex-col items-center gap-1 uppercase tracking-widest"
          >
            <span
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 12,
                background: view === "customers" ? `linear-gradient(135deg, #F9C978, ${AMBER})` : "transparent",
                boxShadow: view === "customers" ? "0 3px 8px rgba(219,138,22,0.35)" : "none",
              }}
            >
              <Users size={16} style={{ color: view === "customers" ? CHARCOAL : "#8A8578" }} />
            </span>
            Customers
          </button>
          <button
            onClick={() => setView("chat")}
            style={{ color: view === "chat" ? CHARCOAL : "#8A8578", fontFamily: "'Oswald', sans-serif", position: "relative" }}
            className="flex-1 py-3 text-xs flex flex-col items-center gap-1 uppercase tracking-widest"
          >
            <span
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 12,
                background: view === "chat" ? `linear-gradient(135deg, #F9C978, ${AMBER})` : "transparent",
                boxShadow: view === "chat" ? "0 3px 8px rgba(219,138,22,0.35)" : "none",
              }}
            >
              <MessageCircle size={16} style={{ color: view === "chat" ? CHARCOAL : "#8A8578" }} />
            </span>
            Chat
            {chatUnreadCount > 0 && (
              <span
                style={{
                  position: "absolute", top: 2, right: "22%",
                  background: RUST, color: "#fff", fontSize: 9, fontWeight: 800,
                  borderRadius: 20, padding: "1px 5px", minWidth: 14, textAlign: "center", lineHeight: 1.3,
                }}
              >
                {chatUnreadCount}
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

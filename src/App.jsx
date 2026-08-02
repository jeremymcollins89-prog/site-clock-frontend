import { useState, useEffect, useRef } from "react";
import { Play, Pause, Square, MapPin, Plane, Clock, Send, LogOut, Mail, CalendarDays, Timer, Users, MessageCircle, Navigation, Menu, ClipboardList, Package, ScanBarcode, PartyPopper, Sun, Moon } from "lucide-react";
// @zxing/library is the single biggest contributor to the main JS bundle,
// but only employees with can_manage_inventory ever open the barcode
// scanner -- so it's loaded on demand (see loadZxing, used by
// BarcodeScanSheet's beginDecoding/handleFileCapture) instead of bundled
// into the chunk every employee downloads on every page load. The promise
// is cached so re-opening the scan sheet later doesn't refetch it.
let zxingModulePromise = null;
function loadZxing() {
  if (!zxingModulePromise) {
    zxingModulePromise = import("@zxing/library");
  }
  return zxingModulePromise;
}
import {
  login,
  restoreSession,
  logout,
  pingActivity,
  submitSnakeScore,
  getSnakeLeaderboard,
  updateMyClockInAnimation,
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
  getMyPullSheets,
  getPullSheetsUnseenCount,
  submitPulledQuantities,
  getMyInventoryItems,
  lookupInventoryBarcode,
  addInventoryCatalogItem,
  updateInventoryCatalogItem,
} from "./api.js";
import { useGeoAutoClock, markManualClockOut, clearAutoClockInSuppression } from "./geoAutoClock.js";

// Bottom-nav tab order, used by the swipe-to-switch-tabs gesture on the
// main content area (see handleTabSwipeStart/End below) -- swiping left
// moves forward through this list, swiping right moves back.
const VIEW_ORDER = ["clock", "schedule", "customers", "chat"];

const JOB_COLORS = {
  rust: "#FF4433",
  amber: "#FFA400",
  teal: "#00B871",
  blue: "#1E88FF",
  purple: "#9B30FF",
  rose: "#FF2D95",
  charcoal: "#707B85",
  yellow: "#FFE400",
};

// "job" gets no badge at all (see the `job.event_type !== "job"` guard at
// each call site) -- this only ever needs to label personal/other/time_off.
function eventTypeLabel(eventType) {
  if (eventType === "personal") return "Personal";
  if (eventType === "time_off") return "Time Off";
  return "Other";
}

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

// Same Day/Night palette as the two admin apps (admin.html, admin-app's
// index.html) -- kept byte-for-byte identical so all three apps look like
// one consistent product. --charcoal/--paper are intentionally NOT given a
// Night override: they're used directly for "chrome" backgrounds (dark
// buttons, the gold clock-in/login buttons, etc.) that stay the same in
// both themes -- see CHARCOAL/PAPER below, which still resolve to those
// fixed values, plus the new INK/BG/SURFACE/INPUT_BG/MUTED tokens which DO
// flip and are used for anything that should actually re-theme.
const THEME_VARS = `
  :root {
    --charcoal: #1F2421;
    --paper: #F4F2ED;
    --amber: #F4B04C;
    --amber-deep: #DB8A16;
    --teal: #46705F;
    --teal-deep: #2B453C;
    --rust: #D35A34;
    --rust-deep: #A63D20;
    --line: #D8D3C4;
    --ink: #1F2421;
    --bg: #F4F2ED;
    --surface: #FFFFFF;
    --input-bg: #FBFAF7;
    --muted: #8A8578;
  }
  [data-theme="night"] {
    --ink: #F4F2ED;
    --bg: #141815;
    --surface: #1E2420;
    --input-bg: #262C26;
    --muted: #ACA79A;
    --line: #333A32;
    --amber: #FFC670;
    --amber-deep: #F0A233;
    --teal: #5FA189;
    --teal-deep: #3E7161;
    --rust: #E8754C;
    --rust-deep: #C25730;
  }
`;
const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');` + THEME_VARS;

// Fixed (unthemed) -- "chrome" backgrounds/fixed-warm-gradient text that
// stay the same dark/light regardless of Day or Night mode.
const CHARCOAL = "var(--charcoal)";
const PAPER = "var(--paper)";
// Themed -- these flip between Day and Night automatically since they're
// plain CSS var() references resolved by the browser, not React state, so
// switching themes needs zero re-render.
const INK = "var(--ink)";
const BG = "var(--bg)";
const SURFACE = "var(--surface)";
const INPUT_BG = "var(--input-bg)";
const MUTED = "var(--muted)";
const AMBER = "var(--amber)";
const AMBER_DEEP = "var(--amber-deep)";
const TEAL = "var(--teal)";
const TEAL_DEEP = "var(--teal-deep)";
const RUST = "var(--rust)";
const RUST_DEEP = "var(--rust-deep)";
const LINE = "var(--line)";

// Full-screen clock-in celebration, shown briefly after a clock-in when the
// employee has a clock-in animation picked (set per-person in the admin
// app's employee section, via clock_in_animation: "none" | "fireworks" |
// "birthday" | "rocket" | "fall" | "easter" | "christmas"). Pure canvas
// animations, no dependencies. All of them run for exactly the same
// duration so they feel consistent.
const ANIMATION_DURATION_MS = 12000;
const FIREWORKS_DURATION_MS = ANIMATION_DURATION_MS;
// Rocket launch splits the same 12s window into a 3s countdown (still on
// the pad) followed by 9s of powered flight up and off the top of the screen.
const ROCKET_COUNTDOWN_MS = 3000;
const ROCKET_LAUNCH_MS = ANIMATION_DURATION_MS - ROCKET_COUNTDOWN_MS;

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
          // Dark text + a light halo (rather than white text + a dark
          // shadow) so this reads clearly against the app's light PAPER
          // background, not just against a dark photo/video background.
          color: INK,
          textShadow: "0 0 10px rgba(244,242,237,0.95), 0 0 4px rgba(244,242,237,0.95), 0 2px 6px rgba(244,242,237,0.7)",
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

// Shared caption style for the three seasonal overlays below and Birthday
// above -- dark text with a light halo (not white-on-dark) so it reads
// clearly against the app's light PAPER background rather than needing a
// dark photo/video behind it.
const CELEBRATION_CAPTION_STYLE = {
  position: "absolute",
  top: "38%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  textAlign: "center",
  color: INK,
  textShadow: "0 0 10px rgba(244,242,237,0.95), 0 0 4px rgba(244,242,237,0.95), 0 2px 6px rgba(244,242,237,0.7)",
  fontSize: "clamp(24px, 6vw, 44px)",
  fontWeight: 800,
  padding: "0 16px",
};

// Full-screen falling-leaves celebration, shown after a clock-in when
// clock_in_animation is "fall". Same ref-based timing/hard-stop pattern as
// the other overlays, at the shared ANIMATION_DURATION_MS. Leaves sway
// side-to-side as a function of how far they've fallen (not raw elapsed
// time), so the motion stays smooth regardless of frame rate.
function FallOverlay({ onDone }) {
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

    const colors = [RUST, RUST_DEEP, AMBER, AMBER_DEEP, "#8B5A2B"];
    let leaves = [];

    function spawnLeaves(count) {
      for (let i = 0; i < count; i++) {
        leaves.push({
          x: Math.random() * width,
          y: -20 - Math.random() * height * 0.3,
          vy: 1 + Math.random() * 1.4,
          swayFreq: 0.01 + Math.random() * 0.012,
          swayAmp: 20 + Math.random() * 30,
          swayOffset: Math.random() * Math.PI * 2,
          size: 8 + Math.random() * 8,
          rotation: Math.random() * Math.PI * 2,
          rotSpeed: (Math.random() - 0.5) * 0.06,
          color: colors[Math.floor(Math.random() * colors.length)],
        });
      }
    }
    spawnLeaves(50);

    const startedAt = performance.now();
    const spawnIntervalMs = 400;
    let lastSpawnAt = 0;
    let raf;
    let stopped = false;

    function tick(now) {
      const elapsed = now - startedAt;
      ctx.clearRect(0, 0, width, height);

      if (elapsed < ANIMATION_DURATION_MS && now - lastSpawnAt >= spawnIntervalMs) {
        spawnLeaves(10);
        lastSpawnAt = now;
      }

      leaves.forEach((l) => { l.y += l.vy; l.rotation += l.rotSpeed; });
      leaves = leaves.filter((l) => l.y < height + 30);

      leaves.forEach((l) => {
        const swayX = l.x + Math.sin(l.y * l.swayFreq + l.swayOffset) * l.swayAmp;
        ctx.save();
        ctx.translate(swayX, l.y);
        ctx.rotate(l.rotation);
        ctx.fillStyle = l.color;
        ctx.beginPath();
        ctx.ellipse(0, 0, l.size, l.size * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });

      if (elapsed >= ANIMATION_DURATION_MS && (leaves.length === 0 || elapsed >= ANIMATION_DURATION_MS + 1200)) {
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
      <div style={CELEBRATION_CAPTION_STYLE}>🍂 Happy Thanksgiving! 🦃</div>
    </div>
  );
}

// Full-screen falling-petals celebration, shown after a clock-in when
// clock_in_animation is "easter". Pastel palette + slower drift than the
// fall leaves so it reads as gentle spring weather rather than a storm.
function EasterOverlay({ onDone }) {
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

    const colors = ["#F4A6C1", "#C6A8E0", "#F4D35E", "#8FCBEA", "#8FE0C4"];
    let petals = [];

    function spawnPetals(count) {
      for (let i = 0; i < count; i++) {
        petals.push({
          x: Math.random() * width,
          y: -20 - Math.random() * height * 0.3,
          vy: 0.6 + Math.random() * 1,
          swayFreq: 0.012 + Math.random() * 0.014,
          swayAmp: 25 + Math.random() * 35,
          swayOffset: Math.random() * Math.PI * 2,
          size: 7 + Math.random() * 7,
          rotation: Math.random() * Math.PI * 2,
          rotSpeed: (Math.random() - 0.5) * 0.05,
          color: colors[Math.floor(Math.random() * colors.length)],
        });
      }
    }
    spawnPetals(50);

    const startedAt = performance.now();
    const spawnIntervalMs = 400;
    let lastSpawnAt = 0;
    let raf;
    let stopped = false;

    function tick(now) {
      const elapsed = now - startedAt;
      ctx.clearRect(0, 0, width, height);

      if (elapsed < ANIMATION_DURATION_MS && now - lastSpawnAt >= spawnIntervalMs) {
        spawnPetals(10);
        lastSpawnAt = now;
      }

      petals.forEach((p) => { p.y += p.vy; p.rotation += p.rotSpeed; });
      petals = petals.filter((p) => p.y < height + 30);

      petals.forEach((p) => {
        const swayX = p.x + Math.sin(p.y * p.swayFreq + p.swayOffset) * p.swayAmp;
        ctx.save();
        ctx.translate(swayX, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.ellipse(0, 0, p.size, p.size * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });

      if (elapsed >= ANIMATION_DURATION_MS && (petals.length === 0 || elapsed >= ANIMATION_DURATION_MS + 1200)) {
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
      <div style={CELEBRATION_CAPTION_STYLE}>🐣 Happy Easter! 🌷</div>
    </div>
  );
}

// Full-screen falling-snow celebration, shown after a clock-in when
// clock_in_animation is "christmas". Deliberately NOT plain white snow --
// on this app's light background that would have the same low-contrast
// problem the Birthday caption had, so the flakes use a cool icy-blue
// palette instead, which stays visible against the light PAPER background.
function ChristmasOverlay({ onDone }) {
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

    const colors = ["#5A8FB5", "#8FCBEA", "#2B6E8F", "#BFE3F7"];
    let flakes = [];

    function spawnFlakes(count) {
      for (let i = 0; i < count; i++) {
        flakes.push({
          x: Math.random() * width,
          y: -20 - Math.random() * height * 0.3,
          vy: 0.7 + Math.random() * 1.2,
          swayFreq: 0.01 + Math.random() * 0.012,
          swayAmp: 15 + Math.random() * 25,
          swayOffset: Math.random() * Math.PI * 2,
          size: 3 + Math.random() * 4,
          color: colors[Math.floor(Math.random() * colors.length)],
        });
      }
    }
    spawnFlakes(70);

    const startedAt = performance.now();
    const spawnIntervalMs = 350;
    let lastSpawnAt = 0;
    let raf;
    let stopped = false;

    function tick(now) {
      const elapsed = now - startedAt;
      ctx.clearRect(0, 0, width, height);

      if (elapsed < ANIMATION_DURATION_MS && now - lastSpawnAt >= spawnIntervalMs) {
        spawnFlakes(18);
        lastSpawnAt = now;
      }

      flakes.forEach((f) => { f.y += f.vy; });
      flakes = flakes.filter((f) => f.y < height + 20);

      flakes.forEach((f) => {
        const swayX = f.x + Math.sin(f.y * f.swayFreq + f.swayOffset) * f.swayAmp;
        ctx.fillStyle = f.color;
        ctx.beginPath();
        ctx.arc(swayX, f.y, f.size, 0, Math.PI * 2);
        ctx.fill();
      });

      if (elapsed >= ANIMATION_DURATION_MS && (flakes.length === 0 || elapsed >= ANIMATION_DURATION_MS + 1200)) {
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
      <div style={CELEBRATION_CAPTION_STYLE}>❄️ Merry Christmas! 🎄</div>
    </div>
  );
}

// Full-screen SpaceX-style rocket launch, shown briefly after a clock-in
// when the employee's clock_in_animation is "rocket". First 3s is a
// pad-side 3-2-1 countdown, then the rocket lifts off with a flame trail
// and flies off the top of the screen over the remaining 9s. Mirrors the
// other overlays' ref-based timing and hard-stop at ANIMATION_DURATION_MS.
function RocketLaunchOverlay({ onDone }) {
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

    // Fixed starfield so the night sky doesn't feel empty during the countdown.
    const stars = Array.from({ length: 70 }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: 0.6 + Math.random() * 1.4,
    }));

    let flames = [];
    const startedAt = performance.now();
    let raf;
    let stopped = false;

    function spawnFlame(x, y) {
      for (let i = 0; i < 3; i++) {
        flames.push({
          x: x + (Math.random() - 0.5) * 16,
          y: y + Math.random() * 6,
          vx: (Math.random() - 0.5) * 0.7,
          vy: 1.6 + Math.random() * 2.2,
          life: 1,
          color: Math.random() < 0.5 ? "#FFB020" : "#FF5A1F",
        });
      }
    }

    function tick(now) {
      const elapsed = now - startedAt;

      // Night-sky background for the whole run.
      ctx.fillStyle = "#0B1220";
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      stars.forEach((s) => {
        ctx.beginPath();
        ctx.arc(s.x * width, s.y * height, s.r, 0, Math.PI * 2);
        ctx.fill();
      });

      const padY = height * 0.82;
      // The rocket emoji renders leaning up-and-to-the-right in most fonts --
      // rotate it upright so "launch" reads as straight up, not sideways.
      const ROCKET_ROTATION = -Math.PI / 4;
      const rocketFontSize = Math.round(Math.min(width, height) * 0.16);

      if (elapsed < ROCKET_COUNTDOWN_MS) {
        const secondsLeft = 3 - Math.floor(elapsed / 1000);
        const label = secondsLeft > 0 ? String(secondsLeft) : "LIFTOFF!";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#fff";
        const bigFont = Math.round(Math.min(width, height) * 0.26);
        const smallFont = Math.round(Math.min(width, height) * 0.1);
        ctx.font = `800 ${label.length > 1 ? smallFont : bigFont}px 'IBM Plex Mono', monospace`;
        ctx.fillText(label, width / 2, height * 0.32);

        // Rocket sits still on the pad during the countdown.
        ctx.save();
        ctx.translate(width / 2, padY);
        ctx.rotate(ROCKET_ROTATION);
        ctx.font = `${rocketFontSize}px serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("🚀", 0, 0);
        ctx.restore();
      } else {
        const launchElapsed = elapsed - ROCKET_COUNTDOWN_MS;
        const progress = Math.min(launchElapsed / ROCKET_LAUNCH_MS, 1);
        // Eases in -- slow off the pad, fastest as it clears the screen.
        const eased = progress * progress;
        const rocketY = padY - eased * (padY + rocketFontSize);
        const rocketX = width / 2;

        spawnFlame(rocketX, rocketY + rocketFontSize * 0.4);

        flames.forEach((p) => {
          p.x += p.vx;
          p.y += p.vy;
          p.life -= 0.03;
        });
        flames = flames.filter((p) => p.life > 0);
        flames.forEach((p) => {
          ctx.globalAlpha = Math.max(p.life, 0);
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 5 * p.life, 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.globalAlpha = 1;

        ctx.save();
        ctx.translate(rocketX, rocketY);
        ctx.rotate(ROCKET_ROTATION);
        ctx.font = `${rocketFontSize}px serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("🚀", 0, 0);
        ctx.restore();
      }

      // Hard stop at exactly the shared 12s window.
      if (elapsed >= ANIMATION_DURATION_MS) {
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

// Hidden easter egg -- see handleLogoSecretTap (tap the header logo/title 7x
// fast) in the main App component below for how this gets opened. Deliberately
// undocumented anywhere in the UI itself; if you know, you know.
const SNAKE_GRID = 15;
const SNAKE_CELL = 18;
const SNAKE_TICK_MS = 140;
const SNAKE_BEST_KEY = "site-clock-snake-best";
// Fixed hex (not the CHARCOAL/AMBER/TEAL/RUST var() constants) since canvas
// fillStyle can't resolve a CSS var() reference -- see draw() below.
const SNAKE_BOARD_HEX = "#1F2421";
const SNAKE_HEAD_HEX = "#F4B04C";
const SNAKE_BODY_HEX = "#46705F";
const SNAKE_FOOD_HEX = "#D35A34";

function snakeRandomFood(snake) {
  let pos;
  do {
    pos = { x: Math.floor(Math.random() * SNAKE_GRID), y: Math.floor(Math.random() * SNAKE_GRID) };
  } while (snake.some((seg) => seg.x === pos.x && seg.y === pos.y));
  return pos;
}

function SnakeGame({ open, onClose }) {
  const canvasRef = useRef(null);
  const snakeRef = useRef([{ x: 7, y: 7 }, { x: 6, y: 7 }, { x: 5, y: 7 }]);
  const dirRef = useRef({ x: 1, y: 0 });
  const nextDirRef = useRef({ x: 1, y: 0 });
  const foodRef = useRef({ x: 10, y: 7 });
  const touchStartRef = useRef(null);
  const scoreRef = useRef(0); // mirrors `score` state so the game-over handler (inside a
  // setInterval closure that only gets recreated when `open`/`gameOver`
  // change, not on every point scored) always has the true current score
  // instead of whatever value was captured when the interval was created.
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(() => Number(localStorage.getItem(SNAKE_BEST_KEY) || 0));
  const [gameOver, setGameOver] = useState(false);
  const [leaderboard, setLeaderboard] = useState([]);

  function loadLeaderboard() {
    getSnakeLeaderboard().then(setLeaderboard).catch(() => {});
  }

  useEffect(() => {
    if (open) loadLeaderboard();
  }, [open]);

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    // Canvas fillStyle needs an actual resolved color, not a CSS var()
    // reference (which CHARCOAL/AMBER/TEAL/RUST became for the rest of the
    // app's theming) -- so the game board uses its own fixed hex constants
    // and, like the app's other "chrome" elements, stays the same dark
    // "game screen" look in both Day and Night mode.
    ctx.fillStyle = SNAKE_BOARD_HEX;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    snakeRef.current.forEach((seg, i) => {
      ctx.fillStyle = i === 0 ? SNAKE_HEAD_HEX : SNAKE_BODY_HEX;
      ctx.fillRect(seg.x * SNAKE_CELL + 1, seg.y * SNAKE_CELL + 1, SNAKE_CELL - 2, SNAKE_CELL - 2);
    });
    ctx.fillStyle = SNAKE_FOOD_HEX;
    ctx.fillRect(foodRef.current.x * SNAKE_CELL + 2, foodRef.current.y * SNAKE_CELL + 2, SNAKE_CELL - 4, SNAKE_CELL - 4);
  }

  function resetGame() {
    const startSnake = [{ x: 7, y: 7 }, { x: 6, y: 7 }, { x: 5, y: 7 }];
    snakeRef.current = startSnake;
    dirRef.current = { x: 1, y: 0 };
    nextDirRef.current = { x: 1, y: 0 };
    foodRef.current = snakeRandomFood(startSnake);
    scoreRef.current = 0;
    setScore(0);
    setGameOver(false);
  }

  useEffect(() => {
    if (!open) return;
    resetGame();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || gameOver) return;
    const interval = setInterval(() => {
      dirRef.current = nextDirRef.current;
      const head = snakeRef.current[0];
      const newHead = { x: head.x + dirRef.current.x, y: head.y + dirRef.current.y };
      const hitWall = newHead.x < 0 || newHead.x >= SNAKE_GRID || newHead.y < 0 || newHead.y >= SNAKE_GRID;
      const hitSelf = snakeRef.current.some((seg) => seg.x === newHead.x && seg.y === newHead.y);
      if (hitWall || hitSelf) {
        setGameOver(true);
        // Fire-and-forget: submit whatever the run's final score was (the
        // backend takes GREATEST against their existing best, so this is
        // safe to call even on a worse-than-usual run), then refresh the
        // board so a new personal best shows up immediately.
        if (scoreRef.current > 0) {
          submitSnakeScore(scoreRef.current).then(loadLeaderboard).catch(() => {});
        }
        return;
      }
      const ateFood = newHead.x === foodRef.current.x && newHead.y === foodRef.current.y;
      const newSnake = [newHead, ...snakeRef.current];
      if (!ateFood) {
        newSnake.pop();
      } else {
        foodRef.current = snakeRandomFood(newSnake);
        setScore((s) => {
          const next = s + 1;
          scoreRef.current = next;
          setBest((b) => {
            if (next <= b) return b;
            localStorage.setItem(SNAKE_BEST_KEY, String(next));
            return next;
          });
          return next;
        });
      }
      snakeRef.current = newSnake;
      draw();
    }, SNAKE_TICK_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, gameOver]);

  useEffect(() => {
    if (!open) return;
    function handleKey(e) {
      if (e.key === "ArrowUp") setDirection(0, -1);
      else if (e.key === "ArrowDown") setDirection(0, 1);
      else if (e.key === "ArrowLeft") setDirection(-1, 0);
      else if (e.key === "ArrowRight") setDirection(1, 0);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open]);

  function setDirection(x, y) {
    // Can't reverse straight into your own neck.
    if (dirRef.current.x === -x && dirRef.current.y === -y) return;
    nextDirRef.current = { x, y };
  }

  function handleTouchStart(e) {
    const t = e.touches[0];
    touchStartRef.current = { x: t.clientX, y: t.clientY };
  }
  function handleTouchEnd(e) {
    if (!touchStartRef.current) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStartRef.current.x;
    const dy = t.clientY - touchStartRef.current.y;
    touchStartRef.current = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 20) return;
    if (Math.abs(dx) > Math.abs(dy)) setDirection(dx > 0 ? 1 : -1, 0);
    else setDirection(0, dy > 0 ? 1 : -1);
  }

  if (!open) return null;

  const canvasSize = SNAKE_GRID * SNAKE_CELL;
  const dpadBtnStyle = {
    width: 44,
    height: 44,
    borderRadius: 10,
    border: "none",
    background: LINE,
    color: INK,
    fontSize: 18,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };

  return (
    <div
      // No backdrop-click-to-close and no touch bubbling: once open, this
      // takes over completely (a stray tap continuing past the 7th one that
      // opened it used to land on this backdrop and instantly close it
      // again), and swipes on the board no longer leak through to the app's
      // own tab-swipe gesture behind it. The X button is the only way out.
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      style={{ position: "fixed", inset: 0, background: "rgba(31,36,33,0.5)", zIndex: 200 }}
      className="flex items-end"
    >
      <div
        style={{
          background: BG,
          width: "100%",
          maxHeight: "92vh",
          overflowY: "auto",
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          boxShadow: "0 -12px 32px rgba(31,36,33,0.18)",
          padding: "20px 20px calc(20px + env(safe-area-inset-bottom))",
          fontFamily: "'IBM Plex Mono', monospace",
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 style={{ fontFamily: "'Oswald', sans-serif" }} className="text-sm uppercase tracking-widest">
            Snake
          </h2>
          <button onClick={onClose} style={{ fontSize: 22, lineHeight: 1, color: INK, background: "transparent", border: "none" }}>
            &times;
          </button>
        </div>

        <div className="flex items-center justify-between mb-2 text-xs" style={{ color: MUTED }}>
          <span>Score: {score}</span>
          <span>Best: {best}</span>
        </div>

        <div className="flex justify-center">
          <div style={{ position: "relative", width: canvasSize, height: canvasSize }}>
            <canvas
              ref={canvasRef}
              width={canvasSize}
              height={canvasSize}
              style={{ borderRadius: 10, touchAction: "none", display: "block" }}
              onTouchStart={handleTouchStart}
              onTouchEnd={handleTouchEnd}
            />
            {gameOver && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  background: "rgba(31,36,33,0.8)",
                  borderRadius: 10,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 10,
                }}
              >
                <p style={{ color: "#fff" }} className="text-sm font-semibold">
                  Game over — score {score}
                </p>
                <button
                  onClick={resetGame}
                  className="text-xs px-4 py-2 rounded-lg font-medium"
                  style={{ background: TEAL, color: "#fff" }}
                >
                  Play again
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col items-center gap-1 mt-4">
          <button onClick={() => setDirection(0, -1)} style={dpadBtnStyle}>↑</button>
          <div className="flex gap-1">
            <button onClick={() => setDirection(-1, 0)} style={dpadBtnStyle}>←</button>
            <button onClick={() => setDirection(0, 1)} style={dpadBtnStyle}>↓</button>
            <button onClick={() => setDirection(1, 0)} style={dpadBtnStyle}>→</button>
          </div>
        </div>
        <p className="text-xs text-center mt-3 mb-4" style={{ color: MUTED }}>
          Swipe on the board or use the arrows.
        </p>

        {/* Global leaderboard -- every company on the platform shares one
            board, so a good run here shows up next to names from other
            businesses entirely, not just coworkers. */}
        <div className="h-px w-full mb-3" style={{ background: `repeating-linear-gradient(90deg, ${LINE} 0 6px, transparent 6px 12px)` }} />
        <h3 style={{ fontFamily: "'Oswald', sans-serif" }} className="text-xs uppercase tracking-widest mb-2 text-center">
          Global leaderboard
        </h3>
        {leaderboard.length === 0 ? (
          <p className="text-xs text-center pb-2" style={{ color: MUTED }}>
            No scores yet -- be the first.
          </p>
        ) : (
          <div className="flex flex-col gap-1 pb-2">
            {leaderboard.map((row, i) => (
              <div key={i} className="flex items-center justify-between text-xs" style={{ padding: "4px 2px" }}>
                <span className="flex items-center gap-2" style={{ minWidth: 0 }}>
                  <span style={{ color: MUTED, width: 16, flexShrink: 0 }}>{i + 1}.</span>
                  <span className="truncate" style={{ fontWeight: 600 }}>{row.employee_name}</span>
                  {row.company_name && (
                    <span className="truncate" style={{ color: MUTED }}>— {row.company_name}</span>
                  )}
                </span>
                <span style={{ color: TEAL, fontWeight: 700, flexShrink: 0, marginLeft: 8 }}>{row.best_score}</span>
              </div>
            ))}
          </div>
        )}
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
        background: SURFACE,
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
              {eventTypeLabel(job.event_type)}
            </span>
          )}
        </div>
        <div className="text-xs mt-0.5" style={{ color: MUTED }}>
          {dateLabel}
          {timeLabel && ` · ${timeLabel}`}
        </div>
      </div>
      <span style={{ color: MUTED, fontSize: 18, flexShrink: 0 }}>&rsaquo;</span>
    </button>
  );
}

// Bottom-sheet with the full picture for one job: customer name, a tel:
// link for the phone, a Google Maps directions link for the address, and
// any notes. Tapping the dimmed backdrop closes it, same as the admin apps.
function formatAttachmentSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function JobDetailSheet({ job, onClose }) {
  const [attachments, setAttachments] = useState([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);

  useEffect(() => {
    if (!job || job.event_type !== "job") {
      setAttachments([]);
      return;
    }
    let cancelled = false;
    setAttachmentsLoading(true);
    getJobAttachments(job.id)
      .then((rows) => { if (!cancelled) setAttachments(rows); })
      .catch(() => { if (!cancelled) setAttachments([]); })
      .finally(() => { if (!cancelled) setAttachmentsLoading(false); });
    return () => { cancelled = true; };
  }, [job && job.id]);

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
          background: BG,
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
                {eventTypeLabel(job.event_type)}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            style={{ fontSize: 22, lineHeight: 1, color: INK, background: "transparent", border: "none", flexShrink: 0 }}
          >
            &times;
          </button>
        </div>
        <div className="text-xs mb-3" style={{ color: MUTED }}>
          {dateLabel}
          {timeLabel && ` · ${timeLabel}`}
        </div>

        {job.customer_name && (
          <div className="text-sm font-medium mt-2" style={{ color: INK }}>{job.customer_name}</div>
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

        {job.event_type === "job" && (attachmentsLoading || attachments.length > 0) && (
          <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${LINE}` }}>
            <div className="text-xs font-medium mb-2" style={{ color: MUTED }}>Attachments</div>
            {attachmentsLoading ? (
              <div className="text-xs" style={{ color: MUTED }}>Loading…</div>
            ) : (
              attachments.map((a) => (
                <button
                  key={a.id}
                  onClick={() => viewAttachment(a.id).catch((err) => alert(err.message))}
                  className="flex items-center justify-between w-full text-left text-sm mb-1"
                  style={{ background: "transparent", border: "none", padding: "6px 0", color: RUST }}
                >
                  <span className="underline truncate">{a.file_name}</span>
                  <span className="text-xs flex-shrink-0 ml-2" style={{ color: MUTED }}>
                    {formatAttachmentSize(a.file_size)}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const TIME_OFF_STATUS_STYLE = {
  pending: { bg: "#FBEFD6", color: "#8A5A00", label: "Pending" },
  approved: { bg: "#DDEFE6", color: "#0A7A45", label: "Approved" },
  denied: { bg: "#FBDCD3", color: "#B23A1E", label: "Denied" },
  cancelled: { bg: LINE, color: "#5C6660", label: "Cancelled" },
};

// Bottom sheet reachable from the "Time off" button on the Schedule tab --
// a flexible date-range request (a day, a week, whatever) with an optional
// note, plus the employee's own request history so they can see what's
// pending/approved/denied without having to ask. Approving a request is
// what actually adds it to the shared calendar (bright yellow, see
// JOB_COLORS.yellow) -- this sheet only ever creates/cancels the request
// itself.
function TimeOffSheet({ open, onClose, requests, loading, form, onFormChange, onSubmit, submitting, error, onCancelRequest }) {
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(31,36,33,0.5)", zIndex: 100 }}
      className="flex items-end"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: BG,
          width: "100%",
          maxHeight: "85vh",
          overflowY: "auto",
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          boxShadow: "0 -12px 32px rgba(31,36,33,0.18)",
          padding: "20px 20px calc(20px + env(safe-area-inset-bottom))",
          fontFamily: "'IBM Plex Mono', monospace",
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 style={{ fontFamily: "'Oswald', sans-serif" }} className="text-sm uppercase tracking-widest flex items-center gap-2">
            <Plane size={14} /> Request time off
          </h2>
          <button onClick={onClose} style={{ fontSize: 22, lineHeight: 1, color: INK, background: "transparent", border: "none" }}>
            &times;
          </button>
        </div>

        <form onSubmit={onSubmit} className="mb-5">
          <div className="grid grid-cols-2 gap-3 mb-3">
            <label className="text-xs">
              <div className="mb-1" style={{ color: MUTED }}>Start date</div>
              <input
                type="date"
                required
                value={form.start_date}
                onChange={(e) => onFormChange({ ...form, start_date: e.target.value })}
                style={{ border: `1px solid ${LINE}`, background: SURFACE }}
                className="rounded-lg px-2 py-2 w-full text-sm"
              />
            </label>
            <label className="text-xs">
              <div className="mb-1" style={{ color: MUTED }}>End date</div>
              <input
                type="date"
                required
                value={form.end_date}
                min={form.start_date || undefined}
                onChange={(e) => onFormChange({ ...form, end_date: e.target.value })}
                style={{ border: `1px solid ${LINE}`, background: SURFACE }}
                className="rounded-lg px-2 py-2 w-full text-sm"
              />
            </label>
          </div>
          <label className="text-xs block mb-3">
            <div className="mb-1" style={{ color: MUTED }}>Note (optional)</div>
            <textarea
              value={form.note}
              onChange={(e) => onFormChange({ ...form, note: e.target.value })}
              placeholder="What's it for? Leave blank if you'd rather not say."
              rows={2}
              style={{ border: `1px solid ${LINE}`, background: SURFACE, resize: "none" }}
              className="rounded-lg px-2 py-2 w-full text-sm"
            />
          </label>
          {error && (
            <div style={{ background: SURFACE, border: `1.5px solid ${RUST}`, color: RUST }} className="rounded-xl p-2.5 mb-3 text-xs">
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={submitting}
            style={{ background: CHARCOAL, color: "#fff", opacity: submitting ? 0.6 : 1 }}
            className="w-full rounded-xl py-2.5 text-sm font-medium"
          >
            {submitting ? "Submitting..." : "Submit request"}
          </button>
        </form>

        <div className="pt-3" style={{ borderTop: `1px solid ${LINE}` }}>
          <div className="text-xs uppercase tracking-widest mb-2" style={{ color: MUTED }}>Your requests</div>
          {loading ? (
            <p className="text-xs" style={{ color: MUTED }}>Loading...</p>
          ) : requests.length === 0 ? (
            <p className="text-xs" style={{ color: MUTED }}>No time off requests yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {requests.map((r) => {
                const style = TIME_OFF_STATUS_STYLE[r.status] || TIME_OFF_STATUS_STYLE.pending;
                const dateLabel =
                  r.start_date === r.end_date
                    ? formatDateShort(r.start_date)
                    : `${formatDateShort(r.start_date)} – ${formatDateShort(r.end_date)}`;
                return (
                  <div key={r.id} style={{ background: SURFACE, border: `1px solid ${LINE}` }} className="rounded-xl p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">{dateLabel}</span>
                      <span
                        className="rounded"
                        style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em", padding: "2px 8px", background: style.bg, color: style.color }}
                      >
                        {style.label}
                      </span>
                    </div>
                    {r.note && <div className="text-xs mt-1" style={{ color: MUTED }}>{r.note}</div>}
                    {r.status === "pending" && (
                      <button
                        onClick={() => onCancelRequest(r.id)}
                        className="text-xs underline mt-2"
                        style={{ color: RUST }}
                      >
                        Cancel request
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const PULL_SHEET_STATUS_STYLE = {
  open: { bg: LINE, color: "#5C6660", label: "Open" },
  pulled: { bg: "#FBEFD6", color: "#8A5A00", label: "Reported" },
  fulfilled: { bg: "#DDEFE6", color: "#0A7A45", label: "Fulfilled" },
};

// One pull sheet's card inside PullSheetsSheet below. Owns its own draft
// quantity-pulled inputs (keyed by item id, seeded from whatever's already
// been reported, falling back to the requested quantity) so typing in one
// card never touches another. Read-only once fulfilled -- at that point
// the admin has already used these numbers to actually remove stock, so
// there's nothing left to report.
function PullSheetCard({ sheet, onSubmitPulled }) {
  const [qtys, setQtys] = useState(() =>
    Object.fromEntries(sheet.items.map((i) => [i.id, String(i.quantity_pulled != null ? i.quantity_pulled : i.quantity)]))
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const style = PULL_SHEET_STATUS_STYLE[sheet.status] || PULL_SHEET_STATUS_STYLE.open;
  const isFulfilled = sheet.status === "fulfilled";

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const items = sheet.items.map((i) => ({ id: i.id, quantity_pulled: qtys[i.id] }));
      await onSubmitPulled(sheet.id, items);
      setSaved(true);
    } catch (err) {
      setError(err.message || "Couldn't save what you pulled.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ background: SURFACE, border: `1px solid ${LINE}` }} className="rounded-xl p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{sheet.source_label}</span>
        <span
          className="rounded"
          style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em", padding: "2px 8px", background: style.bg, color: style.color }}
        >
          {style.label}
        </span>
      </div>
      {sheet.customer_name && (
        <div className="text-xs mt-0.5" style={{ color: MUTED }}>{sheet.customer_name}</div>
      )}
      <div className="text-xs mt-0.5" style={{ color: MUTED }}>
        Built {formatDateShort(sheet.created_at)}
      </div>

      <div className="mt-2 flex flex-col gap-1.5">
        {sheet.items.map((item) => (
          <div key={item.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="flex-1">{item.name}</span>
            <span className="text-xs" style={{ color: MUTED }}>of {item.quantity}</span>
            {isFulfilled ? (
              <span style={{ color: MUTED }}>{item.quantity_pulled != null ? item.quantity_pulled : item.quantity}</span>
            ) : (
              <input
                type="number"
                min="0"
                step="1"
                value={qtys[item.id]}
                onChange={(e) => setQtys((q) => ({ ...q, [item.id]: e.target.value }))}
                style={{ width: 56, border: `1px solid ${LINE}`, background: SURFACE }}
                className="rounded-lg px-2 py-1 text-sm text-right"
              />
            )}
          </div>
        ))}
      </div>

      {!isFulfilled && (
        <>
          {error && (
            <div style={{ background: SURFACE, border: `1.5px solid ${RUST}`, color: RUST }} className="rounded-lg p-2 mt-2 text-xs">
              {error}
            </div>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            style={{ background: CHARCOAL, color: "#fff", opacity: saving ? 0.6 : 1 }}
            className="w-full rounded-lg py-2 text-xs font-medium mt-2"
          >
            {saving ? "Saving..." : saved ? "Saved" : "Mark as pulled"}
          </button>
        </>
      )}
    </div>
  );
}

// Bottom sheet reachable from the "Pull sheets" entry in CalendarView's
// hamburger menu. Visible to every employee, for every pull sheet in the
// company -- an admin builds them in the admin app, and can either build
// from a quote/invoice (tied to a job) or a solo/manual sheet not tied to
// any job at all; both show up here the same way. Employees can report the
// actual quantity they pulled per item (see PullSheetCard above), but that's
// purely informational -- the admin's own "Mark fulfilled" step in the
// admin app is still what actually removes anything from real inventory.
function PullSheetsSheet({ open, onClose, pullSheets, loading, onSubmitPulled }) {
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(31,36,33,0.5)", zIndex: 100 }}
      className="flex items-end"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: BG,
          width: "100%",
          maxHeight: "85vh",
          overflowY: "auto",
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          boxShadow: "0 -12px 32px rgba(31,36,33,0.18)",
          padding: "20px 20px calc(20px + env(safe-area-inset-bottom))",
          fontFamily: "'IBM Plex Mono', monospace",
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 style={{ fontFamily: "'Oswald', sans-serif" }} className="text-sm uppercase tracking-widest flex items-center gap-2">
            <ClipboardList size={14} /> Pull sheets
          </h2>
          <button onClick={onClose} style={{ fontSize: 22, lineHeight: 1, color: INK, background: "transparent", border: "none" }}>
            &times;
          </button>
        </div>

        {loading ? (
          <p className="text-xs py-6 text-center" style={{ color: MUTED }}>Loading...</p>
        ) : pullSheets.length === 0 ? (
          <p className="text-xs py-6 text-center" style={{ color: MUTED }}>
            No pull sheets yet.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {pullSheets.map((sheet) => (
              <PullSheetCard key={sheet.id} sheet={sheet} onSubmitPulled={onSubmitPulled} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// The 7 clock-in celebration choices, matching CLOCK_IN_ANIMATIONS on the
// backend (routes/admin.js and routes/auth.js) -- keep all three in sync if
// this list ever changes. Emoji-prefixed labels double as a quick visual
// preview without needing to actually clock in to see what each one looks
// like.
const CLOCK_IN_ANIMATION_OPTIONS = [
  { value: "none", label: "No animation" },
  { value: "fireworks", label: "🎆 Fireworks" },
  { value: "birthday", label: "🎉 Happy Birthday" },
  { value: "rocket", label: "🚀 Rocket Launch" },
  { value: "fall", label: "🍂 Fall / Thanksgiving" },
  { value: "easter", label: "🐣 Spring / Easter" },
  { value: "christmas", label: "❄️ Christmas / Winter" },
];

// Bottom sheet opened from the small party-popper button in the header,
// letting an employee pick their own clock-in celebration (previously
// admin-only). Saves immediately on tap rather than needing a separate Save
// button -- selecting a row calls onSelect, which the parent awaits and
// closes this sheet once the save actually succeeds (see
// handleSelectClockInAnimation below), so it can't silently claim success
// if the request fails.
function ClockInAnimationSheet({ open, onClose, current, onSelect, saving, error }) {
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(31,36,33,0.5)", zIndex: 100 }}
      className="flex items-end"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: BG,
          width: "100%",
          maxHeight: "85vh",
          overflowY: "auto",
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          boxShadow: "0 -12px 32px rgba(31,36,33,0.18)",
          padding: "20px 20px calc(20px + env(safe-area-inset-bottom))",
          fontFamily: "'IBM Plex Mono', monospace",
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 style={{ fontFamily: "'Oswald', sans-serif" }} className="text-sm uppercase tracking-widest flex items-center gap-2">
            <PartyPopper size={14} /> Clock-in celebration
          </h2>
          <button onClick={onClose} style={{ fontSize: 22, lineHeight: 1, color: INK, background: "transparent", border: "none" }}>
            &times;
          </button>
        </div>
        <p className="text-xs mb-3" style={{ color: MUTED }}>
          Pick what plays when you clock in.
        </p>
        {error && (
          <p className="text-xs mb-3" style={{ color: RUST }}>{error}</p>
        )}
        <div className="flex flex-col gap-2">
          {CLOCK_IN_ANIMATION_OPTIONS.map((opt) => {
            const selected = (current || "none") === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => onSelect(opt.value)}
                disabled={saving}
                className="flex items-center justify-between text-left"
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: `1.5px solid ${selected ? TEAL : LINE}`,
                  background: selected ? "rgba(70,112,95,0.08)" : "transparent",
                  fontSize: 13,
                  color: INK,
                  opacity: saving ? 0.6 : 1,
                }}
              >
                <span>{opt.label}</span>
                {selected && <span style={{ color: TEAL, fontWeight: 700 }}>✓</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Bottom sheet opened from the "Assigned routes" pill button next to Time
// off in CalendarView's header (see below). Shows a Leaflet map with the
// numbered stops + a dashed round-trip line back to the shop, the same
// ordered stop list that used to live in the card, and the "Start Route"
// button that hands off to the real Google Maps app. Map only initializes
// once (on first open) and gets refreshed via fitBounds whenever the route
// changes, since re-creating the Leaflet instance on every open leaks tiles.
function RouteSheet({ open, onClose, route, onStartRoute }) {
  const mapElRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const mapLayerRef = useRef(null);

  useEffect(() => {
    if (!open || !route || !mapElRef.current || typeof window.L === "undefined") return;
    const L = window.L;
    if (!mapInstanceRef.current) {
      mapInstanceRef.current = L.map(mapElRef.current);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 19,
      }).addTo(mapInstanceRef.current);
    }
    const map = mapInstanceRef.current;
    if (mapLayerRef.current) mapLayerRef.current.remove();
    const layer = L.layerGroup().addTo(map);
    mapLayerRef.current = layer;

    function stopIcon(label, color) {
      return L.divIcon({
        className: "",
        html:
          `<div style="width:24px; height:24px; border-radius:50%; background:${color}; color:#fff; ` +
          `display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; ` +
          `box-shadow:0 2px 6px rgba(0,0,0,0.3);">${label}</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
    }

    const points = [];
    const shop = route.shop_location;
    if (shop) {
      L.marker([shop.lat, shop.lng], { icon: stopIcon("S", "#2B6E5C") }).bindTooltip("Shop").addTo(layer);
      points.push([shop.lat, shop.lng]);
    }
    route.stops.forEach((stop, i) => {
      L.marker([stop.lat, stop.lng], { icon: stopIcon(String(i + 1), "#C1502E") }).bindTooltip(stop.title).addTo(layer);
      points.push([stop.lat, stop.lng]);
    });
    if (shop && route.stops.length > 0) {
      const line = [shop, ...route.stops, shop].map((p) => [p.lat, p.lng]);
      L.polyline(line, { color: MUTED, weight: 2, dashArray: "4,6" }).addTo(layer);
    }
    if (points.length > 0) map.fitBounds(points, { padding: [24, 24] });
    setTimeout(() => {
      if (mapInstanceRef.current) mapInstanceRef.current.invalidateSize();
    }, 100);
  }, [open, route]);

  if (!open) return null;
  const hasStops = route && route.stops && route.stops.length > 0;
  const now = new Date();
  const todayStr = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
  const routeDateStr = route && route.route_date ? String(route.route_date).slice(0, 10) : null;
  const isRouteToday = routeDateStr === todayStr;

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(31,36,33,0.5)", zIndex: 100 }}
      className="flex items-end"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: BG,
          width: "100%",
          maxHeight: "88vh",
          overflowY: "auto",
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          boxShadow: "0 -12px 32px rgba(31,36,33,0.18)",
          padding: "20px 20px calc(20px + env(safe-area-inset-bottom))",
          fontFamily: "'IBM Plex Mono', monospace",
        }}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 style={{ fontFamily: "'Oswald', sans-serif" }} className="text-sm uppercase tracking-widest flex items-center gap-2">
            <Navigation size={14} /> Assigned routes
          </h2>
          <button onClick={onClose} style={{ fontSize: 22, lineHeight: 1, color: INK, background: "transparent", border: "none" }}>
            &times;
          </button>
        </div>

        {hasStops && !isRouteToday && (
          <p className="text-xs mb-2" style={{ color: MUTED }}>
            For {formatDateShort(routeDateStr)} — not today
          </p>
        )}

        {!hasStops ? (
          <p className="text-sm py-6 text-center" style={{ color: MUTED }}>
            No route assigned right now. Check back once your admin builds one.
          </p>
        ) : (
          <>
            <div ref={mapElRef} style={{ height: 220, borderRadius: 12, border: `1px solid ${LINE}`, marginBottom: 14 }} />

            <div className="flex flex-col gap-1.5 mb-4">
              {route.stops.map((stop, i) => (
                <div key={stop.id} className="flex items-center gap-2 text-sm">
                  <span
                    className="flex items-center justify-center rounded-full text-xs font-bold flex-shrink-0"
                    style={{ width: 20, height: 20, background: CHARCOAL, color: "#fff" }}
                  >
                    {i + 1}
                  </span>
                  <span>
                    {stop.title}
                    {stop.address_label ? ` · ${stop.address_label}` : ""}
                  </span>
                </div>
              ))}
            </div>

            <button
              onClick={onStartRoute}
              className="w-full rounded-xl py-2.5 text-sm font-medium flex items-center justify-center gap-2"
              style={{ background: CHARCOAL, color: "#fff" }}
            >
              <Navigation size={14} /> Start route in Google Maps
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function CalendarView({ schedule, loading, monthAnchor, onPrevMonth, onNextMonth, onToday, onOpenTimeOff, timeOffPendingCount, onOpenRoute, hasRouteToday, onOpenPullSheets, pullSheetsCount }) {
  const [selectedDay, setSelectedDay] = useState(todayStr());
  const [selectedJob, setSelectedJob] = useState(null);
  const [showScheduleMenu, setShowScheduleMenu] = useState(false);
  const hasScheduleMenuBadge = hasRouteToday || timeOffPendingCount > 0 || pullSheetsCount > 0;

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
        <div className="flex items-center gap-3">
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setShowScheduleMenu((v) => !v)}
              aria-label="Schedule menu"
              className="rounded-lg px-2 py-1.5 flex items-center justify-center"
              style={{ position: "relative", color: INK, background: SURFACE, boxShadow: "0 3px 8px rgba(31,36,33,0.1)" }}
            >
              <Menu size={16} />
              {hasScheduleMenuBadge && (
                <span
                  style={{
                    position: "absolute", top: -2, right: -2, width: 9, height: 9,
                    borderRadius: "50%", background: RUST, border: "1.5px solid #fff",
                  }}
                />
              )}
            </button>
            {showScheduleMenu && (
              <>
                <div onClick={() => setShowScheduleMenu(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
                <div
                  style={{
                    position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 50,
                    background: SURFACE, borderRadius: 12, minWidth: 190, overflow: "hidden",
                    boxShadow: "0 10px 28px rgba(31,36,33,0.18)",
                  }}
                >
                  <button
                    onClick={() => { setShowScheduleMenu(false); onOpenRoute(); }}
                    className="w-full flex items-center gap-2 text-xs font-medium px-3 py-2.5"
                    style={{ color: INK, background: SURFACE, border: "none", textAlign: "left" }}
                  >
                    <Navigation size={14} /> Assigned routes
                    {hasRouteToday && (
                      <span style={{ marginLeft: "auto", background: RUST, color: "#fff", fontSize: 9, fontWeight: 800, borderRadius: 20, padding: "1px 5px" }}>
                        &bull;
                      </span>
                    )}
                  </button>
                  <div style={{ height: 1, background: LINE }} />
                  <button
                    onClick={() => { setShowScheduleMenu(false); onOpenTimeOff(); }}
                    className="w-full flex items-center gap-2 text-xs font-medium px-3 py-2.5"
                    style={{ color: INK, background: SURFACE, border: "none", textAlign: "left" }}
                  >
                    <Plane size={14} /> Time off
                    {timeOffPendingCount > 0 && (
                      <span style={{ marginLeft: "auto", background: RUST, color: "#fff", fontSize: 9, fontWeight: 800, borderRadius: 20, padding: "1px 5px" }}>
                        {timeOffPendingCount}
                      </span>
                    )}
                  </button>
                  <div style={{ height: 1, background: LINE }} />
                  <button
                    onClick={() => { setShowScheduleMenu(false); onOpenPullSheets(); }}
                    className="w-full flex items-center gap-2 text-xs font-medium px-3 py-2.5"
                    style={{ color: INK, background: SURFACE, border: "none", textAlign: "left" }}
                  >
                    <ClipboardList size={14} /> Pull sheets
                    {pullSheetsCount > 0 && (
                      <span style={{ marginLeft: "auto", background: RUST, color: "#fff", fontSize: 9, fontWeight: 800, borderRadius: 20, padding: "1px 5px" }}>
                        {pullSheetsCount}
                      </span>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
          <button
            onClick={() => {
              onToday();
              setSelectedDay(todayStr());
            }}
            className="text-xs underline"
            style={{ color: MUTED }}
          >
            Today
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between mb-3">
        <button
          onClick={onPrevMonth}
          style={{ border: "none", background: SURFACE, boxShadow: "0 3px 8px rgba(31,36,33,0.1)" }}
          className="rounded-xl px-3 py-1 text-sm"
        >
          ‹
        </button>
        <span style={{ fontFamily: "'Oswald', sans-serif" }} className="text-sm uppercase tracking-widest">
          {MONTH_LABELS[month]} {year}
        </span>
        <button
          onClick={onNextMonth}
          style={{ border: "none", background: SURFACE, boxShadow: "0 3px 8px rgba(31,36,33,0.1)" }}
          className="rounded-xl px-3 py-1 text-sm"
        >
          ›
        </button>
      </div>

      {loading ? (
        <p className="text-sm" style={{ color: MUTED }}>Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-7 gap-1 mb-1">
            {DOW_LABELS.map((l, i) => (
              <div key={i} className="text-center text-[10px] uppercase" style={{ color: MUTED }}>
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
                      : SURFACE,
                    boxShadow: isSelected
                      ? "0 3px 8px rgba(211,90,52,0.35)"
                      : isToday
                      ? "0 3px 8px rgba(219,138,22,0.3)"
                      : "0 2px 6px rgba(31,36,33,0.04)",
                  }}
                  className="rounded-xl py-1.5 flex flex-col items-center gap-0.5"
                >
                  <span className="text-xs" style={{ color: isSelected ? "#fff" : isToday ? CHARCOAL : INK, fontWeight: isSelected || isToday ? 700 : 400 }}>{day}</span>
                  {/* Always reserve this row's height (4px), whether or not there
                      are dots to show, so days with events aren't taller than
                      days without -- keeps every week the same height. */}
                  <span className="flex gap-0.5" style={{ height: 4 }}>
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
                </button>
              );
            })}
          </div>

          {selectedDay ? (
            <>
              <h3 className="text-xs uppercase tracking-widest mb-2" style={{ color: MUTED }}>
                {new Date(year, month, Number(selectedDay.split("-")[2])).toLocaleDateString([], {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
              </h3>
              {dayEvents.length === 0 ? (
                <p className="text-sm" style={{ color: MUTED }}>Nothing scheduled that day.</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {dayEvents.map((job) => (
                    <EventCard key={job.id} job={job} onSelect={setSelectedJob} />
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="text-sm" style={{ color: MUTED }}>Tap a day to see what's scheduled.</p>
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
        style={{ border: `1px solid ${LINE}`, background: INPUT_BG }}
        className="w-full px-3 py-2 text-sm rounded-xl mb-4 outline-none"
      />
      {loading ? (
        <p className="text-sm" style={{ color: MUTED }}>Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm" style={{ color: MUTED }}>
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
                  background: SURFACE,
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
                  <p className="text-xs mt-2 pt-2" style={{ color: MUTED, borderTop: `1px solid ${LINE}` }}>
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

// One row in the Inventory tab's item list -- collapsed to just the name and
// available count, expands on tap into an editable quantity/cost/threshold
// form. Deliberately excludes name and unit price (those are billing/quoting
// concerns that stay admin-only -- see routes/employeeInventory.js).
function InventoryItemRow({ item, onSave }) {
  const [expanded, setExpanded] = useState(false);
  const [qty, setQty] = useState(String(item.quantity_on_hand));
  const [cost, setCost] = useState(item.unit_cost != null ? String(item.unit_cost) : "");
  const [threshold, setThreshold] = useState(item.low_stock_threshold != null ? String(item.low_stock_threshold) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      await onSave(item.id, {
        quantity_on_hand: Number(qty) || 0,
        unit_cost: cost === "" ? null : Number(cost) || 0,
        low_stock_threshold: threshold === "" ? null : Number(threshold) || 0,
      });
      setExpanded(false);
    } catch (err) {
      setError(err.message || "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  const low = item.low_stock_threshold != null && Number(item.quantity_available) <= Number(item.low_stock_threshold);

  return (
    <div
      style={{ background: SURFACE, border: `1px solid rgba(31,36,33,0.05)`, boxShadow: "0 6px 16px rgba(31,36,33,0.06), 0 1px 3px rgba(31,36,33,0.04)" }}
      className="rounded-xl p-4"
    >
      <div className="flex items-center justify-between gap-2 cursor-pointer" onClick={() => setExpanded((v) => !v)}>
        <div>
          <div className="text-sm font-medium">{item.name}</div>
          <div className="text-xs mt-0.5" style={{ color: low ? RUST : MUTED }}>
            {item.quantity_available} available
            {Number(item.quantity_on_hold) > 0 ? ` (${item.quantity_on_hold} on hold)` : ""}
          </div>
        </div>
        <span style={{ color: MUTED }}>{expanded ? "▾" : "▸"}</span>
      </div>
      {expanded && (
        <div className="mt-3 flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
          <label className="text-xs" style={{ color: MUTED }}>Quantity on hand</label>
          <input
            type="number" min="0" step="1" value={qty} onChange={(e) => setQty(e.target.value)}
            style={{ border: `1px solid ${LINE}`, background: SURFACE }} className="rounded-lg px-2 py-1.5 text-sm"
          />
          <label className="text-xs" style={{ color: MUTED }}>Unit cost</label>
          <input
            type="number" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0.00"
            style={{ border: `1px solid ${LINE}`, background: SURFACE }} className="rounded-lg px-2 py-1.5 text-sm"
          />
          <label className="text-xs" style={{ color: MUTED }}>Low stock alert threshold</label>
          <input
            type="number" min="0" step="1" value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="none"
            style={{ border: `1px solid ${LINE}`, background: SURFACE }} className="rounded-lg px-2 py-1.5 text-sm"
          />
          {error && <div style={{ color: RUST }} className="text-xs">{error}</div>}
          <button
            onClick={handleSave} disabled={saving}
            style={{ background: CHARCOAL, color: "#fff", opacity: saving ? 0.6 : 1 }}
            className="w-full rounded-lg py-2 text-xs font-medium mt-1"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      )}
    </div>
  );
}

// Inventory tab -- only reachable at all when employee.can_manage_inventory
// is true (see the bottom-nav wiring further down and GET /api/auth/me).
// Lists every catalog item with tracking turned on, same underlying data as
// the admin apps' Inventory > Items view, plus the "Scan barcode" entry point
// into BarcodeScanSheet below.
function InventoryView({ items, loading, onOpenScan, onSaveItem }) {
  const [search, setSearch] = useState("");
  const filtered = items.filter((i) => !search || i.name.toLowerCase().indexOf(search.toLowerCase()) !== -1);

  return (
    <div style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
      <div className="mb-4 flex items-center justify-between">
        <h2 style={{ fontFamily: "'Oswald', sans-serif" }} className="text-sm uppercase tracking-widest">
          Inventory
        </h2>
        <button
          onClick={onOpenScan}
          style={{ background: CHARCOAL, color: "#fff" }}
          className="rounded-xl px-3 py-1.5 text-xs font-medium uppercase tracking-widest flex items-center gap-1.5"
        >
          <ScanBarcode size={14} /> Scan barcode
        </button>
      </div>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search inventory..."
        style={{ border: `1px solid ${LINE}`, background: INPUT_BG }}
        className="w-full px-3 py-2 text-sm rounded-xl mb-4 outline-none"
      />
      {loading ? (
        <p className="text-sm" style={{ color: MUTED }}>Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm" style={{ color: MUTED }}>
          {items.length === 0 ? "No tracked inventory items yet -- scan a barcode to add one." : "No items match that search."}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((item) => (
            <InventoryItemRow key={item.id} item={item} onSave={onSaveItem} />
          ))}
        </div>
      )}
    </div>
  );
}

// A laptop/desktop webcam and a phone camera behave very differently under
// getUserMedia -- forcing a high resolution + focus constraints on a webcam
// previously made the desktop scanner worse (some webcams don't like being
// asked for a mode they don't natively support). Gating the richer request
// behind "does this device have a touchscreen" means phones get the
// higher-res, focus-friendly request while a mouse-driven desktop keeps
// exactly the plain request that's always worked there.
function isTouchDevice() {
  try {
    return !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
  } catch {
    return false;
  }
}

function getBarcodeScanConstraints() {
  if (!isTouchDevice()) {
    return { video: { facingMode: { ideal: "environment" } } };
  }
  return {
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      advanced: [{ focusMode: "continuous" }],
    },
  };
}

// There's no standard "focus right now" command in the web platform, but
// re-applying the focus constraint (and, where supported, telling the
// camera where in frame to focus via pointsOfInterest) is a widely-used
// trick that nudges many camera drivers into re-running their focus
// search on demand -- this is what powers "tap the video to refocus".
function nudgeFocus(track, xRatio, yRatio) {
  if (!track || typeof track.getCapabilities !== "function") return;
  let caps;
  try {
    caps = track.getCapabilities();
  } catch {
    return;
  }
  if (!caps?.focusMode) return;
  const advanced = {};
  if (caps.pointsOfInterest && typeof xRatio === "number" && typeof yRatio === "number") {
    advanced.pointsOfInterest = [{ x: xRatio, y: yRatio }];
  }
  if (caps.focusMode.includes("single-shot")) {
    advanced.focusMode = "single-shot";
  }
  const applyAdvanced = (constraintObj) => track.applyConstraints({ advanced: [constraintObj] }).catch(() => {});
  Promise.resolve()
    .then(() => (Object.keys(advanced).length ? applyAdvanced(advanced) : undefined))
    .then(() => {
      if (caps.focusMode.includes("continuous")) return applyAdvanced({ focusMode: "continuous" });
    });
}

// Runs right before ZXing binarizes+decodes each captured frame -- boosts
// full-frame contrast (stretches the darkest/lightest pixels out to pure
// black/white) and sharpens edges (a simple Laplacian unsharp mask). This
// only touches the internal decode buffer, not the visible video preview,
// and is aimed at recovering legibility from a washed-out or slightly soft
// camera frame -- it can't undo severe out-of-focus blur, but it noticeably
// helps borderline frames that are almost readable. Also returns a rough,
// uncalibrated "sharpness" score (average edge strength) so the UI can show
// a live Focus bar -- it's relative, not an absolute quality guarantee, but
// it reliably rises and falls as you move closer/farther or refocus.
function enhanceCanvasForDecode(ctx, width, height) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const n = width * height;
  const gray = new Float32Array(n);
  let min = 255, max = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const v = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    gray[p] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = Math.max(1, max - min);
  const norm = new Float32Array(n);
  for (let p = 0; p < n; p++) norm[p] = ((gray[p] - min) * 255) / range;

  let edgeSum = 0;
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowStart + x;
      let v, edge;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        v = norm[idx];
        edge = 0;
      } else {
        edge = norm[idx] * 4 - norm[idx - 1] - norm[idx + 1] - norm[idx - width] - norm[idx + width];
        v = norm[idx] + edge;
        edgeSum += Math.abs(edge);
      }
      const clamped = v < 0 ? 0 : v > 255 ? 255 : v;
      const di = idx * 4;
      data[di] = clamped;
      data[di + 1] = clamped;
      data[di + 2] = clamped;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return edgeSum / n;
}

function installFrameEnhancer(reader, onSharpness) {
  const originalDrawFrame = reader.drawFrameOnCanvas.bind(reader);
  const originalDrawImage = reader.drawImageOnCanvas.bind(reader);
  const afterDraw = () => {
    try {
      const canvas = reader.captureCanvas;
      const ctx = reader.captureCanvasContext;
      if (ctx && canvas && canvas.width && canvas.height) {
        const score = enhanceCanvasForDecode(ctx, canvas.width, canvas.height);
        onSharpness?.(score);
      }
    } catch {
      // best-effort only -- decoding still proceeds against the unenhanced
      // frame instead of breaking the scan if this throws for any reason
    }
  };
  // drawFrameOnCanvas runs for the continuous <video> preview loop;
  // drawImageOnCanvas runs when we decodeOnce() against a still <img> (see
  // captureStill below) -- patching both means the same contrast/sharpen
  // boost applies no matter which source produced the frame.
  reader.drawFrameOnCanvas = (...args) => { originalDrawFrame(...args); afterDraw(); };
  reader.drawImageOnCanvas = (...args) => { originalDrawImage(...args); afterDraw(); };
}

// Native camera photos are often huge (8-50+ megapixels) -- that can hit
// canvas size limits on some mobile browsers and makes the per-pixel
// contrast/sharpen pass slow for no decode benefit (barcodes don't need
// more than roughly 1600px on the long side to read cleanly). Downscaling
// first, onto a fresh <img> so it has proper naturalWidth/naturalHeight,
// keeps decoding fast and avoids that failure mode entirely.
function downscaleImageForDecode(img, maxDim) {
  return new Promise((resolve) => {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h || Math.max(w, h) <= maxDim) { resolve(img); return; }
    const scale = maxDim / Math.max(w, h);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) { resolve(img); return; }
      const scaledImg = new Image();
      scaledImg.onload = () => resolve(scaledImg);
      scaledImg.onerror = () => resolve(img);
      scaledImg.src = URL.createObjectURL(blob);
    }, "image/jpeg", 0.92);
  });
}

// Crossing TRIGGER_HIGH while armed fires one auto-capture and disarms;
// dropping back below ARM_LOW re-arms it. This stops a held-steady, still-
// blurry phone from firing (and clicking) over and over -- it has to
// actually leave and re-enter "looks sharp" territory to fire again.
const BARCODE_CAPTURE_ARM_LOW = 35;
const BARCODE_CAPTURE_TRIGGER_HIGH = 65;

// Bottom sheet reachable from the Inventory tab's "Scan barcode" button.
// Uses the device's own camera via ZXing's browser decoder -- no dedicated
// hardware scanner required (though a USB/Bluetooth one would also work,
// since those just "type" into whatever's focused). A barcode already on a
// catalog item jumps straight to a restock quantity; an unknown one offers to
// create a new item, with a best-effort name suggestion from a public UPC
// database (see GET /api/employee-inventory/lookup-barcode/:barcode).
function BarcodeScanSheet({ open, onClose, onDone }) {
  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const readerRef = useRef(null);
  const activeRef = useRef(false);
  const torchTrackRef = useRef(null);
  const activeTrackRef = useRef(null); // shared by tap-to-focus and the zoom slider
  const imageCaptureRef = useRef(null);
  const stillReaderRef = useRef(null);
  const armedRef = useRef(true); // auto-capture arm/disarm state (see updateSharpness)
  const capturingRef = useRef(false); // synchronous guard -- read inside closures that outlive re-renders
  const [stage, setStage] = useState("scanning"); // scanning | looking-up | matched | new-item | error
  const [scannedBarcode, setScannedBarcode] = useState("");
  const [matchedItem, setMatchedItem] = useState(null);
  const [suggestion, setSuggestion] = useState(null);
  const [error, setError] = useState("");
  const [qtyInput, setQtyInput] = useState("1");
  const [nameInput, setNameInput] = useState("");
  const [newQtyInput, setNewQtyInput] = useState("1");
  const [costInput, setCostInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [zoomCaps, setZoomCaps] = useState(null); // { min, max, step } or null when unsupported
  const [zoomValue, setZoomValue] = useState(1);
  const [sharpness, setSharpness] = useState(0); // 0-100, relative live "Focus" indicator
  const [refocusing, setRefocusing] = useState(false);
  const [capturingPhoto, setCapturingPhoto] = useState(false);

  function stopScan() {
    activeRef.current = false;
    torchTrackRef.current = null;
    activeTrackRef.current = null;
    imageCaptureRef.current = null;
    stillReaderRef.current = null;
    armedRef.current = true;
    capturingRef.current = false;
    setTorchSupported(false);
    setTorchOn(false);
    setZoomCaps(null);
    setSharpness(0);
    setCapturingPhoto(false);
    if (readerRef.current) {
      try { readerRef.current.reset(); } catch { /* already stopped */ }
      readerRef.current = null;
    }
  }

  function resetToScanning() {
    setStage("scanning");
    setError("");
    setMatchedItem(null);
    setSuggestion(null);
    setScannedBarcode("");
    setQtyInput("1");
    setNameInput("");
    setNewQtyInput("1");
    setCostInput("");
  }

  // After the camera stream is live, turn on continuous autofocus -- but
  // only if the browser actually reports it supports that (checked via
  // getCapabilities()). Desktop webcams almost never report this
  // capability, so this is a no-op there and leaves that already-working
  // experience alone; phones that do report it (most Android Chrome/Samsung
  // Internet) get real continuous AF instead of whatever fixed/default
  // focus they'd otherwise be stuck with up close.
  function applyContinuousFocusIfSupported(track) {
    try {
      if (!track || typeof track.getCapabilities !== "function") return;
      const caps = track.getCapabilities();
      if (caps?.focusMode?.includes("continuous")) {
        track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
      }
    } catch {
      // best-effort only
    }
  }

  // Shows a flashlight toggle only on devices that report they actually have
  // one (getCapabilities().torch) -- most phone cameras do, laptop webcams
  // never do. More light lets the phone use a faster shutter speed, which
  // is usually the real fix for a "blurry" close-up shot: what looks like a
  // focus problem is very often motion/low-light blur from a slow exposure.
  function setupTorchIfSupported(track) {
    try {
      if (track && typeof track.getCapabilities === "function" && track.getCapabilities()?.torch) {
        torchTrackRef.current = track;
        setTorchSupported(true);
        setTorchOn(false);
        return;
      }
    } catch {
      // best-effort only
    }
    torchTrackRef.current = null;
    setTorchSupported(false);
  }

  function toggleTorch() {
    if (!torchTrackRef.current) return;
    const next = !torchOn;
    setTorchOn(next);
    torchTrackRef.current.applyConstraints({ advanced: [{ torch: next }] }).catch(() => {});
  }

  // Shows a zoom slider only on devices that report a usable zoom range.
  // Filling more of the frame with the barcode (optically or digitally)
  // gives the decoder more pixels per bar, which often matters more than
  // focus once you're already reasonably close.
  function setupZoomIfSupported(track) {
    try {
      if (track && typeof track.getCapabilities === "function") {
        const caps = track.getCapabilities();
        if (caps?.zoom && caps.zoom.max > caps.zoom.min) {
          const settings = typeof track.getSettings === "function" ? track.getSettings() : {};
          setZoomCaps({ min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 });
          setZoomValue(settings.zoom || caps.zoom.min);
          return;
        }
      }
    } catch {
      // best-effort only
    }
    setZoomCaps(null);
  }

  function handleZoomChange(value) {
    const next = Number(value);
    setZoomValue(next);
    activeTrackRef.current?.applyConstraints({ advanced: [{ zoom: next }] }).catch(() => {});
  }

  function handleTap(e) {
    if (!activeTrackRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const yRatio = (e.clientY - rect.top) / rect.height;
    nudgeFocus(activeTrackRef.current, xRatio, yRatio);
    setRefocusing(true);
    setTimeout(() => setRefocusing(false), 900);
  }

  // Squashes the raw (unbounded) edge-strength score into a 0-100 bar so it
  // always renders sensibly regardless of resolution or lighting -- this is
  // a relative live indicator, not a calibrated measurement. Also drives the
  // auto-capture arm/disarm described above captureStill.
  function updateSharpness(score) {
    const pct = 100 * (1 - 1 / (1 + score / 12));
    setSharpness(pct);
    if (pct < BARCODE_CAPTURE_ARM_LOW) {
      armedRef.current = true;
    } else if (pct > BARCODE_CAPTURE_TRIGGER_HIGH && armedRef.current && !capturingRef.current) {
      armedRef.current = false;
      captureStill();
    }
  }

  // The live <video> preview stream is deliberately lower-quality than the
  // phone's actual photo-capture pipeline (the one the native Camera app
  // uses) -- that gap is exactly why a barcode can read perfectly in the
  // native camera but not from our preview frames. ImageCapture.takePhoto()
  // asks the browser to trigger that same higher-quality capture pipeline
  // instead, at the cost of a brief pause (and, on Samsung phones, an
  // unmutable shutter click -- an OS-level privacy requirement, not a bug).
  // Falls back to a plain single decode attempt against the current video
  // frame if takePhoto isn't available or fails for any reason.
  function captureStill() {
    if (capturingRef.current || !activeRef.current) return;
    capturingRef.current = true;
    setCapturingPhoto(true);

    const finish = (resultText) => {
      capturingRef.current = false;
      setCapturingPhoto(false);
      if (resultText && activeRef.current) handleScanned(resultText);
    };

    const decodeFromLiveFrame = () => {
      const video = videoRef.current;
      const stillReader = stillReaderRef.current;
      if (!video || !stillReader) { finish(null); return; }
      stillReader.decodeOnce(video, false, false).then((result) => finish(result.getText())).catch(() => finish(null));
    };

    const capture = imageCaptureRef.current;
    if (capture) {
      capture
        .takePhoto()
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => {
            URL.revokeObjectURL(url);
            const stillReader = stillReaderRef.current;
            if (!activeRef.current || !stillReader) { finish(null); return; }
            downscaleImageForDecode(img, 1600)
              .then((finalImg) => stillReader.decodeOnce(finalImg, false, false))
              .then((result) => finish(result.getText()))
              .catch(() => finish(null));
          };
          img.onerror = () => { URL.revokeObjectURL(url); decodeFromLiveFrame(); };
          img.src = url;
        })
        .catch(decodeFromLiveFrame);
    } else {
      decodeFromLiveFrame();
    }
  }

  // The live preview and even ImageCapture.takePhoto() both still go through
  // the browser's own (often lower-quality/worse-focused) camera pipeline --
  // on some phones that pipeline just isn't as good as the OS's real Camera
  // app, no matter what we tell it. A plain <input type=file capture>
  // sidesteps all of that: mobile browsers hand this off to the actual
  // native camera app (real viewfinder, real autofocus, real shutter), and
  // we just get the finished photo back to decode -- if the barcode is
  // readable by the native camera app at all, this route gives it the best
  // possible chance.
  async function handleFileCapture(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow choosing/relaunching the camera again next time
    if (!file) return;
    if (!stillReaderRef.current) {
      let zxing;
      try {
        zxing = await loadZxing();
      } catch {
        setError("Couldn't load the barcode scanner. Check your connection and try again.");
        return;
      }
      const { BrowserMultiFormatReader, DecodeHintType } = zxing;
      const hints = new Map();
      hints.set(DecodeHintType.TRY_HARDER, true);
      const stillReader = new BrowserMultiFormatReader(hints, 300);
      installFrameEnhancer(stillReader);
      stillReaderRef.current = stillReader;
    }
    setError("");
    setCapturingPhoto(true);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      downscaleImageForDecode(img, 1600)
        .then((finalImg) => stillReaderRef.current.decodeOnce(finalImg, false, false))
        .then((result) => { setCapturingPhoto(false); handleScanned(result.getText()); })
        .catch(() => {
          setCapturingPhoto(false);
          setError("Couldn't find a barcode in that photo -- back off a little so the WHOLE barcode is visible with a bit of white space around it (too close can crop it or cut off the margin it needs), then try again.");
        });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setCapturingPhoto(false);
      setError("Couldn't load that photo -- please try again.");
    };
    img.src = url;
  }

  async function beginDecoding() {
    activeRef.current = true;
    let zxing;
    try {
      zxing = await loadZxing();
    } catch {
      setStage("error");
      setError("Couldn't load the barcode scanner. Check your connection and try again.");
      return;
    }
    // The sheet may have been closed (or reopened+closed again) while the
    // library was still downloading -- don't spin up a camera reader for a
    // scan that's no longer active.
    if (!activeRef.current) return;
    const { BrowserMultiFormatReader, DecodeHintType } = zxing;
    const hints = new Map();
    hints.set(DecodeHintType.TRY_HARDER, true);
    const reader = new BrowserMultiFormatReader(hints, 300);
    readerRef.current = reader;
    installFrameEnhancer(reader, updateSharpness);
    // A separate reader for still-photo decodes: it gets its own internal
    // capture canvas sized to whatever image it's given, instead of reusing
    // (and being cropped by) the continuous reader's canvas, which is sized
    // for the smaller live-preview frame.
    const stillReader = new BrowserMultiFormatReader(hints, 300);
    installFrameEnhancer(stillReader);
    stillReaderRef.current = stillReader;
    armedRef.current = true;
    capturingRef.current = false;
    const onDecode = (result) => {
      if (!activeRef.current || !result) return;
      handleScanned(result.getText());
    };
    const onCameraError = (err) => {
      setStage("error");
      setError("Couldn't access the camera: " + (err.message || "permission denied."));
    };
    reader
      .decodeFromConstraints(getBarcodeScanConstraints(), videoRef.current, onDecode)
      .then(() => {
        const track = reader.stream?.getVideoTracks?.()[0];
        activeTrackRef.current = track || null;
        applyContinuousFocusIfSupported(track);
        setupTorchIfSupported(track);
        setupZoomIfSupported(track);
        if (typeof ImageCapture !== "undefined" && track) {
          try { imageCaptureRef.current = new ImageCapture(track); } catch { imageCaptureRef.current = null; }
        } else {
          imageCaptureRef.current = null;
        }
      })
      .catch(onCameraError);
  }

  useEffect(() => {
    if (!open) {
      stopScan();
      return;
    }
    resetToScanning();
    beginDecoding();
    return () => stopScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function handleScanned(barcode) {
    if (!activeRef.current) return;
    stopScan();
    setScannedBarcode(barcode);
    setStage("looking-up");
    try {
      const data = await lookupInventoryBarcode(barcode);
      if (data.found_in_catalog) {
        setMatchedItem(data.item);
        setStage("matched");
      } else {
        setSuggestion(data.suggestion);
        setNameInput((data.suggestion && data.suggestion.name) || "");
        setStage("new-item");
      }
    } catch (err) {
      setError(err.message || "Couldn't look up that barcode.");
      setStage("error");
    }
  }

  function scanAgain() {
    resetToScanning();
    beginDecoding();
  }

  async function submitRestock() {
    const received = Math.max(0, Math.round(Number(qtyInput)) || 0);
    if (received <= 0) { setError("Enter a quantity greater than 0."); return; }
    setSubmitting(true);
    setError("");
    try {
      await updateInventoryCatalogItem(matchedItem.id, {
        quantity_on_hand: Number(matchedItem.quantity_on_hand || 0) + received,
        track_inventory: true,
      });
      await onDone();
      onClose();
    } catch (err) {
      setError(err.message || "Couldn't update stock.");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitNewItem() {
    const name = nameInput.trim();
    if (!name) { setError("Enter a name for this item."); return; }
    const qty = Math.max(0, Math.round(Number(newQtyInput)) || 0);
    const unitCost = costInput === "" ? null : Number(costInput) || 0;
    setSubmitting(true);
    setError("");
    try {
      const created = await addInventoryCatalogItem({ name, barcode: scannedBarcode });
      await updateInventoryCatalogItem(created.id, { track_inventory: true, quantity_on_hand: qty, unit_cost: unitCost });
      await onDone();
      onClose();
    } catch (err) {
      setError(err.message || "Couldn't add this item.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(31,36,33,0.5)", zIndex: 100 }} className="flex items-end">
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: BG, width: "100%", maxHeight: "85vh", overflowY: "auto",
          borderTopLeftRadius: 24, borderTopRightRadius: 24,
          boxShadow: "0 -12px 32px rgba(31,36,33,0.18)",
          padding: "20px 20px calc(20px + env(safe-area-inset-bottom))",
          fontFamily: "'IBM Plex Mono', monospace",
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 style={{ fontFamily: "'Oswald', sans-serif" }} className="text-sm uppercase tracking-widest flex items-center gap-2">
            <ScanBarcode size={14} /> Scan barcode
          </h2>
          <button onClick={onClose} style={{ fontSize: 22, lineHeight: 1, color: INK, background: "transparent", border: "none" }}>
            &times;
          </button>
        </div>

        {(stage === "scanning" || stage === "looking-up") && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: "none" }}
              onChange={handleFileCapture}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              style={{ background: CHARCOAL, color: "#fff" }}
              className="w-full rounded-lg py-2 text-xs font-medium mb-1"
            >
              Use camera app for a sharper photo
            </button>
            <p className="text-xs text-center mb-3" style={{ color: MUTED }}>
              Recommended -- opens your phone's real camera app instead of the in-app preview. Back
              off enough that the WHOLE barcode, plus a little white space around it, fits in the
              photo -- getting too close can crop the barcode or cut off the blank margin it needs
              to be readable.
            </p>
            <p className="text-xs text-center mb-1.5 uppercase tracking-widest" style={{ color: MUTED }}>
              or use the live scanner
            </p>
            {error && (
              <div style={{ background: SURFACE, border: `1.5px solid ${RUST}`, color: RUST }} className="rounded-lg p-3 text-xs mb-2">
                {error}
              </div>
            )}
            <div
              onClick={handleTap}
              style={{ position: "relative", background: "#000", borderRadius: 12, overflow: "hidden", marginBottom: 8, cursor: "pointer", height: "38vh", maxHeight: 320 }}
              title="Tap to refocus"
            >
              {/* Phones often return a portrait (tall) camera stream -- capping the
                  box height and cropping with objectFit instead of sizing off the
                  video's native aspect ratio keeps the rest of the controls
                  (zoom, focus meter, status) on screen without scrolling. */}
              <video ref={videoRef} muted playsInline style={{ width: "100%", height: "100%", display: "block", objectFit: "cover" }} />
              {torchSupported && (
                <button
                  onClick={(e) => { e.stopPropagation(); toggleTorch(); }}
                  style={{
                    position: "absolute", top: 8, right: 8,
                    background: "rgba(0,0,0,0.55)", color: "#fff", border: "none",
                    borderRadius: 6, padding: "6px 10px", fontSize: 11,
                  }}
                >
                  {torchOn ? "Flashlight off" : "Flashlight on"}
                </button>
              )}
            </div>
            {zoomCaps && (
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs" style={{ color: MUTED }}>Zoom</span>
                <input
                  type="range" min={zoomCaps.min} max={zoomCaps.max} step={zoomCaps.step}
                  value={zoomValue}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => handleZoomChange(e.target.value)}
                  className="flex-1"
                />
              </div>
            )}
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs" style={{ color: MUTED }}>Focus</span>
              <div className="flex-1 rounded-full overflow-hidden" style={{ height: 6, background: LINE }}>
                <div style={{ height: "100%", width: `${sharpness.toFixed(0)}%`, background: TEAL, transition: "width 0.15s linear" }} />
              </div>
            </div>
            <button
              onClick={captureStill}
              disabled={capturingPhoto}
              style={{ background: TEAL, color: "#fff", opacity: capturingPhoto ? 0.6 : 1 }}
              className="w-full rounded-lg py-2 text-xs font-medium mb-2"
            >
              {capturingPhoto ? "Capturing..." : "Capture photo"}
            </button>
            <p className="text-xs text-center" style={{ color: MUTED }}>
              {capturingPhoto
                ? "Capturing a clear photo..."
                : refocusing
                  ? "Refocusing..."
                  : stage === "looking-up"
                    ? `Looking up ${scannedBarcode}...`
                    : "Point the camera at a barcode and hold steady. Tap the video to refocus, or tap Capture photo to grab a sharp still -- the Focus bar fills in as it sharpens and will auto-capture once it's high."}
            </p>
          </>
        )}

        {stage === "error" && (
          <>
            <div style={{ background: SURFACE, border: `1.5px solid ${RUST}`, color: RUST }} className="rounded-lg p-3 text-xs mb-3">
              {error}
            </div>
            <button onClick={scanAgain} style={{ background: CHARCOAL, color: "#fff" }} className="w-full rounded-lg py-2 text-xs font-medium">
              Scan again
            </button>
          </>
        )}

        {stage === "matched" && matchedItem && (
          <div className="flex flex-col gap-2">
            <div className="text-sm font-medium">{matchedItem.name}</div>
            <div className="text-xs" style={{ color: MUTED }}>
              Currently {matchedItem.quantity_on_hand} on hand
              {!matchedItem.track_inventory ? " -- inventory tracking is off for this item, turning it on now" : ""}
            </div>
            <label className="text-xs mt-1" style={{ color: MUTED }}>Quantity received</label>
            <input
              type="number" min="1" step="1" value={qtyInput} onChange={(e) => setQtyInput(e.target.value)}
              style={{ border: `1px solid ${LINE}`, background: SURFACE }} className="rounded-lg px-2 py-1.5 text-sm"
            />
            {error && <div style={{ color: RUST }} className="text-xs">{error}</div>}
            <div className="flex gap-2 mt-1">
              <button
                onClick={submitRestock} disabled={submitting}
                style={{ background: CHARCOAL, color: "#fff", opacity: submitting ? 0.6 : 1 }}
                className="flex-1 rounded-lg py-2 text-xs font-medium"
              >
                {submitting ? "Saving..." : "Add to stock"}
              </button>
              <button onClick={scanAgain} style={{ background: SURFACE, color: INK, border: `1.5px solid ${LINE}` }} className="flex-1 rounded-lg py-2 text-xs font-medium">
                Scan again
              </button>
            </div>
          </div>
        )}

        {stage === "new-item" && (
          <div className="flex flex-col gap-2">
            <p className="text-xs" style={{ color: MUTED }}>
              {suggestion && suggestion.name
                ? "No catalog item has this barcode yet -- found a possible match online:"
                : "No catalog item has this barcode yet, and it wasn't found in a public product database."}
            </p>
            <label className="text-xs" style={{ color: MUTED }}>Name / description</label>
            <input
              value={nameInput} onChange={(e) => setNameInput(e.target.value)} placeholder="Enter a product name"
              style={{ border: `1px solid ${LINE}`, background: SURFACE }} className="rounded-lg px-2 py-1.5 text-sm"
            />
            <label className="text-xs" style={{ color: MUTED }}>Starting quantity on hand</label>
            <input
              type="number" min="0" step="1" value={newQtyInput} onChange={(e) => setNewQtyInput(e.target.value)}
              style={{ border: `1px solid ${LINE}`, background: SURFACE }} className="rounded-lg px-2 py-1.5 text-sm"
            />
            <label className="text-xs" style={{ color: MUTED }}>Unit cost (optional)</label>
            <input
              type="number" min="0" step="0.01" value={costInput} onChange={(e) => setCostInput(e.target.value)} placeholder="0.00"
              style={{ border: `1px solid ${LINE}`, background: SURFACE }} className="rounded-lg px-2 py-1.5 text-sm"
            />
            {error && <div style={{ color: RUST }} className="text-xs">{error}</div>}
            <div className="flex gap-2 mt-1">
              <button
                onClick={submitNewItem} disabled={submitting}
                style={{ background: CHARCOAL, color: "#fff", opacity: submitting ? 0.6 : 1 }}
                className="flex-1 rounded-lg py-2 text-xs font-medium"
              >
                {submitting ? "Saving..." : "Add to catalog"}
              </button>
              <button onClick={scanAgain} style={{ background: SURFACE, color: INK, border: `1.5px solid ${LINE}` }} className="flex-1 rounded-lg py-2 text-xs font-medium">
                Scan again
              </button>
            </div>
          </div>
        )}
      </div>
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
      {loading ? (
        <p className="text-sm" style={{ color: MUTED }}>Loading…</p>
      ) : messages.length === 0 ? (
        <p className="text-sm mb-4" style={{ color: MUTED }}>No messages yet.</p>
      ) : (
        <div className="flex flex-col gap-2 mb-4">
          {messages.map((m) => (
            <div
              key={m.id}
              style={{
                alignSelf: m.sender === "employee" ? "flex-end" : "flex-start",
                maxWidth: "78%",
                // The employee's own bubble is a fixed warm gold gradient in both
                // themes, so it needs fixed dark text; the other bubble is the
                // generic surface color, so its text flips along with it.
                background: m.sender === "employee" ? `linear-gradient(135deg, #F9C978, ${AMBER})` : SURFACE,
                color: m.sender === "employee" ? CHARCOAL : INK,
                borderBottomRightRadius: m.sender === "employee" ? 4 : 14,
                borderBottomLeftRadius: m.sender === "employee" ? 14 : 4,
              }}
              className="rounded-2xl px-3 py-2 text-sm"
            >
              {m.body}
              <div className="text-[10px] mt-0.5" style={{ color: MUTED }}>
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
            style={{ border: `1px solid ${LINE}`, background: INPUT_BG }}
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
        <p className="text-xs mt-auto pt-2" style={{ color: MUTED }}>
          Clock in to send a message.
        </p>
      )}
    </div>
  );
}

// Employee-to-employee direct messages and group chats -- separate from
// ChatView above (which is the single admin<->employee channel). Renders
// one of three states: the new-chat coworker picker, an open thread, or the
// thread list, based on which props the parent hands it. Sending is gated
// on `onClock` exactly like ChatView -- employees can only message each
// other while clocked in, though history stays readable either way.
function TeamChatView({
  threads,
  threadsLoading,
  activeThreadId,
  messages,
  messagesLoading,
  myEmployeeId,
  onClock,
  onOpenThread,
  onCloseThread,
  onSend,
  showNewChat,
  onOpenNewChat,
  onCancelNewChat,
  coworkers,
  selectedIds,
  onToggleSelect,
  groupName,
  onGroupNameChange,
  onSubmitNewChat,
}) {
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
      // surfaced upstream
    } finally {
      setSending(false);
    }
  }

  function threadName(t) {
    if (t.is_group) {
      return t.name || (t.other_participants || []).map((p) => p.name).join(", ") || "Group chat";
    }
    return t.other_participants?.[0]?.name || "Direct message";
  }

  if (showNewChat) {
    return (
      <div style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
        <div className="mb-4 flex items-center justify-between">
          <h2 style={{ fontFamily: "'Oswald', sans-serif" }} className="text-sm uppercase tracking-widest">
            New chat
          </h2>
          <button onClick={onCancelNewChat} className="text-xs" style={{ color: MUTED }}>
            Cancel
          </button>
        </div>
        {coworkers.length === 0 ? (
          <p className="text-sm" style={{ color: MUTED }}>No other active coworkers yet.</p>
        ) : (
          <div className="flex flex-col gap-1 mb-4">
            {coworkers.map((c) => (
              <label
                key={c.id}
                className="flex items-center gap-2 text-sm rounded-xl px-3 py-2"
                style={{ background: selectedIds.includes(c.id) ? SURFACE : "transparent" }}
              >
                <input type="checkbox" checked={selectedIds.includes(c.id)} onChange={() => onToggleSelect(c.id)} />
                {c.name}
              </label>
            ))}
          </div>
        )}
        {selectedIds.length > 1 && (
          <input
            value={groupName}
            onChange={(e) => onGroupNameChange(e.target.value)}
            placeholder="Group name (optional)"
            style={{ border: `1px solid ${LINE}`, background: INPUT_BG }}
            className="w-full px-3 py-2 text-sm rounded-xl outline-none mb-3"
          />
        )}
        <button
          onClick={onSubmitNewChat}
          disabled={selectedIds.length === 0}
          style={{
            background: `linear-gradient(135deg, #F9C978, ${AMBER})`,
            color: CHARCOAL,
            opacity: selectedIds.length === 0 ? 0.5 : 1,
          }}
          className="w-full rounded-xl px-4 py-2 text-sm font-medium"
        >
          {selectedIds.length > 1 ? "Start group chat" : "Start chat"}
        </button>
      </div>
    );
  }

  if (activeThreadId) {
    return (
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", minHeight: "calc(100vh - 220px)" }} className="flex flex-col">
        <div className="mb-4 flex items-center gap-2">
          <button onClick={onCloseThread} className="text-lg leading-none" style={{ color: INK }}>
            &larr;
          </button>
          <h2 style={{ fontFamily: "'Oswald', sans-serif" }} className="text-sm uppercase tracking-widest">
            Team chat
          </h2>
        </div>

        {messagesLoading ? (
          <p className="text-sm" style={{ color: MUTED }}>Loading…</p>
        ) : messages.length === 0 ? (
          <p className="text-sm mb-4" style={{ color: MUTED }}>No messages yet.</p>
        ) : (
          <div className="flex flex-col gap-2 mb-4">
            {messages.map((m) => {
              const mine = m.sender_employee_id === myEmployeeId;
              return (
                <div key={m.id} style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "78%" }}>
                  {!mine && (
                    <div className="text-[10px] mb-0.5 px-1" style={{ color: MUTED }}>
                      {m.sender_name}
                    </div>
                  )}
                  <div
                    style={{
                      background: mine ? `linear-gradient(135deg, #F9C978, ${AMBER})` : SURFACE,
                      color: mine ? CHARCOAL : INK,
                      borderBottomRightRadius: mine ? 4 : 14,
                      borderBottomLeftRadius: mine ? 14 : 4,
                    }}
                    className="rounded-2xl px-3 py-2 text-sm"
                  >
                    {m.body}
                    <div className="text-[10px] mt-0.5" style={{ color: MUTED }}>
                      {new Date(m.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                </div>
              );
            })}
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
              style={{ border: `1px solid ${LINE}`, background: INPUT_BG }}
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
          <p className="text-xs mt-auto pt-2" style={{ color: MUTED }}>
            Clock in to message your team.
          </p>
        )}
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
      <div className="mb-4 flex items-center justify-end">
        <button
          onClick={onOpenNewChat}
          style={{ background: `linear-gradient(135deg, #F9C978, ${AMBER})`, color: CHARCOAL }}
          className="rounded-xl px-3 py-1.5 text-xs font-medium"
        >
          + New
        </button>
      </div>

      {!onClock && (
        <p className="text-xs mb-3" style={{ color: MUTED }}>
          You can read your chats anytime, but you'll need to clock in to send a message.
        </p>
      )}

      {threadsLoading ? (
        <p className="text-sm" style={{ color: MUTED }}>Loading…</p>
      ) : threads.length === 0 ? (
        <p className="text-sm" style={{ color: MUTED }}>No chats yet — tap "+ New" to message a coworker.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {threads.map((t) => (
            <button
              key={t.id}
              onClick={() => onOpenThread(t.id)}
              className="text-left rounded-xl px-3 py-2 flex items-center justify-between gap-2"
              style={{ background: SURFACE, border: `1px solid ${LINE}` }}
            >
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{threadName(t)}</div>
                {t.last_message && (
                  <div className="text-xs truncate" style={{ color: MUTED }}>{t.last_message.body}</div>
                )}
              </div>
              {t.unread_count > 0 && (
                <span
                  style={{ background: RUST, color: "#fff", fontSize: 10, fontWeight: 800, borderRadius: 20, padding: "2px 7px" }}
                >
                  {t.unread_count}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TimeClock() {
  const [checkingSession, setCheckingSession] = useState(true);
  const [loggedIn, setLoggedIn] = useState(false);
  const [employee, setEmployee] = useState(null);
  // Company's uploaded logo (see admin apps' Settings > company logo card),
  // shown in the header in place of the generic app name -- mirrors what
  // the desktop/mobile admin apps already do. Null means none uploaded, so
  // the header falls back to the plain "Site Clock" text.
  const [companyLogo, setCompanyLogo] = useState(null);

  // Easter egg: tap the header logo/title 7 times within 2 seconds to open
  // Snake. secretTapsRef (not state) so counting taps never triggers a
  // re-render on its own -- only the resulting setShowSnake(true) does.
  const [showSnake, setShowSnake] = useState(false);
  const secretTapsRef = useRef({ count: 0, timer: null });
  function handleLogoSecretTap() {
    const s = secretTapsRef.current;
    s.count += 1;
    clearTimeout(s.timer);
    if (s.count >= 7) {
      s.count = 0;
      setShowSnake(true);
    } else {
      s.timer = setTimeout(() => { s.count = 0; }, 2000);
    }
  }

  // Lets an employee pick their own clock-in celebration (previously
  // admin-only). Closes the sheet only once the save actually succeeds, so
  // a network hiccup shows an inline error instead of silently pretending
  // it worked.
  // Day/Night theme -- per-device only (localStorage), not synced to the
  // account. index.html applies a saved Night mode before React even mounts
  // (avoids a flash of Day mode), this just keeps the button's icon/label in
  // sync and handles switching after that.
  const [isNightMode, setIsNightMode] = useState(
    () => document.documentElement.getAttribute("data-theme") === "night"
  );
  function toggleTheme() {
    const next = !isNightMode;
    if (next) {
      document.documentElement.setAttribute("data-theme", "night");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    try { localStorage.setItem("coll-theme", next ? "night" : "day"); } catch {}
    setIsNightMode(next);
  }

  const [showAnimationPicker, setShowAnimationPicker] = useState(false);
  const [savingAnimation, setSavingAnimation] = useState(false);
  const [animationSaveError, setAnimationSaveError] = useState("");
  async function handleSelectClockInAnimation(value) {
    setSavingAnimation(true);
    setAnimationSaveError("");
    try {
      await updateMyClockInAnimation(value);
      setEmployee((prev) => (prev ? { ...prev, clock_in_animation: value } : prev));
      setShowAnimationPicker(false);
    } catch (err) {
      setAnimationSaveError(err.message || "Couldn't save your choice.");
    } finally {
      setSavingAnimation(false);
    }
  }

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
  const breakReminderFiredRef = useRef(null);

  const [log, setLog] = useState([]); // entries from time_entry_durations for this pay period
  const [view, setView] = useState("clock"); // clock | schedule | customers | chat
  const touchStartRef = useRef(null); // swipe-to-switch-tabs gesture state, see handleTabSwipeStart/End below
  const [schedule, setSchedule] = useState([]);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleMonthAnchor, setScheduleMonthAnchor] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const [customers, setCustomers] = useState([]);
  const [customersLoading, setCustomersLoading] = useState(false);
  const [inventoryItems, setInventoryItems] = useState([]);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [showBarcodeScanSheet, setShowBarcodeScanSheet] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatUnreadCount, setChatUnreadCount] = useState(0);
  const [scheduleUnseenCount, setScheduleUnseenCount] = useState(0);
  const [showTimeOffSheet, setShowTimeOffSheet] = useState(false);
  const [showRouteSheet, setShowRouteSheet] = useState(false);
  const [showPullSheetsSheet, setShowPullSheetsSheet] = useState(false);
  const [pullSheets, setPullSheets] = useState([]);
  const [pullSheetsLoading, setPullSheetsLoading] = useState(false);
  const [pullSheetsUnseenCount, setPullSheetsUnseenCount] = useState(0);
  const [timeOffRequests, setTimeOffRequests] = useState([]);
  const [timeOffLoading, setTimeOffLoading] = useState(false);
  const [timeOffForm, setTimeOffForm] = useState({ start_date: "", end_date: "", note: "" });
  const [timeOffSubmitting, setTimeOffSubmitting] = useState(false);
  const [timeOffError, setTimeOffError] = useState("");
  // Today's optimized route (built by the admin -- see admin-app/Routes
  // card), if one's been assigned. Null means "none today", not "loading".
  const [todaysRoute, setTodaysRoute] = useState(null);
  const [teamThreads, setTeamThreads] = useState([]);
  const [teamThreadsLoading, setTeamThreadsLoading] = useState(false);
  const [teamUnreadCount, setTeamUnreadCount] = useState(0);
  const [activeTeamThreadId, setActiveTeamThreadId] = useState(null);
  const [teamMessages, setTeamMessages] = useState([]);
  const [teamMessagesLoading, setTeamMessagesLoading] = useState(false);
  const [coworkers, setCoworkers] = useState([]);
  const [showNewTeamChat, setShowNewTeamChat] = useState(false);
  const [newChatSelectedIds, setNewChatSelectedIds] = useState([]);
  const [newChatGroupName, setNewChatGroupName] = useState("");
  // Which pane shows inside the merged Chat tab -- "direct" is the single
  // admin<->employee channel (ChatView), "team" is employee-to-employee
  // DMs/groups (TeamChatView). Kept separate from `view` so switching
  // sub-tabs doesn't require leaving/re-entering the Chat tab.
  const [chatSubtab, setChatSubtab] = useState("direct"); // direct | team
  const [now, setNow] = useState(new Date());
  const [submitted, setSubmitted] = useState(false);
  const [actionError, setActionError] = useState("");
  const [savedOffline, setSavedOffline] = useState(false);
  // "fireworks" | "birthday" | "rocket" | "fall" | "easter" | "christmas" |
  // null -- which clock-in celebration overlay (if any) is currently
  // showing, based on the employee's clock_in_animation.
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
    if (["fireworks", "birthday", "rocket", "fall", "easter", "christmas"].includes(employee?.clock_in_animation)) {
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
    clockInTime: employee?.auto_clockin_time,
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
        getCompanyLogo().then((data) => setCompanyLogo(data.logo)).catch(() => {});
      }
      setCheckingSession(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global click heartbeat: any tap anywhere in the app while logged in
  // counts as "using the app" for the platform dashboard's dormant-days
  // figure, not just moments the app happens to be loading/saving data on
  // its own. Throttled to once every 5 minutes so a tap-happy session
  // doesn't spam the server -- it's throttled again server-side too, per
  // company, to once an hour (see backend middleware/requireAuth.js).
  useEffect(() => {
    if (!loggedIn) return;
    let lastPingAt = 0;
    function handleClick() {
      const now = Date.now();
      if (now - lastPingAt < 5 * 60 * 1000) return;
      lastPingAt = now;
      pingActivity();
    }
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [loggedIn]);

  // If a job notification is tapped while the app is in the background,
  // the service worker posts a message asking us to jump to the Schedule tab.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    function handleMessage(event) {
      if (event.data?.type !== "navigate") return;
      if (event.data.url?.includes("/schedule")) setView("schedule");
      else if (event.data.url?.includes("/team")) { setView("chat"); setChatSubtab("team"); }
      else if (event.data.url?.includes("/chat")) { setView("chat"); setChatSubtab("direct"); }
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

  async function loadTimeOffRequests() {
    setTimeOffLoading(true);
    try {
      const rows = await getMyTimeOffRequests();
      setTimeOffRequests(rows);
    } catch {
      // non-fatal — leave whatever was last loaded
    } finally {
      setTimeOffLoading(false);
    }
  }

  async function loadTodaysRoute() {
    try {
      const route = await getTodaysRoute();
      setTodaysRoute(route);
    } catch {
      // non-fatal — no route card just won't show this cycle
    }
  }

  // Full list, with items included, for every pull sheet in the company
  // (see getMyPullSheets). The menu badge count is "how many still need
  // attention" -- not yet fulfilled, whether or not someone's already
  // reported quantities on them -- mirroring what GET
  // /api/schedule/pull-sheets/unseen-count counts server-side.
  async function loadPullSheets() {
    setPullSheetsLoading(true);
    try {
      const rows = await getMyPullSheets();
      setPullSheets(rows);
      setPullSheetsUnseenCount(rows.filter((r) => r.status !== "fulfilled").length);
    } catch {
      // non-fatal — leave whatever was last loaded
    } finally {
      setPullSheetsLoading(false);
    }
  }

  // Lightweight background poll for the menu badge (see interval effect
  // below) -- avoids fetching every pull sheet's full item list just to
  // show a count.
  async function refreshPullSheetsUnseenCount() {
    try {
      const { count } = await getPullSheetsUnseenCount();
      setPullSheetsUnseenCount(count);
    } catch {
      // non-fatal — badge just won't update this cycle
    }
  }

  // Called by PullSheetCard when an employee taps "Mark as pulled" --
  // reports actual quantities, then refreshes the list so the card's
  // status badge and badge count reflect the change. Throws on failure so
  // the card itself can show the error inline (see PullSheetCard).
  async function submitPulledForSheet(sheetId, items) {
    await submitPulledQuantities(sheetId, items);
    await loadPullSheets();
  }

  // Opens the real Google Maps app with every stop pre-loaded in the
  // optimized order, ending back at the shop -- a free deep link (no API
  // key/cost). Uses the employee's current location as the starting point
  // when available (a much more useful "origin" than the shop, since
  // they're not usually standing at the shop when they tap this), falling
  // back to the server-computed shop-to-shop link if location is denied,
  // unavailable, or there's no shop location on file to fall back to.
  function startRoute() {
    if (!todaysRoute || todaysRoute.stops.length === 0) return;
    const fallbackUrl = todaysRoute.maps_url;
    if (!navigator.geolocation) {
      if (fallbackUrl) window.open(fallbackUrl, "_blank");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const origin = `${pos.coords.latitude},${pos.coords.longitude}`;
        const destination = todaysRoute.shop_location
          ? `${todaysRoute.shop_location.lat},${todaysRoute.shop_location.lng}`
          : origin;
        const waypoints = todaysRoute.stops.map((s) => `${s.lat},${s.lng}`).join("|");
        const params = new URLSearchParams({ api: "1", origin, destination, travelmode: "driving" });
        if (waypoints) params.set("waypoints", waypoints);
        window.open(`https://www.google.com/maps/dir/?${params.toString()}`, "_blank");
      },
      () => {
        if (fallbackUrl) window.open(fallbackUrl, "_blank");
      },
      { enableHighAccuracy: true, maximumAge: 60000, timeout: 15000 }
    );
  }

  function openTimeOffSheet() {
    setTimeOffError("");
    setShowTimeOffSheet(true);
    loadTimeOffRequests();
  }

  async function submitTimeOffRequest(e) {
    e.preventDefault();
    setTimeOffError("");
    if (!timeOffForm.start_date || !timeOffForm.end_date) {
      setTimeOffError("Pick a start and end date.");
      return;
    }
    if (timeOffForm.end_date < timeOffForm.start_date) {
      setTimeOffError("End date can't be before the start date.");
      return;
    }
    setTimeOffSubmitting(true);
    try {
      await requestTimeOff(timeOffForm.start_date, timeOffForm.end_date, timeOffForm.note.trim());
      setTimeOffForm({ start_date: "", end_date: "", note: "" });
      await loadTimeOffRequests();
    } catch (err) {
      setTimeOffError(err.message || "Couldn't submit request. Try again.");
    } finally {
      setTimeOffSubmitting(false);
    }
  }

  async function handleCancelTimeOffRequest(id) {
    try {
      await cancelTimeOffRequest(id);
      await loadTimeOffRequests();
    } catch {
      // non-fatal — the request just stays in the list as-is
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

  async function loadInventoryItems() {
    setInventoryLoading(true);
    try {
      const rows = await getMyInventoryItems();
      setInventoryItems(rows);
    } catch {
      // non-fatal — leave whatever was last loaded
    } finally {
      setInventoryLoading(false);
    }
  }

  async function saveInventoryItem(id, patch) {
    const updated = await updateInventoryCatalogItem(id, patch);
    setInventoryItems((items) => items.map((i) => (i.id === id ? { ...i, ...updated, quantity_available: updated.quantity_on_hand - updated.quantity_on_hold } : i)));
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

  // Team chat (employee-to-employee) -- separate thread list from the
  // single admin channel above. loadTeamThreads never marks anything read
  // by itself (unlike loadChatMessages); read state is per-thread and only
  // cleared by actually opening that thread via openTeamThread.
  async function loadTeamThreads() {
    setTeamThreadsLoading(true);
    try {
      const rows = await getTeamThreads();
      setTeamThreads(rows);
    } catch {
      // non-fatal — leave whatever was last loaded
    } finally {
      setTeamThreadsLoading(false);
    }
  }

  async function refreshTeamUnreadCount() {
    try {
      const { count } = await getTeamUnreadCount();
      setTeamUnreadCount(count);
    } catch {
      // non-fatal — badge just won't update this cycle
    }
  }

  async function openTeamThread(threadId) {
    setActiveTeamThreadId(threadId);
    setTeamMessagesLoading(true);
    try {
      const rows = await getTeamMessages(threadId);
      setTeamMessages(rows);
    } catch {
      // non-fatal — leave whatever was last loaded
    } finally {
      setTeamMessagesLoading(false);
    }
    refreshTeamUnreadCount();
    loadTeamThreads(); // refresh previews/unread badges in the background
  }

  function closeTeamThread() {
    setActiveTeamThreadId(null);
    setTeamMessages([]);
  }

  async function handleSendTeamMessage(body) {
    const saved = await sendTeamMessage(activeTeamThreadId, body);
    setTeamMessages((prev) => [...prev, saved]);
  }

  async function openNewTeamChat() {
    setShowNewTeamChat(true);
    setNewChatSelectedIds([]);
    setNewChatGroupName("");
    try {
      const rows = await getCoworkers();
      setCoworkers(rows);
    } catch {
      setCoworkers([]);
    }
  }

  function cancelNewTeamChat() {
    setShowNewTeamChat(false);
  }

  function toggleNewChatSelection(id) {
    setNewChatSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function submitNewTeamChat() {
    if (newChatSelectedIds.length === 0) return;
    const result = await createTeamThread(
      newChatSelectedIds,
      newChatSelectedIds.length > 1 ? newChatGroupName.trim() || null : null
    );
    setShowNewTeamChat(false);
    await loadTeamThreads();
    openTeamThread(result.id);
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
    if (view === "schedule" && loggedIn) {
      loadSchedule(scheduleMonthAnchor);
      loadTimeOffRequests();
      loadTodaysRoute();
      loadPullSheets();
    }
    if (view === "customers" && loggedIn) loadCustomers();
    if (view === "inventory" && loggedIn) loadInventoryItems();
    if (view === "chat" && loggedIn) {
      if (chatSubtab === "direct") loadChatMessages();
      else loadTeamThreads();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, chatSubtab, loggedIn, scheduleMonthAnchor]);

  // Background poll for the Chat (both sub-tabs) and Schedule tabs' badges --
  // deliberately uses the lightweight count-only endpoints (not the full
  // fetches) so none of them silently mark things seen/read before the tab
  // is actually opened. Each is skipped while its own pane is the one
  // currently open, since the full fetch there already keeps its count
  // current.
  useEffect(() => {
    if (!loggedIn) return;
    refreshChatUnreadCount();
    refreshScheduleUnseenCount();
    refreshTeamUnreadCount();
    if (view !== "schedule") refreshPullSheetsUnseenCount();
    const interval = setInterval(() => {
      if (view !== "chat" || chatSubtab !== "direct") refreshChatUnreadCount();
      if (view !== "schedule") refreshScheduleUnseenCount();
      if (view !== "chat" || chatSubtab !== "team") refreshTeamUnreadCount();
      if (view !== "schedule") refreshPullSheetsUnseenCount();
    }, 15000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn, view, chatSubtab]);

  // Periodically re-sync clock status from the server. Without this, an
  // admin force-clocking someone out (forgotten shift) never reaches the
  // employee's screen until they happen to log out and back in -- the timer
  // just keeps ticking on a shift the server already closed. This catches
  // that within a few seconds instead.
  useEffect(() => {
    if (!loggedIn) return;
    const interval = setInterval(() => {
      refreshFromServer();
    }, 20000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn]);

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
      } else {
        // Server has no open shift -- covers being force clocked out by an
        // admin (or any other server-side close) while the app was just
        // sitting idle on screen. Setting the same "off" value when we're
        // already off is a harmless no-op re-render.
        setStatus("off");
        setEntryId(null);
        setJobName("");
        setClockInTime(null);
        setBreakStartedAt(null);
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
      getCompanyLogo().then((data) => setCompanyLogo(data.logo)).catch(() => {});
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
    setCompanyLogo(null);
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
    if (["fireworks", "birthday", "rocket", "fall", "easter", "christmas"].includes(employee?.clock_in_animation)) {
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

  // Warns the employee their break is almost over -- 5 minutes before
  // whatever length the admin set for them (break_minutes, e.g. 30 or 60),
  // so the 25-minute mark on a 30-minute break or the 55-minute mark on a
  // 60-minute break. Falls back to 30 if it's somehow missing so this never
  // throws for an older cached session.
  const breakMinutes = employee?.break_minutes || 30;
  const breakReminderThresholdMs = Math.max(0, breakMinutes - 5) * 60 * 1000;
  const breakReminderDue = status === "break" && currentBreakMs >= breakReminderThresholdMs;

  // Fires the local notification exactly once per break -- breakReminderFiredRef
  // remembers which break's breakStartedAt it already fired for, so re-renders
  // every second (from the `now` ticker) don't spam repeat notifications, and
  // starting a new break after ending one resets it.
  useEffect(() => {
    if (status !== "break" || !breakStartedAt) return;
    if (breakReminderFiredRef.current === breakStartedAt) return;
    if (currentBreakMs >= breakReminderThresholdMs) {
      breakReminderFiredRef.current = breakStartedAt;
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        const title = "5 minutes left on break";
        const body = `Your ${breakMinutes}-minute break is almost up.`;
        // Installed PWAs (mainly Android) reject the direct Notification()
        // constructor and require going through the service worker instead --
        // so that's tried first, with the direct constructor as a fallback
        // for browsers where there's no active registration.
        if ("serviceWorker" in navigator) {
          navigator.serviceWorker.ready
            .then((registration) => registration.showNotification(title, { body }))
            .catch(() => {
              try {
                new Notification(title, { body });
              } catch {}
            });
        } else {
          try {
            new Notification(title, { body });
          } catch {}
        }
      }
    }
  }, [status, breakStartedAt, currentBreakMs, breakReminderThresholdMs, breakMinutes]);

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
      // The server now excludes those shifts from GET /time-entries (they're
      // marked submitted), so refetching immediately clears the on-screen
      // history right away rather than waiting for the next 20s poll --
      // the whole point of submitting is to see the slate wiped.
      await refreshFromServer();
    } catch (err) {
      setActionError(err.message || "Nothing to submit yet.");
    }
  }

  if (checkingSession) {
    return (
      <div style={{ background: BG, minHeight: "100vh" }} className="w-full min-h-screen flex items-center justify-center">
        <style>{FONT_IMPORT}</style>
        <p style={{ fontFamily: "'IBM Plex Mono', monospace", color: MUTED }} className="text-sm">
          Loading…
        </p>
      </div>
    );
  }

  if (!loggedIn) {
    return (
      <div style={{ background: BG, minHeight: "100vh", color: INK, fontFamily: "'IBM Plex Mono', monospace" }} className="w-full min-h-screen flex items-center justify-center px-4">
        <style>{FONT_IMPORT}</style>
        <div style={{ border: `1px solid rgba(31,36,33,0.06)`, background: SURFACE, boxShadow: "0 20px 45px rgba(31,36,33,0.14), 0 4px 12px rgba(31,36,33,0.08)" }} className="w-full max-w-xs rounded-2xl p-6">
          <h1 style={{ fontFamily: "'Oswald', sans-serif" }} className="text-xl font-semibold uppercase mb-1 text-center">
            Site Clock
          </h1>
          <p className="text-xs text-center mb-5" style={{ color: MUTED }}>Your personal time clock</p>
          <input
  autoFocus
  type="email"
  value={emailInput}
  onChange={(e) => setEmailInput(e.target.value)}
  placeholder="Your email"
            style={{ border: `1.5px solid ${LINE}`, background: INPUT_BG }}
            className="w-full px-3 py-2.5 text-sm rounded-xl mb-3 outline-none"
          />
          <input
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLogin()}
            placeholder="PIN"
            type="password"
            inputMode="numeric"
            style={{ border: `1.5px solid ${LINE}`, background: INPUT_BG }}
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
            style={{ color: MUTED, background: "none", border: "none" }}
          >
            Forgot PIN?
          </button>
          <p className="text-[10px] text-center mt-4" style={{ color: MUTED }}>
            You only need to do this once on this device.
          </p>
        </div>
      </div>
    );
  }

  // Swipe left/right on the main content area to move through the bottom
  // tabs, like flipping between pages in a native app. Only the touchend
  // delta decides whether this was a deliberate horizontal swipe (not a
  // vertical scroll or a tap) -- touchmove is left alone so normal page
  // scrolling inside a tab is never interrupted. Disabled while a sheet or
  // modal is open so swiping inside one (e.g. scrolling a long list in the
  // Route or Time Off sheet) can't accidentally change tabs underneath it.
  function handleTabSwipeStart(e) {
    if (showTimeOffSheet || showRouteSheet || showNewTeamChat) {
      touchStartRef.current = null;
      return;
    }
    const t = e.touches[0];
    touchStartRef.current = { x: t.clientX, y: t.clientY, time: Date.now() };
  }

  function handleTabSwipeEnd(e) {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start || showTimeOffSheet || showRouteSheet || showNewTeamChat) return;

    const t = e.changedTouches[0];
    const deltaX = t.clientX - start.x;
    const deltaY = t.clientY - start.y;
    const elapsed = Date.now() - start.time;

    if (elapsed > 600) return; // too slow to be a flick
    if (Math.abs(deltaX) < 70) return; // too short to be deliberate
    if (Math.abs(deltaX) < Math.abs(deltaY) * 1.5) return; // more vertical than horizontal -- was a scroll

    // Inventory only joins the swipe order for employees who actually have
    // the tab -- otherwise swiping past Chat would land on a view with no
    // nav button highlighted for anyone else.
    const viewOrder = employee?.can_manage_inventory ? [...VIEW_ORDER, "inventory"] : VIEW_ORDER;
    const idx = viewOrder.indexOf(view);
    if (deltaX < 0 && idx < viewOrder.length - 1) {
      setView(viewOrder[idx + 1]);
    } else if (deltaX > 0 && idx > 0) {
      setView(viewOrder[idx - 1]);
    }
  }

  return (
    <div
      style={{ background: BG, minHeight: "100vh", color: INK }}
      className="w-full min-h-screen pb-16"
      onTouchStart={handleTabSwipeStart}
      onTouchEnd={handleTabSwipeEnd}
    >
      <style>{FONT_IMPORT}</style>
      {activeAnimation === "fireworks" && <FireworksOverlay onDone={() => setActiveAnimation(null)} />}
      {activeAnimation === "birthday" && <BirthdayOverlay name={employee?.name} onDone={() => setActiveAnimation(null)} />}
      {activeAnimation === "rocket" && <RocketLaunchOverlay onDone={() => setActiveAnimation(null)} />}
      {activeAnimation === "fall" && <FallOverlay onDone={() => setActiveAnimation(null)} />}
      {activeAnimation === "easter" && <EasterOverlay onDone={() => setActiveAnimation(null)} />}
      {activeAnimation === "christmas" && <ChristmasOverlay onDone={() => setActiveAnimation(null)} />}
      <SnakeGame open={showSnake} onClose={() => setShowSnake(false)} />
      <ClockInAnimationSheet
        open={showAnimationPicker}
        onClose={() => setShowAnimationPicker(false)}
        current={employee?.clock_in_animation}
        onSelect={handleSelectClockInAnimation}
        saving={savingAnimation}
        error={animationSaveError}
      />
      <div style={{ fontFamily: "'IBM Plex Mono', monospace" }} className="max-w-md mx-auto px-4 pt-8">
        <div className="flex items-center justify-between mb-1">
          {/* No visible hint on purpose -- tap this 7x fast to open Snake. */}
          <div onClick={handleLogoSecretTap} style={{ cursor: "default" }}>
            {companyLogo ? (
              <img
                src={companyLogo}
                alt="Company logo"
                style={{ maxHeight: 40, maxWidth: 180, borderRadius: 6, background: SURFACE, padding: 3, objectFit: "contain" }}
              />
            ) : (
              <h1 style={{ fontFamily: "'Oswald', sans-serif", letterSpacing: "0.02em" }} className="text-2xl font-semibold uppercase">
                Site Clock
              </h1>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={toggleTheme}
              title={isNightMode ? "Switch to Day mode" : "Switch to Night mode"}
              aria-label={isNightMode ? "Switch to Day mode" : "Switch to Night mode"}
              style={{ color: MUTED, background: "transparent", border: "none", display: "flex", alignItems: "center" }}
            >
              {isNightMode ? <Moon size={16} /> : <Sun size={16} />}
            </button>
            <button
              onClick={() => setShowAnimationPicker(true)}
              title="Clock-in celebration"
              aria-label="Clock-in celebration"
              style={{ color: MUTED, background: "transparent", border: "none", display: "flex", alignItems: "center" }}
            >
              <PartyPopper size={16} />
            </button>
            <button onClick={handleLogout} className="text-xs flex items-center gap-1" style={{ color: MUTED }}>
              <LogOut size={12} /> {employee?.name}
            </button>
          </div>
        </div>
        <div className="h-px w-full mb-6" style={{ background: `repeating-linear-gradient(90deg, ${LINE} 0 6px, transparent 6px 12px)` }} />

        {view === "schedule" ? (
          <>
            <RouteSheet
              open={showRouteSheet}
              onClose={() => setShowRouteSheet(false)}
              route={todaysRoute}
              onStartRoute={startRoute}
            />
            <PullSheetsSheet
              open={showPullSheetsSheet}
              onClose={() => setShowPullSheetsSheet(false)}
              pullSheets={pullSheets}
              loading={pullSheetsLoading}
              onSubmitPulled={submitPulledForSheet}
            />
            <CalendarView
              schedule={schedule}
              loading={scheduleLoading}
              monthAnchor={scheduleMonthAnchor}
              onPrevMonth={goPrevMonth}
              onNextMonth={goNextMonth}
              onToday={goToday}
              onOpenTimeOff={openTimeOffSheet}
              timeOffPendingCount={timeOffRequests.filter((r) => r.status === "pending").length}
              onOpenRoute={() => setShowRouteSheet(true)}
              hasRouteToday={Boolean(todaysRoute && todaysRoute.stops && todaysRoute.stops.length > 0)}
              onOpenPullSheets={() => { setShowPullSheetsSheet(true); loadPullSheets(); }}
              pullSheetsCount={pullSheetsUnseenCount}
            />
            <TimeOffSheet
              open={showTimeOffSheet}
              onClose={() => setShowTimeOffSheet(false)}
              requests={timeOffRequests}
              loading={timeOffLoading}
              form={timeOffForm}
              onFormChange={setTimeOffForm}
              onSubmit={submitTimeOffRequest}
              submitting={timeOffSubmitting}
              error={timeOffError}
              onCancelRequest={handleCancelTimeOffRequest}
            />
          </>
        ) : view === "customers" ? (
          <CustomersView customers={customers} loading={customersLoading} />
        ) : view === "inventory" ? (
          <>
            <InventoryView
              items={inventoryItems}
              loading={inventoryLoading}
              onOpenScan={() => setShowBarcodeScanSheet(true)}
              onSaveItem={saveInventoryItem}
            />
            <BarcodeScanSheet
              open={showBarcodeScanSheet}
              onClose={() => setShowBarcodeScanSheet(false)}
              onDone={loadInventoryItems}
            />
          </>
        ) : view === "chat" ? (
          <div style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
            <div className="mb-4 flex items-center justify-between">
              <h2 style={{ fontFamily: "'Oswald', sans-serif" }} className="text-sm uppercase tracking-widest">
                Chat
              </h2>
              <div className="flex gap-2">
                <button
                  onClick={() => setChatSubtab("direct")}
                  style={{
                    background: chatSubtab === "direct" ? CHARCOAL : SURFACE,
                    color: chatSubtab === "direct" ? "#fff" : INK,
                    border: `1.5px solid ${INK}`,
                  }}
                  className="rounded-xl px-3 py-1 text-xs font-medium uppercase tracking-widest flex items-center gap-1.5"
                >
                  Direct
                  {chatUnreadCount > 0 && (
                    <span style={{ background: RUST, color: "#fff", fontSize: 9, fontWeight: 800, borderRadius: 20, padding: "1px 5px" }}>
                      {chatUnreadCount}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => setChatSubtab("team")}
                  style={{
                    background: chatSubtab === "team" ? CHARCOAL : SURFACE,
                    color: chatSubtab === "team" ? "#fff" : INK,
                    border: `1.5px solid ${INK}`,
                  }}
                  className="rounded-xl px-3 py-1 text-xs font-medium uppercase tracking-widest flex items-center gap-1.5"
                >
                  Team
                  {teamUnreadCount > 0 && (
                    <span style={{ background: RUST, color: "#fff", fontSize: 9, fontWeight: 800, borderRadius: 20, padding: "1px 5px" }}>
                      {teamUnreadCount}
                    </span>
                  )}
                </button>
              </div>
            </div>

            {chatSubtab === "direct" ? (
              <ChatView
                messages={chatMessages}
                loading={chatLoading}
                onClock={status !== "off"}
                onSend={handleSendChatMessage}
              />
            ) : (
              <TeamChatView
                threads={teamThreads}
                threadsLoading={teamThreadsLoading}
                activeThreadId={activeTeamThreadId}
                messages={teamMessages}
                messagesLoading={teamMessagesLoading}
                myEmployeeId={employee?.id}
                onClock={status !== "off"}
                onOpenThread={openTeamThread}
                onCloseThread={closeTeamThread}
                onSend={handleSendTeamMessage}
                showNewChat={showNewTeamChat}
                onOpenNewChat={openNewTeamChat}
                onCancelNewChat={cancelNewTeamChat}
                coworkers={coworkers}
                selectedIds={newChatSelectedIds}
                onToggleSelect={toggleNewChatSelection}
                groupName={newChatGroupName}
                onGroupNameChange={setNewChatGroupName}
                onSubmitNewChat={submitNewTeamChat}
              />
            )}
          </div>
        ) : (
        <>
        {actionError && (
          <div style={{ background: SURFACE, border: `1.5px solid ${RUST}`, color: RUST, boxShadow: "0 6px 16px rgba(211,90,52,0.1)" }} className="rounded-xl p-3 mb-4 text-xs">
            {actionError}
          </div>
        )}
        {savedOffline && (
          <div style={{ background: SURFACE, border: `1.5px dashed ${AMBER}` }} className="rounded-xl p-3 mb-4 text-xs">
            No connection — saved on this device and will sync automatically once you're back online.
          </div>
        )}{geo.configured && geo.permission === "denied" && (
          <div style={{ background: SURFACE, border: `1.5px dashed ${RUST}`, color: RUST }} className="rounded-xl p-3 mb-4 text-xs">
            Location access is off, so auto clock-in/out won't work — the manual buttons below still do. To enable it, allow location for this site in your phone's settings.
          </div>
        )}
        {shiftTooLong && (
          <div style={{ background: SURFACE, border: `1.5px solid ${RUST}`, color: RUST, boxShadow: "0 6px 16px rgba(211,90,52,0.1)" }} className="rounded-xl p-3 mb-4 text-xs">
            You've been clocked in for over 10 hours — did you forget to clock out?
          </div>
        )}
        {breakReminderDue && (
          <div style={{ background: SURFACE, border: `1.5px solid ${AMBER_DEEP}`, color: AMBER_DEEP, boxShadow: "0 6px 16px rgba(219,138,22,0.12)" }} className="rounded-xl p-3 mb-4 text-xs">
            5 minutes left on your break.
          </div>
        )}
        <div style={{ border: `1px solid rgba(31,36,33,0.06)`, background: SURFACE, boxShadow: "0 10px 24px rgba(31,36,33,0.08), 0 2px 6px rgba(31,36,33,0.05)" }} className="rounded-2xl p-5 mb-6">
          <div className="flex items-center justify-between mb-4">
            <span style={{ background: statusMeta.bg, color: statusMeta.color, fontFamily: "'Oswald', sans-serif", boxShadow: statusMeta.shadow, fontWeight: 700 }} className="px-3 py-1.5 text-xs tracking-widest rounded-full">
              {statusMeta.label}
            </span>
            <span className="text-xs" style={{ color: MUTED }}>{now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</span>
          </div>

          <div className="text-center mb-4">
            <div
              style={{
                fontFamily: "'Oswald', sans-serif", letterSpacing: "0.03em",
                background: status === "off" ? "none" : `linear-gradient(135deg, ${CHARCOAL}, #3a4440)`,
                WebkitBackgroundClip: status === "off" ? "unset" : "text",
                backgroundClip: status === "off" ? "unset" : "text",
                color: status === "off" ? INK : "transparent",
              }}
              className="text-5xl font-semibold tabular-nums"
            >
              {status === "off" ? "00:00:00" : formatElapsed(elapsedMs)}
            </div>
            {status === "break" && (
              <div className="text-xs mt-1" style={{ color: MUTED }}>
                break {formatElapsed(currentBreakMs)}
              </div>
            )}
          </div>

          {status === "off" ? (
            <input
              value={jobDraft}
              onChange={(e) => setJobDraft(e.target.value)}
              placeholder="Job / site name"
              style={{ border: `1.5px solid ${LINE}`, background: INPUT_BG }}
              className="w-full px-3 py-2 text-sm rounded-xl mb-3 outline-none"
            />
          ) : (
            <div className="flex items-center gap-2 mb-3 text-sm">
              <Clock size={14} style={{ color: MUTED }} />
              <span className="font-medium">{jobName}</span>
              <span style={{ color: MUTED }}>· in since {formatClock(clockInTime)}</span>
            </div>
          )}

          <div className="flex mb-4 rounded-xl overflow-hidden" style={{ border: `1.5px solid ${INK}` }}>
            <button
              disabled={status !== "off"}
              onClick={() => setLocation("in_town")}
              style={{
                background: location === "in_town" ? `linear-gradient(135deg, #5C9481, ${TEAL_DEEP})` : "transparent",
                color: location === "in_town" ? "#fff" : INK, fontFamily: "'Oswald', sans-serif",
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
                color: location === "traveling" ? "#fff" : INK, fontFamily: "'Oswald', sans-serif",
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
                  // Fixed dark text (not INK) -- this button's gold gradient stays a
                  // warm accent in both themes, so it always needs dark text on it.
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
                <button onClick={startBreak} style={{ border: `1.5px solid ${INK}`, background: SURFACE, fontFamily: "'Oswald', sans-serif" }} className="flex-1 py-3 rounded-xl text-sm font-semibold flex items-center justify-center gap-2">
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
          <span className="text-xs" style={{ color: MUTED }}>{log.length} total</span>
        </div>

        {log.length === 0 ? (
          <p className="text-sm" style={{ color: MUTED }}>No completed shifts yet this pay period.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {log.map((entry) => (
              <div
                key={entry.time_entry_id}
                style={{ background: SURFACE, border: `1px solid rgba(31,36,33,0.05)`, boxShadow: "0 6px 16px rgba(31,36,33,0.06), 0 1px 3px rgba(31,36,33,0.04)" }}
                className="rounded-xl p-4"
              >
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <div className="text-sm font-medium">{entry.job_name}</div>
                    <div className="text-xs flex items-center gap-1 mt-0.5" style={{ color: MUTED }}>
                      {entry.location_type === "in_town" ? (<><MapPin size={11} /> In town</>) : (<><Plane size={11} /> Traveling</>)}
                    </div>
                  </div>
                  <div style={{ fontFamily: "'Oswald', sans-serif" }} className="text-lg font-semibold tabular-nums">
                    {formatDuration(entry.worked_seconds)}
                  </div>
                </div>
                <div className="flex justify-between text-xs pt-2" style={{ color: MUTED, borderTop: `1px solid ${LINE}` }}>
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
        style={{ background: SURFACE, borderTop: `1px solid ${LINE}`, boxShadow: "0 -8px 20px rgba(31,36,33,0.06)" }}
        className="fixed bottom-0 left-0 right-0 flex"
      >
        <div className="max-w-md mx-auto w-full flex">
          <button
            onClick={() => setView("clock")}
            style={{ color: view === "clock" ? INK : MUTED, fontFamily: "'Oswald', sans-serif" }}
            className="flex-1 py-3 text-xs flex flex-col items-center gap-1 uppercase tracking-widest"
          >
            <span
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 12,
                background: view === "clock" ? `linear-gradient(135deg, #F9C978, ${AMBER})` : "transparent",
                boxShadow: view === "clock" ? "0 3px 8px rgba(219,138,22,0.35)" : "none",
              }}
            >
              <Timer size={16} style={{ color: view === "clock" ? CHARCOAL : MUTED }} />
            </span>
            Clock
          </button>
          <button
            onClick={() => setView("schedule")}
            style={{ color: view === "schedule" ? INK : MUTED, fontFamily: "'Oswald', sans-serif", position: "relative" }}
            className="flex-1 py-3 text-xs flex flex-col items-center gap-1 uppercase tracking-widest"
          >
            <span
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 12,
                background: view === "schedule" ? `linear-gradient(135deg, #F9C978, ${AMBER})` : "transparent",
                boxShadow: view === "schedule" ? "0 3px 8px rgba(219,138,22,0.35)" : "none",
              }}
            >
              <CalendarDays size={16} style={{ color: view === "schedule" ? CHARCOAL : MUTED }} />
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
            style={{ color: view === "customers" ? INK : MUTED, fontFamily: "'Oswald', sans-serif" }}
            className="flex-1 py-3 text-xs flex flex-col items-center gap-1 uppercase tracking-widest"
          >
            <span
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 12,
                background: view === "customers" ? `linear-gradient(135deg, #F9C978, ${AMBER})` : "transparent",
                boxShadow: view === "customers" ? "0 3px 8px rgba(219,138,22,0.35)" : "none",
              }}
            >
              <Users size={16} style={{ color: view === "customers" ? CHARCOAL : MUTED }} />
            </span>
            Customers
          </button>
          <button
            onClick={() => setView("chat")}
            style={{ color: view === "chat" ? INK : MUTED, fontFamily: "'Oswald', sans-serif", position: "relative" }}
            className="flex-1 py-3 text-xs flex flex-col items-center gap-1 uppercase tracking-widest"
          >
            <span
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 12,
                background: view === "chat" ? `linear-gradient(135deg, #F9C978, ${AMBER})` : "transparent",
                boxShadow: view === "chat" ? "0 3px 8px rgba(219,138,22,0.35)" : "none",
              }}
            >
              <MessageCircle size={16} style={{ color: view === "chat" ? CHARCOAL : MUTED }} />
            </span>
            Chat
            {chatUnreadCount + teamUnreadCount > 0 && (
              <span
                style={{
                  position: "absolute", top: 2, right: "22%",
                  background: RUST, color: "#fff", fontSize: 9, fontWeight: 800,
                  borderRadius: 20, padding: "1px 5px", minWidth: 14, textAlign: "center", lineHeight: 1.3,
                }}
              >
                {chatUnreadCount + teamUnreadCount}
              </span>
            )}
          </button>
          {employee?.can_manage_inventory && (
            <button
              onClick={() => setView("inventory")}
              style={{ color: view === "inventory" ? INK : MUTED, fontFamily: "'Oswald', sans-serif" }}
              className="flex-1 py-3 text-xs flex flex-col items-center gap-1 uppercase tracking-widest"
            >
              <span
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 12,
                  background: view === "inventory" ? `linear-gradient(135deg, #F9C978, ${AMBER})` : "transparent",
                  boxShadow: view === "inventory" ? "0 3px 8px rgba(219,138,22,0.35)" : "none",
                }}
              >
                <Package size={16} style={{ color: view === "inventory" ? CHARCOAL : MUTED }} />
              </span>
              Inventory
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

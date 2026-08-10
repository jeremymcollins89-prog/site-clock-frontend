// geoAutoClock.js
//
// Watches the employee's location while the app is open (foreground or
// backgrounded-but-not-closed) and on every app open/focus, and calls
// autoClockIn / autoClockOut when appropriate.

import { useEffect, useRef, useState } from "react";

const EARTH_RADIUS_M = 6371000;

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isAfterHour(date, hour, minute) {
  return date.getHours() > hour || (date.getHours() === hour && date.getMinutes() >= minute);
}

// Parses a Postgres TIME string like "16:30:00" (or "16:30") into
// { hour, minute }. Falls back to the given default if the value is
// missing or malformed, so a company that hasn't set this yet behaves like
// before.
function parseTimeOfDay(timeStr, defaultHour, defaultMinute) {
  if (typeof timeStr === "string") {
    const match = timeStr.match(/^(\d{1,2}):(\d{2})/);
    if (match) {
      return { hour: Number(match[1]), minute: Number(match[2]) };
    }
  }
  return { hour: defaultHour, minute: defaultMinute };
}

// Manual clock-outs need to stick — an in-memory "did we just arrive" check
// alone isn't enough, since closing and reopening the app (or the phone
// suspending it in the background) resets in-memory state, and the very
// next location reading looks exactly like a fresh arrival even though the
// employee never left. Persisting this in localStorage survives that.
const SUPPRESS_KEY = "site-clock-suppress-auto-clockin";

function isAutoClockInSuppressed() {
  try {
    return localStorage.getItem(SUPPRESS_KEY) === "true";
  } catch {
    return false;
  }
}

function markManualClockOut() {
  try {
    localStorage.setItem(SUPPRESS_KEY, "true");
  } catch {
    // ignore — worst case, auto clock-in behaves as if this flag weren't added
  }
}

function clearAutoClockInSuppression() {
  try {
    localStorage.removeItem(SUPPRESS_KEY);
  } catch {
    // ignore
  }
}

function useGeoAutoClock({ status, locationMode, autoClockIn, autoClockOut, shopLat, shopLng, radiusMeters, clockInTime, clockOutTime, sessionReady, onLeftRangeWhileSuppressed }) {
  const [permission, setPermission] = useState("unknown");
  const [withinRange, setWithinRange] = useState(null);
  const [distanceMeters, setDistanceMeters] = useState(null);
  const [geoError, setGeoError] = useState("");
  const actingRef = useRef(false);
  const watchIdRef = useRef(null);
  // Tracks the previous in-range reading so auto clock-in only fires on a
  // genuine arrival (out-of-range -> in-range), not just "currently in
  // range" — otherwise clocking out manually while still at the shop gets
  // immediately overridden by auto clock-in on the next location check.
  const wasInRangeRef = useRef(false);

  const configured = Number.isFinite(shopLat) && Number.isFinite(shopLng);

  async function evaluate(position) {
    if (!configured) return;
    // Don't evaluate anything until the app has confirmed the real status
    // from the server — right after opening the app there's a brief window
    // where status still holds its stale default, and acting on it here
    // could fire a spurious auto clock-in before the true status loads.
    if (!sessionReady) return;
    // Auto clock-in/out only applies to the "in town" shop crew pattern —
    // someone who's chosen "Traveling" is expected to be away from the
    // shop, so their location shouldn't trigger either rule.
    if (locationMode !== "in_town") return;

    const { latitude, longitude } = position.coords;
    const dist = haversineMeters(latitude, longitude, shopLat, shopLng);
    setDistanceMeters(dist);
    const inRange = dist <= radiusMeters;
    setWithinRange(inRange);

    const justArrived = inRange && !wasInRangeRef.current;
    wasInRangeRef.current = inRange;

    // Once they've actually left the shop, a manual clock-out no longer
    // needs to be protected — the next arrival is a genuine new one.
    if (!inRange && isAutoClockInSuppressed()) {
      clearAutoClockInSuppression();
      // Also tell the server, so the shared, cross-device suppression flag
      // (utils/autoClockinSuppression.js) doesn't stay stuck true for any
      // other client -- e.g. a future native background client -- reading
      // it after this browser tab is closed. Best-effort: this is just
      // keeping the server in sync with what we already decided locally, so
      // a failure here shouldn't block or retry, only get logged.
      if (onLeftRangeWhileSuppressed) {
        Promise.resolve(onLeftRangeWhileSuppressed()).catch(() => {});
      }
    }

    if (actingRef.current) return;
    const now = new Date();

    // Auto clock-in: only on a genuine arrival, and only once the
    // company's configured earliest clock-in time has passed (defaults to
    // midnight, i.e. no restriction, so this behaves exactly like before
    // for any company that hasn't set a real value) — not every time we
    // happen to check while already sitting in range, and never right
    // after a manual clock-out until they've actually left.
    if (justArrived && status === "off" && !isAutoClockInSuppressed()) {
      const { hour: inHour, minute: inMinute } = parseTimeOfDay(clockInTime, 0, 0);
      if (!isAfterHour(now, inHour, inMinute)) return;
      actingRef.current = true;
      try {
        await autoClockIn();
      } finally {
        actingRef.current = false;
      }
    } else if (!inRange && status === "working") {
      const { hour, minute } = parseTimeOfDay(clockOutTime, 16, 30);
      if (!isAfterHour(now, hour, minute)) return;
      actingRef.current = true;
      try {
        await autoClockOut();
      } finally {
        actingRef.current = false;
      }
    }
  }

  function handlePositionError(err) {
    const msg = err.message || "Location error";
    // Chrome's Trusted Web Activity wrapper intermittently fails to hand
    // navigator.geolocation off to the native location service ("no twa
    // found") -- a known, flaky Chromium quirk specific to running inside
    // the wrapped Android app, not an actual location/permission problem.
    // This web-side check is only a backup; native geofencing
    // (GeofenceRegistrar.kt) drives real auto clock-in/out independently
    // and isn't affected by this. Surfacing it as a banner would just
    // cause needless worry over something that isn't actionable.
    if (/no\s*twa\s*found/i.test(msg)) {
      return;
    }
    if (err.code === err.PERMISSION_DENIED) {
      // getCurrentPosition/watchPosition's own PERMISSION_DENIED code is
      // unreliable inside this app's Trusted Web Activity wrapper -- it can
      // fire (with a generic "User denied Geolocation" message, distinct
      // from the "no twa found" quirk above) even when the site's actual
      // permission, per the standalone Permissions API, is still "prompt"
      // (never actually asked) or even already "granted". Cross-check
      // against navigator.permissions.query before flipping the red
      // "location access is off" banner on -- only a state the browser
      // itself confirms as "denied" should trigger it; trusting the raw
      // error code alone produces false alarms for employees who never
      // actually turned location off.
      if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions
          .query({ name: "geolocation" })
          .then((status) => {
            if (status.state === "denied") setPermission("denied");
          })
          .catch(() => {
            // Permissions API itself unavailable -- fall back to trusting
            // the geolocation error code directly, same as before.
            setPermission("denied");
          });
      } else {
        setPermission("denied");
      }
    }
    setGeoError(msg);
  }

  useEffect(() => {
    if (!configured) return;
    if (!("geolocation" in navigator)) {
      setPermission("unsupported");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPermission("granted");
        setGeoError("");
        evaluate(pos);
      },
      handlePositionError,
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 }
    );

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setPermission("granted");
        setGeoError("");
        evaluate(pos);
      },
      handlePositionError,
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 }
    );

    function onVisible() {
      if (document.visibilityState === "visible") {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            setGeoError("");
            evaluate(pos);
          },
          handlePositionError,
          { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
        );
      }
    }
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, configured, locationMode, clockInTime, clockOutTime, sessionReady]);

  return { permission, withinRange, distanceMeters, geoError, configured };
}

export { useGeoAutoClock, haversineMeters, markManualClockOut, clearAutoClockInSuppression };
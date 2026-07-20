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

function useGeoAutoClock({ status, autoClockIn, autoClockOut, shopLat, shopLng, radiusMeters }) {
  const [permission, setPermission] = useState("unknown");
  const [withinRange, setWithinRange] = useState(null);
  const [distanceMeters, setDistanceMeters] = useState(null);
  const [geoError, setGeoError] = useState("");
  const actingRef = useRef(false);
  const watchIdRef = useRef(null);

  const configured = Number.isFinite(shopLat) && Number.isFinite(shopLng);

  async function evaluate(position) {
    if (!configured) return;
    const { latitude, longitude } = position.coords;
    const dist = haversineMeters(latitude, longitude, shopLat, shopLng);
    setDistanceMeters(dist);
    const inRange = dist <= radiusMeters;
    setWithinRange(inRange);

    if (actingRef.current) return;
    const now = new Date();

    if (inRange && status === "off" && isAfterHour(now, 8, 0)) {
      actingRef.current = true;
      try {
        await autoClockIn();
      } finally {
        actingRef.current = false;
      }
    } else if (!inRange && status === "working" && isAfterHour(now, 16, 30)) {
      actingRef.current = true;
      try {
        await autoClockOut();
      } finally {
        actingRef.current = false;
      }
    }
  }

  function handlePositionError(err) {
    if (err.code === err.PERMISSION_DENIED) {
      setPermission("denied");
    }
    setGeoError(err.message || "Location error");
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
        evaluate(pos);
      },
      handlePositionError,
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 }
    );

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setPermission("granted");
        evaluate(pos);
      },
      handlePositionError,
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 }
    );

    function onVisible() {
      if (document.visibilityState === "visible") {
        navigator.geolocation.getCurrentPosition(
          (pos) => evaluate(pos),
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
  }, [status, configured]);

  return { permission, withinRange, distanceMeters, geoError, configured };
}

export { useGeoAutoClock, haversineMeters };
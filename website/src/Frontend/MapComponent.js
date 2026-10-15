import React, { useState, useEffect, useRef } from "react";
import AlertsTable from "./Alerts";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  Polygon,
  useMapEvents,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

// ----------------- Custom Icons -----------------
const vehicleIcon = new L.Icon({
  iconUrl: "https://cdn-icons-png.flaticon.com/512/684/684908.png",
  iconSize: [30, 30],
  iconAnchor: [15, 15],
});

const destIcon = new L.Icon({
  iconUrl: "https://cdn-icons-png.flaticon.com/512/854/854878.png",
  iconSize: [30, 30],
  iconAnchor: [15, 30],
});

function ClickHandler({ onClick }) {
  useMapEvents({
    click(e) {
      onClick(`${e.latlng.lat.toFixed(6)},${e.latlng.lng.toFixed(6)}`);
    },
  });
  return null;
}

// ----------------- Main Map Component -----------------
function MapComponent() {
  const [alerts, setAlerts] = useState([]);
  const [start, setStart] = useState(null);
  const [end, setEnd] = useState(null);
  const [waypoints, setWaypoints] = useState([]);
  const [route, setRoute] = useState(null);
  const [unsafeRoute, setUnsafeRoute] = useState(false);
  const [selecting, setSelecting] = useState(null);
  const [addingWaypoint, setAddingWaypoint] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [showUnsafePrompt, setShowUnsafePrompt] = useState(false);
  const [pendingRoute, setPendingRoute] = useState(null);
  const [vehiclePos, setVehiclePos] = useState(null);
  const [logs, setLogs] = useState([]);
  const [navRunning, setNavRunning] = useState(false);
  const [showAlertsPanel, setShowAlertsPanel] = useState(false);

  const logCooldown = useRef(false);
  const redZoneTimer = useRef(null);

  const redZones = [
    { lat: 28.6139, lon: 77.2090, radius: 700 },
    { lat: 26.8467, lon: 80.9462, radius: 500 },
  ];

  // ----------------- Fetch Alerts -----------------
  useEffect(() => {
    const fetchAlerts = async () => {
      try {
        const isLocal =
          window.location.hostname === "localhost" ||
          window.location.hostname === "127.0.0.1";
        const apiUrl = isLocal
          ? "http://localhost:5000"
          : "https://routeguard.onrender.com";
        const res = await fetch(`${apiUrl}/alerts`);
        const data = await res.json();
        setAlerts(data);
      } catch (err) {
        console.error("Failed to fetch alerts:", err);
      }
    };
    fetchAlerts();
  }, []);

  const getRedZonePolygons = () =>
    redZones.map((zone, idx) => {
      const coords = [];
      const segments = 32;
      for (let i = 0; i < segments; i++) {
        const angle = (i / segments) * 2 * Math.PI;
        const dx =
          (zone.radius * Math.cos(angle)) /
          (111320 * Math.cos((zone.lat * Math.PI) / 180));
        const dy = (zone.radius * Math.sin(angle)) / 111000;
        coords.push([zone.lat + dy, zone.lon + dx]);
      }
      coords.push(coords[0]);
      return (
        <Polygon
          key={idx}
          positions={coords}
          color="red"
          fillColor="#f03"
          fillOpacity={0.4}
        />
      );
    });

  const formatRoute = (osrmData) =>
    osrmData.routes[0].geometry.coordinates.map((c) => [c[1], c[0]]);

  const fetchRoute = async (currentWaypoints, avoidRedZones = false) => {
    if (!start || !end) return alert("Please select a start and end point first.");
    setIsLoading(true);
    setRoute(null);
    setUnsafeRoute(false);

    try {
      const wpParam = currentWaypoints.length
        ? currentWaypoints
            .map((wp) => wp.split(",").reverse().join(","))
            .join(";")
        : "";
      const startParam = start.split(",").reverse().join(",");
      const endParam = end.split(",").reverse().join(",");
      const allCoords = [startParam];
      if (wpParam) allCoords.push(wpParam);
      allCoords.push(endParam);
      const coordStr = allCoords.join(";");

      const isLocal =
        window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1";
      const apiUrl = isLocal
        ? "http://localhost:5000"
        : "https://routeguard.onrender.com";

      let url = `${apiUrl}/route?coords=${coordStr}`;
      if (avoidRedZones) url += "&avoidRedZones=true";

      const res = await fetch(url);
      const data = await res.json();

      if (res.status !== 200 || !data.route || !data.route.routes.length) {
        alert(data.error || "No route found.");
      } else {
        setRoute(formatRoute(data.route));
        setUnsafeRoute(data.unsafe);
        if (data.unsafe && !avoidRedZones) {
          setPendingRoute(data);
          setShowUnsafePrompt(true);
        }
        // Feedback when "Find Safer Route" was used
        if (avoidRedZones && !data.unsafe) {
          alert("✅ Found a safer route that avoids all red zones!");
        } else if (avoidRedZones && data.unsafe) {
          alert("⚠️ Could not find a route that completely avoids the red zone. Showing best alternative.");
        }
      }
    } catch (err) {
      alert("Failed to fetch route from the server.");
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  // ----------------- Unsafe Route Handlers -----------------
  const handleAcceptUnsafe = () => {
    if (pendingRoute) {
      setRoute(formatRoute(pendingRoute.route));
      setUnsafeRoute(true);
      setShowAlertsPanel(true); // ✅ show loitering alerts only after unsafe route
    }
    setShowUnsafePrompt(false);
    setPendingRoute(null);
  };

  const handleFindSafeRoute = () => {
    setShowUnsafePrompt(false);
    setPendingRoute(null);
    fetchRoute(waypoints, true);
  };

  const handleAddWaypointChoice = () => {
    setShowUnsafePrompt(false);
    setPendingRoute(null);
    setAddingWaypoint(true);
  };

  const handleGetRouteClick = () => {
    setWaypoints([]);
    fetchRoute([], false);
  };

  const addWaypointAndRecalculate = (point) => {
    const newWps = [...waypoints, point];
    setWaypoints(newWps);
    setAddingWaypoint(false);
    fetchRoute(newWps, false);
  };

  // ----------------- Stop Navigation -----------------
  const handleStopNavigation = async () => {
    setNavRunning(false);
    setVehiclePos(null);
    setLogs([]);
    setShowAlertsPanel(false);
    // 🔄 Reset database
    const isLocal =
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";
    const apiUrl = isLocal
      ? "http://localhost:5000"
      : "https://routeguard.onrender.com";
    await fetch(`${apiUrl}/reset-alerts`, { method: "DELETE" });
  };

  // ----------------- Vehicle Animation -----------------
  useEffect(() => {
    if (!route || !navRunning) return;
    let i = 0;
    const interval = setInterval(() => {
      if (navRunning && i < route.length) setVehiclePos(route[i++]);
      else clearInterval(interval);
    }, 300);
    return () => clearInterval(interval);
  }, [route, navRunning]);

  // ----------------- Red Zone Detection -----------------
  useEffect(() => {
    if (!vehiclePos) return;
    const inside = redZones.some((zone) => {
      const dist =
        111000 *
        Math.sqrt(
          Math.pow(vehiclePos[0] - zone.lat, 2) +
            Math.pow(
              (vehiclePos[1] - zone.lon) * Math.cos((zone.lat * Math.PI) / 180),
              2
            )
        );
      return dist < zone.radius;
    });
    if (inside && !logCooldown.current) {
      setLogs((l) => [...l, `⏰ ENTER red zone at ${new Date().toLocaleTimeString()}`]);
      logCooldown.current = true;
      if (!redZoneTimer.current) {
        redZoneTimer.current = setTimeout(
          () => alert("⚠ Vehicle in red zone for 10s. Informing authorities..."),
          10000
        );
      }
      setTimeout(() => {
        logCooldown.current = false;
      }, 2000);
    }
    if (!inside && redZoneTimer.current) {
      clearTimeout(redZoneTimer.current);
      redZoneTimer.current = null;
      setLogs((l) => [...l, `✅ EXIT red zone at ${new Date().toLocaleTimeString()}`]);
    }
  }, [vehiclePos]);

  return (
    <div style={{ display: "flex", height: "100vh", width: "100%" }}>
      {/* ------------ Map Section ------------ */}
      <div style={{ flex: 3, position: "relative" }}>
        {isLoading && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              background: "rgba(0,0,0,0.7)",
              zIndex: 1999,
              color: "white",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <h2>Calculating Route...</h2>
          </div>
        )}

        {showUnsafePrompt && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              background: "rgba(0,0,0,0.7)",
              zIndex: 1999,
              color: "white",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div
              style={{
                background: "#333",
                padding: "20px 40px",
                borderRadius: "8px",
                textAlign: "center",
                border: "1px solid #555",
              }}
            >
              <h3>⚠️ Unsafe Route Detected</h3>
              <p>The fastest route passes through a designated red zone.</p>
              <div
                style={{
                  marginTop: "20px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                }}
              >
                <button
                  onClick={handleAcceptUnsafe}
                  style={{
                    padding: "12px",
                    background: "#c82333",
                    color: "white",
                    border: "none",
                    cursor: "pointer",
                    fontSize: "16px",
                  }}
                >
                  Accept Unsafe Route
                </button>
                <button
                  onClick={handleFindSafeRoute}
                  style={{
                    padding: "12px",
                    background: "#218838",
                    color: "white",
                    border: "none",
                    cursor: "pointer",
                    fontSize: "16px",
                  }}
                >
                  Find Safer Route
                </button>
                <button
                  onClick={handleAddWaypointChoice}
                  style={{
                    padding: "12px",
                    background: "#0069d9",
                    color: "white",
                    border: "none",
                    cursor: "pointer",
                    fontSize: "16px",
                  }}
                >
                  Add Waypoint to Avoid
                </button>
              </div>
            </div>
          </div>
        )}

        <MapContainer
          center={[27.5, 79]}
          zoom={6}
          style={{ height: "100%", width: "100%" }}
        >
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          {getRedZonePolygons()}
          {route && (
            <Polyline
              positions={route}
              color={unsafeRoute ? "orange" : "blue"}
              weight={5}
            />
          )}
          {start && <Marker position={start.split(",").map(Number)} icon={destIcon} />}
          {end && <Marker position={end.split(",").map(Number)} icon={destIcon} />}
          {waypoints.map((wp, idx) => (
            <Marker key={idx} position={wp.split(",").map(Number)} />
          ))}
          {vehiclePos && <Marker position={vehiclePos} icon={vehicleIcon} />}
          {selecting && (
            <ClickHandler
              onClick={(point) => {
                if (selecting === "start") setStart(point);
                if (selecting === "end") setEnd(point);
                setSelecting(null);
              }}
            />
          )}
          {addingWaypoint && <ClickHandler onClick={addWaypointAndRecalculate} />}
        </MapContainer>
      </div>

      {/* ------------ Control + Alerts Panel ------------ */}
      <div
        style={{
          flex: 1.2,
          padding: "15px",
          background: "#f8f9fa",
          borderLeft: "1px solid #ccc",
          overflowY: "auto",
        }}
      >
        <h3 style={{ marginBottom: "10px" }}>Route Controls</h3>
        <p><strong>Start:</strong> {start || "Not set"}</p>
        <p><strong>End:</strong> {end || "Not set"}</p>

        <button onClick={() => setSelecting("start")} style={{ marginRight: 5 }}>
          Set Start
        </button>
        <button onClick={() => setSelecting("end")}>Set End</button>

        <button
  onClick={handleGetRouteClick}
  style={{
    width: "100%",
    padding: 8,
    marginTop: 10,
    background: "#007bff",
    color: "white",
    border: "none",
  }}
  disabled={isLoading || !start || !end}
>
  {isLoading ? "Calculating..." : "Get Route"}
</button>

<button
  onClick={() => setNavRunning(true)}
  style={{
    width: "100%",
    padding: 8,
    marginTop: 5,
    background: "#28a745",
    color: "white",
    border: "none",
  }}
  disabled={!route}
>
  Start Navigation
</button>

<button
  onClick={handleStopNavigation}
  style={{
    width: "100%",
    padding: 8,
    marginTop: 5,
    background: "#dc3545",
    color: "white",
    border: "none",
  }}
>
  Stop Navigation
</button>

        <div
          style={{
            marginTop: 10,
            fontSize: "12px",
            maxHeight: 150,
            overflow: "auto",
          }}
        >
          <b>Logs:</b>
          <ul>{logs.map((log, idx) => (<li key={idx}>{log}</li>))}</ul>
        </div>

        {showAlertsPanel && (
          <div style={{ marginTop: 20 }}>
            <AlertsTable alerts={alerts} />
          </div>
        )}
      </div>
    </div>
  );
}

export default MapComponent;

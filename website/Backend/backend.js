import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { MongoClient, ServerApiVersion } from "mongodb"; // Import MongoDB client

const app = express();
app.use(cors());

// --- MongoDB Setup ---
const MONGO_URI = "mongodb+srv://namansrivastava1608_db_user:E2ulW2JnArL1aI7Q@loitering.rahlbgp.mongodb.net/?appName=loitering";
const client = new MongoClient(MONGO_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let alertsCollection; // Variable to hold the collection reference

// --- Connect to MongoDB and start the server ---
async function run() {
  try {
    // Connect the client to the server
    await client.connect();
    // Access the database and collection
    const db = client.db("loitering_db");
    alertsCollection = db.collection("alerts");
    console.log("✅ Successfully connected to MongoDB Atlas!");

    // Start the Express server only after the DB connection is successful
    app.listen(5000, () => console.log("🚀 Backend running on http://localhost:5000"));

  } catch (err) {
    console.error("❌ MongoDB connection failed:", err);
    process.exit(1); // Exit if DB connection fails
  }
}

run().catch(console.dir);


// 🚫 Define restricted areas (red zones)
const redZones = [
 { lat: 28.6139, lon: 77.2090, radius: 700 }, // Delhi
 { lat: 26.8467, lon: 80.9462, radius: 500 }, // Lucknow
];

const R = 6378137; // Earth's radius (m)
const toRad = deg => deg * Math.PI / 180;

// ---------------- Distance + Red Zone Checks ----------------

function distance(lat1, lon1, lat2, lon2) {
 const φ1 = toRad(lat1), φ2 = toRad(lat2);
 const Δλ = toRad(lon2 - lon1);
 return Math.acos(Math.sin(φ1) * Math.sin(φ2) +
   Math.cos(φ1) * Math.cos(φ2) * Math.cos(Δλ)) * R;
}

function inRedZone(lat, lon) {
 return redZones.some(zone => distance(lat, lon, zone.lat, zone.lon) < zone.radius);
}

function routeUnsafe(route) {
 return route.geometry.coordinates.some(([lon, lat]) => inRedZone(lat, lon));
}

// ---------------- Helper: Snap Point to Nearest Road ----------------

async function snapToRoad(lon, lat) {
 try {
   const res = await fetch(`https://router.project-osrm.org/nearest/v1/driving/${lon},${lat}`);
   const data = await res.json();
   if (data.code === "Ok" && data.waypoints?.length > 0) {
     return data.waypoints[0].location; // [lon, lat]
   }
   console.warn("Snap failed, using original point");
   return [lon, lat];
 } catch (err) {
   console.error("Snap to road error:", err);
   return [lon, lat];
 }
}

// ---------------- Routes ----------------

app.get("/", (req, res) => {
 res.send("✅ Backend is running");
});

// ⭐️ --- NEW ROUTE TO GET LOITERING ALERTS --- ⭐️
app.get("/alerts", async (req, res) => {
  if (!alertsCollection) {
    return res.status(503).json({ error: "Database not connected" });
  }
  try {
    // Find all documents and sort by timestamp in descending order (newest first)
    const alerts = await alertsCollection.find({}).sort({ timestamp: -1 }).toArray();
    res.json(alerts);
  } catch (err) {
    console.error("Failed to fetch alerts:", err);
    res.status(500).json({ error: "Failed to fetch alerts from database." });
  }
});
// 🧹 Reset all alerts in DB
app.delete("/reset-alerts", async (req, res) => {
  try {
    await alertsCollection.deleteMany({});
    res.json({ message: "All alerts reset successfully." });
  } catch (err) {
    console.error("Failed to reset alerts:", err);
    res.status(500).json({ error: "Failed to reset alerts." });
  }
});


// Check if a given point lies inside a red zone
app.get("/check", (req, res) => {
 const { lat, lon } = req.query;
 if (!lat || !lon)
   return res.status(400).json({ error: "Missing lat/lon" });

 res.json({ inRedZone: inRedZone(parseFloat(lat), parseFloat(lon)) });
});

// ---------------- Red Zone Avoidance Helpers ----------------

/**
 * Given a route's coordinates, find which red zones it crosses
 * and generate ARC waypoints well outside each zone boundary
 * so OSRM is forced to route completely around the zone.
 */
function computeArcWaypoints(routeCoords) {
  const allDetours = []; // { zoneIdx, waypoints: [{lon, lat}] }

  for (let zi = 0; zi < redZones.length; zi++) {
    const zone = redZones[zi];

    // Find first and last coordinate inside this zone
    let entryIdx = -1;
    let exitIdx = -1;

    for (let i = 0; i < routeCoords.length; i++) {
      const [lon, lat] = routeCoords[i];
      const d = distance(lat, lon, zone.lat, zone.lon);
      if (d < zone.radius) {
        if (entryIdx === -1) entryIdx = i;
        exitIdx = i;
      }
    }

    if (entryIdx === -1) continue; // Route doesn't cross this zone

    // Get points just outside entry and exit
    const beforeIdx = Math.max(0, entryIdx - 1);
    const afterIdx = Math.min(routeCoords.length - 1, exitIdx + 1);

    const [lonEntry, latEntry] = routeCoords[beforeIdx];
    const [lonExit, latExit] = routeCoords[afterIdx];

    // Compute angles from zone center to entry and exit points
    const entryAngle = Math.atan2(latEntry - zone.lat, lonEntry - zone.lon);
    const exitAngle = Math.atan2(latExit - zone.lat, lonExit - zone.lon);

    // We'll generate arc waypoints going around the zone.
    // Choose the arc direction (clockwise vs counterclockwise) that
    // goes the "long way" around — away from the zone center.
    // We pick the arc that does NOT cross through the zone interior.

    // Compute the midpoint of the route inside the zone to determine
    // which side the route passes through
    const midInsideIdx = Math.floor((entryIdx + exitIdx) / 2);
    const [lonMid, latMid] = routeCoords[midInsideIdx];
    const midAngle = Math.atan2(latMid - zone.lat, lonMid - zone.lon);

    // Normalize angle difference
    function normalizeAngle(a) {
      while (a < -Math.PI) a += 2 * Math.PI;
      while (a > Math.PI) a -= 2 * Math.PI;
      return a;
    }

    // Determine arc sweep from entry to exit
    let sweepCW = normalizeAngle(exitAngle - entryAngle); // clockwise
    if (sweepCW < 0) sweepCW += 2 * Math.PI;

    let sweepCCW = 2 * Math.PI - sweepCW; // counterclockwise

    // Check which arc the midpoint falls on
    const midDiff = normalizeAngle(midAngle - entryAngle);
    const midDiffPositive = midDiff < 0 ? midDiff + 2 * Math.PI : midDiff;

    // If the midpoint is on the CW arc (0 to sweepCW), we want the CCW arc (the other way)
    const goClockwise = midDiffPositive > sweepCW;
    const arcSweep = goClockwise ? sweepCW : sweepCCW;
    const direction = goClockwise ? 1 : -1;

    // Generate arc waypoints at radius * 1.8 (well outside the zone)
    // Use enough points to create a proper corridor
    const arcRadius = zone.radius * 1.8;
    const numWaypoints = Math.max(4, Math.ceil(Math.abs(arcSweep) / (Math.PI / 6))); // ~every 30°

    const degPerMeterLat = 1 / 111000;
    const degPerMeterLon = 1 / (111320 * Math.cos(toRad(zone.lat)));

    const arcPoints = [];

    for (let i = 0; i <= numWaypoints; i++) {
      const t = i / numWaypoints;
      const angle = entryAngle + direction * arcSweep * t;

      const wpLon = zone.lon + arcRadius * Math.cos(angle) * degPerMeterLon;
      const wpLat = zone.lat + arcRadius * Math.sin(angle) * degPerMeterLat;

      // Verify this point is actually outside ALL red zones
      let outsideAll = true;
      for (const z of redZones) {
        if (distance(wpLat, wpLon, z.lat, z.lon) < z.radius * 1.2) {
          outsideAll = false;
          break;
        }
      }
      if (outsideAll) {
        arcPoints.push({ lon: wpLon, lat: wpLat });
      }
    }

    if (arcPoints.length > 0) {
      allDetours.push({
        zoneIdx: zi,
        entryCoord: { lon: lonEntry, lat: latEntry },
        exitCoord: { lon: lonExit, lat: latExit },
        waypoints: arcPoints,
      });
    }
  }

  return allDetours;
}

async function fetchOSRMRoute(coordString) {
  const url = `https://router.project-osrm.org/route/v1/driving/${coordString}?overview=full&geometries=geojson`;
  const response = await fetch(url);
  return response.json();
}

// Core: Get route between coordinates, detect safety
app.get("/route", async (req, res) => {
 const { coords, avoidRedZones } = req.query;
 if (!coords) return res.status(400).json({ error: "Coordinates are missing" });

 try {
   const rawPoints = coords.split(";").map(p => p.split(",").map(Number));

   // Snap each to nearest road
   const snappedPoints = await Promise.all(
     rawPoints.map(([lon, lat]) => snapToRoad(lon, lat))
   );

   const coordString = snappedPoints.map(([lon, lat]) => `${lon},${lat}`).join(";");

   // Fetch the initial route
   let data = await fetchOSRMRoute(coordString);

   if (!data.routes || data.routes.length === 0)
     return res.status(404).json({ error: "No route found" });

   let route = data.routes[0];
   let unsafe = routeUnsafe(route);

   // --- Active red zone avoidance via arc waypoints ---
   if (avoidRedZones === "true" && unsafe) {
     console.log("🛡️ Attempting to find a route that avoids red zones...");

     const MAX_ATTEMPTS = 4;

     for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
       const detourSets = computeArcWaypoints(route.geometry.coordinates);

       if (detourSets.length === 0) {
         console.log("  No zone crossings detected, done.");
         break;
       }

       // Build the new waypoint list: start → arc waypoints → end
       const newPoints = [snappedPoints[0]]; // start [lon, lat]

       for (const detour of detourSets) {
         // Add the entry point (just before zone)
         newPoints.push([detour.entryCoord.lon, detour.entryCoord.lat]);

         // Add all arc waypoints (snapped to roads)
         for (const wp of detour.waypoints) {
           const snapped = await snapToRoad(wp.lon, wp.lat);
           // Double-check snapped point is outside all red zones
           const [sLon, sLat] = snapped;
           let outsideAll = true;
           for (const z of redZones) {
             if (distance(sLat, sLon, z.lat, z.lon) < z.radius) {
               outsideAll = false;
               break;
             }
           }
           if (outsideAll) {
             newPoints.push(snapped);
           } else {
             console.warn(`    Skipping snapped point inside red zone: ${sLat},${sLon}`);
           }
         }

         // Add the exit point (just after zone)
         newPoints.push([detour.exitCoord.lon, detour.exitCoord.lat]);
       }

       newPoints.push(snappedPoints[snappedPoints.length - 1]); // end

       // De-duplicate consecutive identical points
       const dedupedPoints = [newPoints[0]];
       for (let i = 1; i < newPoints.length; i++) {
         const prev = dedupedPoints[dedupedPoints.length - 1];
         if (Math.abs(newPoints[i][0] - prev[0]) > 0.00001 ||
             Math.abs(newPoints[i][1] - prev[1]) > 0.00001) {
           dedupedPoints.push(newPoints[i]);
         }
       }

       const newCoordString = dedupedPoints.map(([lon, lat]) => `${lon},${lat}`).join(";");
       console.log(`  Attempt ${attempt + 1}: trying route with ${dedupedPoints.length} waypoints`);

       const newData = await fetchOSRMRoute(newCoordString);

       if (!newData.routes || newData.routes.length === 0) {
         console.warn(`  Attempt ${attempt + 1}: OSRM returned no route, keeping previous`);
         break;
       }

       const newRoute = newData.routes[0];
       const stillUnsafe = routeUnsafe(newRoute);

       // Accept this new route
       data = newData;
       route = newRoute;
       unsafe = stillUnsafe;

       if (!stillUnsafe) {
         console.log(`  ✅ Found safe route on attempt ${attempt + 1}!`);
         break;
       }

       console.log(`  Attempt ${attempt + 1}: still crosses a red zone, retrying with tighter arc...`);
       // On next iteration, computeArcWaypoints will re-analyze the new route
     }

     if (unsafe) {
       console.warn("  ⚠️ Could not fully avoid all red zones after all attempts");
     }
   }

   res.json({
     route: data,
     unsafe,
     message: unsafe
       ? "⚠️ This route passes through a red zone."
       : "✅ Safe route.",
   });

 } catch (err) {
   console.error("Route fetch error:", err);
   res.status(500).json({ error: "Failed to process route." });
 }
});

// The app.listen() call is now inside the run() function

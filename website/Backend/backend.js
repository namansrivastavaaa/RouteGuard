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
 const p1 = toRad(lat1), p2 = toRad(lat2);
 const dL = toRad(lon2 - lon1);
 return Math.acos(
   Math.min(1, Math.max(-1, Math.sin(p1) * Math.sin(p2) +
   Math.cos(p1) * Math.cos(p2) * Math.cos(dL)))
 ) * R;
}

function inRedZone(lat, lon) {
 return redZones.some(zone => distance(lat, lon, zone.lat, zone.lon) < zone.radius);
}

// Safety buffer multiplier — catches routes that barely clip the zone edge
const SAFETY_BUFFER = 1.08;

function inRedZoneWithBuffer(lat, lon) {
  return redZones.some(zone => distance(lat, lon, zone.lat, zone.lon) < zone.radius * SAFETY_BUFFER);
}

function routeUnsafe(route) {
 return route.geometry.coordinates.some(([lon, lat]) => inRedZone(lat, lon));
}

function routeUnsafeWithBuffer(route) {
  return route.geometry.coordinates.some(([lon, lat]) => inRedZoneWithBuffer(lat, lon));
}

// Thorough safety check: checks all route points + interpolated points along segments
function routeUnsafeDetailed(route) {
  const coords = route.geometry.coordinates;
  for (let i = 0; i < coords.length; i++) {
    const [lon, lat] = coords[i];
    if (inRedZoneWithBuffer(lat, lon)) return true;

    // Check intermediate points on segments
    if (i < coords.length - 1) {
      const [lon2, lat2] = coords[i + 1];
      const segDist = distance(lat, lon, lat2, lon2);
      if (segDist > 40) {
        const steps = Math.min(10, Math.ceil(segDist / 40));
        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          const iLat = lat + t * (lat2 - lat);
          const iLon = lon + t * (lon2 - lon);
          if (inRedZoneWithBuffer(iLat, iLon)) return true;
        }
      }
    }
  }
  return false;
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
 * Generate candidate bypass waypoints around a red zone given start and end points.
 * Evaluates both left and right sides of the zone at multiple offset distances,
 * using both single perpendicular waypoints and 2-waypoint tangent corridors.
 */
function generateBypassCandidates(start, end, zone) {
  const [sLon, sLat] = start;
  const [eLon, eLat] = end;

  const cosLat = Math.cos(toRad(zone.lat));
  const dx = (eLon - sLon) * 111320 * cosLat;
  const dy = (eLat - sLat) * 111000;
  const len = Math.hypot(dx, dy) || 1;

  // Unit vector along the travel direction
  const ux = dx / len;
  const uy = dy / len;

  // Conversion factors
  const degPerMLat = 1 / 111000;
  const degPerMLon = 1 / (111320 * cosLat);

  const candidates = [];
  const multipliers = [1.3, 1.6, 2.0, 2.5, 3.0];

  for (const mult of multipliers) {
    const dist = zone.radius * mult;

    // Perpendicular waypoints (left and right of travel vector)
    const leftLon = zone.lon + (-uy * dist) * degPerMLon;
    const leftLat = zone.lat + (ux * dist) * degPerMLat;
    const rightLon = zone.lon + (uy * dist) * degPerMLon;
    const rightLat = zone.lat + (-ux * dist) * degPerMLat;

    // 2-waypoint tangent corridor points (leading in and leading out around the zone)
    const alongOffset = dist * 0.7;
    const l1 = [leftLon - (ux * alongOffset) * degPerMLon, leftLat - (uy * alongOffset) * degPerMLat];
    const l2 = [leftLon + (ux * alongOffset) * degPerMLon, leftLat + (uy * alongOffset) * degPerMLat];
    const r1 = [rightLon - (ux * alongOffset) * degPerMLon, rightLat - (uy * alongOffset) * degPerMLat];
    const r2 = [rightLon + (ux * alongOffset) * degPerMLon, rightLat + (uy * alongOffset) * degPerMLat];

    // Single perpendicular waypoint candidates
    candidates.push({ name: `Left 1-wp x${mult}`, wps: [[leftLon, leftLat]] });
    candidates.push({ name: `Right 1-wp x${mult}`, wps: [[rightLon, rightLat]] });

    // 2-waypoint corridor candidates (forces smooth road bypass)
    candidates.push({ name: `Left corridor x${mult}`, wps: [l1, l2] });
    candidates.push({ name: `Right corridor x${mult}`, wps: [r1, r2] });
  }

  return candidates;
}

async function fetchOSRMRoute(coordString) {
  const url = `https://router.project-osrm.org/route/v1/driving/${coordString}?overview=full&geometries=geojson`;
  const response = await fetch(url);
  return response.json();
}

// Helper: extract route stats
function getRouteStats(route) {
  return {
    distance: route.distance,
    duration: route.duration,
    distanceKm: (route.distance / 1000).toFixed(1),
    durationMin: (route.duration / 60).toFixed(1),
  };
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
   let unsafe = routeUnsafeDetailed(route);

   // Save original route stats for comparison
   const originalStats = getRouteStats(route);

   // --- Active red zone avoidance: evaluate candidate bypasses in parallel ---
   if (avoidRedZones === "true" && unsafe) {
     console.log("🛡️ Finding optimal bypass route to avoid red zones...");

     // Identify all red zones that this route penetrates
     const penetratedZones = redZones.filter(zone =>
       route.geometry.coordinates.some(([lon, lat]) =>
         distance(lat, lon, zone.lat, zone.lon) < zone.radius * SAFETY_BUFFER
       )
     );

     console.log(`  Route penetrates ${penetratedZones.length} red zone(s)`);

     const startPt = snappedPoints[0];
     const endPt = snappedPoints[snappedPoints.length - 1];

     let bestSafeCandidate = null;
     let bestCandidateData = null;

     for (const zone of penetratedZones) {
       const candidates = generateBypassCandidates(startPt, endPt, zone);

       // Query all candidate routes concurrently
       const promises = candidates.map(async (c) => {
         try {
           let fullPoints;
           if (snappedPoints.length <= 2) {
             fullPoints = [startPt, ...c.wps, endPt];
           } else {
             // If user added intermediate waypoints, find segment closest to zone
             let bestSegIdx = 0;
             let minSegDist = Infinity;
             for (let i = 0; i < snappedPoints.length - 1; i++) {
               const midLat = (snappedPoints[i][1] + snappedPoints[i + 1][1]) / 2;
               const midLon = (snappedPoints[i][0] + snappedPoints[i + 1][0]) / 2;
               const d = distance(midLat, midLon, zone.lat, zone.lon);
               if (d < minSegDist) {
                 minSegDist = d;
                 bestSegIdx = i;
               }
             }
             fullPoints = [
               ...snappedPoints.slice(0, bestSegIdx + 1),
               ...c.wps,
               ...snappedPoints.slice(bestSegIdx + 1),
             ];
           }

           const cCoordStr = fullPoints
             .map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`)
             .join(";");

           const resData = await fetchOSRMRoute(cCoordStr);
           if (!resData.routes || resData.routes.length === 0) return null;

           const candRoute = resData.routes[0];
           const isUnsafe = routeUnsafeDetailed(candRoute);

           return {
             name: c.name,
             data: resData,
             route: candRoute,
             unsafe: isUnsafe,
             distance: candRoute.distance,
             duration: candRoute.duration,
           };
         } catch (e) {
           return null;
         }
       });

       const evaluated = (await Promise.all(promises)).filter(Boolean);
       const safeOnes = evaluated.filter(r => !r.unsafe);

       console.log(`  Zone at [${zone.lat}, ${zone.lon}]: ${evaluated.length} candidates tested, ${safeOnes.length} safe`);

       if (safeOnes.length > 0) {
         // Sort by shortest distance — find the minimal detour
         safeOnes.sort((a, b) => a.distance - b.distance);
         if (!bestSafeCandidate || safeOnes[0].distance < bestSafeCandidate.distance) {
           bestSafeCandidate = safeOnes[0];
         }
       } else if (!bestSafeCandidate && evaluated.length > 0) {
         // Fallback: pick candidate furthest from zone center
         evaluated.sort((a, b) => {
           const minA = Math.min(...a.route.geometry.coordinates.map(([lon, lat]) => distance(lat, lon, zone.lat, zone.lon)));
           const minB = Math.min(...b.route.geometry.coordinates.map(([lon, lat]) => distance(lat, lon, zone.lat, zone.lon)));
           return minB - minA; // furthest is best
         });
         bestCandidateData = evaluated[0];
       }
     }

     if (bestSafeCandidate) {
       data = bestSafeCandidate.data;
       route = bestSafeCandidate.route;
       unsafe = false;
       console.log(`  ✅ Optimal safe detour chosen (${bestSafeCandidate.name}): ${(route.distance / 1000).toFixed(2)} km, ${(route.duration / 60).toFixed(1)} min`);
     } else if (bestCandidateData) {
       data = bestCandidateData.data;
       route = bestCandidateData.route;
       unsafe = bestCandidateData.unsafe;
       console.warn(`  ⚠️ Best available candidate: ${(route.distance / 1000).toFixed(2)} km (unsafe: ${unsafe})`);
     }
   }

   // Build response with route comparison stats
   const currentStats = getRouteStats(route);
   const responseData = {
     route: data,
     unsafe,
     message: unsafe
       ? "⚠️ This route passes through a red zone."
       : "✅ Safe route.",
     stats: {
       original: originalStats,
       current: currentStats,
     },
   };

   // Add reroute info if we successfully rerouted
   if (avoidRedZones === "true") {
     const extraDist = (currentStats.distance - originalStats.distance) / 1000;
     const extraTime = (currentStats.duration - originalStats.duration) / 60;
     responseData.rerouted = true;
     responseData.rerouteInfo = {
       extraDistanceKm: extraDist.toFixed(1),
       extraTimeMin: extraTime.toFixed(1),
       message: `Detour adds ${Math.abs(extraDist).toFixed(1)} km and ${Math.abs(extraTime).toFixed(1)} min`,
     };
   }

   res.json(responseData);

 } catch (err) {
   console.error("Route fetch error:", err);
   res.status(500).json({ error: "Failed to process route." });
 }
});

// The app.listen() call is now inside the run() function

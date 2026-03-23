import "maplibre-gl/dist/maplibre-gl.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Map, { Layer, Source, type MapRef } from "react-map-gl/maplibre";
import type { ExpressionSpecification } from "maplibre-gl";
import type { Feature, FeatureCollection, Point, Position } from "geojson";

type ViewBounds = {
  west: number;
  east: number;
  south: number;
  north: number;
};

const updateFrameIndex = (index: number) => {
  if (index < 0) return NUM_FRAMES - 1;
  if (index > NUM_FRAMES - 1) return 0;
  return index;
};

const NUM_POINTS = 2000;
const TARGET_UPS = 20;
const TARGET_FRAMETIME = 1_000 / TARGET_UPS; // 20 updates per second
const NUM_FRAMES = 19;
const DELTA_TIME = 10 * 60 * 1_000; // 10 minutes in milliseconds
const currentTime = new Date().getTime();

const buildValidValueExpression = (
  property: string,
): ExpressionSpecification => {
  const cases: ExpressionSpecification[] = [];

  for (let idx = NUM_FRAMES - 1; idx >= 0; idx--) {
    cases.push(
      [
        "all",
        [">", ["length", ["var", "times"]], idx],
        [">", ["length", ["var", "values"]], idx],
        ["<=", ["at", idx, ["var", "times"]], ["var", "targetTime"]],
      ],
      ["at", idx, ["var", "values"]],
    );
  }

  return [
    "let",
    "targetTime",
    ["to-number", ["global-state", "currentTime"], new Date().getTime()],
    [
      "let",
      "times",
      ["get", "times"],
      ["let", "values", ["get", property], ["case", ...cases, null]],
    ],
  ] as unknown as ExpressionSpecification;
};

const sfcPlotText = (property: string): ExpressionSpecification =>
  [
    "let",
    "value",
    buildValidValueExpression(property),
    [
      "case",
      ["!=", ["var", "value"], null],
      ["to-string", ["var", "value"]],
      "",
    ],
  ] as unknown as ExpressionSpecification;

const sfcPlotNumber = (
  property: string,
  fallback: number,
): ExpressionSpecification =>
  [
    "to-number",
    [
      "let",
      "value",
      buildValidValueExpression(property),
      ["case", ["!=", ["var", "value"], null], ["var", "value"], fallback],
    ],
    fallback,
  ] as unknown as ExpressionSpecification;

function App() {
  const [zoom, setZoom] = useState<number>();
  const [frameIndex, setFrameIndex] = useState(0);
  const [animate, setAnimate] = useState(false);
  const [mode, setMode] = useState<"nested" | "flat">("nested");
  const [requestedUps, setRequestedUps] = useState(0);
  const [presentedUps, setPresentedUps] = useState(0);
  const [avgPresentedUps, setAvgPresentedUps] = useState(0);
  const [viewBounds, setViewBounds] = useState<ViewBounds | null>(null);

  const mapRef = useRef<MapRef | null>(null);
  const updateVersionRef = useRef(0);
  const lastPresentedVersionRef = useRef(0);
  const requestedCountRef = useRef(0);
  const presentedCountRef = useRef(0);
  const presentedAverageSamplesRef = useRef(0);
  const presentedAverageTotalRef = useRef(0);

  const timeStamps = useMemo(() => {
    const times = [];

    for (let i = NUM_FRAMES - 1; i >= 0; i--) {
      times.push(currentTime - i * DELTA_TIME);
    }

    return times;
  }, []);

  useEffect(() => {
    const mapInstance = mapRef.current;
    if (!mapInstance) return;

    mapInstance.setGlobalStateProperty("currentTime", timeStamps[frameIndex]);
  }, [timeStamps, frameIndex]);

  const stepTime = useCallback((delta: number) => {
    setFrameIndex((prev) => updateFrameIndex(prev + delta));
    updateVersionRef.current += 1;
    requestedCountRef.current += 1;
  }, []);

  useEffect(() => {
    if (!animate) {
      return;
    }

    const interval = setInterval(() => {
      stepTime(1);
    }, TARGET_FRAMETIME);

    return () => {
      clearInterval(interval);
    };
  }, [animate, stepTime]);

  useEffect(() => {
    const sampleWindowMs = 1000;

    const sampleInterval = setInterval(() => {
      const currentRequestedUps = requestedCountRef.current;
      const currentPresentedUps = presentedCountRef.current;

      setRequestedUps(currentRequestedUps);
      setPresentedUps(currentPresentedUps);

      presentedAverageSamplesRef.current += 1;
      presentedAverageTotalRef.current += currentPresentedUps;
      setAvgPresentedUps(
        presentedAverageTotalRef.current / presentedAverageSamplesRef.current,
      );

      requestedCountRef.current = 0;
      presentedCountRef.current = 0;
    }, sampleWindowMs);

    return () => {
      clearInterval(sampleInterval);
    };
  }, []);

  const onMapRender = useCallback(() => {
    if (updateVersionRef.current !== lastPresentedVersionRef.current) {
      presentedCountRef.current += 1;
      lastPresentedVersionRef.current = updateVersionRef.current;
    }
  }, []);

  const updateViewBounds = useCallback(() => {
    const mapInstance = mapRef.current;
    if (!mapInstance) return;

    const currentZoom = mapInstance.getZoom();

    setZoom(currentZoom);

    const bounds = mapInstance.getBounds();
    const nextBounds: ViewBounds = {
      west: bounds.getWest(),
      east: bounds.getEast(),
      south: bounds.getSouth(),
      north: bounds.getNorth(),
    };

    setViewBounds((prev) => {
      if (
        prev &&
        prev.west === nextBounds.west &&
        prev.east === nextBounds.east &&
        prev.south === nextBounds.south &&
        prev.north === nextBounds.north
      ) {
        return prev;
      }
      return nextBounds;
    });
  }, []);

  const resetBenchmark = useCallback((play: boolean = false) => {
    setAnimate(play);
    setAvgPresentedUps(0);
    lastPresentedVersionRef.current = updateVersionRef.current;
    presentedAverageSamplesRef.current = 0;
    presentedAverageTotalRef.current = 0;
  }, []);

  const makeFeatures = useCallback(
    (count: number, mode: "nested" | "flat"): Feature<Point>[] => {
      const features: Feature<Point>[] = [];
      for (let i = 0; i < count; i++) {
        const coords: Position = [
          Math.random() * 360 - 180,
          Math.random() * 180 - 90,
        ];

        for (let j = 0; j < (mode === "nested" ? 1 : NUM_FRAMES - 1); j++) {
          features.push({
            type: "Feature",
            geometry: {
              type: "Point",
              coordinates: coords,
            },
            properties:
              mode === "nested"
                ? {
                    siteId: i,
                    times: timeStamps,
                    mslp: timeStamps.map(() => Math.round(Math.random() * 100)),
                    tt: timeStamps.map(() => Math.round(Math.random() * 100)),
                    td: timeStamps.map(() => Math.round(Math.random() * 100)),
                    cig: timeStamps.map(() => Math.round(Math.random() * 100)),
                    vis: timeStamps.map(() => Math.round(Math.random() * 100)),
                    windDir: timeStamps.map(() =>
                      Math.round(Math.random() * 100),
                    ),
                    windSpd: timeStamps.map(() =>
                      Math.round(Math.random() * 100),
                    ),
                    windGust: timeStamps.map(() =>
                      Math.round(Math.random() * 100),
                    ),
                  }
                : {
                    siteId: i,
                    times: timeStamps[j],
                    mslp: Math.round(Math.random() * 100),
                    tt: Math.round(Math.random() * 100),
                    td: Math.round(Math.random() * 100),
                    cig: Math.round(Math.random() * 100),
                    vis: Math.round(Math.random() * 100),
                    windDir: Math.round(Math.random() * 100),
                    windSpd: Math.round(Math.random() * 100),
                    windGust: Math.round(Math.random() * 100),
                  },
          });
        }
      }
      return features;
    },
    [timeStamps],
  );

  const nestedFeatures = useMemo(
    () => makeFeatures(NUM_POINTS, "nested"),
    [makeFeatures],
  );
  const flatFeatures = useMemo(
    () => makeFeatures(NUM_POINTS, "flat"),
    [makeFeatures],
  );

  const nestedGeoJSON: FeatureCollection<Point> = useMemo(
    () => ({
      type: "FeatureCollection",
      features: nestedFeatures,
    }),
    [nestedFeatures],
  );

  const flatGeoJSON: FeatureCollection<Point> = useMemo(() => {
    const features = flatFeatures.reduce<Feature<Point>[]>((acc, feature) => {
      if (!feature.properties) return acc;

      if (feature.properties.times !== timeStamps[frameIndex]) return acc;

      acc.push(feature);

      return acc;
    }, []);
    return {
      type: "FeatureCollection",
      features,
    };
  }, [flatFeatures, timeStamps, frameIndex]);

  const activeGeoJSON: FeatureCollection<Point> =
    mode === "nested" ? nestedGeoJSON : flatGeoJSON;

  const boundsFilteredGeoJSON: FeatureCollection<Point> = useMemo(() => {
    if (!viewBounds) return activeGeoJSON;

    const filteredFeatures = activeGeoJSON.features.filter((feature) => {
      const [lon, lat] = feature.geometry.coordinates;
      return (
        lon >= viewBounds.west &&
        lon <= viewBounds.east &&
        lat >= viewBounds.south &&
        lat <= viewBounds.north
      );
    });

    return {
      type: "FeatureCollection",
      features: filteredFeatures,
    };
  }, [activeGeoJSON, viewBounds]);

  const renderedPointCount = boundsFilteredGeoJSON.features.length;

  const mslpExp = useMemo(() => sfcPlotText("mslp"), []);
  const ttExp = useMemo(() => sfcPlotText("tt"), []);
  const tdExp = useMemo(() => sfcPlotText("td"), []);
  const windDirValExp = useMemo(() => sfcPlotNumber("windDir", 0), []);
  const windDirExp = useMemo(() => sfcPlotText("windDir"), []);
  const windSpdExp = useMemo(() => sfcPlotText("windSpd"), []);

  return (
    <div style={{ width: "100dvw", height: "100dvh" }}>
      <Map
        ref={mapRef}
        mapStyle="https://demotiles.maplibre.org/globe.json"
        projection="mercator"
        onRender={onMapRender}
        onLoad={updateViewBounds}
        onMoveEnd={updateViewBounds}
        onZoomEnd={updateViewBounds}
        onRotateEnd={updateViewBounds}
      >
        <Source id="nested-geojson" type="geojson" data={boundsFilteredGeoJSON}>
          <Layer
            key="nested-data-circle"
            id="nested-data-circle"
            type="circle"
            paint={{ "circle-color": "red" }}
          />
          <Layer
            key="nested-data-symbol-siteId"
            id="nested-data-symbol-siteId"
            type="symbol"
            layout={{
              "text-size": 10,
              "text-field": [
                "concat",
                ["literal", "siteId:"],
                ["to-string", ["get", "siteId"]],
              ],
              "text-allow-overlap": true,
            }}
            paint={{
              "text-color": "orange",
              "text-halo-color": "white",
              "text-halo-width": 1,
            }}
          />
          <Layer
            key="nested-data-symbol-mslp"
            id="nested-data-symbol-mslp"
            type="symbol"
            minzoom={4}
            layout={{
              "text-size": 10,
              "text-field":
                mode === "nested" ? mslpExp : ["to-string", ["get", "mslp"]],
              "text-allow-overlap": true,
              "text-anchor": "left",
              "text-offset": [0.5, 0],
            }}
            paint={{
              "text-color": "black",
              "text-halo-color": "white",
              "text-halo-width": 1,
            }}
          />
          <Layer
            key="nested-data-symbol-tt"
            id="nested-data-symbol-tt"
            type="symbol"
            minzoom={4}
            layout={{
              "text-size": 10,
              "text-field":
                mode === "nested" ? ttExp : ["to-string", ["get", "tt"]],
              "text-allow-overlap": true,
              "text-anchor": "left",
              "text-offset": [0, -1],
            }}
            paint={{
              "text-color": "black",
              "text-halo-color": "white",
              "text-halo-width": 1,
            }}
          />
          <Layer
            key="nested-data-symbol-td"
            id="nested-data-symbol-td"
            type="symbol"
            minzoom={4}
            layout={{
              "text-size": 10,
              "text-field":
                mode === "nested" ? tdExp : ["to-string", ["get", "td"]],
              "text-allow-overlap": true,
              "text-anchor": "left",
              "text-offset": [0, 1],
            }}
            paint={{
              "text-color": "black",
              "text-halo-color": "white",
              "text-halo-width": 1,
            }}
          />
          <Layer
            key="nested-data-symbol-windDir"
            id="nested-data-symbol-windDir"
            type="symbol"
            layout={{
              "text-size": 10,
              "text-field":
                mode === "nested"
                  ? windDirExp
                  : ["to-string", ["get", "windDir"]],
              "text-allow-overlap": true,
              "text-anchor": "left",
              "text-offset": [1, 1],
              "text-rotate":
                mode === "nested" ? windDirValExp : ["get", "windDir"],
            }}
            paint={{
              "text-color": "red",
              "text-halo-color": "white",
              "text-halo-width": 1,
            }}
          />
          <Layer
            key="nested-data-symbol-windSpd"
            id="nested-data-symbol-windSpd"
            type="symbol"
            layout={{
              "text-size": 10,
              "text-field":
                mode === "nested"
                  ? windSpdExp
                  : ["to-string", ["get", "windSpd"]],
              "text-allow-overlap": true,
              "text-anchor": "left",
              "text-offset": [1, -2],
            }}
            paint={{
              "text-color": "blue",
              "text-halo-color": "white",
              "text-halo-width": 1,
            }}
          />
        </Source>

        <div
          style={{
            position: "absolute",
            bottom: 12,
            left: 12,
            padding: "0.5rem 0.75rem",
            borderRadius: 8,
            background: "rgba(0, 0, 0, 0.65)",
            color: "white",
            fontFamily: "monospace",
            fontSize: "0.85rem",
            lineHeight: 1.3,
          }}
        >
          <div>Req UPS: {requestedUps.toFixed(1)}</div>
          <div>Shown UPS: {presentedUps.toFixed(1)}</div>
          <div>Avg Shown UPS: {avgPresentedUps.toFixed(1)}</div>
          <div>Visible Points: {renderedPointCount}</div>
          <div>Mode: {mode}</div>
          <div>Target UPS: {TARGET_UPS}</div>
          <div>Zoom: {zoom}</div>
          <button
            onClick={() => resetBenchmark(animate)}
            style={{
              marginTop: 6,
              fontFamily: "inherit",
              fontSize: "0.8rem",
              padding: "0.2rem 0.4rem",
              cursor: "pointer",
            }}
          >
            Reset Benchmark
          </button>
          <button
            onClick={
              animate === false
                ? () => resetBenchmark(true)
                : () => setAnimate(false)
            }
            style={{
              marginTop: 6,
              fontFamily: "inherit",
              fontSize: "0.8rem",
              padding: "0.2rem 0.4rem",
              cursor: "pointer",
              width: "4rem",
            }}
          >
            {animate === false ? "Start" : "Stop"}
          </button>
          <button
            onClick={() => {
              setMode((prev) => (prev === "flat" ? "nested" : "flat"));
              resetBenchmark();
            }}
            style={{
              marginTop: 6,
              fontFamily: "inherit",
              fontSize: "0.8rem",
              padding: "0.2rem 0.4rem",
              cursor: "pointer",
            }}
          >
            Toggle Mode
          </button>
        </div>
      </Map>
    </div>
  );
}

export default App;

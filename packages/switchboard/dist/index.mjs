#!/usr/bin/env node
import { t as startSwitchboard } from "./server-DaWxxH2k.mjs";
import "./utils-DFl0ezBT.mjs";
import * as Sentry from "@sentry/node";
import { childLogger } from "document-model";
import dotenv from "dotenv";
import { getConfig } from "@powerhousedao/config/node";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
//#region src/config.ts
dotenv.config();
const { switchboard } = getConfig();
const config = {
	database: { url: process.env.PH_SWITCHBOARD_DATABASE_URL ?? switchboard?.database?.url ?? "dev.db" },
	port: process.env.PH_SWITCHBOARD_PORT && !isNaN(Number(process.env.PH_SWITCHBOARD_PORT)) ? Number(process.env.PH_SWITCHBOARD_PORT) : switchboard?.port ?? 4001,
	mcp: true,
	drive: {
		id: "powerhouse",
		slug: "powerhouse",
		global: {
			name: "Powerhouse",
			icon: "https://ipfs.io/ipfs/QmcaTDBYn8X2psGaXe7iQ6qd8q6oqHLgxvMX9yXf7f9uP7"
		},
		local: {
			availableOffline: true,
			listeners: [],
			sharingType: "public",
			triggers: []
		}
	}
};
//#endregion
//#region src/metrics.ts
const logger$1 = childLogger(["switchboard", "metrics"]);
function createMeterProviderFromEnv(env) {
	const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
	if (!endpoint) return void 0;
	const parsed = parseInt(env.OTEL_METRIC_EXPORT_INTERVAL ?? "", 10);
	const exportIntervalMillis = Number.isFinite(parsed) && parsed > 0 ? parsed : 5e3;
	const base = endpoint.replace(/\/$/, "");
	const exporterUrl = base.endsWith("/v1/metrics") ? base : `${base}/v1/metrics`;
	logger$1.info(`Initializing OpenTelemetry metrics exporter at: ${endpoint}`);
	const meterProvider = new MeterProvider({
		resource: new Resource({ "service.name": env.OTEL_SERVICE_NAME ?? "switchboard" }),
		readers: [new PeriodicExportingMetricReader({
			exporter: new OTLPMetricExporter({ url: exporterUrl }),
			exportIntervalMillis,
			exportTimeoutMillis: Math.max(exportIntervalMillis - 250, 1)
		})]
	});
	logger$1.info(`Metrics export enabled (interval: ${exportIntervalMillis}ms)`);
	return meterProvider;
}
//#endregion
//#region src/profiler.ts
async function initProfilerFromEnv(env) {
	const { PYROSCOPE_SERVER_ADDRESS: serverAddress, PYROSCOPE_APPLICATION_NAME: appName, PYROSCOPE_USER: basicAuthUser, PYROSCOPE_PASSWORD: basicAuthPassword, PYROSCOPE_WALL_ENABLED: wallEnabled, PYROSCOPE_HEAP_ENABLED: heapEnabled } = env;
	return initProfiler({
		serverAddress,
		appName,
		basicAuthUser,
		basicAuthPassword,
		wall: {
			samplingDurationMs: 1e4,
			samplingIntervalMicros: 1e4,
			collectCpuTime: true
		},
		heap: {
			samplingIntervalBytes: 512 * 1024,
			stackDepth: 64
		}
	}, {
		wallEnabled: wallEnabled !== "false",
		heapEnabled: heapEnabled === "true"
	});
}
async function initProfiler(options, flags = {
	wallEnabled: true,
	heapEnabled: false
}) {
	console.log("Initializing Pyroscope profiler at:", options?.serverAddress);
	console.log("  Wall profiling:", flags.wallEnabled ? "enabled" : "disabled");
	console.log("  Heap profiling:", flags.heapEnabled ? "enabled" : "disabled");
	const { default: Pyroscope } = await import("@pyroscope/nodejs");
	Pyroscope.init(options);
	if (flags.wallEnabled) Pyroscope.startWallProfiling();
	Pyroscope.startCpuProfiling();
	if (flags.heapEnabled) Pyroscope.startHeapProfiling();
}
//#endregion
//#region src/index.mts
const logger = childLogger(["switchboard"]);
function ensureNodeVersion(minVersion = "24") {
	const version = process.versions.node;
	if (!version) return;
	if (version < minVersion) {
		console.error(`Node version ${minVersion} or higher is required. Current version: ${version}`);
		process.exit(1);
	}
}
ensureNodeVersion("24");
const meterProvider = createMeterProviderFromEnv({
	OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
	OTEL_METRIC_EXPORT_INTERVAL: process.env.OTEL_METRIC_EXPORT_INTERVAL,
	OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME
});
async function shutdown() {
	console.log("\nShutting down...");
	await Promise.race([meterProvider?.shutdown().catch(() => void 0), new Promise((resolve) => setTimeout(resolve, 5e3))]);
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
if (process.env.PYROSCOPE_SERVER_ADDRESS) try {
	await initProfilerFromEnv(process.env);
} catch (e) {
	Sentry.captureException(e);
	logger.error("Error starting profiler: @error", e);
}
startSwitchboard({
	...config,
	meterProvider
}).catch(console.error);
//#endregion
export {};

//# sourceMappingURL=index.mjs.map
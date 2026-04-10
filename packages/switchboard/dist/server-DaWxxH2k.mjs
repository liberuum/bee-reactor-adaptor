import { n as isPostgresUrl, t as addDefaultDrive } from "./utils-DFl0ezBT.mjs";
import { register } from "node:module";
import * as Sentry from "@sentry/node";
import { childLogger, documentModelDocumentModelModule } from "document-model";
import dotenv from "dotenv";
import { getConfig } from "@powerhousedao/config/node";
import { HttpPackageLoader, ImportPackageLoader, PackageManagementService, PackagesSubgraph, getUniqueDocumentModels, httpsHooksPath, initializeAndStartAPI } from "@powerhousedao/reactor-api";
import { PGlite } from "@electric-sql/pglite";
import { metrics } from "@opentelemetry/api";
import { ReactorInstrumentation } from "@powerhousedao/opentelemetry-instrumentation-reactor";
import { ChannelScheme, EventBus, ReactorBuilder, ReactorClientBuilder, driveCollectionId, parseDriveUrl } from "@powerhousedao/reactor";
import { SwarmSyncReadModel, SwarmClient } from "@liberuum-org/bee-reactor-adapter";
import { VitePackageLoader, createViteLogger, startViteServer } from "@powerhousedao/reactor-api/vite";
import { driveDocumentModelModule } from "@powerhousedao/shared/document-drive";
import { documentModels } from "@powerhousedao/vetra";
import { processorFactory } from "@powerhousedao/vetra/processors";
import { Kysely, PostgresDialect } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import path from "path";
import { Pool } from "pg";
import { EnvVarProvider } from "@openfeature/env-var-provider";
import { OpenFeature } from "@openfeature/server-sdk";
import { DEFAULT_RENOWN_URL, NodeKeyStorage, RenownBuilder, RenownCryptoBuilder, createSignatureVerifier } from "@renown/sdk/node";
//#region src/feature-flags.ts
async function initFeatureFlags() {
	const provider = new EnvVarProvider();
	await OpenFeature.setProviderAndWait(provider);
	return OpenFeature.getClient();
}
//#endregion
//#region src/renown.ts
const logger = childLogger(["switchboard", "renown"]);
/**
* Initialize Renown for the Switchboard instance.
* This allows Switchboard to authenticate with remote services
* using the same identity established during `ph login`.
*/
async function initRenown(options = {}) {
	const { keypairPath, requireExisting = false, baseUrl = DEFAULT_RENOWN_URL } = options;
	const keyStorage = new NodeKeyStorage(keypairPath, { logger });
	const existingKeyPair = await keyStorage.loadKeyPair();
	if (!existingKeyPair && requireExisting) throw new Error("No existing keypair found and requireExisting is true. Run \"ph login\" to create one.");
	if (!existingKeyPair) logger.info("No existing keypair found. A new one will be generated.");
	const renownCrypto = await new RenownCryptoBuilder().withKeyPairStorage(keyStorage).build();
	const renown = await new RenownBuilder("switchboard", {}).withCrypto(renownCrypto).withBaseUrl(baseUrl).build();
	logger.info("Switchboard identity initialized: @did", renownCrypto.did);
	return renown;
}
/**
* Get the signer config for the given renown instance.
*
* @param renown - The renown instance
* @param requireSignature - If true, unsigned actions are rejected
*/
function getRenownSignerConfig(renown, requireSignature) {
	return {
		signer: renown.signer,
		verifier: createSignatureVerifier(requireSignature)
	};
}
//#endregion
//#region src/server.mts
register(httpsHooksPath, import.meta.url);
const defaultLogger = childLogger(["switchboard"]);
dotenv.config();
const DOCUMENT_MODEL_SUBGRAPHS_ENABLED = "DOCUMENT_MODEL_SUBGRAPHS_ENABLED";
const DOCUMENT_MODEL_SUBGRAPHS_ENABLED_DEFAULT = true;
const REQUIRE_SIGNATURES = "REQUIRE_SIGNATURES";
const REQUIRE_SIGNATURES_DEFAULT = false;
if (process.env.SENTRY_DSN) {
	defaultLogger.info("Initialized Sentry with env: @env", process.env.SENTRY_ENV);
	Sentry.init({
		dsn: process.env.SENTRY_DSN,
		environment: process.env.SENTRY_ENV
	});
}
const DEFAULT_PORT = process.env.PORT ? Number(process.env.PORT) : 4001;
async function initServer(serverPort, options, renown) {
	if (options.meterProvider) metrics.setGlobalMeterProvider(options.meterProvider);
	const { dev, packages = [], remoteDrives = [], logger = defaultLogger } = options;
	const readModelPath = (options.dbPath ?? process.env.DATABASE_URL) || ".ph/read-storage";
	const config = getConfig(options.configFile ?? path.join(process.cwd(), "powerhouse.config.json"));
	const registryUrl = process.env.PH_REGISTRY_URL ?? config.packageRegistryUrl;
	const registryPackages = process.env.PH_REGISTRY_PACKAGES;
	let httpLoader;
	if (registryUrl) {
		httpLoader = new HttpPackageLoader({ registryUrl });
		registryPackages?.split(",").forEach((p) => {
			const name = p.trim();
			if (!packages.includes(name)) packages.push(name);
		});
	}
	const reactorLogger = logger.child(["reactor"]);
	const initializeClient = async (documentModels$1) => {
		const eventBus = new EventBus();
		const builder = new ReactorBuilder().withEventBus(eventBus).withDocumentModels(getUniqueDocumentModels([
			documentModelDocumentModelModule,
			driveDocumentModelModule,
			...documentModels,
			...documentModels$1
		])).withChannelScheme(ChannelScheme.SWITCHBOARD).withSignalHandlers().withLogger(reactorLogger);
		const maxSkipThreshold = parseInt(process.env.MAX_SKIP_THRESHOLD ?? "", 10);
		if (!isNaN(maxSkipThreshold) && maxSkipThreshold > 0) {
			builder.withExecutorConfig({ maxSkipThreshold });
			logger.info(`Reactor maxSkipThreshold set to ${maxSkipThreshold}`);
		}
		const reactorDbUrl = process.env.PH_REACTOR_DATABASE_URL;
		if (reactorDbUrl && isPostgresUrl(reactorDbUrl)) {
			const kysely = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: reactorDbUrl.includes("?") ? reactorDbUrl : `${reactorDbUrl}?sslmode=disable` }) }) });
			builder.withKysely(kysely);
			logger.info("Using PostgreSQL for reactor storage");
		} else {
			const kysely = new Kysely({ dialect: new PGliteDialect(new PGlite("./.ph/reactor-storage")) });
			builder.withKysely(kysely);
			logger.info("Using PGlite for reactor storage");
		}
		if (httpLoader && options.dynamicModelLoading) builder.withDocumentModelLoader(httpLoader.documentModelLoader);
		const swarmBeeUrl = process.env.SWARM_BEE_URL;
		const swarmStampId = process.env.SWARM_STAMP_ID;
		const swarmSignerKey = process.env.SWARM_SIGNER_KEY;
		let swarmReadModel;
		if (swarmBeeUrl && swarmStampId && swarmSignerKey) {
			const swarmClient = new SwarmClient({
				beeUrl: swarmBeeUrl,
				batchId: swarmStampId,
				signerPrivateKey: swarmSignerKey,
				useFeedMode: process.env.SWARM_FEED_MODE !== "false",
			});
			swarmReadModel = new SwarmSyncReadModel(swarmClient, logger);
			const encKey = process.env.SWARM_ENCRYPTION_KEY;
			if (encKey) {
				swarmReadModel.setEncryptionKey(encKey);
				logger.info("Swarm encryption enabled (app-layer AES-256-GCM)");
			}
			builder.withReadModel(swarmReadModel);
			logger.info(`Swarm Bee adapter enabled (${swarmBeeUrl})`);
		}
		const clientBuilder = new ReactorClientBuilder().withReactorBuilder(builder);
		if (renown) {
			const signerConfig = getRenownSignerConfig(renown, options.identity?.requireSignatures);
			clientBuilder.withSigner(signerConfig);
		}
		const module = await clientBuilder.buildModule();
		if (module.reactorModule) {
			new ReactorInstrumentation(module.reactorModule).start();
			reactorLogger.info("Reactor metrics instrumentation started");
		}
		if (swarmBeeUrl && swarmStampId && swarmSignerKey) {
			logger.info("Swarm Bee adapter started — operations will persist to Swarm");
		}
		return module;
	};
	let defaultDriveUrl = void 0;
	const basePath = process.cwd();
	const viteLogger = createViteLogger(logger);
	const vite = dev ? await startViteServer(process.cwd(), viteLogger) : void 0;
	if (!options.disableLocalPackages) packages.push(basePath);
	const packageLoaders = [];
	if (vite) packageLoaders.push(VitePackageLoader.build(vite));
	else packageLoaders.push(new ImportPackageLoader());
	if (httpLoader) {
		packageLoaders.push(httpLoader);
		registryPackages?.split(",").forEach((p) => {
			const name = p.trim();
			if (!packages.includes(name)) packages.push(name);
		});
	}
	const apiLogger = logger.child(["reactor-api"]);
	const api = await initializeAndStartAPI(initializeClient, {
		port: serverPort,
		dbPath: readModelPath,
		https: options.https,
		packageLoaders: packageLoaders.length > 0 ? packageLoaders : void 0,
		packages,
		processorConfig: options.processorConfig,
		processors: { "@powerhousedao/vetra": [processorFactory] },
		configFile: options.configFile ?? path.join(process.cwd(), "powerhouse.config.json"),
		mcp: options.mcp ?? true,
		logger: apiLogger,
		enableDocumentModelSubgraphs: options.enableDocumentModelSubgraphs
	}, "switchboard");
	if (process.env.SENTRY_DSN) api.httpAdapter.setupSentryErrorHandler(Sentry);
	const { client, graphqlManager, documentModelRegistry } = api;
	if (httpLoader) {
		const packageManagementService = new PackageManagementService({
			defaultRegistryUrl: registryUrl,
			httpLoader,
			documentModelRegistry
		});
		packageManagementService.setOnModelsChanged(() => {
			graphqlManager.regenerateDocumentModelSubgraphs().catch(logger.error);
		});
		const packagesSubgraph = new PackagesSubgraph({
			relationalDb: void 0,
			analyticsStore: void 0,
			reactorClient: client,
			graphqlManager,
			syncManager: api.syncManager,
			path: graphqlManager.getBasePath(),
			packageManagementService
		});
		graphqlManager.registerSubgraphInstance(packagesSubgraph, "graphql", false).then(() => graphqlManager.updateRouter()).catch((error) => {
			logger.error("Failed to register packages subgraph: @error", error);
		});
	}
	if (options.drive) {
		if (!renown) throw new Error("Cannot create default drive without Renown identity");
		defaultDriveUrl = await addDefaultDrive(client, options.drive, serverPort);
	}
	if (vite) api.httpAdapter.mountRawMiddleware(vite.middlewares);
	if (remoteDrives.length > 0) for (const remoteDriveUrl of remoteDrives) {
		let driveId;
		try {
			const { syncManager } = api;
			const parsed = parseDriveUrl(remoteDriveUrl);
			driveId = parsed.driveId;
			const remoteName = `remote-drive-${driveId}-${crypto.randomUUID()}`;
			await syncManager.add(remoteName, driveCollectionId("main", driveId), {
				type: "gql",
				parameters: { url: parsed.graphqlEndpoint }
			});
			logger.debug("Remote drive @remoteDriveUrl synced", remoteDriveUrl);
		} catch (error) {
			if (error instanceof Error && error.message.includes("already exists")) {
				logger.debug("Remote drive already added: @remoteDriveUrl", remoteDriveUrl);
				driveId = remoteDriveUrl.split("/").pop();
			} else logger.error("Failed to connect to remote drive @remoteDriveUrl: @error", remoteDriveUrl, error);
		} finally {
			if (!defaultDriveUrl && driveId) defaultDriveUrl = `${options.https ? "https" : "http"}://localhost:${serverPort}/d/${driveId}`;
		}
	}
	return {
		defaultDriveUrl,
		api,
		reactor: client,
		renown
	};
}
const startSwitchboard = async (options = {}) => {
	const serverPort = options.port ?? DEFAULT_PORT;
	const featureFlags = await initFeatureFlags();
	const enableDocumentModelSubgraphs = await featureFlags.getBooleanValue(DOCUMENT_MODEL_SUBGRAPHS_ENABLED, options.enableDocumentModelSubgraphs ?? DOCUMENT_MODEL_SUBGRAPHS_ENABLED_DEFAULT);
	options.enableDocumentModelSubgraphs = enableDocumentModelSubgraphs;
	const requireSignatures = options.identity?.requireSignatures ?? await featureFlags.getBooleanValue(REQUIRE_SIGNATURES, REQUIRE_SIGNATURES_DEFAULT);
	options.identity = {
		...options.identity,
		requireSignatures
	};
	const logger = options.logger ?? defaultLogger;
	logger.info("Feature flags: @flags", JSON.stringify({
		DOCUMENT_MODEL_SUBGRAPHS_ENABLED: enableDocumentModelSubgraphs,
		REQUIRE_SIGNATURES: requireSignatures
	}, null, 2));
	let renown = null;
	try {
		renown = await initRenown(options.identity);
	} catch (e) {
		logger.warn("Failed to initialize ConnectCrypto: @error", e);
		if (options.identity?.requireExisting) throw new Error("Identity required but failed to initialize. Run \"ph login\" first.");
	}
	try {
		return await initServer(serverPort, options, renown);
	} catch (e) {
		Sentry.captureException(e);
		logger.error("App crashed: @error", e);
		throw e;
	}
};
if (import.meta.main) await startSwitchboard();
//#endregion
export { startSwitchboard as t };

//# sourceMappingURL=server-DaWxxH2k.mjs.map
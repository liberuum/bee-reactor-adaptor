import { PGlite } from "@electric-sql/pglite";
import {
  addRemoteDrive,
  ReactorBuilder,
  ReactorClientBuilder,
  type BrowserReactorClientModule,
  type Database,
  type IDocumentModelLoader,
  type JwtHandler,
  type SignerConfig,
} from "@powerhousedao/reactor-browser";
import type {
  DocumentModelModule,
  UpgradeManifest,
} from "@powerhousedao/shared/document-model";
import { createSignatureVerifier, type IRenown } from "@renown/sdk";
import { ConsoleLogger } from "document-model";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { createSwarmSyncBuilder } from "../../../adapter/src/channel/create-composite-factory.js";

/**
 * Creates a Reactor with dual GQL + Swarm sync via the proper builder API.
 *
 * Uses ReactorBuilder.withSync() to inject a CompositeChannelFactory that
 * handles both "gql" and "swarm" channel types. The GQL factory is registered
 * after buildModule() once the queue (with proper document model resolver)
 * is available from ReactorModule.
 *
 * No monkey-patching required — Swarm remotes persist in sync_remotes
 * and survive page reloads natively.
 */
export async function createBrowserReactor(
  documentModelModules: DocumentModelModule[],
  upgradeManifests: UpgradeManifest<readonly number[]>[],
  renown: IRenown,
  documentModelLoader?: IDocumentModelLoader,
): Promise<BrowserReactorClientModule> {
  const signerConfig: SignerConfig = {
    signer: renown.signer,
    verifier: createSignatureVerifier(),
  };

  const jwtHandler: JwtHandler = async (url: string) => {
    if (!renown.user) {
      return undefined;
    }
    return renown.getBearerToken({ expiresIn: 10, aud: url });
  };

  const pg = new PGlite("idb://reactor", {
    relaxedDurability: true,
  });

  const logger = new ConsoleLogger(["reactor-client"]);

  // Build a SyncBuilder with CompositeChannelFactory.
  // Swarm is registered immediately; GQL is deferred until after build
  // because GqlRequestChannelFactory needs the queue (which contains
  // the document model resolver created inside buildModule).
  const { syncBuilder, registerGqlFactory } = createSwarmSyncBuilder(
    logger,
    jwtHandler,
  );

  const builder = new ReactorClientBuilder()
    .withLogger(logger)
    .withSigner(signerConfig)
    .withReactorBuilder(
      new ReactorBuilder()
        .withDocumentModels(documentModelModules)
        .withUpgradeManifests(upgradeManifests)
        .withSync(syncBuilder)
        .withJwtHandler(jwtHandler)
        .withKysely(
          new Kysely<Database>({
            dialect: new PGliteDialect(pg),
          }),
        ),
    );

  if (documentModelLoader) {
    builder.withDocumentModelLoader(documentModelLoader);
  }

  const module = await builder.buildModule();

  // Register the GQL factory now that the queue (with document model
  // resolver) is available. Any GQL remotes persisted in sync_remotes
  // were already restored during startup — new GQL remotes added via
  // addRemoteDrive() will use this factory.
  const queue = module.reactorModule?.queue;
  if (queue) {
    registerGqlFactory(queue);
  }

  return {
    ...module,
    pg,
  } as BrowserReactorClientModule;
}

/**
 * Parse default drives from environment variable.
 * Returns an array of drive REST endpoint URLs (e.g., "https://example.com/d/powerhouse").
 */
export function getDefaultDrivesFromEnv(): string[] {
  const envValue = import.meta.env.PH_CONNECT_DEFAULT_DRIVES_URL as
    | string
    | undefined;
  if (!envValue) return [];
  return envValue.split(",").filter((url) => url.trim().length > 0);
}

/**
 * Add default drives for the new reactor via sync manager.
 * @param defaultDriveUrls - Array of drive REST endpoint URLs (e.g., "https://example.com/d/powerhouse")
 */
export async function addDefaultDrivesForNewReactor(
  defaultDriveUrls: string[],
): Promise<void> {
  for (const url of defaultDriveUrls) {
    try {
      await addRemoteDrive(url);
    } catch (error) {
      console.error(`Failed to add default drive ${url}:`, error);
    }
  }
}

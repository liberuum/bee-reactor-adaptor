Files that communicate with the Bee node
1. swarm-client.ts — the core gateway
This is the single Bee SDK wrapper. All other files that need Swarm data go through it. It holds the Bee instance and makes two types of calls:

Via bee-js SDK (this.bee.*):

Method	Bee API	Purpose
uploadData	POST /bytes	Upload encrypted data (immutable, content-addressed)
downloadData	GET /bytes/{ref}	Download + auto-decrypt
uploadRawData	POST /bytes	Upload without SwarmClient encryption (for sharing)
downloadRawData	GET /bytes/{ref}	Download without SwarmClient decryption (for sharing)
makeFeedReader → downloadPayload	GET /feeds/{owner}/{topic}	Read a mutable feed pointer
makeFeedWriter → uploadPayload	POST /feeds/{topic}	Write a mutable feed pointer (SOC)
getHealth	GET /health	Node health check
patchGrantees	PATCH /grantees	ACT access control
createGrantees	POST /grantees	Create ACT grantee list
getGrantees	GET /grantees/{ref}	Read ACT grantee list
getPostageBatch	GET /stamps/{batchId}	Read stamp status (delegated to StampManager)
Via raw fetch (bypassing bee-js):

Call	Bee API	Why raw fetch
fetch(bee.url/addresses)	GET /addresses	bee-js doesn't expose node public key or overlay
fetch(bee.url/wallet)	GET /wallet	bee-js doesn't expose wallet balance endpoint
2. stamp-manager.ts — stamp lifecycle
Holds its own Bee reference (passed from SwarmClient constructor). Calls:

Via bee-js SDK:

Method	Bee API	Purpose
getPostageBatch	GET /stamps/{batchId}	Stamp status (TTL, utilization, depth)
topUpBatch	PATCH /stamps/topup/{batchId}/{amount}	Extend stamp TTL
diluteBatch	PATCH /stamps/dilute/{batchId}/{depth}	Increase stamp capacity
getChainState	GET /chainstate	Current storage price per block
Via raw fetch:

Call	API	Why
fetch(bee.url/stamps/{amount}/{depth})	POST /stamps/{amount}/{depth}	Create new stamp — bee-js doesn't have this method
Via external API:

Call	API	Purpose
fetch(api.coingecko.com/...)	CoinGecko REST	xBZZ/USD price for cost estimation UI
3. plugin/init.ts — startup detection
Makes raw fetch calls to probe the Bee node before initializing the plugin:

Call	Bee API	Purpose
fetch(beeUrl/health)	GET /health	Is the node reachable?
fetch(beeUrl/stamps)	GET /stamps	Find a usable postage stamp
fetch(beeUrl/topology)	GET /topology	Detect dev mode (0 peers = dev)
fetch(beeUrl/wallet)	GET /wallet	Node wallet balances (for settings UI)
fetch(beeUrl/addresses)	GET /addresses	Node wallet address (for settings UI)
These are all in initSwarmPlugin() and applySwarmExtensions() — they probe the node before creating the SwarmClient.

4. plugin/sharing.ts — profile publishing
One raw fetch call:

Call	Bee API	Purpose
fetch(beeUrl/addresses)	GET /addresses	Get Bee node public key + overlay for the public profile
How they interact

                          ┌─────────────────────────────┐
                          │       Bee Node API           │
                          │  /bytes  /feeds  /stamps     │
                          │  /health /wallet /addresses   │
                          │  /topology /chainstate        │
                          │  /grantees                    │
                          └──────────────┬────────────────┘
                                         │
          ┌──────────────────────────────┼──────────────────────────────┐
          │                              │                              │
    raw fetch()                    bee-js SDK                    raw fetch()
          │                              │                              │
   ┌──────┴──────┐              ┌────────┴────────┐            ┌───────┴───────┐
   │  init.ts    │              │  swarm-client.ts │            │ stamp-mgr.ts  │
   │  (probe)    │              │  (core gateway)  │            │ (stamps +     │
   │             │              │                  │            │  CoinGecko)   │
   │ /health     │              │ /bytes (upload/  │            │               │
   │ /stamps     │              │  download)       │            │ /stamps       │
   │ /topology   │              │ /feeds (read/    │            │ /chainstate   │
   │ /wallet     │              │  write)          │            │ coingecko API │
   │ /addresses  │              │ /grantees        │            └───────────────┘
   └─────────────┘              │ /addresses       │
                                │ /wallet          │
   ┌─────────────┐              └────────┬─────────┘
   │ sharing.ts  │                       │
   │ /addresses  │          ┌────────────┼────────────┐
   └─────────────┘          │            │            │
                      share-mgr     All plugin/     hydrator
                      (via client)  files (via      (via client)
                                    client)

Everything else in the codebase calls SwarmClient methods.
No other file touches the Bee node directly.
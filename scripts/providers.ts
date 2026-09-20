import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { pathToFileURL } from "url"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOpenAI } from "@ai-sdk/openai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogle } from "@ai-sdk/google"
import type { LanguageModel } from "ai"

/**
 * Supported AI SDK provider packages, resolved per model from models.dev:
 * model `provider.npm` takes priority over the opencode/opencode-go
 * provider-level `npm`.
 */
export const SUPPORTED_NPM_PROVIDERS = [
    "@ai-sdk/openai",
    "@ai-sdk/openai-compatible",
    "@ai-sdk/anthropic",
    "@ai-sdk/google",
] as const

export type NpmProvider = (typeof SUPPORTED_NPM_PROVIDERS)[number]

export interface ResolvedProvider {
    npm: NpmProvider
    api: string
}

/**
 * The implicit default: `@ai-sdk/openai-compatible` against the zen/go base
 * URL matching the model key prefix. `models.json` omits the `provider`
 * block for these; only non-default routing is stored.
 */
export function defaultProviderFor(modelId: string): ResolvedProvider {
    const api = modelId.startsWith("opencode-go/")
        ? "https://opencode.ai/zen/go/v1"
        : "https://opencode.ai/zen/v1"
    return { npm: "@ai-sdk/openai-compatible", api }
}

export function isDefaultProvider(
    modelId: string,
    provider: ResolvedProvider,
): boolean {
    const def = defaultProviderFor(modelId)
    return provider.npm === def.npm && provider.api === def.api
}

/**
 * Resolve the AI SDK package + base URL for one model.
 * Priority: model `provider.npm` > opencode/opencode-go `npm`.
 */
export function resolveProvider(
    providerEntry: { npm?: string; api?: string },
    modelEntry?: { provider?: { npm?: string; api?: string } },
): ResolvedProvider {
    const npm = (modelEntry?.provider?.npm ??
        providerEntry.npm ??
        "@ai-sdk/openai-compatible") as NpmProvider
    if (
        !(SUPPORTED_NPM_PROVIDERS as readonly string[]).includes(npm)
    ) {
        throw new Error(`Unsupported provider npm package: ${npm}`)
    }
    const api = modelEntry?.provider?.api ?? providerEntry.api ?? ""
    if (!api) {
        throw new Error("Missing provider api base URL")
    }
    return { npm, api }
}

/**
 * Load OPENCODE_API_KEY from the .env file first, falling back to the
 * system environment if not present.
 */
export function getOpencodeApiKey(): string | undefined {
    const envPath = join(process.cwd(), ".env")
    if (existsSync(envPath)) {
        const content = readFileSync(envPath, "utf-8")
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith("#")) continue
            const eq = trimmed.indexOf("=")
            if (eq === -1) continue
            if (trimmed.slice(0, eq).trim() === "OPENCODE_API_KEY") {
                return trimmed.slice(eq + 1).trim()
            }
        }
    }
    return process.env.OPENCODE_API_KEY
}

export function isPublicApiKey(key: string | undefined): boolean {
    return key === String.fromCharCode(112, 117, 98, 108, 105, 99)
}

/**
 * Per-model resolutions from the live models.dev snapshot, populated by
 * fetchModels() before any measurement runs. Takes precedence over the
 * models.json fallback below, so newly discovered models route correctly
 * on their first measurement.
 */
const liveResolutions = new Map<string, ResolvedProvider>()
const livePricing = new Map<string, Record<string, number>>()

export function setLiveResolutions(
    entries: Array<{
        id: string
        provider: ResolvedProvider
        pricing?: Record<string, number>
    }>,
): void {
    liveResolutions.clear()
    livePricing.clear()
    for (const entry of entries) {
        liveResolutions.set(entry.id, entry.provider)
        if (entry.pricing) livePricing.set(entry.id, entry.pricing)
    }
}

let modelsJsonCache: Record<
    string,
    { provider?: ResolvedProvider; pricing?: Record<string, number> }
> | null = null

function readModelsJson(): Record<
    string,
    { provider?: ResolvedProvider; pricing?: Record<string, number> }
> {
    if (!modelsJsonCache) {
        try {
            const configPath = join(process.cwd(), "src", "models.json")
            modelsJsonCache = existsSync(configPath)
                ? (JSON.parse(readFileSync(configPath, "utf-8")) as Record<
                      string,
                      {
                          provider?: ResolvedProvider
                          pricing?: Record<string, number>
                      }
                  >)
                : {}
        } catch {
            modelsJsonCache = {}
        }
    }
    return modelsJsonCache
}

/**
 * Default resolver for `opencode/<id>` / `opencode-go/<id>` model ids.
 * Priority: live models.dev snapshot > models.json `provider` block >
 * prefix-based default (`@ai-sdk/openai-compatible` + zen/go base URL).
 */
export function resolveModelProvider(modelId: string): ResolvedProvider {
    const live = liveResolutions.get(modelId)
    if (live) return live
    const entry = readModelsJson()[modelId]?.provider
    if (entry?.npm && entry?.api) {
        if (
            !(SUPPORTED_NPM_PROVIDERS as readonly string[]).includes(entry.npm)
        ) {
            throw new Error(
                `Unsupported provider npm package for ${modelId}: ${entry.npm}`,
            )
        }
        return { npm: entry.npm, api: entry.api }
    }
    return defaultProviderFor(modelId)
}

type ProviderClient = { languageModel: (modelId: string) => LanguageModel }

const clientCache = new Map<string, ProviderClient>()

function getClient(npm: NpmProvider, api: string, apiKey: string): ProviderClient {
    const cacheKey = `${npm}::${api}`
    const cached = clientCache.get(cacheKey)
    if (cached) return cached

    let client: ProviderClient
    switch (npm) {
        case "@ai-sdk/openai-compatible":
            client = createOpenAICompatible({
                name: `opencode-${api.includes("/go/") ? "go" : "zen"}`,
                baseURL: api,
                apiKey,
            })
            break
        case "@ai-sdk/openai":
            client = createOpenAI({ baseURL: api, apiKey })
            break
        case "@ai-sdk/anthropic":
            // Zen expects Bearer auth; the Anthropic package sends
            // `x-api-key` by default, so pass the key as authToken instead.
            client = createAnthropic({ baseURL: api, authToken: apiKey })
            break
        case "@ai-sdk/google":
            // Zen expects Bearer auth; the Google package sends
            // `x-goog-api-key` by default, so override via headers.
            client = createGoogle({
                baseURL: api,
                apiKey,
                headers: { Authorization: `Bearer ${apiKey}` },
            })
            break
    }
    clientCache.set(cacheKey, client)
    return client
}

/**
 * Build a LanguageModel for a `opencode/<id>` / `opencode-go/<id>` model id
 * using the resolved provider client. `resolve` maps a full model id to its
 * resolved `{ npm, api }` (e.g. from the models.dev snapshot or models.json).
 */
export function getLanguageModel(
    modelId: string,
    apiKey: string,
    resolve: (modelId: string) => ResolvedProvider = resolveModelProvider,
): LanguageModel {
    const { npm, api } = resolve(modelId)
    const slash = modelId.indexOf("/")
    const stripped = slash === -1 ? modelId : modelId.slice(slash + 1)
    return getClient(npm, api, apiKey).languageModel(stripped)
}

/**
 * Configure the AI SDK default provider to route opencode (zen) and
 * opencode-go models through the per-model resolved SDK package.
 * `resolve` maps a full model id to its resolved `{ npm, api }`.
 */
export function setupProvider(
    apiKey: string,
    resolve: (modelId: string) => ResolvedProvider = resolveModelProvider,
): void {
    ;(globalThis as any).AI_SDK_DEFAULT_PROVIDER = {
        specificationVersion: "v4",
        languageModel: (modelId: string) =>
            getLanguageModel(modelId, apiKey, resolve),
    }
}

/**
 * Local-only free-tier compatibility shim.
 *
 * When a local `free-tier` helper file is present (gitignored, never
 * published), free models (`cost.input === 0`) are requested with the extra
 * headers and tools it provides. Without that file every model is requested
 * normally, so clones without it can only calibrate paid models.
 */
const FREE_TIER_SHIM_PATH = join(process.cwd(), ".dev", "free-tier.ts")

interface FreeTierShimModule {
    createFreeTierShimTools?: () => Record<string, any>
    getFreeTierHeaders?: () => Promise<Record<string, string>>
}

let shimLoadAttempted = false
let shimModule: FreeTierShimModule | null = null

async function loadFreeTierShim(): Promise<FreeTierShimModule | null> {
    if (shimLoadAttempted) return shimModule
    shimLoadAttempted = true
    try {
        if (!existsSync(FREE_TIER_SHIM_PATH)) return null
        shimModule = (await import(
            pathToFileURL(FREE_TIER_SHIM_PATH).href
        )) as FreeTierShimModule
    } catch {
        shimModule = null
    }
    return shimModule
}

function isFreeModel(modelId: string): boolean {
    const live = livePricing.get(modelId)
    if (live) return (live.input ?? 0) === 0
    const entry = readModelsJson()[modelId]
    if (entry?.pricing) return (entry.pricing.input ?? 0) === 0
    return false
}

/**
 * Extra headers + tools for free-tier measurement, or null when the local
 * shim file is absent or the model is not free. Callers merge the result
 * into their `streamText` options.
 */
export async function getFreeTierShim(
    modelId: string,
): Promise<{
    headers: Record<string, string>
    tools: Record<string, any>
} | null> {
    const shim = await loadFreeTierShim()
    if (!shim || !isFreeModel(modelId)) return null
    const headers = shim.getFreeTierHeaders
        ? await shim.getFreeTierHeaders()
        : {}
    const tools = shim.createFreeTierShimTools
        ? shim.createFreeTierShimTools()
        : {}
    return { headers, tools }
}

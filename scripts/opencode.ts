/**
 * Thin re-export kept for backward compatibility during migration.
 * New code should import from `./providers.ts` directly.
 */
export {
    getOpencodeApiKey,
    isPublicApiKey,
    resolveProvider,
    resolveModelProvider,
    setLiveResolutions,
    getLanguageModel,
    setupProvider,
    SUPPORTED_NPM_PROVIDERS,
} from "./providers.ts"
export type { NpmProvider, ResolvedProvider } from "./providers.ts"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"

/**
 * Configure the AI SDK default provider to route opencode (inference) and
 * opencode-go models to their respective base URLs.
 *
 * @deprecated Use `setupProvider` from `./providers.ts`, which routes each
 * model through its resolved SDK package.
 */
export function setupOpencodeProvider(apiKey: string): void {
    const inference = createOpenAICompatible({
        name: "opencode",
        baseURL: "https://opencode.ai/inference/openai/v1",
        apiKey,
    })
    const go = createOpenAICompatible({
        name: "opencode-go",
        baseURL: "https://opencode.ai/inference/go/openai/v1",
        apiKey,
    })
    ;(globalThis as any).AI_SDK_DEFAULT_PROVIDER = {
        specificationVersion: "v4",
        languageModel: (modelId: string) => {
            if (modelId.startsWith("opencode-go/")) {
                return go.languageModel(modelId.slice("opencode-go/".length))
            }
            if (modelId.startsWith("opencode/")) {
                return inference.languageModel(modelId.slice("opencode/".length))
            }
            return inference.languageModel(modelId)
        },
    }
}
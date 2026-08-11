import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"

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
 * Configure the AI SDK default provider to route opencode (zen) and
 * opencode-go models to their respective base URLs.
 */
export function setupOpencodeProvider(apiKey: string): void {
    const zen = createOpenAICompatible({
        name: "opencode",
        baseURL: "https://opencode.ai/zen/v1",
        apiKey,
    })
    const go = createOpenAICompatible({
        name: "opencode-go",
        baseURL: "https://opencode.ai/zen/go/v1",
        apiKey,
    })
    ;(globalThis as any).AI_SDK_DEFAULT_PROVIDER = {
        specificationVersion: "v4",
        languageModel: (modelId: string) => {
            if (modelId.startsWith("opencode-go/")) {
                return go.languageModel(modelId.slice("opencode-go/".length))
            }
            if (modelId.startsWith("opencode/")) {
                return zen.languageModel(modelId.slice("opencode/".length))
            }
            return zen.languageModel(modelId)
        },
    }
}
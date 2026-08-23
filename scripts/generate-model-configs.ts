import { streamText, tool } from "ai"
import { z } from "zod"
import Tokenizer from "../src/tokenizer.ts"
import { readFileSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { findBestTokenizer, type TokenizerResult } from "./find-best-tokenizer.ts"
import * as encoding from "../src/encoding/index.ts"
import { getOpencodeApiKey, isPublicApiKey, setupOpencodeProvider } from "./opencode.ts"

const apiKey = getOpencodeApiKey()
if (!apiKey) {
    throw new Error("OPENCODE_API_KEY is not set")
}
setupOpencodeProvider(apiKey)

// Manual encoding overrides - specify the encoding for models if known
const ENCODING_OVERRIDES: Record<string, string> = {
}

// Content multiplier overrides by encoding - for tokenizers that systematically undercount
// Claude tokenizer is not official and undercounts by ~10%, so we apply a 1.10x multiplier
const ENCODING_MULTIPLIER_OVERRIDES: Record<string, number> = {
    "claude": 1.10,  // Apply to all models using claude encoding
}

// Per-model content multiplier overrides - takes precedence over encoding overrides
// Use this for models that need a different multiplier than others using the same encoding
const MODEL_MULTIPLIER_OVERRIDES: Record<string, number> = {
    // opencode free models using p50k_base over-count content by ~17-22%
    "opencode/big-pickle": 0.83,
    "opencode/laguna-s-2.1-free": 0.91,
    "opencode/ling-3.0-tiny-free": 1.0,
    "opencode/nemotron-3.5-lightning-free": 1.0,
    "opencode/nemotron-3-ultra-free": 0.98,
    "opencode/mimo-v2.5-free": 0.86,
    "opencode/x-preview-f-free": 0.82,
}

const IGNORE_MODELS = [
    // opencode free models listed in models.dev but unavailable on the API
    "opencode/muse-spark-1.2-contributor-free",
]

// Get tokenizer for a specific encoding
const getTokenizer = (encodingName: string): Tokenizer => {
    const enc = encoding[encodingName as keyof typeof encoding]
    if (!enc) {
        throw new Error(`Unknown encoding: ${encoding}`)
    }
    return new Tokenizer(enc)
}

const run = async (model: string, messages: any[], tools?: any) => {
    const result = streamText({
        model,
        messages,
        maxOutputTokens: 16,
        tools,
        // These measurement scripts intentionally pass system messages inside
        // `messages` to measure their token overhead. The messages are trusted
        // server-side data, so opt in to the v7 default that rejects them.
        allowSystemInMessages: true,
    })
    await result.consumeStream()
    const usage = await result.usage
    return usage.inputTokens!
}

interface ModelConfig {
    encoding: string
    tokens: {
        baseOverhead: number
        perMessage: number
        toolsExist: number
        perTool: number
        perDesc: number
        perFirstProp: number
        perAdditionalProp: number
        perPropDesc: number
        perEnum: number
        perNestedObject: number
        perArrayOfObjects: number
        contentMultiplier: number
    }
    // Metadata from API
    name: string
    contextWindow: number
    maxTokens: number
    pricing: Record<string, number>
}

interface ApiModel {
    id: string
    name: string
    context_window: number
    max_tokens: number
    type: string
    pricing: Record<string, number>
}

interface ModelsDevModel {
    id: string
    name: string
    status?: string
    cost?: Record<string, number>
    limit: {
        context: number
        input?: number
        output: number
    }
}

interface ModelsDevProvider {
    id: string
    name: string
    models: Record<string, ModelsDevModel>
}

async function fetchModels(): Promise<ApiModel[]> {
    console.log("🌐 Fetching models from models.dev...\n")
    const response = await fetch("https://models.dev/api.json")
    const data = await response.json() as Record<string, ModelsDevProvider>

    const isPublic = isPublicApiKey(getOpencodeApiKey())

    const models: ApiModel[] = []
    // With the free-tier key, only the zen provider (opencode) is reachable;
    // opencode-go models are not available, so skip them to avoid failed measurements.
    for (const providerId of isPublic ? ["opencode"] : ["opencode", "opencode-go"]) {
        const provider = data[providerId]
        if (!provider) {
            console.log(`  ⚠️ Provider ${providerId} not found in models.dev`)
            continue
        }
        for (const model of Object.values(provider.models)) {
            // Skip deprecated models
            if (model.status === "deprecated") continue
            // With the free-tier key, only free models (cost.input === 0) are available
            if (isPublic && (model.cost?.input ?? 0) !== 0) continue

            const pricing: Record<string, number> = {}
            if (model.cost) {
                pricing.input = model.cost.input ?? 0
                pricing.output = model.cost.output ?? 0
                if (model.cost.cache_read != null) pricing.input_cache_read = model.cost.cache_read
                if (model.cost.cache_write != null) pricing.input_cache_write = model.cost.cache_write
            }

            models.push({
                id: `${providerId}/${model.id}`,
                name: model.name,
                context_window: model.limit.context,
                max_tokens: model.limit.output,
                type: "language",
                pricing,
            })
        }
    }
    console.log(`  Found ${models.length} models from opencode & opencode-go\n`)

    return models
}

function loadExistingConfigs(): Record<string, ModelConfig> {
    const configPath = join(process.cwd(), "src", "models.json")
    if (existsSync(configPath)) {
        console.log("📂 Loading existing configs from models.json\n")
        try {
            const content = readFileSync(configPath, "utf-8")
            return JSON.parse(content)
        } catch (error) {
            console.log("⚠️  Could not load existing configs, starting fresh")
            return {}
        }
    }
    return {}
}

async function measureModel(modelName: string, encoding: string, apiModel: ApiModel): Promise<ModelConfig> {
    const tokenizer = getTokenizer(encoding)

    console.log(`\n🔍 Measuring: ${modelName} (${encoding})`)

    // Create a simple tool for message overhead tests
    const testTool = {
        x: tool({ inputSchema: z.object({ y: z.string() }) })
    }
    
    // Run all API calls in parallel for maximum speed
    const [
        msgA,
        twoMsgs,
        threeMsgs,
        systemUser,
        systemUserAssistant,
        multiUser,
        multiAssistant,
        msgAWithTools,
        twoMsgsWithTools,
        threeMsgsWithTools,
        noTools,
        emptyTool,
        twoTools,
        withDesc,
        oneProp,
        twoProp,
        propWithDesc,
        stringProp,
        enumProp,
        flatTwoProps,
        nestedTwoProps,
        arrayOfStrings,
        arrayOfObjects,
    ] = await Promise.all([
        // 1. Message overhead - test multiple patterns
        run(modelName, [{ role: "user", content: "a" }]),
        run(modelName, [
            { role: "user", content: "a" },
            { role: "assistant", content: "b" },
        ]),
        run(modelName, [
            { role: "user", content: "a" },
            { role: "assistant", content: "b" },
            { role: "user", content: "c" },
        ]),
        run(modelName, [
            { role: "system", content: "x" },
            { role: "user", content: "a" },
        ]),
        run(modelName, [
            { role: "system", content: "x" },
            { role: "user", content: "a" },
            { role: "assistant", content: "b" },
        ]),
        run(modelName, [
            { role: "user", content: "a" },
            { role: "user", content: "b" },
        ]),
        run(modelName, [
            { role: "user", content: "a" },
            { role: "assistant", content: "b" },
            { role: "assistant", content: "c" },
        ]),
        // Test same patterns WITH tools to get accurate perMessage
        run(modelName, [{ role: "user", content: "a" }], testTool),
        run(modelName, [
            { role: "user", content: "a" },
            { role: "assistant", content: "b" },
        ], testTool),
        run(modelName, [
            { role: "user", content: "a" },
            { role: "assistant", content: "b" },
            { role: "user", content: "c" },
        ], testTool),
        // 2. Tool overhead
        run(modelName, [{ role: "user", content: "Test" }], {}),
        run(modelName, [{ role: "user", content: "Test" }], {
            x: tool({ inputSchema: z.object({}) }),
        }),
        run(modelName, [{ role: "user", content: "Test" }], {
            x: tool({ inputSchema: z.object({}) }),
            y: tool({ inputSchema: z.object({}) }),
        }),
        // 3. Tool description overhead
        run(modelName, [{ role: "user", content: "Test" }], {
            x: tool({ description: "Hi", inputSchema: z.object({}) }),
        }),
        // 4. Property overhead
        run(modelName, [{ role: "user", content: "Test" }], {
            x: tool({ inputSchema: z.object({ y: z.string() }) }),
        }),
        run(modelName, [{ role: "user", content: "Test" }], {
            x: tool({ inputSchema: z.object({ y: z.string(), z: z.string() }) }),
        }),
        // 5. Property description overhead
        run(modelName, [{ role: "user", content: "Test" }], {
            x: tool({ inputSchema: z.object({ y: z.string().describe("Hi") }) }),
        }),
        // 6. Enum overhead
        run(modelName, [{ role: "user", content: "Test" }], {
            x: tool({ inputSchema: z.object({ y: z.string() }) }),
        }),
        run(modelName, [{ role: "user", content: "Test" }], {
            x: tool({ inputSchema: z.object({ y: z.enum(["a", "b", "c"]) }) }),
        }),
        // 7. Nested object overhead
        run(modelName, [{ role: "user", content: "Test" }], {
            x: tool({ inputSchema: z.object({ y: z.string().describe("Hi"), z: z.string().describe("Hi") }) }),
        }),
        run(modelName, [{ role: "user", content: "Test" }], {
            x: tool({ inputSchema: z.object({ 
                data: z.object({
                    y: z.string().describe("Hi"),
                    z: z.string().describe("Hi"),
                }).describe("Data"),
            }) }),
        }),
        // 8. Array of objects overhead
        run(modelName, [{ role: "user", content: "Test" }], {
            x: tool({ inputSchema: z.object({ items: z.array(z.string()).describe("Items") }) }),
        }),
        run(modelName, [{ role: "user", content: "Test" }], {
            x: tool({ inputSchema: z.object({ 
                items: z.array(z.object({
                    y: z.string().describe("Hi"),
                    z: z.string().describe("Hi"),
                })).describe("Items"),
            }) }),
        }),
    ])

    // Calculate all the overhead values
    
    // Now calculate perMessage from with-tools measurements
    // Pattern 1: user -> assistant (with tools)
    const perMsg1WithTools = twoMsgsWithTools - msgAWithTools - tokenizer.encode("assistant").length - tokenizer.encode("b").length
    
    // Pattern 2: user -> assistant -> user (3 messages, with tools)
    const perMsg2WithTools = (threeMsgsWithTools - msgAWithTools - tokenizer.encode("assistant").length - tokenizer.encode("b").length 
                              - tokenizer.encode("user").length - tokenizer.encode("c").length) / 2
    
    // Also calculate without-tools patterns for logging
    const perMsg1 = twoMsgs - msgA - tokenizer.encode("assistant").length - tokenizer.encode("b").length
    const perMsg3 = systemUser - msgA - tokenizer.encode("system").length - tokenizer.encode("x").length
    const perMsg5 = multiUser - msgA - tokenizer.encode("user").length - tokenizer.encode("b").length
    
    // Use ONLY with-tools measurements for perMessage since that's real-world usage
    // The 3-message pattern is most reliable as it captures scaling better
    // If 3-msg pattern is positive, heavily weight it; otherwise fall back to averaging
    let perMessage: number
    if (perMsg2WithTools > 0) {
        // 3-message pattern shows positive scaling - use it primarily
        perMessage = Math.round(perMsg2WithTools)
    } else {
        // Fall back to weighted average if patterns are inconsistent
        const perMessageValues = [perMsg1WithTools, perMsg2WithTools, perMsg1].filter(v => !isNaN(v))
        perMessage = Math.round(perMessageValues.reduce((a, b) => a + b, 0) / perMessageValues.length)
    }

    // baseOverhead is everything else beyond per-message + role + content.
    // Measured from the systemUser probe (system + user) rather than a bare
    // user message: a system-less request makes some backends prepend a
    // cached default system prompt (mimo 246 vs ~1, laguna 42 vs ~6), which
    // pollutes the absolute base-overhead value. count() adds perMessage for
    // EVERY message, so subtract it for the two probe messages here.
    const baseOverhead = systemUser
        - tokenizer.encode("system").length
        - tokenizer.encode("x").length
        - tokenizer.encode("user").length
        - tokenizer.encode("a").length
        - perMessage * 2

    const toolsExist = emptyTool - noTools - tokenizer.encode("x").length
    const perTool = twoTools - emptyTool - tokenizer.encode("y").length
    
    const perDesc = withDesc - emptyTool - tokenizer.encode("Hi").length
    
    const perFirstProp = oneProp - emptyTool - tokenizer.encode("y").length
    const perAdditionalProp = twoProp - oneProp - tokenizer.encode("z").length
    
    const perPropDesc = propWithDesc - oneProp - tokenizer.encode("Hi").length
    
    const enumTokens = tokenizer.encode("a").length + tokenizer.encode("b").length + tokenizer.encode("c").length
    const perEnum = enumProp - stringProp - enumTokens
    
    // Calculate nested overhead
    // flatTwoProps has 2 flat properties (y, z) with same descriptions "Hi"
    //   - y: first prop (+perFirstProp = 13)
    //   - z: additional prop (+perAdditionalProp = 12)
    // nestedTwoProps has 1 property (data) containing nested object with same 2 properties
    //   - data: first prop (+perFirstProp = 13)
    //   - y inside: first in nested context (+perFirstProp = 13) ← KEY DIFFERENCE!
    //   - z inside: additional (+perAdditionalProp = 12)
    // 
    // The key insight: y gets perFirstProp in nested (13) but perAdditionalProp in flat (conceptually, it's the 2nd property)
    // Actually no - in flat, y is FIRST so it gets 13 too. The difference is that in nested we have an extra perFirstProp for data.
    //
    // Let's recalculate properly:
    // flatTwoProps = base + y(first:13) + z(add:12) = base + 25
    // nestedTwoProps = base + data(first:13) + [y(first-in-nest:13) + z(add:12)] + nesting_overhead
    //                = base + 13 + 25 + nesting_overhead
    //
    // diff = nestedTwoProps - flatTwoProps = 13 + nesting_overhead
    // We need to subtract out data's tokens and property overhead
    const dataNameTokens = tokenizer.encode("data").length
    const dataDescTokens = tokenizer.encode("Data").length
    
    // data property overhead: first property, so perFirstProp
    // But wait - if data is first, then in flat the FIRST property also gets perFirstProp
    // So the overhead difference is just the wrapper's tokens + perNestedObject
    const perNestedObject = nestedTwoProps - flatTwoProps - perFirstProp - dataNameTokens - dataDescTokens - perPropDesc
    
    // Calculate array of objects overhead
    // arrayOfStrings has an array of strings
    // arrayOfObjects has an array of objects (with 2 properties each)
    // Both have same "items" property name and "Items" description
    // The difference is the overhead for array of objects
    const perArrayOfObjects = arrayOfObjects - arrayOfStrings - (flatTwoProps - emptyTool - tokenizer.encode("x").length)

    console.log(`  ✓ encoding: ${encoding}`)
    console.log(`  ✓ baseOverhead: ${baseOverhead}`)
    console.log(`  ✓ perMessage: ${perMessage} (with-tools: ${perMsg1WithTools.toFixed(1)}, ${perMsg2WithTools.toFixed(1)}; without: ${perMsg1.toFixed(1)}, ${perMsg3.toFixed(1)}, ${perMsg5.toFixed(1)})`)
    console.log(`  ✓ toolsExist: ${toolsExist}, perTool: ${perTool}`)
    console.log(`  ✓ perFirstProp: ${perFirstProp}, perAdditionalProp: ${perAdditionalProp}`)
    console.log(`  ✓ perNestedObject: ${perNestedObject}, perArrayOfObjects: ${perArrayOfObjects}`)

    // Parse pricing object - convert all values from strings to numbers
    const pricing: Record<string, number> = { ...apiModel.pricing }

    const tokens: any = {
        baseOverhead,
        perMessage,
        toolsExist,
        perTool,
        perDesc,
        perFirstProp,
        perAdditionalProp,
        perPropDesc,
        perEnum,
        perNestedObject,
        perArrayOfObjects,
        contentMultiplier: 1.0,
    }
    
    // Apply content multiplier if defined for this model or encoding
    // Check model-specific override first, then encoding override
    let contentMultiplier = MODEL_MULTIPLIER_OVERRIDES[modelName]
    let multiplierSource = "model"
    
    if (!contentMultiplier) {
        contentMultiplier = ENCODING_MULTIPLIER_OVERRIDES[encoding]
        multiplierSource = "encoding"
    }
    
    if (contentMultiplier) {
        tokens.contentMultiplier = contentMultiplier
        console.log(`  ✓ contentMultiplier: ${contentMultiplier} (from ${multiplierSource}: ${multiplierSource === "model" ? modelName : encoding})`)
    }
    
    return {
        encoding,
        tokens,
        name: apiModel.name,
        contextWindow: apiModel.context_window,
        maxTokens: apiModel.max_tokens,
        pricing,
    }
}

function validateConfig(config: ModelConfig): boolean {
    // Check for NaN in token values
    const tokenValues = Object.values(config.tokens)
    if (tokenValues.some(v => isNaN(v))) {
        return false
    }
    
    // Check for NaN in other numeric fields
    if (isNaN(config.contextWindow) || isNaN(config.maxTokens)) {
        return false
    }
    
    // Check for NaN in pricing
    const pricingValues = Object.values(config.pricing)
    if (pricingValues.some(v => isNaN(v))) {
        return false
    }
    
    return true
}

function saveConfigs(configs: Record<string, ModelConfig>) {
    const outputPath = join(process.cwd(), "src", "models.json")
    const fileContent = JSON.stringify(configs, null, 2)
    writeFileSync(outputPath, fileContent, "utf-8")
}

// Main execution
console.log("🚀 Generating model configs...\n")

// Fetch models from API
let apiModels = await fetchModels()

// Apply IGNORE_MODELS filter
apiModels = apiModels.filter(model => !IGNORE_MODELS.includes(model.id))

// apiModels = apiModels.filter(m => m.id.startsWith("google/"))

console.log(`🔍 Found ${apiModels.length} models`)

// Load existing configs
let configs = loadExistingConfigs()

// Process each model
for (const apiModel of apiModels) {
    const modelId = apiModel.id
    const existingConfig = configs[modelId]

    try {
        // Determine encoding
        let encoding: string | null = null
        let needsRegeneration = false

        // Check for manual override
        if (ENCODING_OVERRIDES[modelId]) {
            encoding = ENCODING_OVERRIDES[modelId]
        } else if (existingConfig) {
            encoding = existingConfig.encoding
        }

        // Check if encoding changed
        if (existingConfig && existingConfig.encoding !== encoding) {
            console.log(`⚠️  Encoding changed for ${modelId}: ${existingConfig.encoding} → ${encoding}`)
            needsRegeneration = true
        }

        // If we have existing config and no regeneration needed, reuse it
        if (existingConfig && !needsRegeneration) {
            console.log(`✓ Reusing existing config for ${modelId}`)

            // Parse pricing object - convert all values from strings to numbers
            const pricing: Record<string, number> = { ...apiModel.pricing }

            // Apply content multiplier overrides even when reusing, so the override
            // tables stay the authoritative source for calibrated multipliers
            // (measureModel applies them on the measurement path; reuse must too)
            const tokens = { ...existingConfig.tokens }
            let contentMultiplier = MODEL_MULTIPLIER_OVERRIDES[modelId]
            let multiplierSource = "model"
            if (!contentMultiplier) {
                contentMultiplier = ENCODING_MULTIPLIER_OVERRIDES[existingConfig.encoding]
                multiplierSource = "encoding"
            }
            if (contentMultiplier && contentMultiplier !== tokens.contentMultiplier) {
                tokens.contentMultiplier = contentMultiplier
                console.log(`  ✓ contentMultiplier: ${contentMultiplier} (from ${multiplierSource}: ${multiplierSource === "model" ? modelId : existingConfig.encoding})`)
            }

            // Update metadata that may have changed
            const updatedConfig = {
                ...existingConfig,
                tokens,
                name: apiModel.name,
                contextWindow: apiModel.context_window,
                maxTokens: apiModel.max_tokens,
                pricing,
            }
            
            configs[modelId] = updatedConfig
            saveConfigs(configs)
            continue
        }

        // If no encoding determined yet, use find-best-tokenizer
        if (!encoding) {
            console.log(`🔎 No encoding override for ${modelId}, finding best tokenizer...`)
            const tokenizerResult = await findBestTokenizer(modelId, false)
            encoding = tokenizerResult.encoding
            console.log(`  → Found best tokenizer: ${encoding}`)
            
            // If a significant multiplier was discovered (>1.05 or <0.95), suggest adding it to overrides
            if (tokenizerResult.multiplier !== 1.0) {
                console.log(`  → Suggested content multiplier: ${tokenizerResult.multiplier}x`)
                console.log(`  → Note: Add to MODEL_MULTIPLIER_OVERRIDES (per-model) or ENCODING_MULTIPLIER_OVERRIDES (per-encoding) if systematic bias confirmed`)
                // Don't auto-apply - let manual testing confirm the multiplier first
            }
        }

        // Measure the model
        const newConfig = await measureModel(modelId, encoding, apiModel)
        
        // Validate the config before storing
        if (!validateConfig(newConfig)) {
            console.error(`❌ Invalid config for ${modelId} (contains NaN values), skipping`)
            continue
        }
        
        configs[modelId] = newConfig
        
        // Save immediately after each successful measurement
        saveConfigs(configs)
        console.log(`💾 Saved config for ${modelId}`)

    } catch (error) {
        console.error(`❌ Failed to process ${modelId}:`, error)

        // If we have an existing config, keep it
        if (existingConfig) {
            console.log(`  → Keeping existing config for ${modelId}`)
            configs[modelId] = existingConfig
        }
    }
}

console.log(`\n✅ Generated configs for ${Object.keys(configs).length} models`)
console.log(`📝 Written to: src/models.json\n`)

# oc-tokenizer

[![CI](https://github.com/sekedus/oc-tokenizer/actions/workflows/ci.yml/badge.svg)](https://github.com/sekedus/oc-tokenizer/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/oc-tokenizer)](https://www.npmjs.com/package/oc-tokenizer)
[![npm downloads](https://img.shields.io/npm/dm/oc-tokenizer)](https://www.npmjs.com/package/oc-tokenizer)

> This project is a fork of [coder/ai-tokenizer](https://github.com/coder/ai-tokenizer/tree/9fa777aa591303a3aad26f3e5cd5c6c0cc8be6fc) with some modifications to support opencode models: opencode & opencode-go providers routed per model through `@ai-sdk/openai`, `@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`, and `@ai-sdk/google`, model configs sourced from `models.dev`, and per-model accuracy calibration.

A faster than tiktoken tokenizer with first-class support for opencode models.

- Supports the [AI SDK](https://github.com/vercel/ai) tool and message schema
- No WASM; highly portable; [5-7x faster](#performance) than [tiktoken WASM](https://github.com/dqbd/tiktoken)
- \>=90% [accuracy](#accuracy) for free models:

<!-- POPULAR_MODELS_TABLE_START -->
| Model | ~500 tokens | ~5k tokens | ~50k tokens |
|-------|-------------|------------|-------------|
| opencode/big-pickle | 95.77% | 96.23% | 97.45% |
| opencode/mimo-v2.5-free | 99.47% | 99.09% | 99.55% |
| opencode/nemotron-3-ultra-free | 99.50% | 99.10% | 99.87% |

<!-- POPULAR_MODELS_TABLE_END -->

[Try it on the website:](https://sekedus.github.io/oc-tokenizer/)

[![Demo](https://raw.githubusercontent.com/sekedus/oc-tokenizer/main/demo.png)](https://sekedus.github.io/oc-tokenizer/)

## Usage

Install:

```sh
npm install oc-tokenizer
```

Estimate tokens with the AI SDK:

```ts
import Tokenizer, { models } from "oc-tokenizer";
import { count } from "oc-tokenizer/sdk";
import * as encoding from "oc-tokenizer/encoding";
import { z } from "zod";

// Find the respective model.
const model = models["opencode/big-pickle"];
const tokenizer = new Tokenizer(encoding[model.encoding]);

// Messages and tools to count.
const messages = [
  { role: "user", content: "What is the weather in San Francisco?" },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "call_123",
        toolName: "getWeather",
        input: { location: "San Francisco" },
      },
    ],
  },
];

const tools = {
  getWeather: {
    description: "Get the current weather",
    inputSchema: z.object({ location: z.string() }),
  },
};

const result = count({
  tokenizer,
  model,
  // Every message is counted separately
  messages,
  // Tool descriptions and input schemas are counted
  tools,
})

// {
//   total: 316,
//   messages: [
//     {
//       total: 11,
//       content: [
//         { type: "text", total: 8 }
//       ]
//     },
//     {
//       total: 11,
//       content: [
//         { type: "tool-call", total: 8, input: 6 }
//       ]
//     }
//   ],
//   tools: {
//     total: 296,
//     definitions: {
//       getWeather: {
//         name: 2,
//         description: 4,
//         inputSchema: 15
//       }
//     }
//   }
// }

// No API calls are performed; no keys.

const costUSD = result.total * model.pricing.input;
```

Estimate tokens using an encoding:

```ts
import { Tokenizer } from "oc-tokenizer";
import * as o200k_base from "oc-tokenizer/encoding/o200k_base";

const tokenizer = new Tokenizer(o200k_base);
const total = tokenizer.count("some text input");
```

> [!WARNING]  
> Import encodings selectively based on what you need. Each encoding is 2-8MB uncompressed.

## Accuracy

Validated against actual API responses with pseudo-random messages:

<!-- ACCURACY_TABLE_START -->
| Model | ~500 tokens | ~5k tokens | ~50k tokens |
|-------|-------------|------------|-------------|
| opencode/big-pickle | 95.77% | 96.23% | 97.45% |
| opencode/deepseek-v4-flash-free | 96.63% | 92.89% | 93.36% |
| opencode/hy3-free | 96.60% | 98.56% | 98.91% |
| opencode/laguna-s-2.1-free | 90.97% | 98.88% | 98.21% |
| opencode/ling-3.0-flash-fin-free | 96.37% | 99.16% | 98.90% |
| opencode/ling-3.0-tiny-free | 96.75% | 96.26% | 96.87% |
| opencode/longcat-2.0-free | 99.61% | 92.40% | 91.13% |
| opencode/longcat-2.5-preview-free | 97.81% | 92.89% | 91.19% |
| opencode/mimo-v2.5-free | 99.47% | 99.09% | 99.55% |
| opencode/mimo-v2.6-flash-free | 96.85% | 99.29% | 98.96% |
| opencode/muse-spark-1.2-contributor-free | 98.26% | 94.12% | 92.76% |
| opencode/muse-spark-1.3-contributor-free | 98.26% | 94.08% | 92.72% |
| opencode/nemotron-3-ultra-free | 99.50% | 99.10% | 99.87% |
| opencode/nemotron-3.5-lightning-free | 99.66% | 97.37% | 97.86% |
| opencode/space-bunny-free | 97.73% | 98.45% | 97.98% |
| opencode/x-preview-f-free | 95.89% | 93.82% | 93.73% |

<!-- ACCURACY_TABLE_END -->

*Accuracy shows percentage within actual token count.*

> [!WARNING]  
> Not every tool/token scenario is tested for accuracy. There will be edge-cases where this is more/less accurate. If you find this inaccurate for your scenario, please open an issue.

Run `node scripts/generate-accuracy.ts` to update this table. Refer to [accuracy.json](./accuracy.json) for greater detail.

## Performance

oc-tokenizer is **5-7x faster than tiktoken** for counting tokens. It is on par with gpt-tokenizer.

```bash
$ node bench/versus.ts

clk: ~1.51 GHz
cpu: AMD EPYC 7763 64-Core Processor
runtime: node 24.14.0 (x64-linux)

benchmark                   avg (min … max) p75 / p99    (min … top 1%)
------------------------------------------- -------------------------------
• initialization
------------------------------------------- -------------------------------
oc-tokenizer                  36.45 µs/iter  31.93 µs █▄                   
                       (19.06 µs … 7.86 ms) 205.43 µs ██                   
                    (416.00  b … 733.18 kb)  50.96 kb ██▅▂▂▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁

tiktoken                     207.75 ms/iter 231.34 ms                █    █
                    (121.95 ms … 411.79 ms) 248.11 ms ▅▅▅▅     ▅    ▅█ ▅  █
                    (600.00  b …   8.00 kb)   2.08 kb ████▁▁▁▁▁█▁▁▁▁██▁█▁▁█

• encode: small text (~13 chars)
------------------------------------------- -------------------------------
oc-tokenizer                   6.06 µs/iter   6.31 µs █                    
                       (3.79 µs … 11.28 µs)  10.39 µs ██   ██              
                    (  1.92 kb …   2.26 kb)   2.00 kb ███▁██████▁▁█▁▁▁█▁▁▁█

gpt-tokenizer                  2.42 µs/iter   2.28 µs █                    
                        (1.04 µs … 3.85 ms)   3.11 µs █         ▃▃▄        
                    (  1.30 kb … 240.78 kb)   1.33 kb █▅▁▁▁▁▁▂▃▅████▅▃▂▁▁▁▁

tiktoken                     264.62 µs/iter 139.30 µs █                    
                       (89.07 µs … 8.88 ms)   3.46 ms █                    
                    (456.00  b …   1.61 mb)  13.10 kb █▂▂▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁

• encode: medium text (~4.5KB)
------------------------------------------- -------------------------------
oc-tokenizer                 279.96 µs/iter 219.44 µs  █                   
                      (109.61 µs … 4.60 ms)   2.30 ms  █                   
                    (  3.80 kb … 449.25 kb) 153.49 kb ▁█▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁

gpt-tokenizer                273.59 µs/iter 218.51 µs █                    
                      (167.91 µs … 8.67 ms)   2.28 ms █                    
                    (126.39 kb … 382.15 kb) 192.56 kb █▃▄▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁

tiktoken                       1.76 ms/iter   1.85 ms       █              
                        (1.03 ms … 3.85 ms)   3.53 ms       ██             
                    (352.00  b … 429.66 kb)   3.33 kb █▄▂▁▂▃██▃▃▁▁▁▁▂▁▁▁▁▁▁

• encode: large text (~500KB)
------------------------------------------- -------------------------------
oc-tokenizer                  69.01 ms/iter  83.03 ms █  █                 
                     (46.39 ms … 145.89 ms)  99.41 ms █  █                 
                    (  8.86 mb …  29.23 mb)  14.22 mb ██▁█▁█▁▁▁▁▁▁▁▁██▁▁▁▁█

gpt-tokenizer                 71.99 ms/iter  67.78 ms █                    
                     (44.14 ms … 175.01 ms) 145.68 ms █                    
                    (893.32 kb … 893.32 kb) 893.32 kb █▆▁▆▆▆▆▁▁▁▁▁▁▁▁▁▁▁▁▁▆

tiktoken                     337.92 ms/iter 452.50 ms ██               █   
                    (208.83 ms … 509.85 ms) 498.56 ms ██▅   ▅  ▅   ▅   █  ▅
                    (352.00  b … 448.00  b) 362.67  b ███▁▁▁█▁▁█▁▁▁█▁▁▁█▁▁█

• encode: unicode text
------------------------------------------- -------------------------------
oc-tokenizer                 648.53 µs/iter 656.23 µs ▆ █                  
                      (313.26 µs … 7.08 ms)   3.52 ms █ █                  
                    (  1.16 kb … 490.48 kb) 170.52 kb █▅█▆▂▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁

gpt-tokenizer                944.57 µs/iter 834.13 µs   █                  
                     (333.95 µs … 10.67 ms)   4.59 ms   █                  
                    (224.07 kb … 622.70 kb) 231.06 kb ▃▆█▃▂▂▂▁▁▁▁▂▁▁▁▁▁▁▁▁▁

tiktoken                       2.07 ms/iter   2.45 ms █                    
                        (1.37 ms … 9.37 ms)   6.70 ms █   ▄                
                    (592.00  b …   8.20 kb) 642.09  b █▄▂▄█▂▁▂▁▂▁▁▁▁▁▁▁▁▁▁▁

• encode: code
------------------------------------------- -------------------------------
oc-tokenizer                   1.30 ms/iter   1.21 ms   █                  
                      (464.37 µs … 9.65 ms)   5.18 ms   █                  
                    (702.33 kb … 768.77 kb) 763.73 kb ▄▃█▇▃▂▂▂▂▂▁▂▁▁▁▁▁▁▁▁▁

gpt-tokenizer                  1.33 ms/iter   1.15 ms   █                  
                      (510.38 µs … 6.39 ms)   5.25 ms   █                  
                    (880.71 kb … 910.86 kb) 894.64 kb ▁▂█▃▂▃▂▁▁▁▂▁▁▁▁▁▁▁▁▁▁

tiktoken                       9.61 ms/iter   9.15 ms  █                   
                       (8.24 ms … 17.59 ms)  16.99 ms  █                   
                    (352.00  b …  10.33 kb) 493.81  b ██▄▃▂▁▁▁▂▁▂▁▁▂▁▂▁▂▁▂▂

• encode: mixed content
------------------------------------------- -------------------------------
oc-tokenizer                  14.14 ms/iter  16.28 ms ▅       █            
                       (7.36 ms … 31.85 ms)  24.93 ms █      ▃█ ▃          
                    (  1.51 mb …   3.45 mb)   3.32 mb █▆▁▁▄▁▄█████▆▁▄▁▁▄▁▁▄

gpt-tokenizer                 16.68 ms/iter  17.32 ms      █               
                      (10.78 ms … 26.84 ms)  25.72 ms      █ ▆             
                    (  4.11 mb …   4.32 mb)   4.24 mb ▃▅▃▃▅█▃█▃▅▁▁▁▁▁▃█▁▃▁▃

tiktoken                      51.48 ms/iter  53.66 ms █                    
                      (43.72 ms … 62.00 ms)  61.52 ms █▅  ▅ ▅ ▅  ▅     ▅  ▅
                    (488.00  b … 584.00  b) 497.14  b ██▁▁█▁█▁█▁▁█▁▁▁▁▁█▁▁█

• decode: large token array
------------------------------------------- -------------------------------
oc-tokenizer                   2.32 ms/iter   2.01 ms █                    
                       (1.53 ms … 11.88 ms)  11.25 ms █                    
                    (192.86 kb …   5.80 mb)   5.77 mb █▄▂▂▃▁▂▁▁▁▁▁▂▁▁▁▁▁▁▁▁

gpt-tokenizer                  8.65 ms/iter   9.20 ms   █                  
                       (3.12 ms … 29.80 ms)  28.23 ms  ▄█▄                 
                    ( 13.05 mb …  13.05 mb)  13.05 mb ▃████▄▄▂█▁▃▁▁▁▁▁▁▂▂▁▂

tiktoken                       7.39 ms/iter   7.43 ms  █                   
                       (4.35 ms … 28.27 ms)  27.28 ms ▃██                  
                    (352.00  b …   1.09 kb) 363.15  b ███▅▅▂▃▃▃▂▂▁▁▁▁▁▁▁▁▁▂

• count: large text (~500KB)
------------------------------------------- -------------------------------
oc-tokenizer                  79.64 ms/iter  86.37 ms     █                
                     (29.31 ms … 168.08 ms) 148.79 ms ▅▅ ▅█▅ ▅▅ ▅     ▅   ▅
                    (  8.86 mb …  29.23 mb)  14.22 mb ██▁███▁██▁█▁▁▁▁▁█▁▁▁█

gpt-tokenizer                 79.91 ms/iter  69.10 ms    █                 
                     (44.48 ms … 183.75 ms) 163.89 ms   ███                
                    (893.60 kb … 893.60 kb) 893.60 kb █████▁█▁▁▁▁▁▁▁▁▁▁▁▁▁█

tiktoken                     453.38 ms/iter 501.17 ms     █                
                    (335.39 ms … 624.79 ms) 574.24 ms     █   █            
                    (352.00  b … 464.00  b) 366.67  b █▁▁██▁▁▁█▁█▁▁▁█▁▁▁▁██
```

Run this yourself with `node bench/versus.ts`.

## Scripts

Development and tooling scripts live in `scripts/`. Run them with plain Node (22+ type-stripping, no build step required):

| Script | Description |
|--------|-------------|
| `generate-encodings.ts` | Generates the optimized encoding modules in `src/encoding/` from the JSON token tables, using a dual-storage format (string-based map for UTF-8 tokens, sorted binary search for the rest, and string-based decoding where possible). |
| `generate-model-configs.ts` | Fetches live model data from `models.dev/api.json` (resolving each model to its AI SDK package via model `provider.npm` first, then the opencode/opencode-go provider `npm`) and regenerates `src/models.json` (model metadata, provider routing, and pricing). Requires `OPENCODE_API_KEY`. |
| `generate-accuracy.ts` | Measures token-count accuracy per model against actual API responses and regenerates the [accuracy table](#accuracy) in this README plus `accuracy.json`. |

Usage: `node scripts/<script>.ts`. Scripts that make live API calls need `OPENCODE_API_KEY`.

## License

[MIT](./LICENSE)

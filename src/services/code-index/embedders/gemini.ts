import { GeminiHandler } from "../../../api/providers/gemini"
import type { ApiHandlerOptions } from "../../../shared/api"
import { IEmbedder, EmbeddingResponse, EmbedderInfo } from "../interfaces"
import {
	MAX_BATCH_TOKENS,
	MAX_ITEM_TOKENS,
	MAX_BATCH_RETRIES as MAX_RETRIES,
	INITIAL_RETRY_DELAY_MS as INITIAL_DELAY_MS,
} from "../constants"

/**
 * Gemini implementation of the embedder interface with batching and rate limiting
 */
export class GeminiEmbedder extends GeminiHandler implements IEmbedder {
	private readonly defaultModelId: string

	/**
	 * Creates a new Gemini embedder.
	 * The Gemini client is inherited from the GeminiHandler.
	 * @param options API handler options
	 */
	constructor(options: ApiHandlerOptions & { geminiEmbeddingModelId?: string }) {
		super(options)
		// Default embedding model for Gemini. Common choices: 'embedding-001', 'text-embedding-004'.
		// The model ID here should NOT be prefixed with `models/`.
		this.defaultModelId = options.geminiEmbeddingModelId || "embedding-001"
	}

	/**
	 * Creates embeddings for the given texts with batching and rate limiting
	 * @param texts Array of text strings to embed
	 * @param model Optional model identifier
	 * @returns Promise resolving to embedding response
	 */
	async createEmbeddings(texts: string[], model?: string): Promise<EmbeddingResponse> {
		const modelToUse = model || this.defaultModelId
		const allEmbeddings: number[][] = []
		// The embedContent API does not return token usage.
		const usage = { promptTokens: 0, totalTokens: 0 }
		const remainingTexts = [...texts]

		while (remainingTexts.length > 0) {
			const currentBatch: string[] = []
			let currentBatchTokens = 0
			const processedIndices: number[] = []

			for (let i = 0; i < remainingTexts.length; i++) {
				const text = remainingTexts[i]
				const itemTokens = Math.ceil(text.length / 4)

				if (itemTokens > MAX_ITEM_TOKENS) {
					console.warn(
						`Text at index ${i} exceeds maximum token limit (${itemTokens} > ${MAX_ITEM_TOKENS}). Skipping.`,
					)
					processedIndices.push(i)
					continue
				}

				if (currentBatchTokens + itemTokens <= MAX_BATCH_TOKENS) {
					currentBatch.push(text)
					currentBatchTokens += itemTokens
					processedIndices.push(i)
				} else {
					break
				}
			}

			for (let i = processedIndices.length - 1; i >= 0; i--) {
				remainingTexts.splice(processedIndices[i], 1)
			}

			if (currentBatch.length > 0) {
				try {
					const batchResult = await this._embedBatchWithRetries(currentBatch, modelToUse)
					// The API returns an array of embeddings, so we may need to filter out undefined ones
					const validEmbeddings = batchResult.embeddings.filter((e): e is number[] => !!e)
					allEmbeddings.push(...validEmbeddings)
				} catch (error) {
					console.error("Failed to process Gemini embedding batch:", error)
					throw new Error("Failed to create Gemini embeddings: batch processing error")
				}
			}
		}

		return { embeddings: allEmbeddings, usage }
	}

	/**
	 * Helper method to handle batch embedding with retries and exponential backoff
	 * @param batchTexts Array of texts to embed in this batch
	 * @param model Model identifier to use
	 * @returns Promise resolving to embeddings and a zeroed usage object
	 */
	private async _embedBatchWithRetries(
		batchTexts: string[],
		model: string,
	): Promise<{ embeddings: (number[] | undefined)[]; usage: { promptTokens: number; totalTokens: number } }> {
		for (let attempts = 0; attempts < MAX_RETRIES; attempts++) {
			try {
				const response = await this.client.models.embedContent({
					model,
					contents: batchTexts,
				})

				// The response contains an array of `ContentEmbedding` objects.
				const embeddings = response.embeddings?.map((item) => item.values) || []

				return {
					embeddings,
					usage: {
						promptTokens: 0,
						totalTokens: 0,
					},
				}
			} catch (error: any) {
				const isRateLimitError = error?.status === 429
				const hasMoreAttempts = attempts < MAX_RETRIES - 1

				if (isRateLimitError && hasMoreAttempts) {
					const delayMs = INITIAL_DELAY_MS * Math.pow(2, attempts)
					await new Promise((resolve) => setTimeout(resolve, delayMs))
					continue
				}

				throw error
			}
		}

		throw new Error(`Failed to create Gemini embeddings after ${MAX_RETRIES} attempts`)
	}

	get embedderInfo(): EmbedderInfo {
		return {
			name: "gemini",
		}
	}
}

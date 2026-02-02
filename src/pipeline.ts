import type { ExtractionResult, Sentence } from "./types";
import { preprocessHtml } from "./preprocessing/strip";
import { segmentHtml } from "./preprocessing/segment";
import { tokenize } from "./preprocessing/tokenize";
import { rankSentencesWithRelevance, type RankerConfig } from "./scoring/ranker";
import { selectAnchorsWithPositionDiversity, type AnchorConfig } from "./extraction/anchors";
import { expandAnchors, type ExpandConfig } from "./extraction/expand";
import { fullDedupe, type DedupeConfig } from "./extraction/dedupe";
import { assembleExcerpts, type ExcerptConfig } from "./output/excerpts";
import { assessDocumentQuality, filterCitationSentences, type QualityConfig } from "./scoring/quality";
import { truncateText } from "./utils/shared";
import Logger from "./utils/logger";

export interface PipelineConfig {
    ranker?: RankerConfig;
    anchors?: AnchorConfig & { minPositionGap?: number };
    expand?: ExpandConfig;
    dedupe?: DedupeConfig;
    excerpts?: ExcerptConfig;
    quality?: QualityConfig;
    skipQualityCheck?: boolean;
    debug?: boolean;
}

export interface PipelineDebugInfo {
    sentenceCount: number;
    anchorCount: number;
    chunkCount: number;
    dedupedChunkCount: number;
    queryTermCoverage?: number;
    maxRawBm25?: number;
    hasRelevantResults?: boolean;
    topSentences: Array<{
        text: string;
        score: number;
        headingPath: string[];
    }>;
}

export interface RelevanceMetrics {
    hasRelevantResults: boolean;
    sentenceCount: number;
    queryTermCoverage: number;
    maxBm25: number;
    maxCooccurrence: number;
    qualityRejectReason?: string;
}

export interface ExtendedExtractionResult extends ExtractionResult {
    debug?: PipelineDebugInfo;
    relevanceMetrics?: RelevanceMetrics;
}

/**
 * Create an empty result with optional debug info and relevance metrics
 */
function createEmptyResult(
    query: string,
    debug: boolean,
    debugInfo?: Partial<PipelineDebugInfo>,
    relevanceMetrics?: RelevanceMetrics
): ExtendedExtractionResult {
    const result: ExtendedExtractionResult = {
        excerpts: [],
        totalChars: 0,
        query,
    };
    if (relevanceMetrics) {
        result.relevanceMetrics = relevanceMetrics;
    }
    if (debug) {
        result.debug = {
            sentenceCount: 0,
            anchorCount: 0,
            chunkCount: 0,
            dedupedChunkCount: 0,
            topSentences: [],
            ...debugInfo,
        };
    }
    return result;
}

const DEFAULT_CONFIG: PipelineConfig = {
    ranker: {
        bm25Weight: 0.6,
        heuristicWeight: 0.4,
    },
    anchors: {
        maxAnchors: 5,
        minScore: 0.25,  // Higher threshold to filter irrelevant results
        diversityThreshold: 0.4,
        minPositionGap: 5,
    },
    expand: {
        contextBefore: 5,
        contextAfter: 8,
        respectBlockBoundaries: false,
        maxChunkChars: 2000,
        includeCodeBlocks: true,
        expandToSection: true,
    },
    dedupe: {
        overlapThreshold: 0.3,
        tokenSimilarityThreshold: 0.6,
    },
    excerpts: {
        maxExcerpts: 3,
        charBudget: 6000,
        minExcerptChars: 100,
    },
    quality: {
        minLongSentences: 3,
        maxFragmentRatio: 0.65,
        minMedianLength: 25,
        minTotalSentences: 5,
    },
    skipQualityCheck: false,
    debug: false,
};

/**
 * Run the full extraction pipeline
 */
export function extractExcerpts(
    html: string,
    query: string,
    config: PipelineConfig = {}
): ExtendedExtractionResult {
    const cfg = mergeConfig(DEFAULT_CONFIG, config);
    const logger = Logger.getInstance();

    // Step 1: Preprocess HTML
    const { $, mainContent } = logger.time("1. Preprocess HTML", () => preprocessHtml(html));

    if (mainContent === null) {
        return createEmptyResult(query, cfg.debug);
    }

    // Step 2: Segment into sentences
    const { sentences: rawSentences } = logger.time("2. Segment into sentences", () => segmentHtml($, mainContent));

    if (rawSentences.length === 0) {
        return createEmptyResult(query, cfg.debug);
    }

    // Step 2a: Filter citation/reference sentences
    const { filtered: sentences, removedCount: citationsRemoved } = logger.time(
        "2a. Filter citations",
        () => filterCitationSentences(rawSentences)
    );

    if (cfg.debug && citationsRemoved > 0) {
        logger.debug(`Filtered ${citationsRemoved} citation sentences`);
    }

    if (sentences.length === 0) {
        return createEmptyResult(query, cfg.debug);
    }

    // Step 2b: Document quality gate (skip expensive scoring for garbage pages)
    if (!cfg.skipQualityCheck) {
        const quality = logger.time("2b. Quality check", () => assessDocumentQuality(sentences, cfg.quality));

        if (!quality.passesThreshold) {
            return createEmptyResult(
                query,
                cfg.debug,
                {
                    sentenceCount: sentences.length,
                    hasRelevantResults: false,
                    topSentences: [],
                },
                {
                    hasRelevantResults: false,
                    sentenceCount: sentences.length,
                    queryTermCoverage: 0,
                    maxBm25: 0,
                    maxCooccurrence: 0,
                    ...(quality.rejectReason && { qualityRejectReason: quality.rejectReason }),
                }
            );
        }
    }

    // Step 3: Tokenize query
    const queryTokens = logger.time("3. Tokenize query", () => tokenize(query));

    if (queryTokens.length === 0) {
        // Empty query after tokenization - return top sentences by position
        return extractWithoutQuery(sentences, query, cfg);
    }

    // Step 4: Rank sentences
    const rankingResult = logger.time("4. Rank sentences", () => rankSentencesWithRelevance(sentences, queryTokens, cfg.ranker));
    const rankedSentences = rankingResult.sentences;

    // Check if we have relevant results
    if (!rankingResult.hasRelevantResults) {
        return createEmptyResult(
            query,
            cfg.debug,
            {
                sentenceCount: sentences.length,
                queryTermCoverage: rankingResult.queryTermCoverage,
                maxRawBm25: rankingResult.maxRawBm25,
                hasRelevantResults: false,
                topSentences: rankedSentences.slice(0, 5).map(s => ({
                    text: truncateText(s.text),
                    score: s.combinedScore,
                    headingPath: s.headingPath,
                })),
            },
            {
                hasRelevantResults: false,
                sentenceCount: sentences.length,
                queryTermCoverage: rankingResult.queryTermCoverage,
                maxBm25: rankingResult.maxRawBm25,
                maxCooccurrence: rankingResult.maxCooccurrence,
            }
        );
    }

    // Step 5: Select anchors
    const anchors = logger.time("5. Select anchors", () => selectAnchorsWithPositionDiversity(rankedSentences, cfg.anchors));

    // Step 6: Expand anchors into chunks
    const chunks = logger.time("6. Expand anchors", () => expandAnchors(anchors, sentences, cfg.expand));

    // Step 7: Deduplicate
    const dedupedChunks = logger.time("7. Deduplicate chunks", () => fullDedupe(chunks, cfg.dedupe));

    // Step 8: Assemble excerpts
    const result = logger.time("8. Assemble excerpts", () => assembleExcerpts(dedupedChunks, query, cfg.excerpts));

    // Always include relevance metrics
    const relevanceMetrics: RelevanceMetrics = {
        hasRelevantResults: rankingResult.hasRelevantResults,
        sentenceCount: sentences.length,
        queryTermCoverage: rankingResult.queryTermCoverage,
        maxBm25: rankingResult.maxRawBm25,
        maxCooccurrence: rankingResult.maxCooccurrence,
    };

    // Add debug info if requested
    if (cfg.debug) {
        const debugInfo: PipelineDebugInfo = {
            sentenceCount: sentences.length,
            anchorCount: anchors.length,
            chunkCount: chunks.length,
            dedupedChunkCount: dedupedChunks.length,
            queryTermCoverage: rankingResult.queryTermCoverage,
            maxRawBm25: rankingResult.maxRawBm25,
            hasRelevantResults: rankingResult.hasRelevantResults,
            topSentences: rankedSentences.slice(0, 10).map(s => ({
                text: truncateText(s.text),
                score: s.combinedScore,
                headingPath: s.headingPath,
            })),
        };
        return { ...result, debug: debugInfo, relevanceMetrics };
    }

    return { ...result, relevanceMetrics };
}

/**
 * Extract excerpts when query is empty or produces no tokens
 * Falls back to position-based selection
 */
function extractWithoutQuery(
    sentences: Sentence[],
    query: string,
    cfg: Required<PipelineConfig>
): ExtendedExtractionResult {
    // Select sentences from early in the document
    const earlySentences = sentences
        .filter(s => s.position < 0.4)
        .slice(0, cfg.anchors?.maxAnchors ?? 5);

    if (earlySentences.length === 0) {
        return {
            excerpts: [],
            totalChars: 0,
            query,
        };
    }

    // Build simple excerpts from early sentences
    const excerpts = earlySentences.map(s => ({
        text: s.text,
        headingPath: s.headingPath,
        score: 1 - s.position, // Higher score for earlier content
        charCount: s.text.length,
    }));

    let totalChars = 0;
    const budget = cfg.excerpts?.charBudget ?? 2000;
    const maxExcerpts = cfg.excerpts?.maxExcerpts ?? 3;
    const selected = [];

    for (const excerpt of excerpts) {
        if (totalChars + excerpt.charCount > budget) break;
        if (selected.length >= maxExcerpts) break;
        selected.push(excerpt);
        totalChars += excerpt.charCount;
    }

    return {
        excerpts: selected,
        totalChars,
        query,
    };
}

/**
 * Deep merge configuration objects
 */
function mergeConfig(
    defaults: PipelineConfig,
    overrides: PipelineConfig
): Required<PipelineConfig> {
    return {
        ranker: { ...defaults.ranker, ...overrides.ranker },
        anchors: { ...defaults.anchors, ...overrides.anchors },
        expand: { ...defaults.expand, ...overrides.expand },
        dedupe: { ...defaults.dedupe, ...overrides.dedupe },
        excerpts: { ...defaults.excerpts, ...overrides.excerpts },
        quality: { ...defaults.quality, ...overrides.quality },
        skipQualityCheck: overrides.skipQualityCheck ?? defaults.skipQualityCheck ?? false,
        debug: overrides.debug ?? defaults.debug ?? false,
    };
}

/**
 * Extract excerpts with default settings - convenience function
 */
export function extract(html: string, query: string): ExtractionResult {
    return extractExcerpts(html, query);
}

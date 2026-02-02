import type { DensityStats, Sentence } from "../types";
import { termOverlapRatio, tokenize } from "../preprocessing/tokenize";
import { isHeadingTag, computeIdfWeightedOverlap } from "../utils/shared";

export interface HeuristicScores {
    positionScore: number;
    headingProximityScore: number;
    densityScore: number;
    structureScore: number;
    proximityScore: number;
    headingPathScore: number;
    coverageScore: number;
    outlierScore: number;
    metaSectionScore: number;
    combined: number;
}

export interface HeuristicWeights {
    position?: number;
    headingProximity?: number;
    density?: number;
    structure?: number;
    proximity?: number;
    headingPath?: number;
    coverage?: number;
    outlier?: number;
    metaSection?: number;
}

// These weights are based on vibes mostly. Lots of testing has revealed these to be the best weights for the job.
const DEFAULT_WEIGHTS: Required<HeuristicWeights> = {
    position: 0.05,
    headingProximity: 0.11,
    density: 0.09,
    structure: 0.11,
    proximity: 0.14,
    headingPath: 0.17,
    coverage: 0.16,
    outlier: 0.09,
    metaSection: 0.08,
};

/**
 * Patterns that indicate meta/structural sections rather than substantive content.
 * These sections describe or frame content rather than being the content itself.
 * Matched case-insensitively against heading text.
 */
const META_SECTION_PATTERNS: RegExp[] = [
    // Introduction/overview patterns
    /^introduction$/i,
    /^overview$/i,
    /^about(\s+this)?(\s+(article|guide|tutorial|post|page))?$/i,
    /^what('s|\s+is)\s+this/i,
    /^what\s+you('ll|.will)\s+(learn|cover|build|create)/i,
    /^what\s+we('ll|.will)\s+(learn|cover|build|create)/i,
    /^in\s+this\s+(article|guide|tutorial|post)/i,
    /^getting\s+started$/i,
    /^before\s+(you\s+)?begin/i,
    /^prerequisites?$/i,
    /^requirements?$/i,
    /^background$/i,
    /^context$/i,

    // Summary/conclusion patterns
    /^summary$/i,
    /^conclusion$/i,
    /^tl;?\s*dr$/i,
    /^takeaways?$/i,
    /^key\s+takeaways?$/i,
    /^key\s+points?$/i,
    /^wrapping\s+up$/i,
    /^final\s+thoughts?$/i,
    /^closing\s+thoughts?$/i,
    /^in\s+summary$/i,
    /^to\s+summarize$/i,
    /^recap$/i,

    // Next steps/related content
    /^next\s+steps?$/i,
    /^what('s|.is)\s+next/i,
    /^further\s+reading$/i,
    /^additional\s+resources?$/i,
    /^related\s+(articles?|posts?|content|links?|resources?)/i,
    /^see\s+also$/i,
    /^learn\s+more$/i,
    /^more\s+resources?$/i,
    /^references?$/i,
    /^sources?$/i,
    /^bibliography$/i,
    /^credits?$/i,
    /^acknowledgements?$/i,

    // Author/meta content
    /^about\s+(the\s+)?author/i,
    /^author(\s+bio)?$/i,
    /^bio(graphy)?$/i,
    /^written\s+by$/i,
    /^posted\s+by$/i,
    /^published\s+by$/i,

    // Engagement/social
    /^comments?$/i,
    /^feedback$/i,
    /^discussion$/i,
    /^share(\s+this)?$/i,
    /^subscribe$/i,
    /^newsletter$/i,
    /^follow(\s+us)?$/i,
    /^connect(\s+with\s+us)?$/i,
    /^join(\s+us)?$/i,
    /^support(\s+us)?$/i,
    /^donate$/i,
    /^buy\s+me\s+a\s+coffee/i,
    /^sponsor/i,

    // Navigation/structural
    /^table\s+of\s+contents?$/i,
    /^contents?$/i,
    /^toc$/i,
    /^navigation$/i,
    /^menu$/i,
    /^sidebar$/i,
    /^footer$/i,
    /^header$/i,
    /^breadcrumb/i,
    /^skip\s+to/i,

    // Cross-reference sections (often just link lists)
    /^see\s+also$/i,
    /^more\s+info(rmation)?$/i,
    /^external\s+links?$/i,
    /^useful\s+links?$/i,
    /^quick\s+links?$/i,
    /^related\s+topics?$/i,
    /^related\s+guides?$/i,
    /^related\s+tutorials?$/i,
    /^related\s+documentation$/i,
    /^other\s+resources?$/i,
    /^specifications?$/i,
    /^browser\s+compatibility$/i,
    /^browser\s+support$/i,

    // Disclaimers/legal
    /^disclaimer$/i,
    /^disclosure$/i,
    /^affiliate\s+disclosure/i,
    /^privacy(\s+policy)?$/i,
    /^terms(\s+(of\s+)?(use|service))?$/i,
    /^copyright$/i,
    /^legal$/i,

    // Promotional
    /^featured$/i,
    /^trending$/i,
    /^popular(\s+posts?)?$/i,
    /^recommended$/i,
    /^you\s+might\s+(also\s+)?like$/i,
    /^related\s+posts?$/i,
    /^top\s+stories$/i,
    /^latest(\s+posts?)?$/i,
    /^recent(\s+posts?)?$/i,
    /^archives?$/i,
    /^categories$/i,
    /^tags?$/i,
];

/**
 * Calculate position bonus
 * Earlier content scores higher, but with a gradual decay
 * Sentences in the first 30% get a bonus, middle is neutral, end is penalized
 */
export function calculatePositionScore(sentence: Sentence): number {
    const position = sentence.position;

    // Piecewise linear function:
    // 0.0 - 0.3: score = 1.0 to 0.7 (early content bonus)
    // 0.3 - 0.7: score = 0.7 to 0.5 (middle content, neutral)
    // 0.7 - 1.0: score = 0.5 to 0.3 (late content, slight penalty)

    if (position <= 0.3) {
        return 1.0 - (position / 0.3) * 0.3;
    } else if (position <= 0.7) {
        return 0.7 - ((position - 0.3) / 0.4) * 0.2;
    } else {
        return 0.5 - ((position - 0.7) / 0.3) * 0.2;
    }
}

/**
 * Calculate heading proximity score
 * Sentences near headings that contain query terms score higher
 */
export function calculateHeadingProximityScore(
    sentence: Sentence,
    queryTokens: string[],
    allSentences: Sentence[]
): number {
    // Find the nearest heading before this sentence
    let nearestHeading: Sentence | null = null;
    let distance = Infinity;

    for (let i = sentence.globalIndex - 1; i >= 0; i--) {
        const s = allSentences[i];
        if (s === undefined) continue;

        if (isHeadingTag(s.blockType)) {
            nearestHeading = s;
            distance = sentence.globalIndex - i;
            break;
        }
    }

    if (nearestHeading === null) {
        // No heading before this sentence
        return 0.3;
    }

    // Check if heading contains query terms
    const headingOverlap = termOverlapRatio(queryTokens, nearestHeading.tokens);

    // Combine overlap with distance (closer is better)
    // Distance decay: 1 / (1 + distance/5)
    const distanceScore = 1 / (1 + distance / 5);

    // If heading matches query terms, boost significantly
    if (headingOverlap > 0) {
        return Math.min(1.0, headingOverlap * 0.6 + distanceScore * 0.4);
    }

    // Heading doesn't match - base score on distance only
    return distanceScore * 0.5;
}

/**
 * Calculate query term density score
 * High query-term density in short sentences scores higher
 */
export function calculateDensityScore(
    sentence: Sentence,
    queryTokens: string[]
): number {
    if (sentence.tokens.length === 0 || queryTokens.length === 0) {
        return 0;
    }

    // Count query term occurrences in sentence
    const querySet = new Set(queryTokens);
    let queryTermCount = 0;
    for (const token of sentence.tokens) {
        if (querySet.has(token)) {
            queryTermCount++;
        }
    }

    // Raw density: query terms / total tokens
    const rawDensity = queryTermCount / sentence.tokens.length;

    // Unique query term coverage: how many unique query terms are present
    const uniqueQueryTerms = new Set<string>();
    for (const token of sentence.tokens) {
        if (querySet.has(token)) {
            uniqueQueryTerms.add(token);
        }
    }
    const coverage = uniqueQueryTerms.size / queryTokens.length;

    // Combined score: balance density and coverage
    // Prefer sentences that cover more query terms over those with repeated single terms
    return rawDensity * 0.4 + coverage * 0.6;
}

/**
 * Calculate structure score
 * Sentences in paragraph blocks after relevant headings score higher
 */
export function calculateStructureScore(
    sentence: Sentence,
    queryTokens: string[],
    allSentences: Sentence[]
): number {
    // Base score by block type
    let baseScore: number;
    switch (sentence.blockType) {
        case "p":
            baseScore = 0.8; // Paragraphs are most likely to contain answers
            break;
        case "li":
            baseScore = 0.7; // List items often contain procedural content
            break;
        case "pre":
            baseScore = 0.65; // Code blocks - valuable for technical queries
            break;
        default:
            // Headings themselves
            baseScore = 0.4;
    }

    // Bonus for sentences adjacent to code blocks (explanatory text)
    const codeAdjacentBonus = sentence.blockType !== "pre" &&
        allSentences.some(s =>
            s.blockType === "pre" &&
            s.globalIndex !== sentence.globalIndex &&
            Math.abs(s.globalIndex - sentence.globalIndex) <= 2
        ) ? 0.1 : 0;

    // Bonus if in the same block as other query-matching sentences
    // (indicates a relevant section)
    let sameBlockBonus = 0;
    for (const s of allSentences) {
        if (s.blockIndex === sentence.blockIndex && s.globalIndex !== sentence.globalIndex) {
            const overlap = termOverlapRatio(queryTokens, s.tokens);
            if (overlap > 0.3) {
                sameBlockBonus = Math.max(sameBlockBonus, 0.15);
            }
        }
    }

    // Bonus if heading path contains query terms
    let headingPathBonus = 0;
    for (const heading of sentence.headingPath) {
        const headingLower = heading.toLowerCase();
        for (const token of queryTokens) {
            if (headingLower.includes(token)) {
                headingPathBonus = 0.1;
                break;
            }
        }
        if (headingPathBonus > 0) break;
    }

    return Math.min(1.0, baseScore + sameBlockBonus + headingPathBonus + codeAdjacentBonus);
}

/**
 * Calculate proximity score based on how tightly clustered query terms are
 * Uses minimal spanning window algorithm
 */
export function calculateProximityScore(
    sentence: Sentence,
    queryTokens: string[]
): number {
    if (sentence.tokens.length === 0 || queryTokens.length === 0) {
        return 0;
    }

    const querySet = new Set(queryTokens);

    // Build map of query term -> positions in sentence
    const termPositions = new Map<string, number[]>();
    for (let i = 0; i < sentence.tokens.length; i++) {
        const token = sentence.tokens[i];
        if (token !== undefined && querySet.has(token)) {
            const positions = termPositions.get(token);
            if (positions === undefined) {
                termPositions.set(token, [i]);
            } else {
                positions.push(i);
            }
        }
    }

    const matchedTermCount = termPositions.size;
    if (matchedTermCount === 0) {
        return 0;
    }

    // Coverage ratio: fraction of query terms found
    const coverageRatio = matchedTermCount / queryTokens.length;

    // If only one term matched, score based on coverage only
    if (matchedTermCount === 1) {
        return coverageRatio * 0.5;
    }

    // Find minimal window spanning all matched terms using sliding window
    // Collect all positions with their term labels
    const allPositions: Array<{ pos: number; term: string }> = [];
    for (const [term, positions] of termPositions) {
        for (const pos of positions) {
            allPositions.push({ pos, term });
        }
    }
    allPositions.sort((a, b) => a.pos - b.pos);

    // Sliding window to find minimum span covering all matched terms
    let minSpan = Infinity;
    const windowTermCount = new Map<string, number>();
    let uniqueTermsInWindow = 0;
    let left = 0;

    for (let right = 0; right < allPositions.length; right++) {
        const rightItem = allPositions[right];
        if (rightItem === undefined) continue;

        const rightTerm = rightItem.term;
        const prevCount = windowTermCount.get(rightTerm) ?? 0;
        windowTermCount.set(rightTerm, prevCount + 1);
        if (prevCount === 0) {
            uniqueTermsInWindow++;
        }

        // Shrink window from left while maintaining all terms
        while (uniqueTermsInWindow === matchedTermCount) {
            const leftItem = allPositions[left];
            if (leftItem === undefined) break;

            const currentSpan = rightItem.pos - leftItem.pos + 1;
            if (currentSpan < minSpan) {
                minSpan = currentSpan;
            }

            const leftTerm = leftItem.term;
            const leftCount = windowTermCount.get(leftTerm) ?? 0;
            windowTermCount.set(leftTerm, leftCount - 1);
            if (leftCount - 1 === 0) {
                uniqueTermsInWindow--;
            }
            left++;
        }
    }

    // Span tightness: 1 - (span / sentence length), clamped
    const spanTightness = 1 - Math.min(1, minSpan / sentence.tokens.length);

    // Density within span: matched terms / span size
    const densityInSpan = matchedTermCount / minSpan;

    // Blend coverage, span tightness, and density
    return coverageRatio * 0.4 + spanTightness * 0.35 + Math.min(1, densityInSpan) * 0.25;
}

/**
 * Calculate heading path score using IDF-weighted overlap with query
 */
export function calculateHeadingPathScore(
    sentence: Sentence,
    queryTokens: string[],
    getIdf: (term: string) => number
): number {
    if (sentence.headingPath.length === 0 || queryTokens.length === 0) {
        return 0.3; // Neutral score for no heading path
    }

    // Tokenize concatenated heading path
    const headingText = sentence.headingPath.join(" ");
    const headingTokens = tokenize(headingText);

    if (headingTokens.length === 0) {
        return 0.3;
    }

    const headingSet = new Set(headingTokens);
    const idfWeightedOverlap = computeIdfWeightedOverlap(queryTokens, headingSet, getIdf);

    // Return score in [0.3, 1.0] range (0.3 is neutral baseline)
    return 0.3 + idfWeightedOverlap * 0.7;
}

/**
 * Calculate coverage score using IDF-weighted term coverage
 * Distinguishes "core" terms (high IDF) from generic terms
 */
export function calculateCoverageScore(
    sentence: Sentence,
    queryTokens: string[],
    getIdf: (term: string) => number
): number {
    if (sentence.tokens.length === 0 || queryTokens.length === 0) {
        return 0;
    }

    const sentenceSet = new Set(sentence.tokens);

    // Compute IDF-weighted coverage
    const idfWeightedCoverage = computeIdfWeightedOverlap(queryTokens, sentenceSet, getIdf);

    // Also compute simple coverage for blending
    let matchedCount = 0;
    for (const queryTerm of queryTokens) {
        if (sentenceSet.has(queryTerm)) {
            matchedCount++;
        }
    }
    const simpleCoverage = matchedCount / queryTokens.length;

    // Blend IDF-weighted and simple coverage for balance
    return idfWeightedCoverage * 0.7 + simpleCoverage * 0.3;
}

/**
 * Compute density statistics (median and MAD) for outlier detection
 */
export function computeDensityStats(
    sentences: Sentence[],
    queryTokens: string[]
): DensityStats {
    if (sentences.length === 0 || queryTokens.length === 0) {
        return { median: 0, mad: 0.001 };
    }

    const querySet = new Set(queryTokens);
    const densities: number[] = [];

    for (const sentence of sentences) {
        if (sentence.tokens.length === 0) {
            densities.push(0);
            continue;
        }

        let queryTermCount = 0;
        for (const token of sentence.tokens) {
            if (querySet.has(token)) {
                queryTermCount++;
            }
        }
        densities.push(queryTermCount / sentence.tokens.length);
    }

    // Sort for median calculation
    densities.sort((a, b) => a - b);

    // Calculate median
    const mid = Math.floor(densities.length / 2);
    const median = densities.length % 2 === 0
        ? ((densities[mid - 1] ?? 0) + (densities[mid] ?? 0)) / 2
        : (densities[mid] ?? 0);

    // Calculate MAD (Median Absolute Deviation)
    const absoluteDeviations = densities.map(d => Math.abs(d - median));
    absoluteDeviations.sort((a, b) => a - b);

    const madMid = Math.floor(absoluteDeviations.length / 2);
    let mad = absoluteDeviations.length % 2 === 0
        ? ((absoluteDeviations[madMid - 1] ?? 0) + (absoluteDeviations[madMid] ?? 0)) / 2
        : (absoluteDeviations[madMid] ?? 0);

    // Floor MAD at 0.001 to avoid division by zero
    if (mad < 0.001) {
        mad = 0.001;
    }

    return { median, mad };
}

/**
 * Check if a heading matches any meta-section pattern
 */
function isMetaHeading(heading: string): boolean {
    const trimmed = heading.trim();
    for (const pattern of META_SECTION_PATTERNS) {
        if (pattern.test(trimmed)) {
            return true;
        }
    }
    return false;
}

/**
 * Calculate meta-section score
 * Penalizes sentences that appear under meta-section headings
 * Returns 1.0 for substantive content, lower scores for meta content
 */
export function calculateMetaSectionScore(sentence: Sentence): number {
    // Check if any heading in the path is a meta-section
    for (const heading of sentence.headingPath) {
        if (isMetaHeading(heading)) {
            // Strong penalty for being under a meta heading
            return 0.2;
        }
    }

    // Also check the sentence text itself for meta-content patterns
    const text = sentence.text.toLowerCase();

    // Common meta-content phrases that indicate framing rather than substance
    const metaPhrases = [
        "in this article",
        "in this guide",
        "in this tutorial",
        "in this post",
        "we will cover",
        "we'll cover",
        "you will learn",
        "you'll learn",
        "we will explore",
        "we'll explore",
        "let's explore",
        "let's dive",
        "let's get started",
        "i will show you",
        "i'll show you",
        "we will discuss",
        "we'll discuss",
        "this article covers",
        "this guide covers",
        "this tutorial covers",
        "by the end of this",
        "after reading this",
        "if you enjoyed this",
        "if you found this helpful",
        "don't forget to",
        "make sure to subscribe",
        "leave a comment",
        "share this article",
        "follow me on",
        "check out my",
        "support my work",
        "buy me a coffee",
    ];

    for (const phrase of metaPhrases) {
        if (text.includes(phrase)) {
            return 0.3; // Moderate penalty for meta phrases in text
        }
    }

    // No meta-section indicators found - full score
    return 1.0;
}

/**
 * Calculate outlier score for sentences with unusually high query term density
 */
export function calculateOutlierScore(
    sentence: Sentence,
    queryTokens: string[],
    densityStats: DensityStats
): number {
    if (sentence.tokens.length === 0 || queryTokens.length === 0) {
        return 0.3; // Neutral score
    }

    const querySet = new Set(queryTokens);
    let queryTermCount = 0;
    for (const token of sentence.tokens) {
        if (querySet.has(token)) {
            queryTermCount++;
        }
    }

    const density = queryTermCount / sentence.tokens.length;

    // Calculate z-score using MAD
    const zScore = (density - densityStats.median) / densityStats.mad;

    // Return neutral for at-or-below-median sentences
    if (zScore <= 0) {
        return 0.3;
    }

    // Map positive outliers to [0.3, 1.0] via sigmoid
    // Shifted so z=0 → 0.3, z=2 → ~0.5, z=4 → ~0.87
    const sigmoid = 1 / (1 + Math.exp(-(zScore - 2)));
    return 0.3 + 0.7 * sigmoid;
}

/**
 * Calculate all heuristic scores for a sentence
 */
export function calculateHeuristicScores(
    sentence: Sentence,
    queryTokens: string[],
    allSentences: Sentence[],
    getIdf: (term: string) => number,
    densityStats: DensityStats,
    weights: HeuristicWeights = {}
): HeuristicScores {
    const w = { ...DEFAULT_WEIGHTS, ...weights };

    const positionScore = calculatePositionScore(sentence);
    const headingProximityScore = calculateHeadingProximityScore(sentence, queryTokens, allSentences);
    const densityScore = calculateDensityScore(sentence, queryTokens);
    const structureScore = calculateStructureScore(sentence, queryTokens, allSentences);
    const proximityScore = calculateProximityScore(sentence, queryTokens);
    const headingPathScore = calculateHeadingPathScore(sentence, queryTokens, getIdf);
    const coverageScore = calculateCoverageScore(sentence, queryTokens, getIdf);
    const outlierScore = calculateOutlierScore(sentence, queryTokens, densityStats);
    const metaSectionScore = calculateMetaSectionScore(sentence);

    const combined =
        w.position * positionScore +
        w.headingProximity * headingProximityScore +
        w.density * densityScore +
        w.structure * structureScore +
        w.proximity * proximityScore +
        w.headingPath * headingPathScore +
        w.coverage * coverageScore +
        w.outlier * outlierScore +
        w.metaSection * metaSectionScore;

    return {
        positionScore,
        headingProximityScore,
        densityScore,
        structureScore,
        proximityScore,
        headingPathScore,
        coverageScore,
        outlierScore,
        metaSectionScore,
        combined,
    };
}

/**
 * Score all sentences with heuristics
 */
export function scoreAllSentencesHeuristics(
    sentences: Sentence[],
    queryTokens: string[],
    getIdf: (term: string) => number,
    weights: HeuristicWeights = {}
): Map<number, HeuristicScores> {
    const scores = new Map<number, HeuristicScores>();

    // Pre-compute density stats before iterating
    const densityStats = computeDensityStats(sentences, queryTokens);

    for (const sentence of sentences) {
        const heuristics = calculateHeuristicScores(
            sentence,
            queryTokens,
            sentences,
            getIdf,
            densityStats,
            weights
        );
        scores.set(sentence.globalIndex, heuristics);
    }

    return scores;
}

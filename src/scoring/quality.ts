/**
 * Document-level quality assessment
 * Determines if a document is worth extracting from before expensive scoring
 */

import type { Sentence } from "../types";
import { calculateMedian } from "../utils/shared";

/**
 * Strong citation indicators - high confidence these are reference/bibliography content
 */
const CITATION_PATTERNS: RegExp[] = [
    // Wikipedia-style caret reference markers: ^ or ^ a b c d e
    // Matches: ^ Foo, ^ a b Foo, ^ "Quoted title", etc.
    /^\^\s*([a-z]\s*)*["'\w]/i,

    // "Retrieved DATE" - very specific to citations
    /\bretrieved\s+\d{1,2}\s+\w+\s+\d{4}/i,
    /\bretrieved\s+\w+\s+\d{1,2},?\s+\d{4}/i,

    // "Accessed DATE"
    /\baccessed\s+\d{1,2}\s+\w+\s+\d{4}/i,
    /\baccessed\s+\w+\s+\d{1,2},?\s+\d{4}/i,

    // "Archived from the original"
    /\barchived\s+from\s+(the\s+)?original/i,

    // Academic identifiers
    /\bdoi\s*:\s*10\.\d+/i,
    /\bisbn\s*[-:]?\s*[\d-]{10,}/i,
    /\bpmid\s*[-:]?\s*\d+/i,
    /\barxiv\s*[-:]?\s*[\d.]+/i,
    /\bissn\s*[-:]?\s*[\d-]+/i,

    // Numbered reference at start: [1], [2], etc.
    /^\[\d+\]\s*["'\w]/,
];

/**
 * Patterns for short sentences (< 50 chars) that indicate citation fragments
 */
const SHORT_CITATION_PATTERNS: RegExp[] = [
    // Just a domain name
    /^[a-z][a-z0-9-]*\.(com|org|net|edu|gov|io|co\.uk)\.*$/i,

    // Just "Retrieved" or "Accessed" at start (fragment)
    /^retrieved\s+/i,
    /^accessed\s+/i,

    // Common publication/site names as standalone fragments
    /^(github|arxiv|wired|ars\s*technica|the\s+register|lwn|nist|ieee|acm|cisa|suse|ubuntu|red\s*hat|openssf|bleepingcomputer|help\s+net\s+security|decipher|the\s+record|the\s+new\s+york\s+times|the\s+verge|omg!\s*ubuntu)\.*$/i,

    // Standalone date that looks like citation date
    /^\d{1,2}\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\.*$/i,

    // Short fragment: just a proper noun phrase (1-4 capitalized words) with optional trailing date
    // Matches: "National Vulnerability Database.", "Oxide Computer Company. 14 August 2025."
    /^([A-Z][a-z]*\s*){1,5}\.(\s+\d{1,2}\s+\w+\s+\d{4}\.?)?$/,

    // Short fragment ending with just a date (likely citation date)
    /\.\s+\d{1,2}\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\.?$/i,
];

/**
 * Check if a sentence appears to be citation/reference content
 */
export function isCitationSentence(sentence: Sentence): boolean {
    const text = sentence.text.trim();

    // Check strong citation patterns
    for (const pattern of CITATION_PATTERNS) {
        if (pattern.test(text)) {
            return true;
        }
    }

    // For short sentences, check fragment patterns
    if (text.length < 50) {
        for (const pattern of SHORT_CITATION_PATTERNS) {
            if (pattern.test(text)) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Filter out citation sentences from a list
 * Returns filtered list and count of removed sentences
 */
export function filterCitationSentences(sentences: Sentence[]): {
    filtered: Sentence[];
    removedCount: number;
} {
    const filtered: Sentence[] = [];
    let removedCount = 0;

    for (const sentence of sentences) {
        if (isCitationSentence(sentence)) {
            removedCount++;
        } else {
            filtered.push(sentence);
        }
    }

    return { filtered, removedCount };
}

export interface DocumentQuality {
    /** Total number of sentences */
    totalSentences: number;
    /** Sentences with > 50 characters */
    longSentenceCount: number;
    /** Median sentence length in characters */
    medianSentenceLength: number;
    /** Ratio of short sentences (< 30 chars) to total */
    fragmentRatio: number;
    /** Whether the document passes quality thresholds */
    passesThreshold: boolean;
    /** Reason for rejection if failed */
    rejectReason?: string;
}

export interface QualityConfig {
    /** Minimum number of long sentences (> 50 chars) required */
    minLongSentences?: number;
    /** Maximum allowed fragment ratio (sentences < 30 chars) */
    maxFragmentRatio?: number;
    /** Minimum median sentence length */
    minMedianLength?: number;
    /** Minimum total sentences */
    minTotalSentences?: number;
}

const DEFAULT_CONFIG: Required<QualityConfig> = {
    minLongSentences: 3,
    maxFragmentRatio: 0.65,
    minMedianLength: 25,
    minTotalSentences: 5,
};

/**
 * Assess document quality based on sentence characteristics
 * Call this after segmentation but before expensive scoring
 */
export function assessDocumentQuality(
    sentences: Sentence[],
    config: QualityConfig = {}
): DocumentQuality {
    const {
        minLongSentences,
        maxFragmentRatio,
        minMedianLength,
        minTotalSentences,
    } = { ...DEFAULT_CONFIG, ...config };

    const totalSentences = sentences.length;

    // Early exit for empty documents
    if (totalSentences === 0) {
        return {
            totalSentences: 0,
            longSentenceCount: 0,
            medianSentenceLength: 0,
            fragmentRatio: 1,
            passesThreshold: false,
            rejectReason: "No sentences found",
        };
    }

    // Calculate sentence lengths
    const lengths = sentences.map(s => s.text.length);

    // Count long sentences (> 50 chars) - these are real content
    const longSentenceCount = lengths.filter(len => len > 50).length;

    // Count fragments (< 30 chars) - navigation, metadata, UI elements
    const fragmentCount = lengths.filter(len => len < 30).length;
    const fragmentRatio = fragmentCount / totalSentences;

    // Calculate median
    const medianSentenceLength = calculateMedian(lengths);

    // Apply thresholds
    let passesThreshold = true;
    let rejectReason: string | undefined;

    if (totalSentences < minTotalSentences) {
        passesThreshold = false;
        rejectReason = `Too few sentences (${totalSentences} < ${minTotalSentences})`;
    } else if (longSentenceCount < minLongSentences) {
        passesThreshold = false;
        rejectReason = `Too few long sentences (${longSentenceCount} < ${minLongSentences})`;
    } else if (fragmentRatio > maxFragmentRatio) {
        passesThreshold = false;
        rejectReason = `Too many fragments (${(fragmentRatio * 100).toFixed(0)}% > ${maxFragmentRatio * 100}%)`;
    } else if (medianSentenceLength < minMedianLength) {
        passesThreshold = false;
        rejectReason = `Median sentence too short (${medianSentenceLength.toFixed(0)} < ${minMedianLength})`;
    }

    return {
        totalSentences,
        longSentenceCount,
        medianSentenceLength,
        fragmentRatio,
        passesThreshold,
        ...(rejectReason && { rejectReason }),
    };
}

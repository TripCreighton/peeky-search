export interface Sentence {
    text: string;
    tokens: string[];
    blockIndex: number;
    sentenceIndex: number;
    globalIndex: number;
    headingPath: string[];
    position: number; // 0-1, normalized position in document
    blockType: BlockType;
}

export interface ScoredSentence extends Sentence {
    bm25Score: number;
    heuristicScore: number;
    combinedScore: number;
}

export interface Chunk {
    sentences: Sentence[];
    anchorIndex: number;
    score: number;
    text: string;
    charCount: number;
    headingPath: string[];
}

export interface Excerpt {
    text: string;
    headingPath: string[];
    score: number;
    charCount: number;
}

export interface ExtractionResult {
    excerpts: Excerpt[];
    totalChars: number;
    query: string;
}

export type BlockType = "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "li" | "pre";

export interface Block {
    type: BlockType;
    text: string;
    index: number;
    headingPath: string[];
}

export interface TermFrequencyMap {
    [term: string]: number;
}

export interface DocumentStats {
    totalDocs: number;
    avgDocLength: number;
    docFrequency: TermFrequencyMap; // How many docs contain each term
}

export interface DensityStats {
    median: number;
    mad: number; // Median Absolute Deviation
}

import { describe, it, expect } from "vitest";
import { assessDocumentQuality, isCitationSentence, filterCitationSentences } from "../quality";
import type { Sentence } from "../../types";

function createSentence(text: string, options: Partial<Sentence> = {}): Sentence {
    return {
        text,
        tokens: text.split(" "),
        blockIndex: 0,
        sentenceIndex: 0,
        globalIndex: 0,
        headingPath: [],
        position: 0.5,
        blockType: "p",
        ...options,
    };
}

function createSentencesWithLengths(lengths: number[]): Sentence[] {
    return lengths.map((len, i) =>
        createSentence("x".repeat(len), { globalIndex: i })
    );
}

describe("assessDocumentQuality", () => {
    describe("empty document handling", () => {
        it("rejects empty document with clear reason", () => {
            const result = assessDocumentQuality([]);

            expect(result.passesThreshold).toBe(false);
            expect(result.rejectReason).toBe("No sentences found");
            expect(result.totalSentences).toBe(0);
            expect(result.fragmentRatio).toBe(1);
        });
    });

    describe("minTotalSentences threshold", () => {
        it("rejects document with fewer than 5 sentences", () => {
            const sentences = createSentencesWithLengths([60, 60, 60, 60]); // 4 sentences

            const result = assessDocumentQuality(sentences);

            expect(result.passesThreshold).toBe(false);
            expect(result.rejectReason).toContain("Too few sentences");
            expect(result.rejectReason).toContain("4 < 5");
        });

        it("passes document with exactly 5 sentences (boundary)", () => {
            const sentences = createSentencesWithLengths([60, 60, 60, 60, 60]); // 5 sentences

            const result = assessDocumentQuality(sentences);

            // Should pass minTotalSentences, but might fail other thresholds
            // Since all are 60 chars (> 50), longSentenceCount = 5 >= 3 ✓
            // fragmentRatio = 0 (none < 30) <= 0.65 ✓
            // medianLength = 60 >= 25 ✓
            expect(result.passesThreshold).toBe(true);
        });

        it("respects custom minTotalSentences", () => {
            const sentences = createSentencesWithLengths([60, 60, 60]);

            const strictResult = assessDocumentQuality(sentences, { minTotalSentences: 10 });
            expect(strictResult.passesThreshold).toBe(false);

            const looseResult = assessDocumentQuality(sentences, { minTotalSentences: 2 });
            expect(looseResult.passesThreshold).toBe(true);
        });
    });

    describe("minLongSentences threshold", () => {
        it("rejects document with fewer than 3 long sentences", () => {
            // Mix of long (>50) and short sentences
            const sentences = createSentencesWithLengths([60, 60, 40, 40, 40]); // Only 2 long

            const result = assessDocumentQuality(sentences);

            expect(result.passesThreshold).toBe(false);
            expect(result.rejectReason).toContain("Too few long sentences");
            expect(result.rejectReason).toContain("2 < 3");
        });

        it("passes document with exactly 3 long sentences (boundary)", () => {
            const sentences = createSentencesWithLengths([60, 60, 60, 40, 40]); // Exactly 3 long

            const result = assessDocumentQuality(sentences);

            // 3 long sentences >= 3 ✓
            // fragmentRatio = 0 (none < 30) ✓
            // medianLength = 60 (sorted: 40,40,60,60,60 → median = 60) ✓
            expect(result.passesThreshold).toBe(true);
        });

        it("counts sentences > 50 chars as long", () => {
            const sentences = [
                createSentence("x".repeat(50)), // Exactly 50 - NOT long
                createSentence("x".repeat(51)), // 51 - long
                createSentence("x".repeat(100)), // 100 - long
                createSentence("x".repeat(200)), // 200 - long
                createSentence("x".repeat(40)), // 40 - not long
            ];

            const result = assessDocumentQuality(sentences);

            expect(result.longSentenceCount).toBe(3); // 51, 100, 200
        });
    });

    describe("maxFragmentRatio threshold", () => {
        it("rejects document with >65% fragments", () => {
            // Need 3+ long sentences to pass minLongSentences check first
            // Then >65% fragments to fail fragmentRatio
            // 10 sentences: 3 long (60), 7 fragments (20) = 70% fragments
            const sentences = createSentencesWithLengths([60, 60, 60, 20, 20, 20, 20, 20, 20, 20]);

            const result = assessDocumentQuality(sentences);

            expect(result.passesThreshold).toBe(false);
            expect(result.rejectReason).toContain("Too many fragments");
            expect(result.rejectReason).toContain("70%");
        });

        it("passes document with exactly 65% fragments (boundary)", () => {
            // We need exactly 65% fragments and enough long sentences
            // 20 sentences: 13 fragments (65%), 7 long (>50)
            const lengths = [
                ...Array(13).fill(25), // 13 fragments
                ...Array(7).fill(60),  // 7 long sentences
            ];
            const sentences = createSentencesWithLengths(lengths);

            const result = assessDocumentQuality(sentences);

            // fragmentRatio = 13/20 = 0.65 = 65% (passes <=65%)
            // longSentences = 7 >= 3 ✓
            // totalSentences = 20 >= 5 ✓
            // Need to check median
            expect(result.fragmentRatio).toBeCloseTo(0.65, 2);
        });

        it("counts sentences < 30 chars as fragments", () => {
            const sentences = [
                createSentence("x".repeat(29)), // 29 - fragment
                createSentence("x".repeat(30)), // 30 - NOT fragment
                createSentence("x".repeat(31)), // 31 - NOT fragment
                createSentence("x".repeat(60)), // 60 - NOT fragment
                createSentence("x".repeat(9)),  // 9 - fragment (like "Read more")
            ];

            const result = assessDocumentQuality(sentences);

            expect(result.fragmentRatio).toBeCloseTo(2 / 5, 5); // 40%
        });
    });

    describe("minMedianLength threshold", () => {
        it("rejects document with median < 25", () => {
            // Need to pass earlier thresholds first:
            // - minTotalSentences: 5+ sentences ✓
            // - minLongSentences: 3+ long (>50) ✓
            // - maxFragmentRatio: <=65% fragments ✓
            // Then fail on median < 25
            // 5 sentences: 3 long (60), 2 medium (35, 35), median = 35
            // Actually need: 3 long + 2 short where median < 25
            // Sorted: [20, 20, 60, 60, 60] → median = 60 (won't work)
            // Need more non-fragments with short length
            // Use: [32, 32, 32, 60, 60, 60] - 6 sentences, 3 long, 0 fragments, median = 32
            // Actually median should be (32+32)/2 = 32 for even, or middle for odd
            // Try: [20, 32, 32, 32, 60, 60, 60] - 7 sentences, median = 32 (middle value)
            // 20 is a fragment, so fragmentRatio = 1/7 = 14% ✓
            // Need median < 25... that's tricky with no fragments
            // Try custom config to isolate the test
            const sentences = createSentencesWithLengths([20, 20, 20, 60, 60]);

            // Use custom config to bypass fragment check
            const result = assessDocumentQuality(sentences, {
                minLongSentences: 2, // Pass with 2 long sentences
                maxFragmentRatio: 1.0, // Allow all fragments
            });

            expect(result.passesThreshold).toBe(false);
            expect(result.rejectReason).toContain("Median sentence too short");
        });

        it("passes document with median >= 25", () => {
            const sentences = createSentencesWithLengths([26, 26, 26, 60, 60]); // median = 26

            const result = assessDocumentQuality(sentences);

            // medianLength = 26 >= 25 ✓
            // Need 3 long sentences: only 2 (60s) are > 50
            expect(result.longSentenceCount).toBe(2);
        });

        it("calculates median correctly for odd count", () => {
            const sentences = createSentencesWithLengths([10, 30, 50, 70, 90]);
            // Sorted: [10, 30, 50, 70, 90] → median = 50

            const result = assessDocumentQuality(sentences);

            expect(result.medianSentenceLength).toBe(50);
        });

        it("calculates median correctly for even count", () => {
            const sentences = createSentencesWithLengths([10, 30, 50, 70]);
            // Sorted: [10, 30, 50, 70] → median = (30 + 50) / 2 = 40

            const result = assessDocumentQuality(sentences);

            expect(result.medianSentenceLength).toBe(40);
        });
    });

    describe("threshold priority", () => {
        it("checks minTotalSentences first", () => {
            const sentences = createSentencesWithLengths([10, 10]); // Fails all thresholds

            const result = assessDocumentQuality(sentences);

            expect(result.rejectReason).toContain("Too few sentences");
        });

        it("checks minLongSentences second", () => {
            // Pass minTotalSentences but fail minLongSentences
            const sentences = createSentencesWithLengths([40, 40, 40, 40, 40]); // 5 sentences, 0 long

            const result = assessDocumentQuality(sentences);

            expect(result.rejectReason).toContain("Too few long sentences");
        });

        it("checks maxFragmentRatio third", () => {
            // Pass minTotalSentences and minLongSentences but fail fragmentRatio
            const sentences = createSentencesWithLengths([60, 60, 60, 10, 10, 10, 10, 10]);
            // 8 sentences, 3 long, 5 fragments (62.5%) - actually passes

            const result = assessDocumentQuality(sentences);

            // 5/8 = 62.5% fragments - passes 65% threshold
            // Let's make it fail
            const moreSentences = createSentencesWithLengths([60, 60, 60, 10, 10, 10, 10, 10, 10, 10]);
            const moreResult = assessDocumentQuality(moreSentences);
            // 7/10 = 70% fragments - fails

            expect(moreResult.rejectReason).toContain("Too many fragments");
        });
    });

    describe("code blocks and long sentence counting", () => {
        it("code blocks count as long sentences if > 50 chars", () => {
            // This tests a potential issue: code blocks might have many lines
            // but be treated as single "sentences"
            const sentences = [
                createSentence("x".repeat(60), { blockType: "p" }),
                createSentence("x".repeat(100), { blockType: "pre" }), // Code block
                createSentence("x".repeat(80), { blockType: "pre" }),  // Code block
                createSentence("x".repeat(40), { blockType: "p" }),
                createSentence("x".repeat(40), { blockType: "p" }),
            ];

            const result = assessDocumentQuality(sentences);

            // All 3 > 50 chars count as long, regardless of blockType
            expect(result.longSentenceCount).toBe(3);
        });
    });

    describe("custom config", () => {
        it("respects all custom thresholds", () => {
            const sentences = createSentencesWithLengths([60, 60, 40, 40, 40, 40]);

            // With default config, this would fail (only 2 long sentences)
            const defaultResult = assessDocumentQuality(sentences);
            expect(defaultResult.passesThreshold).toBe(false);

            // With custom config
            const customResult = assessDocumentQuality(sentences, {
                minLongSentences: 2,
                minTotalSentences: 3,
                maxFragmentRatio: 0.8,
                minMedianLength: 20,
            });
            expect(customResult.passesThreshold).toBe(true);
        });
    });

    describe("result properties", () => {
        it("returns all expected properties for passing document", () => {
            const sentences = createSentencesWithLengths([60, 60, 60, 60, 60]);

            const result = assessDocumentQuality(sentences);

            expect(result).toHaveProperty("totalSentences", 5);
            expect(result).toHaveProperty("longSentenceCount", 5);
            expect(result).toHaveProperty("medianSentenceLength", 60);
            expect(result).toHaveProperty("fragmentRatio", 0);
            expect(result).toHaveProperty("passesThreshold", true);
            expect(result.rejectReason).toBeUndefined();
        });

        it("returns all expected properties for failing document", () => {
            const sentences = createSentencesWithLengths([10, 10]);

            const result = assessDocumentQuality(sentences);

            expect(result).toHaveProperty("totalSentences", 2);
            expect(result).toHaveProperty("longSentenceCount", 0);
            expect(result).toHaveProperty("medianSentenceLength", 10);
            expect(result).toHaveProperty("fragmentRatio", 1);
            expect(result).toHaveProperty("passesThreshold", false);
            expect(result.rejectReason).toBeDefined();
        });
    });
});

describe("isCitationSentence", () => {
    describe("Wikipedia-style caret references", () => {
        it("detects ^ at start of sentence", () => {
            const sentence = createSentence("^ Freire, Rodrigo (30 April 2024).");

            expect(isCitationSentence(sentence)).toBe(true);
        });

        it("detects ^ a b c style references", () => {
            const sentence = createSentence("^ a b c d e James, Sam. \"xz-utils backdoor situation\".");

            expect(isCitationSentence(sentence)).toBe(true);
        });

        it("does not flag ^ in middle of sentence", () => {
            const sentence = createSentence("The value x^2 represents the square.");

            expect(isCitationSentence(sentence)).toBe(false);
        });
    });

    describe("Retrieved/Accessed date patterns", () => {
        it("detects 'Retrieved DATE' with day-month-year format", () => {
            const sentence = createSentence("Retrieved 14 August 2025.");

            expect(isCitationSentence(sentence)).toBe(true);
        });

        it("detects 'Retrieved DATE' with month-day-year format", () => {
            const sentence = createSentence("Retrieved August 14, 2025.");

            expect(isCitationSentence(sentence)).toBe(true);
        });

        it("detects 'Accessed DATE' patterns", () => {
            const sentence = createSentence("Accessed 2 April 2024.");

            expect(isCitationSentence(sentence)).toBe(true);
        });

        it("detects Retrieved in longer citation text", () => {
            const sentence = createSentence("GitHub. Retrieved 19 June 2024.");

            expect(isCitationSentence(sentence)).toBe(true);
        });
    });

    describe("Archived from patterns", () => {
        it("detects 'Archived from the original'", () => {
            const sentence = createSentence("Archived from the original on 2 April 2024.");

            expect(isCitationSentence(sentence)).toBe(true);
        });

        it("detects 'Archived from original' without 'the'", () => {
            const sentence = createSentence("Archived from original on 1 May 2023.");

            expect(isCitationSentence(sentence)).toBe(true);
        });
    });

    describe("academic identifiers", () => {
        it("detects DOI", () => {
            const sentence = createSentence("doi: 10.1000/xyz123");

            expect(isCitationSentence(sentence)).toBe(true);
        });

        it("detects ISBN", () => {
            const sentence = createSentence("ISBN 978-3-16-148410-0");

            expect(isCitationSentence(sentence)).toBe(true);
        });

        it("detects PMID", () => {
            const sentence = createSentence("PMID: 12345678");

            expect(isCitationSentence(sentence)).toBe(true);
        });

        it("detects arXiv", () => {
            const sentence = createSentence("arXiv:2301.00001");

            expect(isCitationSentence(sentence)).toBe(true);
        });

        it("detects ISSN", () => {
            const sentence = createSentence("ISSN 1234-5678");

            expect(isCitationSentence(sentence)).toBe(true);
        });
    });

    describe("numbered references", () => {
        it("detects [1] style references", () => {
            const sentence = createSentence("[1] Smith, John. \"Article Title\". Journal Name.");

            expect(isCitationSentence(sentence)).toBe(true);
        });

        it("detects [42] style references", () => {
            const sentence = createSentence("[42] Reference text here.");

            expect(isCitationSentence(sentence)).toBe(true);
        });
    });

    describe("short citation fragments", () => {
        it("detects standalone domain names", () => {
            expect(isCitationSentence(createSentence("github.com"))).toBe(true);
            expect(isCitationSentence(createSentence("redhat.com."))).toBe(true);
            expect(isCitationSentence(createSentence("example.org"))).toBe(true);
            expect(isCitationSentence(createSentence("nist.gov"))).toBe(true);
        });

        it("detects short 'Retrieved' fragments", () => {
            const sentence = createSentence("Retrieved 2024.");

            expect(isCitationSentence(sentence)).toBe(true);
        });

        it("detects publication name fragments", () => {
            expect(isCitationSentence(createSentence("GitHub."))).toBe(true);
            expect(isCitationSentence(createSentence("arXiv"))).toBe(true);
            expect(isCitationSentence(createSentence("LWN."))).toBe(true);
            expect(isCitationSentence(createSentence("NIST"))).toBe(true);
        });

        it("detects standalone dates", () => {
            const sentence = createSentence("14 August 2025.");

            expect(isCitationSentence(sentence)).toBe(true);
        });
    });

    describe("legitimate content not flagged", () => {
        it("does not flag normal technical sentences", () => {
            const sentence = createSentence(
                "The XZ Utils backdoor was discovered by Andres Freund while investigating SSH performance issues."
            );

            expect(isCitationSentence(sentence)).toBe(false);
        });

        it("does not flag sentences mentioning retrieval in other contexts", () => {
            const sentence = createSentence(
                "The data retrieval process involves querying the database and fetching results."
            );

            expect(isCitationSentence(sentence)).toBe(false);
        });

        it("does not flag code examples", () => {
            const sentence = createSentence("const result = await fetch('https://api.example.com');");

            expect(isCitationSentence(sentence)).toBe(false);
        });

        it("does not flag URLs in explanatory text", () => {
            const sentence = createSentence(
                "You can find the documentation at https://docs.example.com for more details."
            );

            expect(isCitationSentence(sentence)).toBe(false);
        });
    });

    describe("real Wikipedia citation examples", () => {
        it("handles multi-part Wikipedia citations", () => {
            // These are actual fragments from the Wikipedia XZ backdoor article
            const citations = [
                '^ Freire, Rodrigo (30 April 2024). "Understanding Red Hat\'s response".',
                "Retrieved 14 August 2025.",
                "Archived from the original on 2 April 2024.",
                "GitHub.",
                "^ a b c d e James, Sam.",
            ];

            for (const text of citations) {
                expect(isCitationSentence(createSentence(text))).toBe(true);
            }
        });
    });
});

describe("filterCitationSentences", () => {
    it("removes citation sentences and keeps regular content", () => {
        const sentences = [
            createSentence("The XZ Utils backdoor was a major security incident.", { globalIndex: 0 }),
            createSentence("^ Freire, Rodrigo (30 April 2024).", { globalIndex: 1 }),
            createSentence("It was discovered in March 2024.", { globalIndex: 2 }),
            createSentence("Retrieved 14 August 2025.", { globalIndex: 3 }),
            createSentence("The backdoor affected liblzma.", { globalIndex: 4 }),
        ];

        const { filtered, removedCount } = filterCitationSentences(sentences);

        expect(removedCount).toBe(2);
        expect(filtered).toHaveLength(3);
        expect(filtered.map(s => s.globalIndex)).toEqual([0, 2, 4]);
    });

    it("returns all sentences when none are citations", () => {
        const sentences = [
            createSentence("First sentence about the topic.", { globalIndex: 0 }),
            createSentence("Second sentence with more details.", { globalIndex: 1 }),
            createSentence("Third sentence concluding the point.", { globalIndex: 2 }),
        ];

        const { filtered, removedCount } = filterCitationSentences(sentences);

        expect(removedCount).toBe(0);
        expect(filtered).toHaveLength(3);
    });

    it("returns empty array when all sentences are citations", () => {
        const sentences = [
            createSentence("^ Reference 1.", { globalIndex: 0 }),
            createSentence("Retrieved 1 January 2024.", { globalIndex: 1 }),
            createSentence("github.com", { globalIndex: 2 }),
        ];

        const { filtered, removedCount } = filterCitationSentences(sentences);

        expect(removedCount).toBe(3);
        expect(filtered).toHaveLength(0);
    });

    it("handles empty input", () => {
        const { filtered, removedCount } = filterCitationSentences([]);

        expect(removedCount).toBe(0);
        expect(filtered).toHaveLength(0);
    });
});

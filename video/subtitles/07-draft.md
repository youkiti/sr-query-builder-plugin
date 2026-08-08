---
scene: "07"
slug: draft
---

## cue 01
Generating and validating the search strategy — the heart of this extension. Generation and validation are combined into a single button. Pressing it assembles the search terms block by block, queries PubMed each time to count hits, and finally checks the seed paper capture rate, all automatically.

## cue 02
Let's press it. A progress tracker appears at the top. This run has twenty steps in total.

## cue 03
First, the generation phase. It works through four tasks for each block: designing the skeleton of the search terms, proposing MeSH terms, expanding free-text synonyms, and counting hits at that point. You can see it working through block 1 and onward.

## cue 04
On the right, the hit count for each block fills in as soon as it's measured. If a count is extremely low the terms are too narrow; if it's extremely high they're too broad — and you can tell right away. The point of this display is that you notice without waiting for the whole build to finish.

## cue 05
Once generation completes, the validation phase begins. It totals the hits per line, checks the seed paper capture rate, retrieves the MeSH terms on the seed papers along with their hierarchy, and records the results.

## cue 06
And it's done — this is the generated search strategy. There's one line per block, with the combination expression on the last line. The colors distinguish the kinds of search terms: blue for MeSH terms, green for free-text words searched in titles and abstracts. A legend appears below, so you can read the strategy while seeing how much each kind contributes. At this point it's already in a form you can paste straight into PubMed.

## cue 07
Below that are the results of the validation that just ran: hits per line, the overall count, the seed paper capture rate, and the MeSH analysis. How to read these results, and what to fix based on them, is covered in detail in the next chapter.

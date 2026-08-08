---
scene: "08"
slug: validation
---

## cue 01
Let's read through the validation results from the run in the previous chapter. At the top, you can see which version of the search strategy you're looking at. Below that, the findings are grouped under three headings.

## cue 02
The first is hits per line. Block 1 returned 8 records, block 2 returned 6, block 3 returned 10, and the final line combining all three returned 4. A line with an extremely low count is a hint that the concept is missing synonyms.

## cue 03
The second is the most important metric on this screen: the seed paper capture rate. Four records overall, and a capture rate of 80 percent — 4 out of 5. The strategy is missing one of the papers you said it absolutely had to retrieve, and its PMID is listed right here.

## cue 04
You can have the AI analyze why a paper was missed. Pressing this button reports, for each missed paper, which block appears to be responsible, why it didn't match, and which terms would bring it back. Here, block 2 is the cause, and adding a MeSH term would capture it.

## cue 05
The third is the list of MeSH terms assigned to your seed papers, ordered by frequency, so you can check what concepts this set has in common. Below it, the hierarchy is output in Mermaid notation. That's text rather than a rendered diagram — paste it into the site listed there to draw it.

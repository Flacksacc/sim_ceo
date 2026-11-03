# Advisor character and meeting behavior

Latest user direction, 2026-11-03. This supersedes fixed tone selectors, many independently configured personality attributes, and the old independent board-profile-copy design. It is an acceptance specification, not a claim that implementation is deployed.

The user supplies an advisor name and description. Background and a few web links are optional. A short research run, targeting two to three minutes with a total hard deadline of no more than three minutes, compiles the character into three short paragraphs the user can edit:

| Paragraph | Purpose |
| --- | --- |
| When to contribute | Expertise, relevant questions, and criteria for contributing or staying out of a discussion. |
| How to reason | The character's perspective, methods, evidence needs, limits, and circumstances for agreeing, disagreeing or challenging an assumption. |
| How to respond | Context-sensitive expression grounded in that character: circumstances for bluntness, diplomacy, formality, brevity or detail. |

Research informs all three paragraphs. Avoid generic defaults such as humorous, blunt or formal as fixed personality settings. Keep researched facts distinct from interpretations and fictional characterization. Do not invent credentials or imply a simulated advisor is the real person who inspired it.

The interface shows real research stages, a compiled summary and sources, and the three compact editable paragraphs. Preserve the user's inputs on failure. Incomplete research remains visibly incomplete. There is one creation path and an explicit final save; creation does not automatically attach or approve a board advisor.

The saved paragraphs are operational input. The meeting selection/bidding step uses contribution criteria. Every advisor answer uses the current character reasoning and response instructions, together with authorized meeting context and the user's communication preferences. Roster chat and audition use the same character contract. Essential character instructions must not disappear through blind profile truncation. Changes retire pending replies based on the previous version.

All board advisors must reference canonical roster entries visible to the authorized user. Fix legacy filtering and recover genuinely missing entries without duplicate people, cross-account merges, lost board memberships, roles, images or message history. Roster changes affect subsequent board behavior. Preserve existing profiles and metadata through backward-compatible interpretation; do not silently rewrite existing characters.

Completion requires independent AI review, primary inspection and meaningful verification of the integrated app: create and research, edit and save, reload, roster visibility and recovery, board attachment, participant settings, character-aware selection and answers, direct roster chat, history/privacy/version handling, bounded timeout and error recovery, and persistence. Static component presence, self-rated auditions or actor PASS summaries do not establish completion. Real provider checks must be distinguished from deterministic fixture tests.

Deploy coherent verified slices as ready. Notify the user when all advisor-related work is tested and live; do not label a component or undeployed branch as completed advisor functionality.

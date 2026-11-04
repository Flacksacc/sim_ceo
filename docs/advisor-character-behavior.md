# Advisor character and meeting behavior

## Independent judgment and constructive challenge (2026-11-04)

Every meeting answer, optional peer follow-up, roster chat answer and audition
uses two stages: assess the supplied context, then write from the validated
assessment. Advisors derive evaluation standards from their own researched
expertise and principles. Communication preferences govern delivery rather than
correctness. Agreement, challenge and mixed judgments require specific supported
findings; missing essential material calls for a focused question. Explanations
and creative deliverables remain possible without forcing a critique template.

The bounded assessment identifies its target, criteria, supported strengths and
concerns, position, missing information and a concrete next step. Quote excerpts
must occur in supplied context. Peer targets must be real first replies from
another advisor and the target quote must belong to that peer. Malformed,
unsupported or invented-target assessments block the writer; there is no silent
fallback to an unassessed answer. A concise findings summary is used, not a
private reasoning transcript.

The writer connects the particular claim or passage to the advisor's expertise
and the CEO's circumstances, explains the tradeoff, and gives a useful next
step. It avoids compulsory praise, manufactured conflict and blanket approval.
AI authorship alone does not establish poor quality. A local improvement does
not establish that the whole plan or draft is ready. Peer review remains at most
one substantive follow-up, with abstention when nothing useful changes.

The assessment supplies stance labels and peer targets. Users see conversational
replies and human-readable positions, including Mixed assessment and Needs
context; they do not see the assessment's JSON. Activity distinguishes considering
from responding. Both model calls use the applicable model/privacy policy and
normal metering, bounded prompt/output budgets, cancellation and freshness
checks. Existing canonical profiles stay intact; future research compilation
adds domain-specific evaluation standards within the existing three paragraphs.

Quality verification must cover justified agreement as well as criticism,
mixed judgments, absent material, peer targeting, invented quotations, ordinary
creative requests, profile/context changes and cancellation. Real provider
examples supplement deterministic contract/integration tests; sample success is
not a guarantee of the quality of every future judgment.

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

## Live replies and formatting

Meeting advisor replies and direct roster chat stream visible text while the
writer generates it. Assessment remains private. Parallel advisors have separate
previews; successful saved messages replace those previews without duplicates.
Interrupted, stale or rejected output is removed rather than saved as complete.
Final publication retains the existing authorization and context checks.

Advisors may use bold, italics, underlining, bullets and numbered lists. Both
surfaces render the same sanitized formatting, including existing replies.
Scripts, embedded images, unsafe links and arbitrary HTML are not permitted.
Model instructions request concise readable formatting; partial delimiters are
suppressed while streaming. Scrolling follows live replies only while the user
is already at the bottom.

## Latest meeting feedback

During a meeting, show every board member with their selected portrait and include the secretary in the same visible participant area. Show actual responding activity for each participant; an approved seat is not evidence that the advisor is responding. Use a clear fallback avatar if no portrait is available. Keep the participant area visible on desktop and usable on narrow screens. Decisions and Evidence belong inside the existing Meeting settings menu, retaining their review controls, permissions and source navigation.

Sending a normal board message must lead into the advisor response workflow instead of silently stopping after storing the message. Show truthful progress from sending through advisor selection and response generation, then a clear completion, abstention, clarification or actionable failure state. Secretary messages use the existing dedicated secretary workflow and need equivalent visible progress. Keep new-meeting creation and settings saves separate from generation. Preserve submitted text and original meeting/identity, prevent duplicate sends/runs, and allow response-only retry without duplicating the lead message. If briefing, access or participant setup blocks a response, explain that explicitly rather than showing a false activity indicator.

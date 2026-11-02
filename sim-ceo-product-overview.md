# Sim CEO

Build a web application for creating advisory boards, holding continuing meetings, and turning those conversations into approved, traceable decisions. The website is the complete product: board setup, voice and text conversation, documents, advisors, records, permissions, and operations.

## Meta model assignments

| Model or tool | Use it for |
| --- | --- |
| [Muse Spark](https://dev.meta.ai/models/muse-spark/) via Meta Model API | Fast onboarding suggestions, setup interviews, fictional advisor profiles, advisor research synthesis, independent advisor agents, participation decisions, discussion, secretary requests, briefings, and record drafts. |
| [Meta Model API web search grounding](https://dev.meta.ai/docs/search-grounding) | Live web research for advisor dossiers and questions that need current external evidence. |
| [Muse Wonder](https://dev.meta.ai/models/muse-wonder/) via Meta Model API | Complex briefings and synthesis across unusually large or conflicting sets of approved material when Muse Spark is insufficient. |
| [Muse Voice Transcribe](https://dev.meta.ai/models/muse-voice-transcribe/) via Meta Model API | Live speech input for board setup, meeting briefs, conversation turns, corrections, and secretary requests. |
| [Muse Image](https://dev.meta.ai/models/muse-image/) | Optional synthetic advisor portraits requested explicitly by the user. Never start image generation from a preset, advisor creation, or background job without a separate **Generate images** action. |
| [Muse Code](https://dev.meta.ai/products/muse-code/) | Development assistance, if useful. It is not part of the running product. |

Use hosted Meta models. Keep model selection explicit and record usage, latency, and cost for every call. Use the Standard Muse Spark model for private board content unless the owner explicitly chooses different data-use terms. Voice is input through transcription; advisor and secretary replies remain text.

## Product structure

An account can own multiple boards and one reusable **Advisor Roster** with no advisor-count limit. Each board has its own project context, configuration, selected advisor copies, sources, collaborators, meetings, decisions, activity, and usage. A board may have at most **10 attached advisors**, counting both pending and approved advisor seats; removed advisors no longer count. A board can contain any number of meetings. Each meeting has its own brief, conversation, attachments, notes, draft records, and approved records.

Keep board data isolated. Board-wide approved sources and decisions may inform meetings on that board. Meeting-scoped material stays in its meeting unless the owner explicitly promotes it. An Advisor Roster entry holds reusable profile information only; it never collects board messages, sources, decisions, private notes, or meeting memory. Adding an advisor to another board copies a reviewed profile version into that board. Nothing crosses boards automatically.

Provide these web views:

| View | Required actions |
| --- | --- |
| Boards | Launch the new-board wizard; search, open, archive, and restore boards. Show recent activity and outstanding work. |
| Board home | Show mission, setup state, advisors, active meetings, pending reviews, and recent decisions. Start a meeting. |
| Your Profile | Review and edit the board lead's profile and settings panel. Show when changes became active and which board they affect. |
| Meetings | Create, rename, filter, pause, resume, close, reopen, and search meetings on the current board. |
| Conversation | Type or speak, attach files, address advisors or the secretary, follow citations, inspect status, and review notes. |
| My Advisor Roster | Search, filter, preview, edit, archive, and reuse account-level fictional characters, public figures, and unnamed roles. See each advisor's capability card, portrait source, and the boards where a copy is currently attached. |
| This Board's Advisors | Show the board's advisor count out of 10; add from My Advisor Roster or create a new advisor; audition characters, edit board-specific roles, review evidence and images, and approve profiles. |
| Settings | Review project fields, edit a draft, compare revisions, and activate an approved configuration. |
| Resources and Inbox | Upload and connect sources; preview, approve, scope, search, exclude, restore, and inspect versions. |
| Records | Review drafts, approve selected items, inspect amendments and board-wide directions, and export records. |
| People | Invite collaborators, set board and meeting grants, and revoke access. |
| Activity and Usage | Inspect jobs, failures, sync state, audit events, model usage, and cost. |

Make the conversation a polished messaging interface. Show advisor identity, message time and status, reply targets, citations, source cards, attachments, and clear provisional or approved labels. Group replies by discussion round and show one compact progress indicator while advisors are working; keep unsent drafts out of the thread. On desktop, a side panel can show the brief, participants, sources, and record state. On phones, use focused views and a usable composer. Always show which board and meeting will receive a message and whether the composer addresses the board, one advisor, or the secretary. Support keyboard, mouse, touch, light theme, and dark theme.

### New-board wizard

Open a guided wizard from **Create board**. Save a draft board immediately, autosave each completed field, and let the owner leave and resume at the same step on another device. Show a short progress rail, the next required action, a live board preview, and persistent **Saved**, **Saving**, or **Needs attention** status. Allow Back, Continue, and Skip for optional steps; background work must not block navigation. Required gaps remain visible on the final review with a direct link to the field that needs attention. Keep advanced fields collapsed and let a preset, a reviewed lead profile, and one approved advisor start a useful first meeting without requiring optional sources, research refresh, portraits, or auditions.

1. **Choose a starting point.** Offer Blank, Strategy, Product, Operations, and the life and work presets below. A preset fills editable prompts, a first-meeting question and agenda, and suggested advisor roles. It offers **Choose from Advisor Roster**, **Create a character**, **Use a public figure**, and **Define a role** for each seat. It never invents board-lead facts, approved decisions, or portraits. Show the selected defaults before applying them. Set a sensible initial discussion rhythm, Standard Muse model, private board access, explicit source approval, and no raw-audio retention. Let the owner change each setting in a compact **Common settings** panel or restore defaults.
2. **Describe the board.** Ask for name, purpose, project stage, desired outcomes, and constraints through a short form or natural-language message. The onboarding agent suggests structured fields and one useful next question as information arrives. Show suggestions beside the form with **Apply**, **Edit**, and **Dismiss** controls; never silently replace owner text.
3. **Meet the board lead.** Ask for the lead's name, role, background, familiar topics, topics needing simpler explanation, and communication preferences. Default the role label to **Board Lead** for personal boards and **CEO** for business boards; offer Founder, Project Lead, Care Lead, Organizer, and a custom label. Prefill only from details the owner previously approved for reuse. Review and save this board's lead profile; it remains editable from **Your Profile** after activation.
4. **Add advisors.** Show **Advisors 0/10** and offer **Choose from Advisor Roster**, **Create a character**, **Use a public figure**, and **Define a role** on every open seat. Search and preview the roster without leaving the wizard, then copy the chosen profile into the board for review. For a newly named public figure, start versioned identity checks and Meta-grounded profile research in the background; offer portrait search as a separate action. For a character, generate an editable professional profile from the selected role and board purpose, and offer a live audition. For a role, keep a simple unnamed expert profile until the owner chooses a character or public figure. Show each card's progress and let the owner continue while text research finishes. Ask the owner to resolve ambiguous real identities, and approve each exact board profile version before board activation. Disable additional board seats at 10 with a clear **Remove an advisor to add another** explanation; creating an account roster entry remains available. Image generation starts only after an explicit user action.
5. **Add knowledge.** Offer file upload and optional Wiki.js connection. Begin extraction and source preview in the background. Ask for board or meeting scope where relevant and require explicit source approval before content enters the agents' context. Show progress without posting one notification per page or file section.
6. **Review and create.** Present a single summary of lead profile, board fields, advisors, source readiness, common settings, costs and privacy choices, and unresolved items. Mark suggested defaults and AI-derived facts. Allow direct editing from the summary. Activate only the exact reviewed configuration after checks for advisors and sources actually selected for use. Show optional background research as pending without blocking activation; keep an unapproved advisor or source out of agent context until reviewed. An advisor without a portrait uses an initials avatar. Offer **Start first meeting** with the preset's editable question and agenda.

Use a dedicated, fast **onboarding agent** to interpret owner input, propose fields, ask the next question, and coordinate background research. Keep its context to the current wizard step, saved board draft, and relevant new input. Debounce suggestions after a pause or field commit; do not call the model on every keystroke. Give each research job an advisor ID and profile revision so a rename, role change, or removal cancels stale results. Deduplicate repeated searches, bound concurrent jobs and result size, and show useful local UI feedback immediately while network work proceeds. If the agent or a provider fails, keep the manual form usable and offer a targeted retry. The owner approves information before it becomes active.

### Preset library

Each preset supplies the exact editable starter question, first-meeting agenda, advisor roles, and expected deliverable below. Preview these before applying the preset. The owner can change the question, agenda, roles, and output; choose each advisor from the roster or create one. Do not infer personal facts, credentials, or conclusions. On activation, offer to start this meeting with the reviewed question and agenda instead of opening an empty conversation.

| Preset | Suggested advisor roles | First question | First meeting agenda | Deliverable |
| --- | --- | --- | --- | --- |
| Strategy | Strategist, operator, customer advocate, skeptic | What decision would make the biggest difference to this board's goal? | Define goal; compare options; test risks. | Options and tradeoffs. |
| Product | Product lead, user researcher, engineer, go-to-market advisor | Who is this for, and what problem should we validate first? | Define user and problem; challenge assumptions; choose a test. | Product priorities and next validation step. |
| Operations | Process lead, finance reviewer, people advisor, risk reviewer | Where is work slowing down or producing avoidable errors? | Map the bottleneck; weigh fixes; choose measures. | Improvement plan and owners to confirm. |
| Career Change | Recruiter, field practitioner, skills coach, skeptic | Which next role fits my goals and current experience? | Compare roles; identify gaps; choose first steps. | Transition plan and skill-gap list. |
| Learning & Education | Teacher, subject expert, study coach, career advisor | What should I learn first to reach my goal? | Define outcome; sequence topics; set a study rhythm. | Learning path and weekly plan. |
| Family Decisions | Family organizer, budget planner, logistics advisor, mediator | What decision does our family need to make, and what matters to everyone involved? | Gather priorities; compare options; identify conversations needed. | Tradeoff map and shared action list. |
| Caregiving | Care coordinator, patient advocate, benefits navigator, logistics planner | What care tasks and questions need attention first? | Map people and appointments; list unknowns; assign follow-ups. | Appointment questions and coordination plan. |
| Home Project | Designer, contractor, budget reviewer, maintenance advisor | What is the smallest useful scope for this project? | Define needs; phase the work; identify cost and maintenance risks. | Phased scope and budget questions. |
| Small Business | Operator, customer advocate, marketer, financial planner | What should this business prove in the next 90 days? | Define customer and offer; test economics; set milestones. | Practical 90-day plan. |
| Creative Project | Creative director, producer, audience researcher, rights advisor | What should this project make, and who is it for? | Shape concept; identify audience; plan production and rights. | Concept brief and production roadmap. |
| Community or Nonprofit | Community representative, program designer, fundraiser, operations lead | What community outcome should we work toward first? | Define need; map stakeholders; choose a measurable pilot. | Impact plan and stakeholder map. |
| Travel or Relocation | Local researcher, logistics planner, budget advisor, accessibility advisor | Which destination best fits my priorities and constraints? | Compare places; check costs and access; plan logistics. | Destination comparison and logistics plan. |
| Retirement & Next Chapter | Lifestyle planner, financial questions advisor, community connector, skeptic | What do I want my next chapter to make room for? | Explore priorities; compare scenarios; list decisions to research. | Scenarios for time, work, and priorities. |

### Character generator

Let the owner create a fictional advisor from a preset role, a free-text prompt, or a blank form. Ask only for the role and the problem this advisor should help solve; generate the rest as a draft. Offer quick controls for specialization, depth of experience, practical versus academic perspective, temperament, level of challenge, and communication style. Show three compact character directions when the owner wants a choice. Allow **Regenerate**, **Edit**, and **Keep** on individual fields, so a good profile is not lost to one disliked detail. Keep character creation available from **My Advisor Roster** and **This Board's Advisors**.

A character profile must make professional capability usable in meetings: name, clearly fictional background, domain strengths, specific problems it can handle, methods it tends to use, evidence it needs, limits and defer rules, challenge triggers, collaboration style, and a short example of how it would respond to a board-relevant question. Add a compact **capability card** that shows what this advisor should lead on, contribute to, and leave to others. The generator checks the roster for duplicated specialties and suggests a complementary angle when useful; the owner can keep deliberate overlap. Do not claim real employment, degrees, licenses, publications, or endorsements for a fictional character. Mark generated biography and experience as fictional; current domain facts still require approved sources or Meta-grounded web search when used in a meeting.

Offer **Upload image** and **Use image URL** for every advisor, **Find a portrait** for a public figure, and **Generate images** for a fictional character. The default is an initials avatar. Display a preview, source/type label, crop, and **Use this image** action. Accept common image formats with byte and pixel limits; normalize the selected image to bounded thumbnail and display sizes. For an image URL, fetch through a server-side public-network-only image importer with redirects, content type, size, and timeout checks; store the selected image locally rather than relying on a hotlink. Record owner-provided URL and rights information. Keep sourced public-figure portraits and license provenance separate from owner uploads and generated art.

**Generate images** opens an opt-in panel with style and appearance controls, a clear cost/usage indication, and a button labeled **Generate 1**, **Generate 2**, or **Generate 4 options**. Only clicking that button starts Muse Image. A preset, character draft, page load, audition, or background research must never invoke image generation. Show returned candidates as a stable grid; let the owner select, crop, retry, or choose another source. Label generated images, keep prompts and selected image references small, and discard unselected previews after a short retention period. Do not make a fictional portrait resemble a named real person. If generation fails or no image is chosen, the initials avatar remains usable.

Use Muse Spark for short, structured profile drafts and roster checks. Generate profile text only after a role is selected or the owner requests it, not on every keystroke. Run requested text, portrait-search, and opt-in image jobs asynchronously with advisor ID and draft revision; discard stale results after edits or removal. The owner reviews the exact character profile and selected image before activation. Store an advisor type of **fictional character**, **public figure**, or **unnamed role**; never silently switch types. The Context Curator sends a compact version of the approved character's capability card and behavior rules to its agent, with relevant evidence fetched separately. Character personality must not override board instructions, source access, abstention, or the lead's approved decisions.

### Character audition

Put **Try this advisor** beside the capability card. Prefill a sample question from the selected preset or current board goal; let the owner edit it or choose a harder scenario. Run one isolated, metered advisor response using the draft profile and only board information the owner has entered or approved. Show the response beside the capability card, with concise indicators for the expertise used, assumptions made, sources used, and whether the advisor stayed within its limits. Allow the owner to adjust individual profile fields and rerun the same scenario to compare responses. A **Compare advisors** view can audition two candidates against the same question and highlight different contributions. Keep auditions out of meetings, records, and long-term agent memory; retain only a short-lived preview unless the owner explicitly saves an example to the roster profile. An audition does not approve an advisor or commit a board decision.

### Advisor Roster

Every advisor created in a wizard or on a board is saved in the account's Advisor Roster as a draft profile, including fictional characters, public figures, and unnamed roles. Approving a new board advisor also publishes the reusable profile fields as a roster version; drafts remain visible to their creator for later completion. The roster has no count limit and supports search, tags, expertise filters, type filters, recently used, and compact or detailed views. Show capability, portrait provenance, approval state, and a **Boards** column with the names of boards where a copy is currently attached. Show the first few board chips and a **View all boards** control for longer lists; the advisor detail page lists every current board, the advisor's role there, and a link to that board. Derive this list from board advisor copies so adding or removing a copy updates it immediately. Provide **Add to board** in the roster and **Choose from Advisor Roster** in the wizard and **This Board's Advisors**. A board receives an independent versioned copy of the selected profile and can set its own role, participation rules, and image without changing the roster template. Roster edits do not silently overwrite existing board copies; offer a reviewed **Update this board copy** action when a newer roster version is available. Removing an advisor from a board does not delete the roster entry. Archiving a roster entry hides it from default search without deleting existing board copies.

Only reusable profile fields and approved public-figure research belong in the roster. Strip board names, private source excerpts, meeting contributions, board-lead details, and decisions from roster suggestions and saved templates. Copying a roster entry to another board does not copy its past conversation or agent state. Public-figure source URLs and access dates travel with the reusable profile, with a visible **Refresh research** action for stale information. Apply account ownership checks to roster reads and writes; board collaborators see the board copy only unless separately granted roster access.

### Visual design and interaction

Use a calm, information-dense workspace with a dark navy and warm neutral palette, restrained accent color, clear typography, generous message spacing, and strong contrast. Avoid chat bubbles that make long advisor answers hard to read. Present each advisor reply as a compact identity header followed by readable text, expandable evidence, and actions. Distinguish the board lead, secretary, advisors, provisional notes, and approved records by layout and labels as well as color. Keep a single primary action visible per screen.

Desktop layout: a narrow left rail for board navigation; a board-specific meeting list beside it; the conversation in the main column; and a collapsible right inspector for brief, sources, people, and record state. Put the composer at the bottom of the conversation with text, microphone, attachment, and direct-secretary controls. Show the current recipient and meeting immediately above Send, with one-click correction. Keep Pause, Resume, and End discussion reachable from the meeting header with clear state labels. Keep the newest message in view only while the user is already at the bottom; when they are reading older messages, show a new-message indicator instead of pulling the page away.

Mobile layout: one focused pane at a time, with a board switcher, meeting drawer, conversation, and bottom composer. Open source citations, advisor profiles, and record reviews in full-height sheets. Keep microphone and Send controls large enough for touch. Preserve composer drafts when switching views or meetings; show the destination when returning to a draft. Provide visible keyboard focus, accessible names, transcript captions, and reduced-motion support. Use skeletons for loading, concise inline status for background work, and toasts only for completed actions that do not need review.

Build a coherent icon system with Lucide: clear icons for boards, roster, meetings, microphone, sources, records, search, settings, status, and actions. Pair unfamiliar icons with text; give every icon-only control a tooltip and accessible name. Use active and inactive states, portraits or initials, compact status badges, and empty-state illustrations made from interface shapes rather than automatically generated images. Define typography, spacing, color, elevation, focus, and motion tokens once and use them across all views. Provide light, dark, and system theme; comfortable and compact density; collapsible navigation and inspector; resizable desktop panes; message text-size control; reduced motion; keyboard shortcuts with a discoverable shortcut list; and a command palette for board, meeting, advisor, and page navigation. Keep all essential actions reachable through visible controls.

Label the account-level view **My Advisor Roster** and the board-scoped view **This Board's Advisors**; always show the current board name and its count out of 10 before **Add to board**. The roster should have a fast searchable list or grid, filter chips, quick preview, board membership chips, a clear **Add to board** action, and a comparison tray for two profiles. In the wizard, let the owner choose a roster advisor or create one from the same advisor seat. In meetings, an advisor identity header opens the board copy and shows its capability, image provenance, and role in that board. A first-time user should reach a useful meeting within minutes; keep advanced settings collapsed until needed. Use responsive transitions only when they improve orientation, and honor reduced-motion settings.

In the wizard, put the current step and editable fields in the main column with a narrow live-preview and AI-suggestions panel on desktop; stack these into tabs or expandable cards on mobile. Show immediate local validation and saving feedback. Keep buttons responsive while suggestions, character drafts, and research stream in. Avoid layout jumps when a profile card or selected image arrives. Do not make the user wait for all advisor jobs before adding the next advisor. On an advisor card, show its type, capability summary, progress, selected image or initials, **Try this advisor**, and **Edit profile**; open the character generator in an inline panel or full-height mobile sheet. Show image generation only behind its opt-in control.

**Your Profile** sits within each board. Show the approved board-lead profile in the main area and a **Profile settings** panel beside it on desktop or in a dedicated tab on mobile. Editable fields: name, role label for this board, background, relevant expertise, subjects already familiar, subjects needing simpler explanation, communication preferences, decision priorities, and any board-specific instructions. Display the current saved version and last edit. Saving is an explicit, immediate action; do not route it through full board setup approval. Reject stale saves with a refresh prompt. After a save, increment one board-level lead-profile version; every pending generation checks it before publication and discards stale work. Use the new profile in the next model context for every meeting on that board without rewriting each meeting row. Previously delivered messages and approved records remain unchanged. Never infer qualifications or preferences the lead did not supply.

### Discussion rhythm choices

Offer these policies in board settings, with **Balanced** as the initial default and a per-meeting override when the board lead wants a shorter discussion:

| Policy | Response groups | Best use |
| --- | --- | --- |
| Focused | 3, then 2; maximum 5 advisor replies | Quick decision or narrow question. |
| Balanced | 4, 4, then 2; maximum 10 advisor replies | Full discussion with the board's entire roster when relevant. |
| Open | Groups of up to 4 until no useful bid remains, subject to a board-lead maximum of 10 replies | Exploratory meetings with many relevant advisors. |

All policies stop early when no advisor can add a useful point or when the board lead intervenes. An advisor replies at most once to a given lead turn; it may speak again after a later turn. Advisors within one group bid against the same delivered snapshot; later groups see the prior delivered group. Show a small status line when a round yields, including any qualified advisors omitted by the cap. Keep policy limits in the application, not in a model prompt.

### Independent advisor agents and context selection

Give each advisor an independent agent identity with its approved profile, role, contribution rules, bounded private working state, and access only to the board and meeting it is serving. Agents may run in the same application worker pool; they do not need separate containers or continuously open model sessions. On a new board-lead turn, launch eligible agents' participation bids concurrently under a configurable provider concurrency limit, initially four calls. Launch selected agents' reply generation concurrently. If more agents are eligible than the provider limit, schedule short parallel waves rather than serial persona turns. Each agent receives the same **delivered conversation snapshot**, but its own relevant evidence packet. Unpublished drafts are private to their agent; another advisor sees them only after they are committed as delivered messages. The orchestrator alone selects, orders, cancels, and publishes replies.

Implement a **Context Curator** helper between retrieval and every advisor call. It constructs a versioned context manifest for each agent from: the approved board-lead profile, board mission and constraints, meeting brief, latest board-lead turn and exact reply target, a bounded window of delivered messages, current approved decisions, that advisor's board copy and recent contributions, and a small set of relevant source excerpts. Rank excerpts for the current question and advisor expertise, enforce board/meeting source permissions, discard superseded evidence, deduplicate overlapping passages, and preserve citation IDs. Do not send complete documents or the entire meeting transcript by default.

Use two context sizes. A **small bid packet** contains the question, brief, advisor role, relevant recent turns, and only enough evidence to decide whether to contribute. Start with a target of 2,000 input tokens per bid. Build the **draft packet** only for selected agents; start with 8,000 input tokens, at most six ranked excerpts, and a reserved output allowance. Allow a measured expansion up to 12,000 input tokens when a specific task needs it; log the reason. These are configurable starting budgets, not reasons to omit essential approved directions. If the agent identifies a specific missing fact, permit one bounded, scoped retrieval or Meta web search step and rebuild just that agent's packet. If essential context cannot fit or no usable evidence exists, ask for clarification or abstain instead of guessing. Cache stable profile and board prefixes, but invalidate them on lead-profile, configuration, source-access, or approved-record changes.

Store a compact manifest of source IDs, versions, selected message sequences, profile versions, token estimate, retrieval reason, and delivered-snapshot revision for each generated reply. Do not store duplicate full context blobs. Track input tokens, latency, relevance, and citation accuracy per agent so context budgets can be tuned from measurements. Keep each agent's private state to short, versioned notes and its latest relevant contributions; authoritative history remains in PostgreSQL. Cancel stale bids and drafts when the board lead intervenes or permissions change.

## Core workflow

1. **Create and configure a board.** The owner starts the new-board wizard, selects Blank or an editable preset, and describes the project, mission, stage, outcomes, success criteria, constraints, non-goals, assumptions, commitments, and their background. Require a name and reviewed board-lead profile covering role, background, and stated familiarity before activation. Accept typed or spoken input and document uploads. The onboarding agent proposes structured fields and one useful next question while the owner continues. Extract fields from all approved material in bounded sections; retain provenance and analysis checkpoints. Owner corrections take priority over extracted claims.
2. **Build the advisor roster.** The owner chooses advisors from the account roster or creates fictional characters, public figures, or unnamed roles. Save each new advisor as a roster draft linked to its board draft; copy a reviewed roster version when selecting an existing advisor for a new board. Generate editable character profile text and offer an audition; make all image generation opt-in. Start identity checks and Meta-grounded research for public figures; offer portrait search separately. Keep fictional biography separate from sourced facts and unnamed roles distinct from both. Prepare capability cards and contribution rules. Let the owner inspect and approve each exact board profile and selected image. Editing a draft invalidates its approval and stale results.
3. **Activate setup.** Present the exact draft, its sources, and changes from the active version. Require explicit owner approval. Later edits stay in a draft until reviewed. Meetings use the active version.
4. **Create a meeting.** The owner creates a meeting under a board and supplies a brief by voice or text. Attachments can be scoped to that meeting. Wait for required extraction and approval before using them. An empty meeting or lone attachment does not start discussion.
5. **Run discussion.** Every eligible advisor agent independently bids from a small context packet, with bids running concurrently. Apply the selected discussion policy. Run an explicit alignment check on the board lead's premise or proposed direction: if a material, evidence-supported challenge exists, assign it to the advisor best qualified to make it. Record the issue, evidence, and assignment for the round; do not manufacture dissent. The Context Curator prepares a separate bounded evidence packet for each selected agent. Those agents draft simultaneously from the same delivered conversation snapshot, then the orchestrator publishes their replies in order. Advisors should cite evidence, explain unfamiliar ideas at the lead's stated level, challenge assumptions when useful, and abstain when they have nothing new to add.
6. **Direct the conversation.** A new owner turn interrupts unsent work. The owner can pause, resume, request a specific perspective, or end the meeting. An explicit secretary request bypasses advisor polling.
7. **Use the secretary.** The secretary can retrieve an approved source or record, answer from saved context, prepare a briefing, and save labeled provisional notes. A briefing or note does not become an instruction or decision by itself.
8. **Review the record.** Closing a meeting prepares a review containing working notes, proposed items, supporting excerpts, and recent owner input. The owner may approve all or selected items, request revision, or discard. An empty draft offers no approval action. Vague agreement never approves a record.
9. **Continue and amend.** Reopen the same meeting with its history intact, or start another meeting on the board. An amendment identifies the approved item it supersedes. Preserve the full history while current retrieval favors the latest approved item.

## Voice interaction

Voice is part of the main composer, not a file-upload workflow. Provide push-to-talk and a start/stop control. Request microphone permission when recording starts. Show recording state, input level, elapsed time, partial transcript, and cancel and send controls. Stream audio through an authenticated session to Muse Voice Transcribe. Bind the session to the account, board, meeting, and draft message.

Show the finalized transcript as an editable draft before sending it. Once sent, it becomes a normal durable user message with the same routing, permissions, and interruption behavior as typed text. Keep the original audio only when the board's retention setting allows it; otherwise discard it after transcription. Store timestamps and audio provenance when audio is retained. Recover from silence, uncertain words, and dropped connections by leaving an editable draft or offering a retry. Never silently post a partial transcript.

Use voice for setup, meeting briefs, ordinary turns, corrections, and direct secretary requests. An authenticated account supplies the speaker identity for a live microphone session; model speaker labels are only hints for uploaded multi-speaker recordings. Granting access, enabling a source, activating setup, and approving a record require explicit web controls even if the owner asked for them by voice. Keep every reply readable as text. Do not add speech playback to the first release.

## Sources and memory

Accept web uploads, approved watched-folder files, and explicitly configured Wiki.js pages. Support board and meeting scopes. Retain originals, immutable content versions, extraction manifests, source approval, access rules, and provenance. Read text and Markdown directly. Extract PDF, Office, and image content through a pinned document service with OCR as needed. Report empty or failed extraction. Prevent path traversal and unsafe symlink or junction access in watched folders.

New uploads and watched files enter an approval inbox before setup analysis, advisor context, search, or recall. A replacement does not displace the last approved version until reviewed. Let the owner block source types, exclude a document across versions, and restore access without deleting originals. Changing source access invalidates pending replies and pauses affected meetings.

For Wiki.js, require an endpoint, encrypted key, description, allowed use, explicit path allowlist, optional exclusions, tags, locale, scope, and an enable action. Import only matching pages. Recheck rules before committing fetched content. Deleted or excluded pages stop being current evidence. Failed sync blocks current retrieval from that connection until recovery. Keep credentials out of messages, prompts, exports, and logs.

Use Hindsight for semantic recall over approved source sections, approved records, and bounded meeting summaries. Index only selected high-value messages when a later question requires semantic recall of them; do not create a vector entry for every chat message. Keep every exact message in PostgreSQL and search that history with a scoped full-text index. PostgreSQL remains authoritative. Resolve every recall hit against an owned, current, permitted source version, exact message, summary, or approved record. Discard stale, unsupported, wrong-board, and wrong-meeting hits. Load recent messages, current approved directions, and unindexed changes directly from PostgreSQL.

Use Meta Model API's `web_search` tool through the **Responses API** for external research. Request raw search results with `include: ["web_search_call.results"]` when building an advisor dossier. Record whether a `web_search_call` actually ran, citation URL and title, available result excerpt, claim supported, time accessed, and the model response ID. If no search ran or no usable citations were returned, mark the research unsupported and do not present it as verified. Break a broad biography into focused searches for identity, relevant work, and limitations. Cross-check important claims against more than one independent source when possible; show conflicts and inaccessible articles instead of resolving them by guesswork. A search snippet alone does not establish a quotation or a detailed career claim. Keep sourced facts separate from the proposed advisor perspective. Internal source search never launches web research implicitly.

## Authority and access

Give owners control over board setup, advisors, sources, collaborators, and final decisions. Store configuration drafts separately from active versions. Bind setup activation and record approval to owner identity, board, meeting where applicable, draft revision, content hash, source-message watermark, and selected items. Recheck these at submission. A stale review action must fail. Commit an approved decision, audit event, authoritative record, and export/index intents in one transaction. An export or indexing failure must not undo approval.

### Records and decisions

Keep secretary working notes private and provisional. A record draft contains an exact list of items; each item has text, supporting detail, status, scope, message IDs, source IDs, unresolved questions, and any approved item IDs it supersedes. Supported statuses include adopted, rejected, deferred, withdrawn, proposed, and unresolved. Scope is either this meeting or the whole board. Do not invent owners, deadlines, or decision status. Attach the current meeting message watermark and a hash of the complete draft. Show the board lead what changed since the last review.

The record-review page shows the entire draft, evidence beside each item, and **Approve selected**, **Approve all**, **Revise**, and **Discard** actions. The approval request sends the reviewed version, hash, watermark, and item IDs; the server validates them again. An empty draft has no approval action. A concise record and a detailed record are generated from the same approved items. Revisions append new immutable versions, and amendments name the approved IDs they replace. Current retrieval excludes superseded decisions while the history remains available. Offer an explicit **Adopt as meeting direction** or **Adopt board-wide** action for an exact board-lead-authored instruction; show the exact text and scope before committing it.

Use account-based web authentication with secure sessions, CSRF protection for writes, login and upload rate limits, and authenticated downloads. Invitations and grants are board-specific. A meeting grant reaches only that meeting. Read-only collaborators can inspect only the settings and meetings they are allowed to see. Meeting participants can contribute only where granted. Management actions require separate explicit rights. Recheck authorization on API requests, real-time subscriptions, downloads, and background retrieval. Revocation should promptly stop new reads and live updates.

## Conversation and job integrity

Use a meeting state machine: awaiting brief, active, yielded, paused, wrapping up, awaiting record decision, closed with record, and closed without publication. Store exact messages, revisions, reply targets, citations, delivery states, private bids, selected advisors, abstentions, drafts, and delivered IDs.

Persist each user message before starting model work. Generate advisor replies against a known board configuration and delivered meeting revision. Check both again before publishing. Discard or redraft stale output after a correction, permission change, or source-access change. Never hold a database lock while waiting for a model or network call. Use durable jobs with leases, retries, and idempotency keys.

### Failures and recovery

Show the state of setup analysis, character and portrait generation, advisor research, transcription, document extraction, wiki sync, memory indexing, briefing, and reply generation where the user is waiting for it. Preserve submitted text, uploads, approved settings, and completed checkpoints when a dependency fails. Offer **Retry** only for a failed step that is safe to repeat; show a short error and the last successful checkpoint. A retry must reuse the existing job identity or an idempotency key so it does not create duplicate sources, messages, or advisor replies. A stale job must be discarded instead of retried. Give administrators a full job log in Activity while keeping normal conversation status quiet.

These controls are needed because model calls can fail, documents can be unreadable, wiki sync can stop, and a browser or network connection can drop while work continues. Without a visible recovery path, the board lead cannot tell whether a source was read, a transcript was saved, or a reply will still arrive. Browser reconnects replay committed messages automatically; they do not require a manual redelivery action. Keep manual recovery for genuinely failed background work.

Stream committed messages and status to authorized browsers with sequence numbers and replay after reconnect. Refreshing the browser must reconstruct the same thread from PostgreSQL. A disconnected tab must not cancel durable meeting work or create a duplicate message.

## Implementation architecture

| Layer | Responsibility |
| --- | --- |
| Web client | Responsive board navigation, messaging, microphone composer, Advisor Roster, board advisor review and auditions, sources, records, people, and activity. |
| Web API and real-time transport | Authentication, scoped board and meeting endpoints, uploads, voice sessions, committed-message streaming, and authorization. |
| Workflows | Setup, roster versioning and board copies, auditions, opt-in image jobs, research, independent advisor agents, Context Curator, selection, discussion, secretary, source access, and record approval. |
| Adapters | Meta Model API language, image generation, transcription, and web search grounding; Hindsight; document extraction; and Wiki.js. |
| Domain and persistence | Accounts, boards, configurations, lead profiles, roster entries, board advisors, meetings, messages, voice turns, sources, approvals, grants, jobs, audit, and usage. |

Use ASP.NET Core on .NET 10, PostgreSQL for authoritative state, a separate PostgreSQL/pgvector database for Hindsight, Docling Serve for extraction, Meta Model API for external web research, Wiki.js GraphQL for allowed pages, and a [React](https://react.dev/) + strict TypeScript web client built with [Vite](https://vite.dev/guide/). Use [TanStack Router](https://tanstack.com/router/latest/docs/overview) for typed board and meeting routes, [TanStack Query](https://tanstack.com/query/latest) for server data and optimistic draft updates, [TanStack Virtual](https://tanstack.com/virtual/latest/docs/framework/react/react-virtual) for long conversations and large rosters, [Radix Primitives](https://www.radix-ui.com/primitives/docs/overview/introduction) for accessible complex controls, [Lucide](https://lucide.dev/guide/react/) for icons, and a small design-token layer in CSS. Generate typed client contracts from the ASP.NET OpenAPI schema. Use [SignalR](https://learn.microsoft.com/aspnet/core/signalr/) for committed-message and job-status events with sequence replay; submit consequential changes through authenticated HTTP actions. Load route features on demand, keep large documents and image previews out of initial bundles, and avoid broad application-wide rerenders when a message arrives.

Build and run the complete application with Docker Compose. Provide a multi-stage Dockerfile that builds the TypeScript client and .NET service, then serves the compiled website from the application container. Compose must start the application, its PostgreSQL database, Hindsight and its database, the document extractor, and an HTTPS reverse proxy. Meta Model API is the hosted external dependency. Pin service versions, add health checks and persistent volumes, keep credentials in private configuration, mount watched source input read-only, and store generated data separately. Define limits and retention for uploads, audio, and exports. A fresh installation must start with `docker compose up -d --build` after secrets are configured.

Use account, board, and meeting IDs with foreign keys and indexes. Store boards, lead profiles, account roster entries and versions, board advisor copies, meetings, memberships, messages, sources, records, jobs, and usage in separate tables rather than growing one board JSON document indefinitely. Give each message a board ID, meeting ID, monotonically increasing meeting sequence, sender, content, status, and timestamp. Index `(meeting_id, sequence)` for conversation paging and indexed scope fields for permissions and search. Index roster search by account, type, tags, and expertise; index board advisor copies by roster advisor ID and board ID so roster membership lists are paged and current. Enforce the 10-attached-advisor limit in the database-backed add/copy/import transaction, counting pending and approved seats and rejecting a concurrent eleventh add even if two tabs both showed 9/10. Do not attach the same roster advisor twice to one board. Keep transactions scoped to the affected board or meeting; a busy meeting must not block a different meeting on the same board. Add a lead-profile version to context and reject pending generations that used an older one. Hindsight and model output have no approval or permission authority. Validate typed model output before committing it. Treat retrieved documents and web pages as untrusted evidence; they cannot choose paths, retrieval namespaces, permissions, model routing, or approval actions. Preserve exact citation targets and excerpts shown to a model.

Load the latest 40–60 messages on opening a meeting. Fetch older messages with cursor-based pagination; virtualize the visible list so thousands of messages do not create thousands of DOM nodes. Virtualize large roster result sets too. Preserve scroll position when older pages load and when images expand. Search messages server-side and jump to a selected sequence with its surrounding page. Stream only new committed events, not the whole history. Use thumbnail assets, lazy image loading, stable image dimensions, and bounded browser caches; defer full-size portraits until opened. Keep input responsive while streaming or searching. The Context Curator builds bounded per-agent packets from recent turns, relevant excerpts, and authoritative decisions; never send every message in a long meeting to every advisor. Set explicit size and token limits, and fail visibly if authoritative context alone exceeds them.

Keep originals once by content hash, store new versions only when content changes, and put large text/audio outside hot board and meeting rows. Bound excerpts, job payloads, audit detail, cached research results, and in-memory per-meeting state. Set retention rules for raw audio, temporary uploads, superseded derived indexes, expired sessions, and completed job logs; retain approved records and their evidence until the owner applies a separate retention policy. Measure query latency, first-page load, memory use, and database size with a meeting of at least 10,000 messages before release. Add partitioning or archival tables only if measurements justify them.

Persist accounts, sessions, boards, memberships, wizard step and autosaved draft, selected preset and edited defaults, bounded suggestion state, roster entries and approved template versions, board advisor copies and overrides, advisor type and profile revision, compact character capability cards, chosen image and provenance, per-advisor research and explicitly requested image-generation job status, configuration drafts and active versions, setup checkpoints, advisor dossiers and approvals, meetings and rounds, messages, notes and records, finalized transcripts and retained audio references, source originals and versions, connector rules and encrypted keys, jobs, audit events, usage, and encryption keys. Restart safely and let clients reconnect to the same ordered conversation. Resume an interrupted wizard without replaying completed research or explicitly requested generation jobs or creating duplicate advisors and sources.

Expose health and readiness checks, source and job status, audit history, and usage by meeting, board, account, day, and date range. Meter private model roles and voice transcription as well as visible replies. Mark missing cost as unknown. Back up both databases, originals, generated artifacts, configuration, and encryption keys together; restore into an empty environment and verify counts, grants, source versions, and record hashes.

## Command coverage in the website

Provide a visible control for every capability in the command inventory below. Use buttons, forms, menus, and contextual actions; the user should not have to remember slash commands. Keep the listed command names here as a functional checklist for implementation. A command that only opened help becomes navigation or a help view. A command that changed data becomes a scoped web action with the same authority and revision checks.

### Entry, setup, and board lead

| Command | Web representation |
| --- | --- |
| `/start`, `/setup` | Create-board wizard or the board's setup conversation and checklist. |
| `/help`, `/setup help`, `/tools` | Searchable Help drawer with current capabilities and page links. |
| `/app` | Board list and board switcher. |
| `/status`, `/setup status` | Board readiness card plus detailed Activity status. |
| `/settings`, `/setup fields` | Settings page with every saved field and its provenance. |
| `/setup field <name>` | Open one field's detail and source panel. |
| `/setup set <field> <value>`, `/setup clear <field>` | Edit or clear a field in the settings draft; show the pending change. |
| `/setup set ceo-name <name>`, `/setup set ceo-bio <text>` | **Your Profile** fields. Save updates the active lead profile immediately for future context. |
| `/setup edit` | Open the setup draft editor and conversational setup panel. |
| `/setup research` | Refresh public-figure advisor research from **This Board's Advisors**. |
| `/review`, `/setup review`, `/setup preview` | Setup review page showing the exact draft, changes, and evidence. |
| `/setup activate` | **Activate configuration** action bound to the reviewed version and hash. |
| `/setup retry` | Retry failed setup analysis from its saved checkpoint. |
| `/setup export`, `/setup import` | Export or import board configuration in Settings; imported content requires a new review. |
| `/setup accept-rendering` | Web preview sign-off for advisor-card and review presentation; keep as a design verification action rather than a command the board lead must type. |
| `/setup advisors`, `/setup advisor ...`, `/setup member add <name> | <role>`, `/setup member remove <id>` | **This Board's Advisors** list and add/remove actions; the `advisor` and `member` forms share the same controls. |

**Your Profile** is the normal place to update the active board-lead profile. Other board setup fields remain draft-and-activate changes. Make that distinction visible beside Save so the user knows which edits take effect immediately.

### Advisor profiles and portraits

| Command | Web representation |
| --- | --- |
| `/advisor`, `/advisors` | **This Board's Advisors** list with approval and research status. |
| `/advisor add <name> | <role>` | Add-advisor form. |
| Advisor Roster (new web view) | Search unlimited saved account advisors; see each advisor's current boards and board-specific roles; preview and copy a selected version into this board while respecting its 10-advisor limit. Creating any advisor also saves its reusable profile to the roster. |
| Character generator and audition (new web actions) | **Create a character**, edit its capability and behavior, and **Try this advisor** before approval. The audition never creates a meeting message. |
| `/advisor <id>` | Advisor profile page. |
| `/advisor <id> sources`, `/advisor <id> source <number>`, `/advisor <id> dossier` | Evidence list, saved excerpt viewer, and full research notes. |
| `/advisor <id> set <role|biography|persona|tone|expertise|triggers|defer> <text>` | Labeled profile fields in an edit panel; show researched facts separately from board-lead preferences. |
| `/advisor <id> research` | **Research again** action for that advisor. |
| `/advisor <id> portrait research`, `/setup portrait research <id>`, `/portraits`, `/setup portraits` | Explicit **Find a portrait** action for public figures; show candidate source and license. |
| `/setup portrait <id> <https-image-url> <source/licence>` | **Use image URL** with provenance, or **Upload image**; preview and select the result. |
| Generate images (new web action) | Optional **Generate 1/2/4 options** panel for fictional advisors; never runs automatically. |
| `/advisor <id> remove` | Remove-advisor action with a review of the pending roster change. |
| Advisor research-card and portrait-choice buttons | Approve exact profile version; accept or retry a portrait candidate. |

### Meetings, secretary, and records

| Command | Web representation |
| --- | --- |
| `/meetings` | Board-scoped meeting list with status, search, and filters. |
| `/begin`, `/resume` | **Start discussion** or **Resume** button in the meeting header. |
| `/pause` | **Pause** button; do not imply a record was approved. |
| `/summary` | Provisional notes panel. |
| `/briefing <topic>` | **Prepare briefing** form in the meeting inspector; let discussion continue. |
| `/secretary <request>`, `Secretary, ...` | Direct-secretary composer mode with its own visible routing label. |
| `/end` | **End discussion and prepare record** action. |
| `/record` | Open or prepare the current record draft. |
| `/record detail` | Detailed draft and supporting evidence view. |
| `/record revise <instructions>` | **Request revision** form. |
| `/record approve <draft-version> <full-hash> <item-ids>` | **Approve selected** or **Approve all** controls that send the reviewed version, hash, watermark, and item IDs. |
| `/record discard` | **Discard draft** action; preserve conversation and notes. |
| `/notes <meeting-id> [detail]` | Notes and records in the selected meeting, with summary/detail tabs. |
| `/redeliver` | **Inspect and retry failed reply** in Activity when generation or publication failed; never duplicate a committed web message. |
| `record board-wide: <text>`, `record for this meeting: <text>`, `adopt and record ...` | Exact-text **Adopt board-wide** and **Adopt for meeting** actions with visible scope review. |
| `approve all/items ... record version ...` | The same exact-version record review controls; free-form agreement alone cannot approve. |
| Meeting attachment scope buttons | Upload dialog: **Use in this meeting**, **Save for board**, or **Ignore**. |

### Sources and knowledge connections

| Command | Web representation |
| --- | --- |
| `/sources`, `/sources help`, `/sources list [page]` | Paged Resources table with source, scope, version, state, and access. |
| `/sources status` | Source policy and indexing summary. |
| `/sources only wiki`, `/sources all` | Source-type policy selector with a clear effect preview. |
| `/sources disable <source-id>`, `/sources enable <source-id>` | Per-source access toggle, with scope and historical/future-version effect shown. |
| `/context status` | Extraction and memory-index status in Resources and Activity. |
| `/context`, `/context initialize`, `/context refresh` | **Scan or refresh sources** action. |
| `/context retry` | Retry failed extraction or indexing after the cause is addressed. |
| `/wiki`, `/wiki help`, `/wiki list` | Knowledge connections list and setup guide. |
| `/wiki add <name> <https-site-url>` | Add Wiki.js connection form. |
| `/wiki key <id> <api-key>` | Secret-entry field for that connection, never displayed again. |
| `/wiki status <id>`, `/wiki pages <id>` | Connection health and imported-pages views. |
| `/wiki describe <id> <text>`, `/wiki use <id> <text>` | Contents description and allowed-use fields. |
| `/wiki allow <id> <paths>`, `/wiki exclude <id> <paths|none>`, `/wiki tags <id> <tags|none>`, `/wiki locale <id> <locale>` | Path, exclusion, tag, and locale editors with a preview of matched pages. |
| `/wiki scope <id> board`, `/wiki scope <id> meeting <id>`, `/wiki setup <id> on|off` | Scope and setup-use controls. |
| `/wiki refresh <id> <minutes|off>`, `/wiki sync <id>` | Schedule selector and **Sync now** action. |
| `/wiki enable <id>`, `/wiki disable <id>`, `/wiki remove <id>` | Enable, disable, and remove actions with affected-source review. |

### People, usage, and operational status

| Command | Web representation |
| --- | --- |
| `/people` | Board People page showing invitations, members, and effective grants. |
| `/people <user-id> settings on|off` | Grant or revoke approved-settings access. |
| `/people <user-id> meeting <id> on|off` | Grant or revoke access to one meeting. |
| `/usage`, `/usage meeting`, `/usage board`, `/usage installation`, `/usage day`, `/usage <start-date> [end-date]` | Usage dashboard with meeting, board, installation, day, and inclusive UTC date-range filters. |

Natural-language setup edits, pause/end requests, direct secretary addresses, and source questions may remain convenient shortcuts. Every consequential action must also have a visible web control and the same authorization checks. Provide board and meeting context in every menu so an action cannot silently target another board.

## UI and usability QA

Run UI QA during every build slice. A feature is complete when its visible states, keyboard and touch paths, error recovery, and measured performance work in a running browser. Record findings in the issue tracker with the screen, viewport, theme, input method, steps, expected behavior, actual behavior, severity, and a screenshot or short capture. Recheck the affected flow after each fix.

### Usability risks to check first

| Flow | QA question | Pass condition |
| --- | --- | --- |
| First board | Can a new personal or business user reach a useful first meeting without learning the system? | A preset, lead profile, and one approved advisor suffice. Optional research, portraits, uploads, and auditions never block the short path. The first question and agenda are visible and editable before Start. |
| Wizard state | Does the user always know what is saved and what still needs review? | Every step shows Saved, Saving, or Needs attention; leaving and resuming restores the exact draft and step. Review links jump to the offending field and return without losing other entries. |
| Advisor scope | Can users tell an account template from a board copy? | **My Advisor Roster** and **This Board's Advisors** have distinct headings and breadcrumbs. Adding or updating a board copy shows the destination board and exact profile version; no board-specific material appears in the account roster. |
| Advisor capacity | Does the 10-advisor limit stay clear and consistent? | The board shows its count out of 10 in the wizard and advisor view. The eleventh add is blocked with an explanation, including concurrent tabs and imports. Creating another account roster advisor still works. |
| Roster membership | Can a user see every board using an advisor? | Roster cards show board chips and the profile lists all current boards with roles and links. Adding or removing a board copy updates the list; no private meeting content appears there. |
| Character trust | Can users judge an advisor's usefulness without mistaking fiction for evidence? | The capability card and audition are easy to find. Fictional background, generated images, researched facts, and uploaded images have clear labels. An audition never appears as a meeting or decision. |
| Meeting flow | Can users follow simultaneous replies and interrupt them? | Replies are grouped by round; status is compact; recipient and meeting are visible before Send; Pause, Resume, and End are discoverable. New replies never move a reader who is viewing older messages. |
| Voice | Can a user recover from microphone denial, silence, a bad transcript, or disconnect? | The composer stays editable; partial text is never sent; a user edit is not overwritten by later partial updates; recording, transcription, review, and sent states are distinct. |
| Approval | Can users understand the effect of a source, access, setup, or record action? | Review shows exact content, scope, and destination. Approval requires the explicit control, not a chat message. Stale reviews and failures preserve the user's work and explain the next action. |
| Large data | Does the UI remain usable with long meetings and many advisors? | Virtualized lists retain scroll anchor and keyboard focus; searches jump to the correct result; portraits do not shift content; the browser keeps a bounded rendered node count. |

### Accessibility and interaction checks

Target [WCAG 2.2 AA](https://www.w3.org/TR/WCAG22/) for all public and authenticated views. Test keyboard-only use, visible focus, screen reader names and announcements, contrast, reflow, error messages, and accessible authentication. Follow [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/) for dialogs, comboboxes, tabs, and menus. Check 320 CSS-pixel width and 200% and 400% zoom without losing essential controls; test desktop and mobile orientation. Make touch targets comfortable, with no action available only by hover, drag, gesture, color, or icon recognition. A screen reader must hear the board and meeting name, recipient, message sender, status, and citation label without the live conversation being announced repeatedly. Return focus to the invoking control after closing a sheet or dialog. Test the virtualized conversation and roster with keyboard and screen reader navigation, including newly loaded pages.

### Visual and workflow checks

Maintain a state matrix for every screen: empty, loading, ready, editing, saving, pending background work, success, failure, stale revision, and access denied. Capture and inspect each affected screen in light and dark themes, comfortable and compact density, desktop and phone widths, and reduced motion. Check type hierarchy, spacing, icon consistency, truncation, image crop, scroll behavior, focus visibility, and whether the primary action remains obvious. Verify the wizard, roster, character audition, portrait choices, voice composer, records, source review, and permissions through actual clicks and keyboard interaction; a component render or successful build alone does not complete UI QA. Keep dialog and toast copy short and action-oriented. Avoid repeated status toasts for background jobs; keep their current state where the user is working.

Run task-based usability sessions with new users from both personal and business scenarios, including mobile, keyboard-only, and screen reader use. Ask them to create a board, add a saved advisor, audition a character, choose an image without triggering generation accidentally, start a meeting, direct a question to one advisor, find a source, and approve one record item. Record where they hesitate, choose the wrong board or recipient, fail to locate a control, or misunderstand an advisor's status. Fix recurrent confusion before adding more settings or visual detail.

### Performance and release gate

Measure [Core Web Vitals](https://web.dev/articles/vitals/) on the authenticated board and meeting routes. Target p75 Largest Contentful Paint at or below 2.5 seconds, Interaction to Next Paint at or below 200 milliseconds, and Cumulative Layout Shift at or below 0.1 on representative devices and connections. Use repeatable lab runs before release and real-user measurements when traffic permits. Track initial JavaScript, route chunk size, image bytes, query latency, and long tasks; set and enforce project budgets from the first working build. Exercise a 10,000-message meeting and a 1,000-advisor roster on a midrange phone and desktop, including older-page loads, image expansion, search jumps, live replies, view switches, and reconnect. Check that typing and recording controls stay responsive while advisor jobs run.

For each feature slice, add the relevant automated accessibility and interaction checks, then perform the manual browser review above. Before release, complete the end-to-end acceptance walkthrough with no unresolved critical or high-severity usability defects. Keep a dated QA record with measured results, tested devices and browsers, accessibility findings, usability-session notes, fixes, and any accepted limitations. Re-run the affected checks after changes to navigation, design tokens, virtualization, voice, or approval flows.

## Build order and acceptance

Apply the relevant UI and usability QA checks to each numbered build step as its screens become available. Do not defer visual and interaction review to the final step.

1. Build the account, board, lead-profile, account Advisor Roster, board advisor-copy, and meeting data model; authentication and grants; model gateway; durable jobs; real-time event stream; responsive web shell; and Docker images and Compose configuration. Prove a clean Compose startup and that two boards and concurrent meetings stay isolated.
2. Build the resumable new-board wizard, complete editable presets and first meetings, common settings, onboarding agent, character generator and audition, Advisor Roster search and copy flow, setup extraction, provenance, document coverage, draft revisions, background public-figure research, explicit image choices, profile approval, and setup activation. Add **Your Profile** and its settings panel. Prove every preset has an editable question and agenda; every newly created advisor enters the unlimited account roster; the wizard and board view show an accurate count out of 10; an eleventh add fails even under concurrent requests or import; the roster lists each advisor's current boards and roles; copying one to another board carries no board data; auditions create no meeting messages; image generation never starts without a **Generate** click; only selected images are retained; fictional credentials cannot be mistaken for sourced facts; owner corrections override extracted claims; advisor edits discard stale draft results; and a lead-profile save changes the next model context in every active meeting on that board and invalidates stale unsent replies.
3. Build live voice input, partial and final transcription, edit-before-send, disconnect recovery, and audio retention. Test real microphones and browsers on desktop and phone. Prove a voice transcript cannot approve a record or grant access. Keep advisor and secretary output as text.
4. Build source storage and approval, extraction, Wiki.js sync, access controls, Meta web search grounding, and validated Hindsight recall. Prove excluded, replaced, and deleted sources cannot appear as current evidence; prove dossier claims retain actual citations, surface conflicting sources, and label an unsearched or weakly supported answer accordingly.
5. Build the discussion-policy choices, independent advisor agents, Context Curator, concurrent bids and drafts, explicit alignment/challenge pass, selective rounds, interruption, secretary requests, pause/resume, citations, and formatted real-time delivery. Prove agents share one delivered snapshot without seeing each other's unpublished drafts; prove different advisors receive relevant bounded packets; prove a new owner turn prevents an old unsent reply from publishing; prove challenge is assigned only when evidence supports it.
6. Build provisional notes, briefings, complete record review, selected-item approval, status and scope, watermarks, amendments, concise/detailed exports, and retrieval. Prove stale or unauthorized approvals fail and superseded decisions remain in history but not current context.
7. Finish every website view and the full command-coverage map. Exercise rendered controls at desktop and phone sizes in light and dark themes, comfortable and compact density, keyboard-only navigation, screen reader flows, reduced motion, and adjustable panes. Measure initial bundle size, route transitions, input responsiveness, and image loading on a representative midrange phone. Test a 10,000-message meeting and a large Advisor Roster for cursor paging, virtual scrolling, search, and bounded database and browser memory. Add operational probes, safe retries, backup and restore, and a full end-to-end walkthrough against a fresh Docker Compose deployment.

Acceptance walkthrough:

1. Start the full stack from a clean Docker Compose deployment. Use different presets to create two boards. Edit each preset's opening question and agenda; leave and resume one draft. Confirm a personal board says **Board Lead** and a business board can say **CEO** while both use **Your Profile**.
2. Create a fictional advisor, edit its capability card, and audition it against the starter question without adding a meeting message. Add it to the roster automatically. Add a public-figure advisor while identity checks and Meta web research run. Confirm that no image generation or portrait search starts automatically. Upload one image, import another by URL, and explicitly request multiple Muse Image options for a fictional advisor. Select one candidate, verify provenance and bounded storage, and confirm stale jobs cannot overwrite later edits.
3. Copy the saved advisor from the roster to the second board. Verify the roster profile lists both boards and their distinct advisor roles, while sources, meeting history, private notes, and agent state remain only on their original board. Fill one board to 10 pending or approved advisors; verify the eleventh is rejected, the count is accurate after removal, and the unlimited roster still accepts a new advisor. Verify the fictional advisor's invented background is never shown as a sourced fact. Review the lead profile, advisor evidence, and an approved document; activate one board and start its preset meeting.
4. Create another meeting on that board; speak and correct a brief; observe concurrent advisor agents receiving different bounded evidence packets from the same delivered snapshot; receive selective replies and an evidence-supported challenge with working citations. Change the lead's familiarity setting and confirm both meetings use it on their next response. Interrupt by voice and ask the secretary for an approved fact.
5. Close one meeting and reject a stale record review; approve one current item; retrieve it in the other meeting but not on the other board. Revoke a collaborator and verify their stream and downloads stop. Exclude a source and verify retrieval stops using it. Induce one extraction failure and recover from its saved checkpoint without duplicates.
6. Open a 10,000-message meeting and a large roster; scroll, filter, search, and switch routes smoothly with bounded browser memory. Back up and restore; verify boards, roster entries and board copies, meetings, grants, sources, selected images, and approved record hashes.

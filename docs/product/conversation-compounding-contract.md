# Conversation Compounding Contract

> CBrain 产品级体验契约
>
> Status: Canonical product direction
> Established: 2026-05-27
> Tracking issue: #76

## Purpose

CBrain is not primarily a collection of memory tools. It is a compounding cognition system shared by a user and the user's primary Agent.

The user communicates naturally. The Agent quietly captures valuable material, recalls it when relevant, reconstructs forgotten context when needed, and surfaces higher-order feedback only when the accumulated evidence is strong enough.

The "C" in CBrain means **Compounding**:

- For the Agent, accumulated knowledge, relationships, thoughts, corrections, and confirmed preferences create increasingly aligned help.
- For the user, scattered people, experiences, knowledge, and reflections can later return as deeper understanding, recovered context, and more systematic thinking.

Internal modules, tools, modes, and maintenance commands are implementation details. Product success is measured by whether the user naturally feels:

- It remembers what matters.
- It understands why prior context matters now.
- It can help recover a person or experience even when the name has been forgotten.
- It notices a meaningful connection only when that connection is worth attention.
- It learns from correction without quietly converting guesses into facts.

## Product Principles

1. **Natural dialogue first.** Users should not have to remember CBrain tool names, storage commands, retrieval modes, or maintenance workflows.
2. **Compounding requires trust.** Incorrect or untraceable memory compounds harm rather than value. Source, trust state, correction history, and rejection handling are foundational product capabilities.
3. **Memory is more than facts.** CBrain retains source content, verifiable facts, lived context, user thoughts, and confirmed collaboration preferences without conflating them.
4. **Recall should be selective.** Retrieval exists to improve the current exchange, not to dump the vault or expose internal machinery.
5. **Social memory is durable but private.** A relationship that has been quiet for years may remain highly valuable for context-based recall, while never becoming a reason for unsolicited social prompting.
6. **Silence is a feature.** Proactive feedback is successful when it withholds weak observations as reliably as it surfaces strong ones.

## Memory Layers

| Layer | What It Preserves | Typical Future Value |
| --- | --- | --- |
| Content memory | Materials, excerpts, notes, and source artifacts intentionally shared for later use | Answering from known material |
| Fact memory | Entities, events, relationships, decisions, and factual corrections | Grounded continuity and accurate retrieval |
| Episodic memory | Encounters, conversations, approximate time/place, surrounding event, theme, and why a relationship mattered | Reconstructing forgotten people or experiences |
| Thought memory | User judgments, questions, principles, reflections, and viewpoint evolution | Helping the user reason with their own accumulated thinking |
| Collaboration memory | Confirmed preferences, boundaries, and working patterns with the Agent | More aligned assistance over time |

These layers may relate to one another, but they must not be silently collapsed into one kind of truth.

## Trust Protocol

Memory-bearing items must support at least these states:

| State | Meaning | Allowed Use |
| --- | --- | --- |
| `trusted` | Explicitly supported source material, confirmed fact, or confirmed correction | May support factual answers |
| `user-thought` | The user's expressed judgment, preference hypothesis about a topic, or reflection | May be presented as the user's prior thinking, never as objective fact |
| `candidate` | Extracted or inferred material awaiting sufficient support or confirmation | May inform cautious prompts or internal reasoning; cannot be stated as fact |
| `rejected` | User rejected the interpretation or requested it not be retained | Excluded from active recall and proactive output; keep only minimal suppression/audit signal |
| `superseded` | An older fact or interpretation replaced by a newer accepted one | Excluded from current-truth answers; retained only for explanation or history |

### Store Without Interrupting

- User-provided materials intentionally supplied for future reference.
- Clear new facts that do not overwrite a significant existing fact.
- The user's explicit reflections or judgments, stored as `user-thought`.

### Store As Candidate And Confirm Only When Needed

- Material changes to an existing fact.
- Significant relationship or status changes.
- Agent-inferred collaboration preferences or patterns in the user's thinking.
- Cross-topic insights, contradictions, and suggested themes.

Confirmation should be lightweight and arise only when the candidate affects a current answer or qualifies for a high-value review. Daily dialogue must not turn into an approval queue.

### Do Not Retain As Active Memory

- Casual acknowledgements and transient operating instructions.
- Low-confidence guesses.
- Rejected interpretations, other than a minimal record needed to avoid repeatedly presenting the same unwanted suggestion.

### Provenance Requirement

Any fact, relationship, or episodic clue used to answer or reconstruct memory must carry a compact, inspectable evidence basis:

- source category, such as explicit user input, imported content, dialogue extraction, Agent inference, user confirmation, or correction;
- source reference, such as a page, record, or resolvable session locator;
- timestamp where available;
- short evidence excerpt or locator;
- trust state and correction history where applicable.

Agent inference must never silently acquire the authority of user-confirmed fact.

## Primary User Journeys

### 1. Natural Capture

**Intent**

The user provides meaningful content through ordinary conversation or material sharing; the Agent turns it into durable, trustworthy memory without requiring a storage command.

**Representative dialogue**

- "I discussed a possible direction with someone today."
- "This material may be useful for later comparison."
- "I increasingly think this class of decision should begin with risk."
- "That previous relationship note was inaccurate; use the updated version."

**Expected experience**

- Useful materials, facts, and user thoughts are captured naturally.
- Significant corrections or relationship changes invite lightweight confirmation only when needed.
- The user can say "do not remember this", "use the newer version", or "that is only my current thought".
- Rejected content does not reappear as an unsolicited suggestion.

**Required capabilities**

- Memory classification across the five memory layers.
- Trust-state management and correction history.
- Provenance-bearing dialogue capture.
- Reliable NER/entity resolution without duplicate or generic-entity pollution.
- Natural-language evaluation of capture quality.

### 2. Grounded Conversational Benefit

**Intent**

When a user asks a normal question, relevant accumulated memory quietly improves the answer.

**Representative dialogue**

- "Why did we choose this approach last time?"
- "Have we discussed this theme before?"
- "What might I be overlooking in this judgment?"
- "Is this similar to something from earlier?"

**Expected experience**

- The Agent automatically recalls relevant history.
- The answer distinguishes stored facts, prior user thoughts, and system inference.
- The Agent mentions only the basis needed for confidence and continuity.
- At most one additional connection is surfaced, and only if it meaningfully changes understanding.
- Pages, raw records, and tool traces are not poured into the conversation.

**Required capabilities**

- EvidenceBoard for compact evidence organization, conflicts, and gaps.
- Grounded answer synthesis.
- Retrieval integration that is automatic from natural dialogue.
- Provenance and active-evidence filtering.
- Strong suppression of irrelevant hints.

### 3. Episodic Reconstruction Of Social Memory

**Intent**

The user can recover a person or relevant relationship through partial remembered context, even when a name is unavailable or the relationship has been dormant for a long time.

**Representative dialogue**

- "Who was the person I met at an event a few years ago who discussed a similar topic?"
- "Someone once introduced this direction to me, but I cannot remember the name."
- "Among people I encountered in that period, who is relevant to the current theme?"
- "Did I first learn about this through someone?"

**Expected experience**

- Search works from approximate time, setting, event, topic, and shared connection cues.
- Results are ranked candidates with reasons and confidence, not a flat page dump.
- A long-quiet relationship remains recallable when context makes it relevant.
- CBrain does not suggest reconnecting with a person merely because that person was recalled.

**Required capabilities**

- Distinct modeling for a person and the episodes or records connecting that person to the user.
- Traceable relationships shaped as `person <-> episode/record <-> topic/event/time/place`.
- Fuzzy episodic retrieval and candidate ranking.
- Evidence-based candidate explanations.
- Privacy and display gates for social-memory output.

This journey is a defining capability of CBrain, not a side effect of generic search.

### 4. Low-Frequency Compounding Review

**Intent**

Once memory has accumulated sufficiently, CBrain helps the user notice changes and connections in their own thinking without becoming noisy.

**Representative feedback**

- "Several recent entries converge on one unresolved theme."
- "Two previously separate lines of thinking now have a supported connection."
- "Your recorded judgment on a topic appears to have changed over time."
- "I observed a possible collaboration preference; should I use it going forward?"

**Expected experience**

- Feedback arrives as a short, high-value `Compounding Review`.
- The system remains silent when evidence, novelty, or action value is insufficient.
- The user can accept, reject, defer, or disable a line of feedback.
- Rejected interpretations do not repeatedly demand attention.

**Required capabilities**

- Candidate insight lifecycle.
- Evidence, persistence, novelty, action-value, and trust-risk scoring.
- Feedback and rejection memory.
- Strict proactive budget.

## Feedback Budget

Immediate proactive output must be rare:

- It must be strongly evidenced.
- It must be directly relevant to the current exchange.
- It must plausibly change understanding or action.
- It is limited to at most one unsolicited additional insight per answer.

Periodic feedback must be rarer still:

- It must be evidence-backed, novel, persistent across material or time, and potentially useful.
- Inferred collaboration preferences must be confirmed before becoming active.
- Internal health warnings, discovery queues, and maintenance reports must never be forwarded as cognition feedback without product-level filtering.

## End-To-End Evaluation Contract

Feature completion is evaluated through anonymous natural dialogue, not by proving that an internal tool can be called.

All fixtures must use placeholders such as `人物A`, `事件B`, `主题C`, `资料D`, and `地点E`. No identifiable personal, organizational, product, physical item, or private source information may appear in issues, fixtures, examples, or review output.

Minimum evaluation scenarios:

1. The user supplies a useful material, then later receives a relevant answer without explicitly requesting memory lookup.
2. The user corrects an earlier factual statement; later answers use the accepted newer version and do not surface the superseded claim as current truth.
3. The user shares a reflection; later answers correctly present it as the user's prior thinking, not as an external fact.
4. The user recalls a past encounter using vague time/topic/context clues without a name; the system returns candidate people with reasons and confidence.
5. A dormant social relationship is returned only because the current retrieval context supports it, without unsolicited contact advice.
6. The Agent suppresses a weak cross-topic guess and surfaces a strong, relevant connection at most once.
7. A periodic review contains only evidence-backed, high-value items, or returns no review when none qualify.
8. The user rejects an inferred preference or insight; the same interpretation is not repeatedly proposed.

## Roadmap By User Value

### Phase 0: Experience Contract And Evaluation

**Purpose:** Establish this contract as the acceptance standard for all downstream development.

**Deliverables**

- This canonical document and tracking issue #76.
- Natural-dialogue evaluation fixtures and privacy rule.
- Rewritten acceptance criteria for user-facing downstream issues.

### Phase 1: Trustworthy Capture Loop

**Purpose:** Secure the principal entering the compounding system: reliable captured memory.

**Deliverables**

- Memory category and state support.
- Provenance, correction history, and active-evidence behavior.
- Explicit separation between people and episodic context.
- Capture/confirmation/rejection behavior through natural dialogue.

### Phase 2: Grounded Natural Answers

**Purpose:** Deliver the first immediately visible memory benefit in ordinary dialogue.

**Deliverables**

- EvidenceBoard.
- Grounded answer synthesis.
- Automatic dialogue entry integration.
- Minimal, relevant basis display and hint suppression.

### Phase 3: Episodic Social-Memory Reconstruction

**Purpose:** Make forgotten-context retrieval a signature capability.

**Deliverables**

- Episodic schema and person-linking boundaries.
- Fuzzy recall by time, place, event, theme, and shared relation.
- Candidate explanation and confidence.
- Dormant-relationship recall strategy.
- Social-memory privacy gates.

### Phase 4: Research And Compounding Feedback

**Purpose:** Move from remembering past context to helping the user form new, reliable understanding.

**Deliverables**

- Budgeted research planning and execution.
- Evidence-aware critic.
- Candidate lifecycle for discovery and reflection.
- Compounding Review.
- Strictly gated immediate inspiration.

## Issue Alignment

| Issue | Product Role | Direction |
| --- | --- | --- |
| #76 | Conversation Compounding Contract | Canonical product acceptance contract; prerequisite for user-visible work |
| #37 | Provenance Envelope | Phase 1 foundation; must enforce active evidence and prevent Agent inference from becoming trusted fact |
| #72 | EvidenceBoard | Phase 2 core evidence structure; elevate priority after trustworthy capture |
| #67 | Grounded Answers | Phase 2 visible user value; deliver with EvidenceBoard |
| #68 | Deep recall integration | Rewrite as automatic benefit during natural conversation, not a mode the user must understand |
| #10 | Episodic reconstruction | Rewrite/expand as Phase 3 social-memory milestone |
| #36 | Review artifact output | Align to high-value, low-frequency Compounding Review |
| #29 | Bulk curation/maintenance | Keep as internal maintenance support; do not expose it as product feedback |
| #71 | Trace | Retain only as background observability and quality support |
| #70 / #65 / #69 | Search planning, execution, critic | Defer to Phase 4 after the minimum natural-answer loop works |
| #75 | Typed-test quality gate | Complete before large-scale data-model or architecture changes |

## Delivery And Review Governance

The project delivery loop follows this contract:

1. Product issues must state which user journey they improve and which trust boundary they preserve.
2. Claude Code implements an agreed issue and commits changes locally.
3. Codex reviews the commit as PM and CTO against product value, architecture, privacy, correctness, regression tests, and the applicable user journey.
4. A review passes only when both implementation behavior and natural-dialogue acceptance criteria are satisfied.
5. Approved commits may be pushed and issues closed; release decisions remain separate.

Engineering work is not complete merely because tests pass or a tool exists. It is complete when the user can experience a trustworthy compounding benefit through normal conversation.

## Near-Term Decision

After the provenance and trustworthy-capture foundation is correct, the first user-visible capability slice should be:

**EvidenceBoard + grounded answer synthesis, experienced through one ordinary conversation.**

This slice demonstrates CBrain's essential promise: prior memory returns naturally, with enough evidence to be useful and enough restraint to remain trusted.

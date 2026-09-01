/**
 * ExplainerAskService — grounded Q&A over de fleet knowledge pack.
 *
 * Pipeline: retrieve (Qdrant semantisch,ExplainerKnowledgeService) → generate
 * (Ollama chat, strikt evidence-geciteerd) → verify (ExplainerClaimVerifier
 * resolutie over antwoord-citaties) → uitkomsten:
 *   - grounded answer (grounding ≥ threshold)
 *   - REFUSAL (NOT_ENOUGH_EVIDENCE) bij te laag confidence — met beste evidence
 *   - extractive fallback (geen LLM): ranked fragmenten met citaties
 *
 * Architecturaal beginsel: Retrieval ≠ cognitie; hier sluit de cirkel.
 * Refusal is een feature,ahlwege nooit fantaseren (RKD-patroon).
 */

import type { Database } from "better-sqlite3";
import { ExplainerKnowledgeService, type ExplainerChunk } from "./explainer-knowledge-service";

const OLLAMA_CHAT_URL = process.env.DJIMITFLO_ASK_LLM_URL || process.env.OLLAMA_CLOUD_URL || "http://100.77.58.72:11434";
const OLLAMA_CHAT_MODEL = process.env.DJIMITFLO_ASK_LLM_MODEL || "glm-5.2:cloud";
const GROUNDING_THRESHOLD = Number(process.env.DJIMITFLO_ASK_GROUNDING_THRESHOLD) || 0.7;
const MIN_EVIDENCE_SCORE = Number(process.env.DJIMITFLO_ASK_MIN_EVIDENCE_SCORE) || 0.25;

export interface AskCitation {
  chunk_id: string;
  repo: string;
  section: string | null;
  chunk_type: string;
  citation: string | null;
  text_excerpt: string;
  score: number;
}

export interface AskResponse {
  question: string;
  answer: string | null;
  refused: boolean;
  refusal_reason: string | null;
  mode: "semantic" | "extractive";
  grounding_ratio: number;
  claim_report: {
    checked: number;
    resolved: number;
    unresolved: Array<{ claim: string; reason: string }>;
  };
  citations: AskCitation[];
  embed_model: string;
  llm_model: string;
  generated_at: string;
}

export class ExplainerAskService {
  constructor(db: Database, private knowledge: ExplainerKnowledgeService) {
    void db; // reserved for ask-audit logging (FR-015 lineage)
  }

  async ask(question: string, options: { repo?: string; limit?: number } = {}): Promise<AskResponse> {
    const limit = options.limit ?? 6;

    // 1) Retrieve — semantisch, met knowledge-age filter (valid_until)
    const { results, degraded } = await this.knowledge.search(question, { repo: options.repo, limit: limit * 3 });
    const now = Date.now();
    const fresh = results.filter((r) => {
      const vu = r.chunk.valid_until ? new Date(r.chunk.valid_until).getTime() : Infinity;
      return vu > now;
    });
    const evidence = fresh.slice(0, limit);

    if (evidence.length === 0 || evidence[0].score < MIN_EVIDENCE_SCORE) {
      // 1a. Extractive fallback / refusal met beste evidence (mogelijk leeg)
      return {
        question,
        answer: null,
        refused: true,
        refusal_reason: evidence.length === 0
          ? "NOT_ENOUGH_EVIDENCE: geen frisse kennis in de knowledge pack voor deze vraag."
          : `NOT_ENOUGH_EVIDENCE: beste evidence score ${evidence[0]?.score?.toFixed(3)} < ${MIN_EVIDENCE_SCORE}; weigeren i.p.v. fantaseren.`,
        mode: degraded ? "extractive" : "semantic",
        grounding_ratio: 0,
        claim_report: { checked: 0, resolved: 0, unresolved: [] },
        citations: evidence.map((r) => this.toCitation(r.chunk, r.score)),
        embed_model: process.env.DJIMITFLO_EMBED_MODEL || "snowflake-arctic-embed:s",
        llm_model: OLLAMA_CHAT_MODEL,
        generated_at: new Date().toISOString(),
      };
    }

    // 2) Generate — LLM met evidence-context; weiger bij fallback naar extractive
    const context = evidence
      .map((r, i) => `[E${i + 1}] (${r.chunk.repo_full_name}, ${r.chunk.section ?? r.chunk.chunk_type}) ${r.chunk.text}`)
      .join("\n\n");
    const llm = await this.generate(question, context);
    if (!llm.answer) {
      // 2a. Extractive fallback — NOT_IN_CONTENT (model knew) of endpoint down
      return {
        question,
        answer: null,
        refused: true,
        refusal_reason: llm.available
          ? "NOT_IN_CONTEXT: het model vond het antwoord niet in de opgehaalde evidence; extractive fragmenten teruggegeven i.p.v. gegeneraliseerd antwoord."
          : "LLM endpoint onbereikbaar of leeg antwoord na retry; extractive evidence teruggegeven i.p.v. gegeneraliseerd antwoord.",
        mode: "extractive",
        grounding_ratio: evidence.length > 0 ? 1 : 0,
        claim_report: { checked: 0, resolved: 0, unresolved: [] },
        citations: evidence.map((r) => this.toCitation(r.chunk, r.score)),
        embed_model: process.env.DJIMITFLO_EMBED_MODEL || "snowflake-arctic-embed:s",
        llm_model: OLLAMA_CHAT_MODEL,
        generated_at: new Date().toISOString(),
      };
    }

    // 3) Verify — verificatie dat elke [E-n]-citeermarkering in het antwoord
    // verwijst naar evidence die wél in de retrieval zat (geen verzonnen E-referenties).
    // Antwoorden zonder citaten zijn onverifieerbaar → refusal met evidence.
    const citedText = this.injectCitationMarkers(llm.answer);
    if (citedText === null) {
      return {
        question,
        answer: llm.answer,
        refused: true,
        refusal_reason: "NOT_ENOUGH_GROUNDING: antwoord bevat geen evidence-citaten ([E-n]) en is daarmee onverifieerbaar; evidence direct gegeven.",
        mode: degraded ? "extractive" : "semantic",
        grounding_ratio: 0,
        claim_report: { checked: 0, resolved: 0, unresolved: [] },
        citations: evidence.map((r) => this.toCitation(r.chunk, r.score)),
        embed_model: process.env.DJIMITFLO_EMBED_MODEL || "snowflake-arctic-embed:s",
        llm_model: OLLAMA_CHAT_MODEL,
        generated_at: new Date().toISOString(),
      };
    }
    const citationReport = this.verifyCitationMarkers(citedText, evidence.length);
    const groundedEnough = citationReport.grounding_ratio >= GROUNDING_THRESHOLD;

    if (!groundedEnough) {
      return {
        question,
        answer: llm.answer,
        refused: true,
        refusal_reason: `NOT_ENOUGH_GROUNDING: citation grounding ${Math.round(citationReport.grounding_ratio * 100)}% < ${Math.round(GROUNDING_THRESHOLD * 100)}%; antwoord verworpen, evidence direct gegeven.`,
        mode: degraded ? "extractive" : "semantic",
        grounding_ratio: citationReport.grounding_ratio,
        claim_report: {
          checked: citationReport.checked,
          resolved: citationReport.resolved,
          unresolved: citationReport.unresolved,
        },
        citations: evidence.map((r) => this.toCitation(r.chunk, r.score)),
        embed_model: process.env.DJIMITFLO_EMBED_MODEL || "snowflake-arctic-embed:s",
        llm_model: OLLAMA_CHAT_MODEL,
        generated_at: new Date().toISOString(),
      };
    }

    // 3) Grounded answer met citaties-correcties
    return {
      question,
      answer: citedText,
      refused: false,
      refusal_reason: null,
      mode: degraded ? "extractive" : "semantic",
      grounding_ratio: citationReport.grounding_ratio,
      claim_report: {
        checked: citationReport.checked,
        resolved: citationReport.resolved,
        unresolved: citationReport.unresolved,
      },
      citations: evidence.map((r) => this.toCitation(r.chunk, r.score)),
      embed_model: process.env.DJIMITFLO_EMBED_MODEL || "snowflake-arctic-embed:s",
      llm_model: OLLAMA_CHAT_MODEL,
      generated_at: new Date().toISOString(),
    };
  }

  private async generate(question: string, context: string): Promise<{ answer: string | null; available: boolean }> {
    // Retry once on empty or failed response (cloud-model cold starts return empty content).
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${OLLAMA_CHAT_URL}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(Number(process.env.DJIMITFLO_ASK_TIMEOUT_MS) || 30_000),
          body: JSON.stringify({
            model: OLLAMA_CHAT_MODEL,
            stream: false,
            messages: [
              {
                role: "system",
                content: "Answer ONLY from the provided evidence context. Cite every claim as [E1], [E2] etc. If the context does not answer the question, reply exactly: NOT_IN_CONTEXT.",
              },
              {
                role: "user",
                content: `Evidence:\n${context}\n\nQuestion: ${question}`,
              },
            ],
            options: { temperature: 0.1, num_predict: 500 },
          }),
        });
        if (!res.ok) {
          if (attempt === 0) continue; // retry once on HTTP failure (503 cold start etc.)
          return { answer: null, available: false };
        }
        const data = (await res.json()) as { message?: { content?: string } };
        const content = data.message?.content?.trim();
        if (!content || content.length < 2) {
          if (attempt === 0) continue; // cold-start empty → retry once
          return { answer: null, available: false };
        }
        if (/NOT_IN_CONTEXT/i.test(content) && !/\[E\d+\]/.test(content)) {
          return { answer: null, available: true };
        }
        return { answer: content, available: true };
      } catch {
        return { answer: null, available: false };
      }
    }
    return { answer: null, available: false };
  }

  /**
   * Verifieer [E-n]-citatie-markeringen: elke markering moet verwijzen naar
   * een evidence-index die daadwerkelijk is opgehaald (1-based). Onterechte
   * verwijzingen (verzonnen E-referenties) verminderen de grounding-ratio.
   */
  private verifyCitationMarkers(citedText: string, evidenceCount: number): {
    checked: number;
    resolved: number;
    unresolved: Array<{ claim: string; reason: string }>;
    grounding_ratio: number;
  } {
    const markers = [...citedText.matchAll(/\[E(\d+)\]/g)].map((m) => Number(m[1]));
    if (markers.length === 0) {
      return { checked: 0, resolved: 0, unresolved: [], grounding_ratio: 1 };
    }
    const unresolved: Array<{ claim: string; reason: string }> = [];
    let resolvedCount = 0;
    for (const n of markers) {
      if (n >= 1 && n <= evidenceCount) {
        resolvedCount += 1;
      } else {
        unresolved.push({ claim: `[E${n}]`, reason: `citaat verwijst naar evidence ${n} buiten de ${evidenceCount} opgehaalde chunks (mogelijk verzonnen)` });
      }
    }
    return {
      checked: markers.length,
      resolved: resolvedCount,
      unresolved,
      grounding_ratio: markers.length === 0 ? 1 : resolvedCount / markers.length,
    };
  }

  /**
   * Geen gefabriceerde grounding: een antwoord zonder citaten is niet
   * verifieerbaar → null teruggeven zodat de refusal/fallback-pad volgt.
   * ponytail: marker-injectie was self-defeating (index-bewijs ≠ claim-bewijs);
   * upgrade: NLI-alignment van elke claim tegen de evidence-chunk-tekst.
   */
  private injectCitationMarkers(answer: string): string | null {
    if (/\[E\d+\]/.test(answer)) return answer;
    return null;
  }

  private toCitation(chunk: ExplainerChunk, score: number): AskCitation {
    return {
      chunk_id: chunk.id,
      repo: chunk.repo_full_name,
      section: chunk.section,
      chunk_type: chunk.chunk_type,
      citation: chunk.citation,
      text_excerpt: chunk.text.slice(0, 200),
      score: Math.round(score * 1000) / 1000,
    };
  }
}
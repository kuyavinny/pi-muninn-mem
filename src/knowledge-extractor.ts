/**
 * LLM-based knowledge extractor for MuninnDB.
 *
 * Uses Ollama to analyze conversations and extract only genuinely memorable
 * knowledge — facts, decisions, preferences, issues, and procedures that
 * are worth persisting across sessions.
 *
 * This replaces the old regex-heuristic approach with proper LLM extraction,
 * which handles:
 * - User messages (implicit knowledge: "I prefer X", "We decided on Y")
 * - Agent responses (extract key takeaways, not raw text)
 * - Meta-conversation filtering (skip chitchat, tool output, etc.)
 */

// Ollama configuration — matches MuninnDB's enrichment URL pattern
const OLLAMA_BASE_URL = process.env.MUNINN_OLLAMA_URL
  ?.replace(/^ollama:\/\//, "http://")
  ?.replace(/\/[^/]+$/, "") // strip model name
  ?? "http://localhost:11434";

const OLLAMA_MODEL = process.env.MUNINN_EXTRACT_MODEL ?? "llama3.2:1b";
const OLLAMA_TIMEOUT_MS = 30_000; // 30s timeout for extraction

interface ExtractedMemory {
  concept: string;
  content: string;
  type: "fact" | "decision" | "preference" | "issue" | "procedure";
  tags: string[];
  entities: Array<{ name: string; type: string }>;
  confidence: number; // 0-1, how confident we are this is worth remembering
}

const EXTRACTION_PROMPT = `You are a knowledge extraction assistant. Analyze the conversation and extract ONLY information worth remembering long-term.

Rules:
- Extract facts, decisions, preferences, issues, and procedures — NOT chitchat, acknowledgments, or meta-discussion
- Skip: greetings, "let me check", "I'll do that", tool output, error messages, status updates
- Each memory must be ATOMIC — one concept per memory
- Be specific: "Use MUNINN_LISTEN_HOST=0.0.0.0 for Docker" not "Configure networking"
- For user messages: extract implicit knowledge ("I prefer X", "We decided Y", "X doesn't work")
- For agent responses: extract only the key takeaway, not the full response
- Set confidence 0.0-1.0: how important is this to remember? 0.0 = trivial, 1.0 = critical project knowledge

Respond with JSON only, no explanation:
{"memories": [{"concept": "short label", "content": "full detail", "type": "fact|decision|preference|issue|procedure", "tags": ["tag1"], "entities": [{"name": "EntityName", "type": "project|tool|concept|person"}], "confidence": 0.8}]}

If nothing is worth remembering, respond: {"memories": []}`;

/**
 * Extract knowledge from a conversation turn using Ollama.
 * Returns an array of memories worth storing, or empty array if nothing memorable.
 */
export async function extractMemories(
  userMessage: string,
  agentResponse: string,
): Promise<ExtractedMemory[]> {
  const conversation = `USER: ${userMessage}\n\nASSISTANT: ${agentResponse}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: "system", content: EXTRACTION_PROMPT },
          { role: "user", content: conversation },
        ],
        stream: false,
        options: {
          temperature: 0.1, // Low temperature for consistent extraction
          num_predict: 512, // Short response — just JSON
        },
      }),
    });

    clearTimeout(timeout);

    if (!response.ok) {
      // Ollama unavailable — fall back silently
      return [];
    }

    const data = await response.json();
    const content = data?.message?.content?.trim() ?? "";

    if (!content) return [];

    // Parse the JSON response
    return parseExtractionResponse(content);
  } catch {
    // Network error, timeout, or parse failure — silent fallback
    return [];
  }
}

/**
 * Extract knowledge from just a user message.
 * Used in before_agent_start to capture implicit knowledge.
 */
export async function extractUserMemories(
  userMessage: string,
): Promise<ExtractedMemory[]> {
  const prompt = `Analyze this user message and extract ONLY knowledge worth remembering long-term. Skip questions, commands, and chitchat. Focus on implicit decisions, preferences, constraints, and facts the user reveals.

Rules:
- "I always use X" → preference
- "We decided on Y" → decision
- "X doesn't work with Y" → issue
- "The project uses Z" → fact
- If it's just a question or command with no knowledge, return empty array

Respond with JSON only: {"memories": [{"concept": "short label", "content": "full detail", "type": "fact|decision|preference|issue|procedure", "tags": ["tag1"], "entities": [{"name": "EntityName", "type": "project|tool|concept|person"}], "confidence": 0.8}]}

If nothing is worth remembering: {"memories": []}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: userMessage },
        ],
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 512,
        },
      }),
    });

    clearTimeout(timeout);

    if (!response.ok) return [];

    const data = await response.json();
    const content = data?.message?.content?.trim() ?? "";

    if (!content) return [];

    return parseExtractionResponse(content);
  } catch {
    return [];
  }
}

/**
 * Parse the LLM's extraction response.
 * Handles both clean JSON and JSON wrapped in markdown code blocks.
 */
function parseExtractionResponse(content: string): ExtractedMemory[] {
  // Strip markdown code blocks if present
  let json = content;
  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    json = codeBlockMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(json);
    if (!parsed.memories || !Array.isArray(parsed.memories)) return [];

    return parsed.memories
      .filter((m: any) => m.concept && m.content && m.confidence >= 0.5)
      .map((m: any) => ({
        concept: String(m.concept).slice(0, 512),
        content: String(m.content).slice(0, 16384),
        type: ["fact", "decision", "preference", "issue", "procedure"].includes(m.type)
          ? m.type
          : "fact",
        tags: Array.isArray(m.tags) ? m.tags.slice(0, 10) : [],
        entities: Array.isArray(m.entities)
          ? m.entities
              .filter((e: any) => e.name && e.type)
              .slice(0, 5)
              .map((e: any) => ({ name: String(e.name), type: String(e.type) }))
          : [],
        confidence: Number(m.confidence) || 0.5,
      }));
  } catch {
    // Not valid JSON — try to find JSON object in the content
    const jsonMatch = json.match(/\{[\s\S]*"memories"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.memories && Array.isArray(parsed.memories)) {
          return parsed.memories
            .filter((m: any) => m.concept && m.content && m.confidence >= 0.5)
            .map((m: any) => ({
              concept: String(m.concept).slice(0, 512),
              content: String(m.content).slice(0, 16384),
              type: ["fact", "decision", "preference", "issue", "procedure"].includes(m.type)
                ? m.type
                : "fact",
              tags: Array.isArray(m.tags) ? m.tags.slice(0, 10) : [],
              entities: Array.isArray(m.entities)
                ? m.entities
                    .filter((e: any) => e.name && e.type)
                    .slice(0, 5)
                    .map((e: any) => ({ name: String(e.name), type: String(e.type) }))
                : [],
              confidence: Number(m.confidence) || 0.5,
            }));
        }
      } catch {
        // Really not JSON — give up
      }
    }
    return [];
  }
}

/**
 * Quick heuristic check: is this message likely worth the LLM extraction cost?
 * Filters out obvious noise before calling Ollama.
 */
export function isWorthExtracting(text: string): boolean {
  if (!text || text.length < 20) return false;

  // Skip pure tool output, errors, and status messages
  const noisePatterns = [
    /^(ok|done|sure|yes|no|thanks|thank you|got it|right|correct)\.?$/i,
    /^(error|warning|info|debug):/i,
    /^\s*\{/m, // raw JSON output
    /^\s*[\d.]+\s*$/m, // just numbers
    /^(Command exited|Process exited)/m,
  ];

  for (const pattern of noisePatterns) {
    if (pattern.test(text.trim())) return false;
  }

  // Must have some substance
  const wordCount = text.split(/\s+/).length;
  if (wordCount < 5) return false;

  return true;
}